import express from "express";
import { getAdminSession } from "./auth.js";
import { hasPermission, reportAccessScope, requirePermission } from "./authorization.js";
import { getZonedDateParts } from "../core/runtime/timezone.js";
import { aggregateMonthlyRecords, MONTHLY_PROJECTS, MONTHLY_REPORT_PERMISSION, MONTHLY_REPORTERS, monthlyCsv, monthlyDetails, monthlyStoresForScope, monthlyTotals, monthRange, MonthlyReportValidationError, readMonthlyRecords } from "../scenarios/reimbursement/monthly-report.js";

export function createMonthlyReportRouter(timeZone: string) {
  const router = express.Router();
  router.use(requirePermission("report:view"), requirePermission(MONTHLY_REPORT_PERMISSION));
  function text(value: unknown, label: string, maxLength = 120): string {
    if (value === undefined) return "";
    if (typeof value !== "string" || value.length > maxLength) throw new MonthlyReportValidationError(`${label}参数无效。`);
    return value.trim();
  }
  function integer(value: unknown, fallback: number, maximum: number) {
    if (value === undefined) return fallback;
    if (typeof value !== "string" || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) throw new MonthlyReportValidationError("分页参数无效。");
    return Number(value);
  }
  function read(request: express.Request, response: express.Response) {
    const month = text(request.query.month, "月份", 7), store = text(request.query.store, "门店", 30);
    monthRange(month, timeZone);
    const session = getAdminSession(response)!;
    const data = readMonthlyRecords({ month, store, timeZone, scope: reportAccessScope(session) });
    if (!data) { response.status(404).json({ success: false, error: { message: "门店不存在或无权查看。" } }); return null; }
    return { ...data, month, session };
  }
  router.get("/options", (_request, response) => {
    const session = getAdminSession(response)!, parts = getZonedDateParts(new Date(), timeZone);
    response.json({ success: true, stores: monthlyStoresForScope(reportAccessScope(session)).map(({ channels: _channels, ...store }) => store), projects: MONTHLY_PROJECTS, reporters: MONTHLY_REPORTERS,
      currentMonth: `${parts.year}-${String(parts.month).padStart(2, "0")}`, timeZone, dateBasis: "createdAt", canAttachment: hasPermission(session, "attachment:view") });
  });
  router.get("/", (request, response, next) => {
    try {
      const data = read(request, response); if (!data) return;
      const groups = aggregateMonthlyRecords(data.records);
      response.json({ success: true, month: data.month, store: { id: data.store.id, name: data.store.name, partial: data.store.partial }, groups, totals: monthlyTotals(groups), timeZone });
    } catch (error) { next(error); }
  });
  router.get("/details", (request, response, next) => {
    try {
      const data = read(request, response); if (!data) return;
      const projectId = text(request.query.projectId, "项目", 30), reporter = text(request.query.reporter, "报账人", 500), currency = text(request.query.currency, "币种", 100);
      if (!MONTHLY_PROJECTS.some(p => p.id === projectId) || !reporter || !currency) throw new MonthlyReportValidationError("请选择有效的汇总条目。");
      const offset = integer(request.query.offset, 0, 10000000), limit = integer(request.query.limit, 50, 100);
      if (limit === 0) throw new MonthlyReportValidationError("分页大小必须大于零。");
      response.json({ success: true, ...monthlyDetails(data.records, { projectId, reporter, currency, offset, limit }, hasPermission(data.session, "attachment:view")), canAttachment: hasPermission(data.session, "attachment:view"), timeZone });
    } catch (error) { next(error); }
  });
  router.get("/export", (request, response, next) => {
    try {
      const data = read(request, response); if (!data) return;
      const reporter = text(request.query.reporter, "报账人", 500), currency = text(request.query.currency, "币种", 100), query = text(request.query.q, "搜索", 200).toLocaleLowerCase();
      const groups = aggregateMonthlyRecords(data.records).filter(g => (!reporter || g.reporter === reporter) && (!currency || g.currency === currency) && (!query || [g.project, g.reporter].some(value => value.toLocaleLowerCase().includes(query))));
      response.set("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(`${data.store.name}-${data.month}-项目报表.csv`)}`);
      response.type("text/csv; charset=utf-8").send(monthlyCsv(groups));
    } catch (error) { next(error); }
  });
  router.use((error: unknown, _request: express.Request, response: express.Response, next: express.NextFunction) => {
    if (error instanceof MonthlyReportValidationError) { response.status(400).json({ success: false, error: { message: error.message } }); return; }
    next(error);
  });
  return router;
}
