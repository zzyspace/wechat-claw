import express from "express";
import { getAdminSession } from "./auth.js";
import { hasPermission, reportAccessScope, requirePermission } from "./authorization.js";
import { getMonthlyMonthSelection } from "./monthly-report-routes.js";
import { MONTHLY_REPORT_PERMISSION, monthRange, readMonthlyRecords, MonthlyReportValidationError } from "../scenarios/reimbursement/monthly-report.js";
import { OperatingConflictError, operatingCurrencies, operatingCsv, operatingSummary, parseOperatingInput, readOperatingRecord, saveOperatingRecord } from "../scenarios/reimbursement/operating-report.js";

export function createOperatingReportRouter(timeZone: string) {
  const router = express.Router();
  router.use(requirePermission("report:view"), requirePermission(MONTHLY_REPORT_PERMISSION));
  function read(request: express.Request, response: express.Response) {
    if (Object.keys(request.query).some(key => !["month", "store", "currency"].includes(key))) throw new MonthlyReportValidationError("查询参数无效。");
    const { month, store, currency = "CNY" } = request.query;
    if (typeof month !== "string" || typeof store !== "string" || store.length > 30 || typeof currency !== "string" || currency.length > 100 || !currency.trim()) throw new MonthlyReportValidationError("请选择有效的月份、门店和币种。");
    monthRange(month, timeZone);
    const session = getAdminSession(response)!;
    if (month < getMonthlyMonthSelection(timeZone, new Date(), session).minMonth) throw new MonthlyReportValidationError("月度报表仅支持 2026-09 及之后的月份。");
    const data = readMonthlyRecords({ month, store, timeZone, scope: reportAccessScope(session) });
    if (!data) { response.status(404).json({ success: false, error: { message: "门店不存在或无权查看。" } }); return null; }
    const finance = data.store.partial ? null : readOperatingRecord(store, month, currency);
    const summary = operatingSummary(data.records, currency, finance, data.store.partial, month);
    const currencies = [...new Set(["CNY", ...summary.currencies, ...(data.store.partial ? [] : operatingCurrencies(store, month))])];
    if (!currencies.includes(currency)) throw new MonthlyReportValidationError("该门店月份没有此币种的数据。");
    return { month, currency, session, records: data.records, store: data.store, summary: { ...summary, currencies }, canEdit: !data.store.partial && hasPermission(session, "report:edit") && /^[A-Z]{3}$/.test(currency) };
  }
  router.get(["/", "/export"], (request, response, next) => {
    try {
      const data = read(request, response); if (!data) return;
      if (request.path === "/export") {
        response.set("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(`${data.store.name}-${data.month}-经营及分红月报.csv`)}`);
        response.type("text/csv; charset=utf-8").send(operatingCsv(data.summary, data.store.name, data.month, data.currency));
      } else response.json({ success: true, month: data.month, currency: data.currency, store: { id: data.store.id, name: data.store.name, partial: data.store.partial }, ...data.summary, canEdit: data.canEdit, timeZone });
    } catch (error) { next(error); }
  });
  router.put("/", requirePermission("report:edit"), (request, response, next) => {
    try {
      if (!request.is("application/json")) throw new MonthlyReportValidationError("请使用 JSON 提交数据。");
      const origin = request.get("Origin");
      if (request.get("Sec-Fetch-Site") === "cross-site" || origin && origin !== `${request.protocol}://${request.get("Host")}`) { response.status(403).json({ success: false, error: { message: "请在本站页面保存经营数据。" } }); return; }
      const data = read(request, response); if (!data) return;
      if (!data.canEdit) { response.status(403).json({ success: false, error: { message: "只有可查看整店报账且拥有编辑权限的账号才能录入经营数据。" } }); return; }
      const input = parseOperatingInput(request.body, data.summary.finance);
      operatingSummary(data.records, data.currency, { ...input, updatedAt: "" }, false, data.month);
      const finance = saveOperatingRecord(data.store.id, data.month, data.currency, input, data.session.accountId);
      response.json({ success: true, finance });
    } catch (error) { next(error); }
  });
  router.use((error: unknown, _request: express.Request, response: express.Response, next: express.NextFunction) => {
    if (error instanceof MonthlyReportValidationError || error instanceof OperatingConflictError) { response.status(error instanceof OperatingConflictError ? 409 : 400).json({ success: false, error: { message: error.message } }); return; }
    next(error);
  });
  return router;
}
