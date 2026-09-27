/* Desktop design study of /expense, based on src/admin/public/admin.html (2026-09-27).
   Scope: three desktop filter layouts, existing tokens and compound-input grammar.
   All records are fictional. No API requests, authentication, writes or uploads. */
const {useState,useEffect,useRef}=React;
const variant=document.body.dataset.variant||'a';
const base={store:'',from:'2026-09-01',to:'2026-09-27',search:'',reporter:'',category:'',note:''};
const extraKeys=['search','reporter','category','note'];
const labels={search:'关键词 / 报账 ID',reporter:'报账人',category:'类别',note:'备注'};
const shortLabels={search:'关键词',reporter:'报账人',category:'类别',note:'备注'};
const hints={search:'关键词 / 报账 ID',reporter:'如 张||李',category:'如 食材||房租',note:'如 采购&!平'};
const stores=['Fuzzy','Fuzzy店长报账群','Peanut','Peanut店长报账群','Fuzzy泉州店','Fuzzy泉州店长报账群'];
const demoRecords=[
 {id:'26092701',store:'Fuzzy',reporter:'林晓',category:'食材',amount:328.50,note:'日常食材采购',date:'2026-09-27',time:'09:42',files:2},
 {id:'26092702',store:'Peanut',reporter:'陈悦',category:'其他',amount:86,note:'日用品补充',date:'2026-09-27',time:'08:36',files:1},
 {id:'26092601',store:'Fuzzy泉州店',reporter:'李宁',category:'食材',amount:216.80,note:'蔬菜采购 农',date:'2026-09-26',time:'17:20',files:1},
 {id:'26092501',store:'Fuzzy',reporter:'张晨',category:'房租',amount:6500,note:'九月门店房租',date:'2026-09-25',time:'14:08',files:1},
 {id:'26092001',store:'Peanut',reporter:'张晨',category:'食材',amount:152,note:'调料采购 平',date:'2026-09-20',time:'10:30',files:2},
 {id:'26091801',store:'Fuzzy泉州店',reporter:'李宁',category:'其他',amount:45,note:'补票 待确认',date:'2026-09-18',time:'12:06',files:1}
];
function CalendarIcon(){return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="3"></rect><path d="M7 3v4M17 3v4M3 11h18"></path></svg>}
function Chevron(){return <i className="chevron" aria-hidden="true"></i>}
function Count({value}){return value>0?<span className="count">{value}</span>:null}
function ExprHelp(){return <p className="expression-help"><code>!</code> 排除 · <code>&amp;</code> 同时满足 · <code>||</code> 任一满足</p>}
function parseExpr(value,key){
 if(!value.trim())return null;
 if(/[()（）]/.test(value)||value.replaceAll('||','').includes('|'))throw Error(`${labels[key]}：请使用 !、&、|| 组合条件`);
 return value.split('||').map(group=>group.split('&').map(term=>{
  const clean=term.trim(),exclude=clean.startsWith('!'),token=(exclude?clean.slice(1):clean).trim();
  if(!token||token.includes('!'))throw Error(`${labels[key]}：请补全筛选条件`);
  if(key==='category'&&!['食材','房租','水电','工资','其他','food','rent','utilities','salary','other'].includes(token))throw Error('类别：请输入有效类别，如 食材、房租、其他');
  return {exclude,token};
 }));
}
function matches(value,expr,key){if(!expr)return true;return expr.some(group=>group.every(({exclude,token})=>{const aliases={food:'食材',rent:'房租',utilities:'水电',salary:'工资',other:'其他'};const found=key==='category'?value===(aliases[token]||token):value.toLowerCase().includes(token.toLowerCase());return exclude?!found:found}))}
function getRecords(filters){const parsed=Object.fromEntries(['reporter','category','note'].map(key=>[key,parseExpr(filters[key],key)]));return demoRecords.filter(r=>(!filters.store||r.store===filters.store)&&(!filters.from||r.date>=filters.from)&&(!filters.to||r.date<=filters.to)&&(!filters.search||Object.values(r).join(' ').toLowerCase().includes(filters.search.toLowerCase()))&&['reporter','category','note'].every(key=>matches(r[key],parsed[key],key)))}
function dateLabel(from,to,compact=false){const format=v=>v.replaceAll('-','/');if(!from&&!to)return '不限日期';if(from&&to)return compact&&from.slice(0,4)===to.slice(0,4)?`${format(from)} — ${format(to).slice(5)}`:`${format(from)} — ${format(to)}`;return from?`${format(from)} 起`:`截至 ${format(to)}`}
function Modal({open,onClose,title,sheet=false,children}){
 const ref=useRef(null),closeRef=useRef(onClose),titleId=React.useId();closeRef.current=onClose;
 useEffect(()=>{const d=ref.current;if(open){d.showModal();const old=document.body.style.overflow;document.body.style.overflow='hidden';return()=>{d.close();document.body.style.overflow=old}}},[open]);
 return <dialog ref={ref} className={sheet?'sheet':''} aria-labelledby={titleId} onCancel={e=>{e.preventDefault();closeRef.current()}} onClick={e=>{if(e.target===ref.current){const b=ref.current.getBoundingClientRect();if(e.clientX<b.left||e.clientX>b.right||e.clientY<b.top||e.clientY>b.bottom)closeRef.current()}}}>
 {sheet&&<div className="sheet-handle"></div>}<div className="dialog-heading"><h2 id={titleId}>{title}</h2><button className="icon-button" aria-label="关闭" onClick={onClose}>×</button></div>{children}</dialog>
}
function DatePicker({open,value,onClose,onApply}){
 const [range,setRange]=useState({from:value.from,to:value.to});const [month,setMonth]=useState('2026-09');
 useEffect(()=>{if(open){setRange({from:value.from,to:value.to});setMonth((value.from||'2026-09').slice(0,7))}},[open]);
 const [year,mo]=month.split('-').map(Number);const count=new Date(year,mo,0).getDate(),offset=(new Date(year,mo-1,1).getDay()+6)%7;
 const move=n=>{const d=new Date(year,mo-1+n,1);setMonth(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`)};
 function choose(date){if(!range.from||range.to)setRange({from:date,to:''});else setRange({from:date<range.from?date:range.from,to:date<range.from?range.from:date})}
 function preset(kind){const ranges={today:['2026-09-27','2026-09-27'],week:['2026-09-21','2026-09-27'],month:['2026-09-01','2026-09-30'],last:['2026-08-01','2026-08-31']};const [from,to]=ranges[kind];setRange({from,to});setMonth(from.slice(0,7))}
 return <Modal open={open} onClose={onClose} title="选择创建日期"><div className="date-body"><div className="shortcuts"><button onClick={()=>preset('today')}>今天</button><button onClick={()=>preset('week')}>近 7 天</button><button onClick={()=>preset('month')}>本月</button><button onClick={()=>preset('last')}>上月</button></div><div className="calendar-heading"><button className="icon-button" aria-label="上个月" onClick={()=>move(-1)}>‹</button><strong>{year} 年 {mo} 月</strong><button className="icon-button" aria-label="下个月" onClick={()=>move(1)}>›</button></div><div className="calendar-week">{['一','二','三','四','五','六','日'].map(d=><span key={d}>{d}</span>)}</div><div className="calendar-days">{Array.from({length:offset},(_,i)=><span key={`blank-${i}`}></span>)}{Array.from({length:count},(_,i)=>{const date=`${month}-${String(i+1).padStart(2,'0')}`,selected=date===range.from||date===range.to,between=range.from&&range.to&&date>range.from&&date<range.to;return <button key={date} aria-label={date} aria-pressed={selected} className={selected?'selected':between?'between':''} onClick={()=>choose(date)}>{i+1}</button>})}</div><div className="date-draft" aria-live="polite">{dateLabel(range.from,range.to)}</div><p className="date-instruction">{range.from&&!range.to?'再选一天作为结束日期':'依次选择开始日期和结束日期'}</p></div><div className="date-bottom"><button className="text-button" onClick={()=>onApply({from:'',to:''})}>不限日期</button><button onClick={onClose}>取消</button><button className="primary" disabled={!range.from||!range.to} onClick={()=>onApply(range)}>应用日期</button></div></Modal>
}
function Field({name,value,onChange}){return <div className={`field field-${name} ${name==='search'||name==='note'?'wide':''}`}><label htmlFor={`field-${name}`}>{labels[name]}</label><input id={`field-${name}`} name={name} value={value} autoComplete="off" placeholder={hints[name]} onChange={e=>onChange(name,e.target.value)}></input></div>}
function ExtraFields({values,onChange}){return <><Field name="search" value={values.search} onChange={onChange}></Field><Field name="reporter" value={values.reporter} onChange={onChange}></Field><Field name="category" value={values.category} onChange={onChange}></Field><Field name="note" value={values.note} onChange={onChange}></Field></>}
function DesktopApp(){
 const [draft,setDraft]=useState({...base}),[applied,setApplied]=useState({...base}),[expanded,setExpanded]=useState(false),[dateOpen,setDateOpen]=useState(false),[error,setError]=useState(''),[toast,setToast]=useState(''),[detail,setDetail]=useState(null);
 const [theme,setTheme]=useState(new URLSearchParams(location.search).get('theme')||'light');
 useEffect(()=>{document.documentElement.dataset.theme=theme},[theme]);
 useEffect(()=>{const handler=e=>{if(e.origin!==location.origin)return;switch(e.data?.type){case 'desktop-theme':setTheme(e.data.theme);break;case 'desktop-example':{const sample={...base,reporter:'张||李',category:'食材||房租',note:'!平'};setDraft(sample);setApplied(sample);setError('');setExpanded(false);break}case 'desktop-reset':reset();break}};window.addEventListener('message',handler);return()=>window.removeEventListener('message',handler)},[]);
 useEffect(()=>{if(!toast)return;const timer=setTimeout(()=>setToast(''),2200);return()=>clearTimeout(timer)},[toast]);
 const records=getRecords(applied),total=records.reduce((n,r)=>n+r.amount,0),active=extraKeys.filter(k=>applied[k]),draftCount=extraKeys.filter(k=>draft[k].trim()).length;
 function update(key,value){setDraft(v=>({...v,[key]:value}));setError('')}
 function apply(next=draft){try{getRecords(next);setDraft({...next});setApplied({...next});setError('');setExpanded(false)}catch(e){setError(e.message);setExpanded(true)}}
 function reset(){setDraft({...base});setApplied({...base});setExpanded(false);setError('')}
 function clear(key){setDraft(v=>({...v,[key]:''}));setApplied(v=>({...v,[key]:''}));setError('')}
 const fields=<><Field name="search" value={draft.search} onChange={update}></Field><Field name="reporter" value={draft.reporter} onChange={update}></Field><Field name="category" value={draft.category} onChange={update}></Field><Field name="note" value={draft.note} onChange={update}></Field></>;
 const actions=<div className="desktop-actions"><button className="primary" type="submit">查询</button><button className="reset" type="button" onClick={reset}>重置</button></div>;
 return <><nav className="topbar desk-topbar"><div className="brand"><svg viewBox="0 0 32 32" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="7" width="22" height="19" rx="4" fill="currentColor" fillOpacity=".16"></rect><path d="M8 7V5.5A2.5 2.5 0 0 1 10.5 3H22M10 13h8m-6 4 2.2 2.2 3.5-3.7"></path><circle cx="24" cy="24" r="4" fill="currentColor" stroke="none"></circle><path d="M24 22v4M22 24h4" stroke="white" strokeWidth="1.8"></path></svg><span>报账中心</span></div><div className="top-actions"><button aria-label="切换主题" onClick={()=>setTheme(theme==='light'?'dark':'light')}>{theme==='light'?'◐':'◑'}</button><button onClick={()=>setToast('设计预览，不会退出实际账号')}>退出登录</button></div></nav>
 <main className={`desk-page design-${variant}`} data-screen-label={`桌面方案 ${variant.toUpperCase()}`}><header className="desk-hero"><h1>报账查看后台</h1><p>查看已入库的报账记录，按门店、报账人、类别、日期和备注文字筛选，并展开详情查看 OCR、原始消息、附件和回执记录。</p><div className="hero-actions"><button className="primary" onClick={()=>setToast('本次预览聚焦筛选模块')}>手工补录</button><button className="primary" onClick={()=>setToast('本次预览聚焦筛选模块')}>批量补录</button></div></header>
 <section className="desk-filters" aria-label="筛选报账"><form onSubmit={e=>{e.preventDefault();apply()}}><div className="desktop-grid"><div className="field store-field"><label htmlFor="store">门店</label><select id="store" value={draft.store} onChange={e=>update('store',e.target.value)}><option value="">全部门店</option>{stores.map(store=><option key={store}>{store}</option>)}</select></div><div className="field date-field"><label htmlFor="created-date">创建日期</label><button id="created-date" className="date-trigger" type="button" aria-haspopup="dialog" aria-expanded={dateOpen} onClick={()=>setDateOpen(true)}><span>{dateLabel(draft.from,draft.to)}</span><CalendarIcon></CalendarIcon></button></div>
 {variant==='b'?<button className="more-desktop" type="button" aria-expanded={expanded} aria-controls="secondary-fields" onClick={()=>setExpanded(v=>!v)}>更多条件<Count value={draftCount}></Count><Chevron></Chevron></button>:fields}{actions}</div>
 {variant==='b'&&<div id="secondary-fields" className="secondary-grid" hidden={!expanded} style={!expanded?{display:'none'}:undefined}>{fields}</div>}{error&&<p role="alert" className="error">{error}</p>}</form>
 {active.length>0&&<div className="desktop-chips" aria-label="已生效的条件">{active.map(key=><button key={key} onClick={()=>clear(key)} aria-label={`移除${shortLabels[key]}条件`} title={`${shortLabels[key]}：${applied[key]}`}><span>{shortLabels[key]}：{applied[key]}</span><span aria-hidden="true">×</span></button>)}</div>}
 <div className="filter-foot"><span className="result-status" role="status" aria-live="polite">已加载 {records.length} 条记录，总计金额 {total.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})} 元</span>{variant==='b'&&!expanded?<span className="scope-help">{active.length?`已应用 ${active.length} 项更多条件`:'更多条件：关键词、报账人、类别、备注'}</span>:<ExprHelp></ExprHelp>}</div></section>
 <section className="panel desk-records" aria-label="报账记录"><div className="table-overflow"><table className="desk-table"><thead><tr><th>门店</th><th>创建时间</th><th>报账人</th><th>金额</th><th>类别</th><th>备注</th><th>附件</th><th>需复核</th><th>更新时间</th><th>报账 ID</th></tr></thead><tbody>{records.map(r=><tr key={r.id}><td><span className="store-name">{r.store}</span></td><td><time>{r.date.slice(5).replace('-','/')}<small>{r.time}</small></time></td><td><span className="tag reporter-tag">{r.reporter}</span></td><td><span className="money"><small>¥</small>{r.amount.toLocaleString('en-US',{minimumFractionDigits:2})}</span></td><td><span className={`tag ${r.category==='房租'?'rent':r.category==='其他'?'other':''}`}>{r.category}</span></td><td className="remark">{r.note}</td><td><button className="bill-button" onClick={()=>setToast('示例记录，不包含真实附件')}>查看附件</button></td><td><span className="confirmed">✓ 已确认</span></td><td><time>{r.date.slice(5).replace('-','/')}<small>{r.time}</small></time></td><td><button className="id-button" onClick={()=>setDetail(r)}>#{r.id.slice(-4)}</button></td></tr>)}</tbody></table></div>{records.length===0&&<div className="empty">没有匹配的报账记录。<button className="text-button" onClick={reset}>重置筛选</button></div>}<div className="desk-pagination"><div><span>{records.length?`1 – ${records.length}`:'0 – 0'} / {records.length}</span><span>每页</span><select aria-label="每页条数" defaultValue="200" onChange={()=>setToast('预览只有 6 条示例记录')}><option>20</option><option>50</option><option>200</option></select></div><div><button disabled>上一页</button><button disabled>下一页</button></div></div></section></main>
 <DatePicker open={dateOpen} value={draft} onClose={()=>setDateOpen(false)} onApply={range=>{setDateOpen(false);apply({...draft,...range})}}></DatePicker><Modal open={!!detail} onClose={()=>setDetail(null)} title="报账详情"><div className="record-preview">{detail&&<><strong>{detail.reporter} · {detail.store}</strong><p>{detail.category} · ¥{detail.amount.toFixed(2)}</p><p>{detail.note}</p><p>虚构示例记录，仅用于筛选效果演示。</p></>}</div></Modal>{toast&&<div className="toast preview-toast" role="status">{toast}</div>}</>
}
ReactDOM.createRoot(document.getElementById('root')).render(<DesktopApp></DesktopApp>);
