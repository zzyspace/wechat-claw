import React, {useEffect,useState} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {AreaChart} from './vendor/tremor/components/AreaChart/AreaChart';
import {LineChart} from './vendor/tremor/components/LineChart/LineChart';
import {ComboChart} from './vendor/tremor/components/ComboChart/ComboChart';
import {chartData,combinedLabel,series,type SummaryChartRow,type ChartKind} from '../../src/admin/operating-chart-data';
interface Props {rows:SummaryChartRow[]; currency:string; partial:boolean}
const definitions={balance:['收支趋势','总收入与总支出'],profit:['盈利趋势','当期盈利金额'],cost:['成本率变化','食材占营业收入 · 总成本占总收入']};
const currencyMoney=(n:number|null,currency:string)=>n==null?'—':`${currency==='CNY'?'¥':currency} ${(n/100).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
let selectedKind:ChartKind='balance',expanded=true;
function Panel({kind,...props}:Props&{kind:ChartKind}) {
  const data=chartData(props.rows,props.partial);
  const definition=definitions[kind],groups=series[kind];
  const min=Math.min(0,...data.flatMap(r=>groups.map(([,label])=>r[label])).filter((v):v is number=>typeof v==='number'));
  const maxRaw=Math.max(0,...data.flatMap(r=>groups.map(([,label])=>r[label])).filter((v):v is number=>typeof v==='number'));
  const scale=10**Math.floor(Math.log10((maxRaw||1)/4));
  const step=([1,2,2.5,5,10].find(n=>n*scale>=(maxRaw||1)/4)??10)*scale;
  const max=step*4;
  const hasData=data.some(r=>groups.some(([,label])=>r[label]!=null));
  const axis=(v:number)=>kind==='cost'?`${v}%`:(v/10000).toLocaleString('zh-CN',{maximumFractionDigits:Math.abs(v)<10000?6:1});
  const tooltip=({active,label}:{active?:boolean;label?:string})=>{
    const point=data.find(p=>p.label===label),source=props.rows.find(r=>r.month===point?.month);
    if(!active||!point)return null;
    const note=source&&!source.costComplete?(props.partial?'仅含可见支出':'成本未完整'):'';
    // Compact readout: rendered above the plot area (see styles.css) so it never covers the lines.
    return <div className="operating-chart-tooltip" role="status"><b>{String(point.month)}{combinedLabel(source)?` ${combinedLabel(source)}`:''}</b>{groups.map(([key,name,color])=><span className="tip-item" key={key}><i className={'swatch '+color}/>{props.partial&&name==='总支出'?'可见支出':name}<strong>{point[name]==null?'—':kind==='cost'?Number(point[name]).toFixed(2)+'%':currencyMoney(Math.round(Number(point[name])*100),props.currency)}</strong></span>)}{note&&<small>{note}</small>}</div>;
  };
  const TrendComponent=kind==='balance'?AreaChart:LineChart;
  // Stable ASCII series keys keep Tremor's SVG gradient IDs distinct for Chinese labels.
  const plotData=kind==='balance'?data.map(point=>({...point,income:point['总收入'],expense:point['总支出']})):data;
  const common={curveType:'monotoneX' as const,data:plotData,index:'label',showLegend:false,showGridLines:true,showTooltip:true,tickGap:22,startEndOnly:data.length>18,customTooltip:tooltip,syncId:'operating-summary-trends'};
  return <article className={'trend trend-'+kind} aria-label={definition[0]}>
    <div className="trend-heading"><div><h3>{definition[0]}</h3><p>{definition[1]}</p></div></div>
    <div className="legend">{groups.map(([key,label,color])=><span key={key}><i className={'swatch '+color}/>{props.partial&&label==='总支出'?'可见支出':label}</span>)}<span className="legend-unit">{kind==='cost'?'单位：%':`单位：万${props.currency==='CNY'?'元':' '+props.currency}`}</span></div>
    <div className="chart-canvas">{hasData?(kind==='profit'?<ComboChart {...common} className="tremor-plot" enableBiaxial={false} barSeries={{categories:['盈利'],colors:['emerald'],valueFormatter:axis,minValue:min,maxValue:max,yAxisWidth:44}} lineSeries={{categories:[]}}/>:<TrendComponent {...common} className="tremor-plot" categories={kind==='balance'?['income','expense']:groups.map(([,label])=>label)} colors={groups.map(([, ,color])=>color)} valueFormatter={axis} yAxisWidth={44} minValue={min} maxValue={max} connectNulls={false}/>):<div className="chart-empty">{props.rows.length?'暂无完整数据可绘制':'此年份暂无已结束月份的数据'}</div>}</div>

  </article>;
}
function App(props:Props){
 const [kind,setKind]=useState(selectedKind),[open,setOpen]=useState(expanded),[mobile,setMobile]=useState(matchMedia('(max-width:740px)').matches);
 useEffect(()=>{const media=matchMedia('(max-width:740px)'),change=()=>setMobile(media.matches);media.addEventListener('change',change);return()=>media.removeEventListener('change',change)},[]);
 return <section className="charts card charts-visual" aria-label="经营图表"><div className="chart-top"><div><h2>经营趋势</h2><p>仅汇总已结束月份</p></div>{mobile&&<div className="chart-tabs" role="group" aria-label="选择图表">{([['balance','收支'],['profit','盈利'],['cost','成本率']] as const).map(([key,label])=><button type="button" key={key} aria-pressed={kind===key} onClick={()=>{selectedKind=key;setKind(key);expanded=true;setOpen(true)}}>{label}</button>)}</div>}<button type="button" className="collapse-chart" aria-expanded={open} aria-controls="operatingChartGrid" onClick={()=>{expanded=!open;setOpen(!open)}}>{open?'收起 ⌃':'展开 ⌄'}</button></div>{open&&<><div id="operatingChartGrid" className="chart-grid">{(Object.keys(series) as ChartKind[]).filter(key=>!mobile||key===kind).map(key=><div className="chart-slot selected" key={key}><Panel {...props} kind={key}/></div>)}</div><div className="chart-footnote"><span>悬停或点按图形查看数值 · {props.rows.length} 期{props.rows.some(r=>combinedLabel(r))?' · 含合并期间':''}</span><span>缺失数据不补零 · 食材占营业收入，总成本占总收入</span></div></>}</section>
}
class ChartBoundary extends React.Component<React.PropsWithChildren,{failed:boolean}>{state={failed:false};static getDerivedStateFromError(){return {failed:true}}render(){return this.state.failed?<p className="scope-notice">图表暂时不可用，请通过下方表格查看数据。</p>:this.props.children}}
let root:Root|undefined,container:HTMLElement|undefined;
window.OperatingSummaryCharts={
 mount(element:HTMLElement,props:Props){if(element!==container){root?.unmount();container=element;root=createRoot(element)}root!.render(<ChartBoundary><App {...props}/></ChartBoundary>)},
 unmount(){root?.unmount();root=undefined;container=undefined}
};
declare global{interface Window{OperatingSummaryCharts:{mount:(element:HTMLElement,props:Props)=>void;unmount:()=>void}}}
