export interface SummaryChartRow {
  month: string; income: number|null; expense: number|null; profit: number|null; dividend: number|null;
  foodRate: number|null; costRate: number|null; costComplete: boolean;
  pendingAmountCount: number; unknownCurrencyCount: number; note: string;
}
export const series = {
  balance: [['income','总收入','blue'],['expense','总支出','gray']],
  profit: [['profit','盈利','emerald'],['dividend','总分红','violet']],
  cost: [['foodRate','食材占比','amber'],['costRate','总成本率','gray']],
} as const;
export type ChartKind = keyof typeof series;
// Expand absent calendar months to explicit nulls so lines never bridge missing periods.
export function chartData(rows: SummaryChartRow[], partial: boolean) {
  const sorted=[...rows].sort((a,b)=>a.month.localeCompare(b.month));
  if(!sorted.length)return [];
  const byMonth=new Map(sorted.map(row=>[row.month,row]));
  const result: Record<string,string|number|null>[]=[];
  let [year,month]=sorted[0].month.split('-').map(Number);
  const last=sorted.at(-1)!.month;
  while(true){
    const key=`${year}-${String(month).padStart(2,'0')}`;if(key>last)break;
    const row=byMonth.get(key);
    const knownCost=!!row && (row.costComplete || (partial && !row.pendingAmountCount && !row.unknownCurrencyCount));
    result.push({month:key,label:sorted[0].month.slice(0,4)===last.slice(0,4)?`${month}月`:key,
      总收入:row?.income==null?null:row.income/100,
      总支出:knownCost&&row?.expense!=null?row.expense/100:null,
      盈利:row?.profit==null?null:row.profit/100,
      总分红:row?.dividend==null?null:row.dividend/100,
      食材占比:row?.foodRate??null,总成本率:row?.costRate??null});
    if(++month>12){month=1;year++;}
  }
  return result;
}
export function combinedLabel(row?: SummaryChartRow) {
  return row && /合并|合计|归入/.test(row.note) ? '合并期间' : '';
}
