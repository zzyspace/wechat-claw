import express from "express";
import { getAdminSession } from "./auth.js";
import { hasPermission, reportAccessScope, requirePermission } from "./authorization.js";
import { getMonthlyMonthSelection } from "./monthly-report-routes.js";
import { MONTHLY_REPORT_PERMISSION, monthlyStoresForScope, MonthlyReportValidationError } from "../scenarios/reimbursement/monthly-report.js";
import { OPERATING_SUMMARY_PERMISSION, loadOperatingSummarySource, operatingSummaryOptions, buildOperatingSummary, operatingSummaryCsv } from "../scenarios/reimbursement/operating-summary.js";

export function createOperatingSummaryRouter(timeZone: string) {
  const router=express.Router();
  router.use(requirePermission("report:view"),requirePermission(OPERATING_SUMMARY_PERMISSION));
  function read(request:express.Request,response:express.Response) {
    const allowed=request.path==="/export"?["store","year","currency","sort","direction"]:["store","year","currency"];
    if(Object.keys(request.query).some(key=>!allowed.includes(key)))throw new MonthlyReportValidationError("查询参数无效。");
    const session=getAdminSession(response)!;
    const months=getMonthlyMonthSelection(timeZone,new Date(),session),defaultYear=months.defaultMonth.slice(0,4);
    const stores=monthlyStoresForScope(reportAccessScope(session)).map(({channels:_,...store})=>store);
    const store=request.query.store??stores[0]?.id,year=request.query.year??defaultYear,currency=request.query.currency??"CNY";
    if(typeof store!=="string"||store.length>30||typeof year!=="string"||typeof currency!=="string"||!currency||currency.length>100)throw new MonthlyReportValidationError("请选择有效门店、年份和币种。");
    if(year!=="all"&&(!/^(19|20|21)\d{2}$/.test(year)||year<months.minMonth.slice(0,4)))throw new MonthlyReportValidationError(`经营汇总仅支持 ${months.minMonth} 及之后的月份。`);
    const source=loadOperatingSummarySource({store,minMonth:months.minMonth,currentMonth:months.currentMonth,timeZone,scope:reportAccessScope(session)});
    if(!source){response.status(404).json({success:false,error:{message:"门店不存在或无权查看。"}});return null;}
    const options=operatingSummaryOptions(source,defaultYear);
    if(!options.currencies.includes(currency))throw new MonthlyReportValidationError("该门店没有此币种的数据。");
    return {source,stores,year,currency,options,defaultYear,minMonth:months.minMonth,canMonthlyReport:hasPermission(session,MONTHLY_REPORT_PERMISSION)};
  }
  router.get(["/","/options","/export"],(request,response,next)=>{
    try{
      const data=read(request,response);if(!data)return;
      const metadata={success:true,store:data.source.store,stores:data.stores,...data.options,defaultYear:data.defaultYear,minMonth:data.minMonth,timeZone,canMonthlyReport:data.canMonthlyReport};
      if(request.path==="/options"){response.json(metadata);return;}
      const summary=buildOperatingSummary(data.source,data.year,data.currency);
      if(request.path==="/export"){
        const sort=request.query.sort??"month",direction=request.query.direction??"desc";
        const fields=["month","income","expense","profit","dividend","food","foodRate","costRate",...summary.allocationNames.map((_,i)=>`person_${i}`)];
        if(typeof sort!=="string"||!fields.includes(sort)||!["asc","desc"].includes(String(direction))||typeof direction!=="string")throw new MonthlyReportValidationError("排序参数无效。");
        const value=(row:(typeof summary.rows)[number]):string|number|null=>sort.startsWith("person_")
          ? row.dividend===null?null:row.allocations.find(item=>item.name===summary.allocationNames[Number(sort.slice(7))])?.amountCents??0
          : row[sort as "month"|"income"|"expense"|"profit"|"dividend"|"food"|"foodRate"|"costRate"];
        summary.rows.sort((a,b)=>{const x=value(a),y=value(b);if(x===null&&y===null)return b.month.localeCompare(a.month);if(x===null)return 1;if(y===null)return -1;
          return (direction==="desc"?-1:1)*(typeof x==="string"?x.localeCompare(String(y)):x-Number(y))||b.month.localeCompare(a.month);});
        response.set("Content-Disposition",`attachment; filename*=UTF-8''${encodeURIComponent(`${data.source.store.name}-${data.year==="all"?"全部年份":data.year}-${data.currency}-经营及分红汇总.csv`)}`);
        response.type("text/csv; charset=utf-8").send(operatingSummaryCsv(summary,data.source.store.name,data.currency));return;
      }
      response.json({...metadata,year:data.year,currency:data.currency,...summary});
    }catch(error){next(error);}
  });
  router.use((error:unknown,_request:express.Request,response:express.Response,next:express.NextFunction)=>{
    if(error instanceof MonthlyReportValidationError){response.status(400).json({success:false,error:{message:error.message}});return;}next(error);
  });
  return router;
}
