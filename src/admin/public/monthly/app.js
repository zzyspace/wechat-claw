(() => {
  'use strict';
  const API = '/expense/api/monthly-reports';
  const $ = id => document.getElementById(id);
  const MONTH_PATTERN = /^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/;
  const minMonth = () => s.options?.minMonth || '2026-09';
  const allowedMonth = month => MONTH_PATTERN.test(month || '') && month >= minMonth();
  const s = { sourceSerial:0, editSerial:0, sourceSaving:false, sourceChanged:false, options: null, data: null, store: '', month: '', currency: 'CNY', reporter: '', query: '', loading: true, error: '', serial: 0, group: null, details: [], detailTotal: 0, detailLoading: false, detailError: '', detailSerial: 0, canAttachment: false, attachments: [], attachmentIndex: 0 };
  const icons = {receipt:'M6 3h12v18l-3-2-3 2-3-2-3 2V3Zm3 5h6m-6 4h6',left:'m14 6-6 6 6 6',right:'m9 6 6 6-6 6',calendar:'M4 5h16v16H4V5Zm0 5h16M8 3v4m8-4v4',search:'M21 21l-5-5M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16',download:'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',moon:'M20 15A9 9 0 0 1 9 3a9 9 0 1 0 11 12Z',sun:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5',close:'m6 6 12 12M6 18 18 6',info:'M12 11v6m0-10v.1M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',store:'M4 10v11h16V10M3 10l2-7h14l2 7M9 21v-7h6v7M3 10c0 4 6 4 6 0 0 4 6 4 6 0 0 4 6 4 6 0'};
  const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${icons[name] || ''}"/></svg>`;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = cents => (cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const currencyLabel = currency => currency === 'CNY' ? '¥' : currency;
  const amount = g => g.recordCount && g.missingAmountCount === g.recordCount ? '待确认' : money(g.amountCents);
  const category = c => `<span class="tag category-${['food','flower','salary','rent','utilities','manager_reimbursement','planned_expense'].includes(c.code) ? c.code : 'other'}">${esc(c.label)}</span>`;
  function reporterTag(name) {
    const order = [...new Set([...(s.options?.reporters || []), ...(s.data?.groups || []).map(g => g.reporter)])];
    let index = order.indexOf(name);
    if (index < 0 || index > 15) { let hash = 0; for (const char of name) hash = (hash * 31 + char.codePointAt(0)) >>> 0; index = hash % 16; }
    return `<span class="tag reporter-${index}">${esc(name || '未知')}</span>`;
  }
  function remark(value) {
    const text = String(value || '').replace(/\s+/g, ' ').trim() || '(空)';
    return `<span class="note-content" title="${esc(text)}">${esc(text).replace(/[平农]/gu, c => `<span class="tag note-pill${c === '农' ? ' note-pill-farm' : ''}">${c}</span>`)}</span>`;
  }
  function detailAmount(record) {
    if (record.amount === null || record.amount === undefined || !Number.isFinite(Number(record.amount))) return '<span class="column-amount-missing">待复核</span>';
    const number = Number(record.amount).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const currency = String(record.currency || 'CNY').trim().toUpperCase();
    return `<span class="column-amount-value${number.length > 10 ? ' is-large' : ''}"><span class="column-amount-number">${currency === 'CNY' ? '<small>¥</small>' : ''}${esc(number)}</span><span class="column-amount-currency">${esc(currency)}</span></span>`;
  }
  function createdAt(value) {
    const date = new Date(value.includes('T') ? value : value.replace(' ', 'T') + 'Z');
    if (!Number.isFinite(date.getTime())) return '—';
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: s.options?.timeZone || 'Asia/Shanghai', year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23' }).formatToParts(date);
    const fields = Object.fromEntries(parts.map(p => [p.type, p.value]));
    return `<time class="column-created-at-value" datetime="${esc(date.toISOString())}"><span class="column-created-at-date">${fields.year}-${fields.month}-${fields.day}</span><span class="column-created-at-time">${fields.hour}:${fields.minute}:${fields.second}</span></time>`;
  }
  function currentTheme() { return document.documentElement.dataset.theme || 'light'; }
  function setTheme(value) {
    const theme=value==='dark'?'dark':'light';
    document.documentElement.dataset.theme=theme;document.documentElement.style.colorScheme=theme;
    if($('themeIcon'))$('themeIcon').textContent=theme==='dark'?'☀️':'🌙';
    if($('themeToggle')){$('themeToggle').setAttribute('aria-label',theme==='dark'?'切换到浅色模式':'切换到深色模式');$('themeToggle').setAttribute('aria-pressed',String(theme==='dark'));}
  }
  try { setTheme(localStorage.getItem('comeover-admin-theme') || localStorage.getItem('reimbursement-admin-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')); } catch { setTheme('light'); }
  window.addEventListener('storage', e => { if (e.key === 'comeover-admin-theme' && ['light','dark'].includes(e.newValue)) { setTheme(e.newValue); render(); } });
  async function json(url, signal) {
    const response = await fetch(url, { headers: { Accept:'application/json' }, signal });
    if ([401,403].includes(response.status)) throw new Error(response.status === 403 ? '当前账号没有查看权限，或权限已变更。' : '登录已失效，请返回报账后台重新登录。');
    let data; try { data = await response.json(); } catch { throw new Error('无法读取报表，请返回报账后台确认登录状态。'); }
    if (!response.ok || !data.success) throw new Error(data.error?.message || '报表加载失败，请重试。');
    return data;
  }
  function params(extra = {}) { return new URLSearchParams({ month:s.month, store:s.store, ...extra }); }
  function filteredGroups() { return (s.data?.groups || []).filter(g => g.currency === s.currency && (!s.reporter || g.reporter === s.reporter) && (!s.query.trim() || [g.project,g.reporter].some(t => t.toLocaleLowerCase().includes(s.query.trim().toLocaleLowerCase())))); }
  function clearFilters() { s.query = ''; s.reporter = ''; }
  function notify(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(s.toastTimer); s.toastTimer = setTimeout(() => $('toast').hidden = true, 3200); }
  const SUMMARY_CATEGORIES = [['food','食材'],['salary','工资'],['rent','房租'],['utilities','水电'],['flower','花卉'],['other','其他']];
  function categoryBreakdown(total) {
    const categories = SUMMARY_CATEGORIES.map(([code,label]) => s.data?.categoryTotals?.find(c => c.currency === s.currency && c.code === code) || {code,label,amountCents:0,recordCount:0,missingAmountCount:0});
    const hasNegative = categories.some(c => c.amountCents < 0);
    const allUnknown = total.recordCount > 0 && total.missingAmountCount === total.recordCount;
    const showShares = !hasNegative && !allUnknown && total.amountCents > 0;
    const share = c => showShares ? `${(c.amountCents / total.amountCents * 100).toFixed(1)}%` : hasNegative || allUnknown ? '—' : '0.0%';
    const bars = showShares ? categories.filter(c => c.amountCents > 0).map(c => `<span class="category-segment summary-category-${c.code}" data-share-cents="${c.amountCents}" title="${esc(c.label)} ${share(c)}"></span>`).join('') : '';
    return `<div class="category-breakdown" aria-label="报账类别金额与占比"><div class="category-share-bar" aria-hidden="true">${bars}</div><div class="category-legend">${categories.map(c => `<div class="category-legend-item summary-category-${c.code}"><div class="category-legend-heading"><span class="category-dot" aria-hidden="true"></span><span>${esc(c.label)}</span><span class="category-percent">${share(c)}</span></div><div class="category-legend-amount">${c.recordCount && c.missingAmountCount === c.recordCount ? '待确认' : `${esc(currencyLabel(s.currency))} ${money(c.amountCents)}`}</div>${c.missingAmountCount?`<span class="category-pending">${c.missingAmountCount} 笔待确认</span>`:''}</div>`).join('')}</div>${hasNegative?'<p class="category-share-note">含负数类别金额，暂不显示占比。</p>':''}</div>`;
  }
  function render() {
    const focus = document.activeElement, focusId = focus?.id, selection = focus?.tagName === 'INPUT' && focus.type === 'text' ? [focus.selectionStart, focus.selectionEnd] : null;
    const total = s.data?.totals.find(t => t.currency === s.currency) || { amountCents:0, recordCount:0, missingAmountCount:0, groupCount:0, projectCount:0 };
    const groups = filteredGroups(), filtered = Boolean(s.query.trim() || s.reporter);
    const title = s.options?.stores.find(store => store.id === s.store)?.name || '';
    const reporters = [...new Set([...(s.options?.reporters || []), ...(s.data?.groups || []).map(g=>g.reporter)])];
    $('app').innerHTML = `
      <section class="hero"><div><h1>月度支出报表</h1><p>按指定项目归类，按报账人汇总，每一笔都可追溯。</p></div><div class="month-control"><button data-action="prevMonth" aria-label="上个月" ${!s.options||s.month<=minMonth()?'disabled':''}>${icon('left')}</button><label>${icon('calendar')}<input id="month" type="month" min="${esc(minMonth())}" max="2199-12" aria-label="报表月份" value="${esc(s.month)}" ${!s.options?'disabled':''}></label><button data-action="nextMonth" aria-label="下个月" ${!s.options?'disabled':''}>${icon('right')}</button></div></section>
      <div class="storebar"><div class="store-tabs" aria-label="选择门店">${(s.options?.stores || []).map(store=>`<button data-store="${esc(store.id)}" aria-pressed="${store.id===s.store}">${esc(store.name)}</button>`).join('')}</div><span class="scope">${icon('store')}${s.data?.store.partial?'仅统计当前账号可见记录':'包含该门店各报账群'}</span></div>
      ${s.error?`<div class="report-error" role="alert"><p>${esc(s.error)}</p><button data-action="retry">重试</button> <a href="/expense">返回报账后台</a></div>`:''}
      <div id="reportRegion" aria-busy="${s.loading}">${s.loading?'<div class="empty" role="status">正在加载报表…</div>':!s.data?'<div class="empty">当前账号没有可查看的门店。</div>':`
      <section class="summary" aria-label="月度概览"><div class="summary-head"><div class="kicker"><span class="dot"></span>${esc(title)} · ${esc(s.month.replace('-',' 年 '))} 月${total.missingAmountCount?'已知金额合计':'报账总额'}</div><div class="big-amount"><span class="currency">${esc(currencyLabel(s.currency))}</span>${amount(total)}</div>${total.missingAmountCount?`<p class="amount-warning">${total.missingAmountCount} 笔金额或币种待确认，未纳入已知金额合计。</p>`:''}</div>${categoryBreakdown(total)}</section>
      ${s.data.store.partial?'<p class="scope-note">此报表仅包含当前账号有权查看的门店渠道和记录，可能不是整店全部报账。</p>':''}
      <section class="report"><div class="report-head"><div><h2>项目汇总</h2><p>先按报账人，再按指定项目顺序排列</p></div><button class="rules-link" data-action="rules">归类规则</button></div><div class="toolbar"><label class="search">${icon('search')}<input id="search" type="text" maxlength="200" aria-label="搜索项目或报账人" placeholder="搜索项目、报账人" value="${esc(s.query)}"></label><select id="reporter" aria-label="筛选报账人"><option value="">全部报账人</option>${reporters.map(name=>`<option ${name===s.reporter?'selected':''} value="${esc(name)}">${esc(name)}</option>`).join('')}</select>${s.data.totals.length>1?`<select id="currency" aria-label="选择币种">${s.data.totals.map(t=>`<option ${t.currency===s.currency?'selected':''}>${esc(t.currency)}</option>`).join('')}</select>`:''}<div class="result-count"><span>共 ${groups.length} 条汇总 · ${groups.reduce((n,g)=>n+g.recordCount,0)} 笔报账</span>${filtered?'<button class="clear" data-action="clear">清除筛选</button>':''}</div></div>
      ${groups.length?`<table class="project-table" aria-label="按报账人及项目顺序汇总"><thead><tr><th>项目</th><th>类别</th><th>报账人</th><th>报账笔数</th><th class="align-right">汇总金额（${esc(s.currency)}）</th><th><span class="sr-only">明细</span></th></tr></thead><tbody>${groups.map((g,i)=>`<tr data-group-row="${i}" class="${i>0&&groups[i-1].reporter!==g.reporter?'reporter-break':''}"><td class="supplier"><button data-group="${i}" >${esc(g.project)}</button></td><td class="desktop-category"><div class="category-tags">${g.categories.map(category).join('')}</div></td><td class="desktop-reporter">${reporterTag(g.reporter)}</td><td class="count"><span class="mobile-meta">${g.categories.map(category).join('')}<strong class="reporter-name">${esc(g.reporter)}</strong><span>·</span></span>${g.recordCount} 笔</td><td class="amount">${amount(g)}${g.missingAmountCount?`<small class="amount-warning">${g.missingAmountCount} 笔待确认</small>`:''}</td><td class="action-cell"><button class="detail-button" data-group="${i}" aria-label="查看${esc(g.reporter)}的${esc(g.project)}明细">${icon('right')}</button></td></tr>`).join('')}</tbody></table><div class="total-row"><span>${filtered?'筛选结果合计':'本月合计'}${groups.some(g=>g.missingAmountCount)?'（已知金额）':''}<span>${groups.length} 条汇总</span></span><strong>${esc(currencyLabel(s.currency))} ${groups.every(g=>g.missingAmountCount===g.recordCount)?'待确认':money(groups.reduce((n,g)=>n+g.amountCents,0))}</strong></div>`:`<div class="empty">${icon('receipt')}<h3>${filtered?'未找到符合条件的项目':'该月份暂无报账记录'}</h3>${filtered?'<button data-action="clear">清除筛选</button>':'<p>可切换月份或门店查看。</p>'}</div>`}</section>`}</div>
      <footer class="foot report-footer"><details><summary>统计口径：按创建时间归属月份</summary><p>按 ${esc(s.options?.timeZone || 'Asia/Shanghai')} 的创建时间月份统计。店长报账群的全部记录优先归入店长报账；花卉仅按类别归类；其余记录按 OCR 或备注命中指定项目，未命中时房租、水电、工资按类别兜底，每笔只计入一次。店长报账在汇总中显示为张志延，详情保留原始姓名。金额或币种缺失时单独提示，不同币种分开显示。</p></details><span class="demo">${esc(s.currency)}</span><button class="footer-export" data-action="export" ${!s.data||s.loading||!groups.length?'disabled':''}>${icon('download')}导出报表</button></footer>`;
    for (const segment of document.querySelectorAll('.category-segment')) segment.style.flexGrow = segment.dataset.shareCents;
    if (focusId && $(focusId)) { $(focusId).focus({preventScroll:true}); if (selection) $(focusId).setSelectionRange(...selection); }
  }
  async function loadSummary() {
    const serial = ++s.serial; s.abort?.abort(); s.abort = new AbortController(); s.loading = true; s.data = null; s.error = ''; render();
    try {
      const data = await json(`${API}?${params()}`,s.abort.signal); if(serial!==s.serial)return;
      s.data = data; if(!data.totals.some(t=>t.currency===s.currency))s.currency=data.totals[0]?.currency || 'CNY';
      const url = new URL(location.href); url.searchParams.set('month',s.month);url.searchParams.set('store',s.store);history.replaceState(null,'',url);
    } catch(error) { if(serial===s.serial&&error.name!=='AbortError')s.error=error.message; }
    finally { if(serial===s.serial){s.loading=false;render();} }
  }
  function closeDialog(id) { if((id==='sourceEditDialog'||id==='sourceReportDialog')&&s.sourceSaving)return; if($(id).open)$(id).close(); }
  function modalTop(title,id,label) { return `<div class="drawer-inner"><div class="drawer-top"><span>${esc(label)}</span><button class="icon-button" data-close="${id}" aria-label="关闭面板">${icon('close')}</button></div><h2 id="${id==='detailDialog'?'detailTitle':id==='rulesDialog'?'rulesTitle':'attachmentTitle'}">${esc(title)}</h2>`; }
  function showDialog(id) { $(id).showModal(); document.body.classList.add('dialog-open'); }
  function mobileDetailRecord(record) {
    const value = record.amount;
    const currency = String(record.currency || 'CNY').trim().toUpperCase();
    const number = value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value).toLocaleString('en-US', {minimumFractionDigits:2,maximumFractionDigits:2});
    const amountHtml = number === null ? '<span class="mobile-detail-amount is-missing">待复核</span>' : `<span class="mobile-detail-amount${number.length > 10 ? ' is-large' : ''}">${currency === 'CNY' ? '<small>¥</small>' : ''}<span>${esc(number)}</span>${currency === 'CNY' ? '' : `<small>${esc(currency)}</small>`}</span>`;
    const attachment = record.billAttachment;
    const attachmentHtml = s.canAttachment && attachment?.exists ? `<button class="mobile-detail-attachment" data-attachment="${attachment.id}" aria-label="查看${esc(record.reporter)}的附件"><img src="/expense/api/attachments/${attachment.id}/content" alt="${esc(record.reporter || '报账人')}的报账附件" loading="lazy"></button>` : `<span class="mobile-detail-unavailable">${!s.canAttachment ? '无附件权限' : attachment ? '已清理' : '无附件'}</span>`;
    return `<article class="mobile-detail-record" role="listitem" data-record-id="${record.id}"><div class="mobile-detail-heading"><div class="mobile-detail-identity"><strong><button class="record-detail-link" data-source-record="${record.id}" type="button">${esc(record.reporter || '未知')}</button></strong>${category({code:record.expenseCategory,label:record.expenseCategoryLabel})}</div>${amountHtml}</div><div class="mobile-detail-body"><div class="mobile-detail-copy"><div class="mobile-detail-note">${record.note?.trim() ? remark(record.note) : '<span class="mobile-detail-empty">暂无备注</span>'}</div><div class="mobile-detail-footer"><div class="mobile-detail-time">${createdAt(record.createdAt)}</div></div></div>${attachmentHtml}</div></article>`;
  }
  function renderDetail() {
    const g=s.group;if(!g)return;
    const focusOnLoadMore = document.activeElement?.matches('[data-action="more"]');
    $('detailDialog').innerHTML = modalTop(g.project,'detailDialog','项目汇总 / 报账详情')+`<div class="drawer-tags">${reporterTag(g.reporter)}${g.categories.map(category).join('')}</div><div class="drawer-summary"><div><label>${esc(s.data.store.name)} · ${esc(s.month)}</label><strong>${esc(currencyLabel(g.currency))} ${amount(g)}</strong></div><span>共 ${g.recordCount} 笔报账</span></div>${g.missingAmountCount?`<p class="amount-warning">${g.missingAmountCount} 笔金额待确认</p>`:''}${g.projectId==='manager'?'<div class="rule-note">店长报账统一归入张志延。以下报账人保留每笔记录的原始姓名。</div>':''}<div class="detail-heading"><b>报账记录</b><span>按创建时间排列</span></div>
      ${s.detailError?`<div class="report-error" role="alert">${esc(s.detailError)} <button data-action="more">重试</button></div>`:''}
      <div class="detail-table-scroll" tabindex="0" role="region" aria-label="报账记录六列表格，可横向滚动"><table class="detail-record-table" aria-label="报账记录"><thead><tr><th>创建时间</th><th>报账人</th><th>类别</th><th>备注</th><th>附件</th><th class="detail-amount-heading">金额</th></tr></thead><tbody>${s.details.map(r=>`<tr data-record-id="${r.id}"><td class="column-created-at"><button class="record-detail-link" data-source-record="${r.id}" type="button">${createdAt(r.createdAt)}</button></td><td class="detail-reporter">${reporterTag(r.reporter)}</td><td class="detail-category">${category({code:r.expenseCategory,label:r.expenseCategoryLabel})}</td><td class="note-cell">${remark(r.note)}</td><td class="column-bill">${!s.canAttachment?'<span class="bill-placeholder">无权限</span>':!r.billAttachment?'<span class="bill-placeholder">无</span>':!r.billAttachment.exists?'<span class="bill-placeholder warn">已清理</span>':`<button class="bill-link" data-attachment="${r.billAttachment.id}" aria-label="查看${esc(r.reporter)}的附件"><img src="/expense/api/attachments/${r.billAttachment.id}/content" alt="报账附件" loading="lazy"></button>`}</td><td class="detail-amount">${detailAmount(r)}</td></tr>`).join('')}</tbody></table></div>
      <div class="mobile-detail-list" role="list" aria-label="报账记录">${s.details.map(mobileDetailRecord).join('')}</div>
      ${s.detailLoading?'<p class="loading-line" role="status">正在加载记录…</p>':s.details.length<s.detailTotal&&!s.detailError?'<div class="load-more"><button data-action="more">加载更多记录</button></div>':''}<div class="drawer-foot">已显示 ${s.details.length} / ${s.detailTotal} 笔</div></div>`;
    if(focusOnLoadMore)$('detailDialog').querySelector('[data-action="more"]')?.focus({preventScroll:true});
  }
  async function loadDetails() {
    if(!s.group||s.detailLoading)return;
    const serial=++s.detailSerial,g=s.group;s.detailAbort?.abort();s.detailAbort=new AbortController();s.detailLoading=true;s.detailError='';renderDetail();
    try {
      const data=await json(`${API}/details?${params({projectId:g.projectId,reporter:g.reporter,currency:g.currency,offset:String(s.details.length),limit:'50'})}`,s.detailAbort.signal);
      if(serial!==s.detailSerial||!s.group)return;
      s.details.push(...data.items);s.detailTotal=data.total;s.canAttachment=data.canAttachment;
      s.attachments=s.details.filter(r=>data.canAttachment&&r.billAttachment?.exists).map(r=>({id:r.billAttachment.id,reporter:r.reporter}));
    }catch(error){if(serial===s.detailSerial&&error.name!=='AbortError')s.detailError=error.message;}
    finally{if(serial===s.detailSerial&&s.group){s.detailLoading=false;renderDetail();}}
  }
  function openDetail(index) {
    s.group=filteredGroups()[index];if(!s.group)return;
    s.details=[];s.detailTotal=s.group.recordCount;s.detailLoading=false;s.detailError='';s.attachments=[];s.canAttachment=s.options.canAttachment;renderDetail();showDialog('detailDialog');loadDetails();
  }
  function renderAttachment() {
    const a=s.attachments[s.attachmentIndex];if(!a)return;
    $('attachmentDialog').innerHTML=modalTop('附件预览','attachmentDialog','报账附件')+`<div class="attachment-preview-meta"><span>${esc(a.reporter)}</span><span>${s.attachmentIndex+1} / ${s.attachments.length}</span></div><div class="attachment-preview-stage"><button class="attachment-preview-nav previous" data-action="prevAttachment" aria-label="上一个附件" ${s.attachmentIndex===0?'disabled':''}>${icon('left')}</button><img src="/expense/api/attachments/${a.id}/content" alt="报账附件"><button class="attachment-preview-nav next" data-action="nextAttachment" aria-label="下一个附件" ${s.attachmentIndex===s.attachments.length-1?'disabled':''}>${icon('right')}</button></div><p class="attachment-error" role="alert" hidden>附件无法加载，可能已被清理或无权访问。</p></div>`;
    $('attachmentDialog').querySelector('img').addEventListener('error',()=>{$('attachmentDialog').querySelector('.attachment-error').hidden=false;});
  }
  function sourceShell(title, body) {
    return `<div class="detail-dialog"><div class="detail-grip"></div><div class="detail-topbar"><h2 id="sourceReportDialogTitle">${esc(title)}</h2><button id="sourceReportDialogClose" data-close="sourceReportDialog" aria-label="关闭报账详情">${icon('close')}</button></div><div class="detail-scroll" id="sourceReportScroll">${body}</div></div>`;
  }
  function paintSourceReport() {
    $('sourceReportDialog').innerHTML = sourceShell(`报账 #${s.sourceReport.id}`, window.ExpenseReportDetail.render(s.sourceReport, { timeZone:s.options.timeZone, canAttachment:s.sourceCanAttachment, canEdit:s.sourceCanEdit, canDelete:s.sourceCanDelete }));
  }
  async function openSourceReport(id) {
    if (!Number.isSafeInteger(id) || id <= 0) return;
    const serial = ++s.sourceSerial;
    s.sourceAbort?.abort();s.sourceAbort=new AbortController();s.sourceReport=null;s.sourceChanged=false;
    s.sourceReturnFocus=document.activeElement;
    $('sourceReportDialog').innerHTML=sourceShell(`报账 #${id}`,'<p class="detail-empty" role="status">正在加载报账详情…</p>');
    if(!$('sourceReportDialog').open)showDialog('sourceReportDialog');
    try {
      const [payload,session]=await Promise.all([json(`/expense/api/reports/${id}`,s.sourceAbort.signal),json('/expense/api/session',s.sourceAbort.signal)]);
      if(serial!==s.sourceSerial||!$('sourceReportDialog').open)return;
      s.sourceReport=payload.report;s.sourceCanAttachment=session.permissions?.canAttachment??true;s.sourceCanEdit=session.permissions?.canEdit??session.permissions?.canWrite===true;s.sourceCanDelete=(session.permissions?.canDelete??session.permissions?.canWrite===true)||session.permissions?.canDeleteSelf===true;
      paintSourceReport();$('sourceReportDialogClose').focus({preventScroll:true});
    }catch(error){if(serial===s.sourceSerial&&error.name!=='AbortError')$('sourceReportDialog').innerHTML=sourceShell(`报账 #${id}`,`<p class="detail-empty" role="alert">${esc(error.message)}</p>`);}
  }
  async function refreshAfterSourceEdit() {
    const previous=s.group;
    await loadSummary();
    if(!previous||s.group!==previous)return;
    const updated=s.data?.groups.find(g=>g.projectId===previous.projectId&&g.reporter===previous.reporter&&g.currency===previous.currency);
    if(!updated){closeDialog('detailDialog');return;}
    s.group=updated;s.details=[];s.detailTotal=updated.recordCount;s.detailLoading=false;s.detailError='';await loadDetails();
  }
  async function deleteSourceReport() {
    const report=s.sourceReport;
    if(!report||!s.sourceCanDelete||report.permissions?.canDelete!==true||s.sourceSaving)return;
    const amountText=report.amount==null?'待复核':`${Number(report.amount).toFixed(2)} ${report.currency||'CNY'}`;
    if(!window.confirm(`确认删除报账 #${report.id} 吗？\n报账人：${report.reporter||'未知'}\n金额：${amountText}\n此操作不可恢复。`))return;
    s.sourceSaving=true;
    const button=$('sourceReportDialog').querySelector('[data-detail-delete]');
    if(button){button.disabled=true;button.textContent='正在删除...';}
    $('sourceReportDialog').querySelector('[data-detail-edit]')?.setAttribute('disabled','');
    try {
      const response=await fetch(`/expense/api/reports/${report.id}`,{method:'DELETE',headers:{Accept:'application/json'}}),data=await response.json();
      if(!response.ok||!data.success)throw new Error(data.error?.message||'删除失败，请重试。');
      s.sourceChanged=true;s.sourceSaving=false;closeDialog('sourceReportDialog');notify(`已删除报账 #${report.id}`);
    }catch(error){
      s.sourceSaving=false;
      if($('sourceReportDialog').open&&s.sourceReport?.id===report.id){paintSourceReport();$('sourceReportDialog').querySelector('#detailDeleteStatus').textContent=error.message;}
    }finally{s.sourceSaving=false;}
  }
  async function openSourceEdit() {
    if(!s.sourceReport||!s.sourceCanEdit||s.sourceSaving)return;
    const serial=++s.editSerial,report=s.sourceReport;
    $('sourceEditDialog').innerHTML=`<div class="drawer-inner"><div class="drawer-top"><h2 id="sourceEditTitle">编辑报账 #${report.id}</h2><button data-close="sourceEditDialog" aria-label="关闭编辑">${icon('close')}</button></div><form id="sourceEditForm"><label>报账人<input id="sourceEditReporter" required autocomplete="off" placeholder="请输入报账人姓名" value="${esc(report.reporter||'')}"></label><div class="source-edit-grid"><label>金额（元）<input id="sourceEditAmount" type="number" step="any" placeholder="留空表示不修改" value="${esc(report.amount??'')}"></label><label>类别<select id="sourceEditCategory" required disabled><option value="">正在加载类别…</option></select></label></div><label>当前备注（只读）<div class="source-edit-note">${esc(report.note||'暂无备注')}</div></label><label>追加备注（选填）<textarea id="sourceEditNote" maxlength="1000" placeholder="仅追加，不覆盖已有备注"></textarea></label><p id="sourceEditStatus" role="status">正在加载类别…</p><div class="source-edit-actions"><button type="button" data-close="sourceEditDialog">取消</button><button id="sourceEditSave" class="primary" disabled>保存修改</button></div></form></div>`;
    showDialog('sourceEditDialog');
    try {
      const options=await json('/expense/api/edit-report-options');
      if(serial!==s.editSerial||!$('sourceEditDialog').open)return;
      $('sourceEditCategory').replaceChildren(new Option('请选择类别',''),...options.categories.map(c=>new Option(c.label,c.code)));
      if(report.expenseCategory&&![...$('sourceEditCategory').options].some(c=>c.value===report.expenseCategory))$('sourceEditCategory').add(new Option(report.expenseCategoryLabel||report.expenseCategory,report.expenseCategory));
      $('sourceEditCategory').value=report.expenseCategory;$('sourceEditCategory').disabled=false;$('sourceEditSave').disabled=false;$('sourceEditStatus').textContent='';
    }catch(error){if(serial===s.editSerial&&$('sourceEditDialog').open)$('sourceEditStatus').textContent=error.message;}
  }
  async function saveSourceEdit(event) {
    event.preventDefault();if(!s.sourceReport||!s.sourceCanEdit||s.sourceSaving||$('sourceEditSave').disabled)return;
    const report=s.sourceReport,patch={updatedAt:report.updatedAt},reporter=$('sourceEditReporter').value.trim(),amountText=$('sourceEditAmount').value.trim(),categoryValue=$('sourceEditCategory').value,note=$('sourceEditNote').value.trim();
    if(!reporter){$('sourceEditStatus').textContent='报账人不能为空。';return;}
    if(reporter!==report.reporter)patch.reporter=reporter;
    if(amountText){const value=Number(amountText);if(!Number.isFinite(value)){$('sourceEditStatus').textContent='金额必须是有效数字。';return;}if(report.amount==null||value!==Number(report.amount))patch.amount=value;}
    if(categoryValue&&categoryValue!==report.expenseCategory)patch.expenseCategory=categoryValue;
    if(note)patch.noteToAppend=note;
    if(Object.keys(patch).length===1){$('sourceEditStatus').textContent='没有需要保存的修改。';return;}
    s.sourceSaving=true;$('sourceEditSave').disabled=true;$('sourceEditStatus').textContent='正在保存…';
    try {
      const response=await fetch(`/expense/api/reports/${report.id}`,{method:'PATCH',headers:{Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify(patch)}),data=await response.json();
      if(!response.ok||!data.success)throw new Error(data.error?.message||'保存失败，请重新打开详情后重试。');
      s.sourceReport={...report,...data.report,expenseCategoryLabel:$('sourceEditCategory').selectedOptions[0]?.textContent||report.expenseCategoryLabel};s.sourceChanged=true;s.sourceSaving=false;closeDialog('sourceEditDialog');paintSourceReport();notify('报账已更新，关闭详情后刷新月报。');
    }catch(error){$('sourceEditStatus').textContent=error.message;}finally{s.sourceSaving=false;if($('sourceEditSave'))$('sourceEditSave').disabled=false;}
  }

  function rules() {
    const list=s.options.projects;
    $('rulesDialog').innerHTML=modalTop('项目归类规则','rulesDialog','项目名称与固定顺序')+`<p class="rules-intro">店长报账仅按来源渠道归类；花卉仅按类别识别；其他项目按指定字样匹配，并按类别兜底。每位报账人名下，项目按以下顺序显示。</p><ol class="rules-list">${list.map(p=>`<li><b>${esc(p.name)}</b><p>${esc(p.description)}</p><div class="keywords">${p.keywords.map(k=>`<span>${esc(k)}</span>`).join('')}</div></li>`).join('')}</ol><section class="rule-note"><b>冲突与兜底</b><p>来源为店长报账群的记录优先合并，不以 OCR、备注或类别识别店长报账；花卉类别优先于字样匹配，宿舍房租优先于房租。其他多个项目命中，按上方顺序归入第一个。</p><p>未命中指定项目时，房租、水电、工资按类别兜底，食材归入其他食材，其余归入其他项目。每笔只计入一次。</p></section><section class="rule-note"><b>固定排序</b><p>${s.options.reporters.map(esc).join(' → ')} → 其他报账人；每人名下再按项目顺序排列。</p><p>店长报账在汇总中显示为张志延，原始姓名不变。不同类别可合并到同一项目，类别作为信息保留。</p></section></div>`;showDialog('rulesDialog');
  }
  async function exportReport(button) {
    button.disabled=true;
    const filename=`${s.data.store.name}-${s.month}-项目报表.csv`;
    try {
      const response=await fetch(`${API}/export?${params({currency:s.currency,reporter:s.reporter,q:s.query.trim()})}`);
      if(!response.ok||!response.headers.get('content-type')?.includes('text/csv'))throw new Error('导出失败，请确认当前账号权限后重试。');
      const blob=await response.blob(),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);notify('已按报账人、项目顺序导出报表。');
    }catch(error){notify(error.message);}finally{button.disabled=false;}
  }
  async function init() {
    s.loading=true;s.error='';render();
    try {
      s.options=await json(`${API}/options`);const url=new URL(location.href);
      const requestedMonth=url.searchParams.get('month');
      s.month=allowedMonth(requestedMonth)?requestedMonth:s.options.defaultMonth;
      s.store=s.options.stores.some(store=>store.id===url.searchParams.get('store'))?url.searchParams.get('store'):s.options.stores[0]?.id||'';
      if(s.store)await loadSummary();else{s.loading=false;render();}
    }catch(error){s.loading=false;s.error=error.message;render();}
  }
  document.addEventListener('input',e=>{if(e.target.id==='search'){s.query=e.target.value;render();}});
  document.addEventListener('change',e=>{
    if(e.target.id==='month'){
      if(!allowedMonth(e.target.value)){e.target.value=s.month;notify('仅支持选择 2026 年 9 月及之后的月份。');return;}
      s.month=e.target.value;clearFilters();loadSummary();
    }
    if(e.target.id==='reporter'){s.reporter=e.target.value;render();}
    if(e.target.id==='currency'){s.currency=e.target.value;render();}
  });
  document.addEventListener('click',e=>{
    const target=e.target.closest('button');
    if (!target) {
      if (e.target.closest('a,input,select,textarea') || window.getSelection()?.toString()) return;
      const record = e.target.closest('[data-record-id]');
      if (record) {
        const id = Number(record.dataset.recordId);
        if (Number.isSafeInteger(id) && id > 0) {
          void openSourceReport(id);
        }
        return;
      }
      const row = e.target.closest('[data-group-row]');
      if (row) openDetail(Number(row.dataset.groupRow));
      return;
    }
    if(target.disabled)return;
    if(target.dataset.sourceRecord){void openSourceReport(Number(target.dataset.sourceRecord));return;}
    if(target.hasAttribute('data-detail-delete')){void deleteSourceReport();return;}
    if(target.hasAttribute('data-detail-edit')){void openSourceEdit();return;}
    if(target.hasAttribute('data-detail-attachments')){const section=$('sourceReportDialog').querySelector('#detailSources');if(section){section.open=true;section.scrollIntoView({block:'start'});}return;}
    if(target.dataset.close){closeDialog(target.dataset.close);return;}
    if(target.dataset.store){s.store=target.dataset.store;clearFilters();loadSummary();return;}
    if(target.dataset.group!==undefined){openDetail(Number(target.dataset.group));return;}
    if(target.dataset.attachment){s.attachmentIndex=s.attachments.findIndex(a=>a.id===Number(target.dataset.attachment));if(s.attachmentIndex>=0){s.attachmentFocus=target;renderAttachment();showDialog('attachmentDialog');}return;}
    switch(target.dataset.action){
      case 'theme':{const theme=currentTheme()==='light'?'dark':'light';setTheme(theme);try{localStorage.setItem('comeover-admin-theme',theme);localStorage.setItem('reimbursement-admin-theme',theme);}catch{}render();break;}
      case 'prevMonth':case 'nextMonth':{const [y,m]=s.month.split('-').map(Number),date=new Date(y,m-1+(target.dataset.action==='prevMonth'?-1:1),1),month=`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}`;if(!allowedMonth(month))return;s.month=month;clearFilters();loadSummary();break;}
      case 'clear':clearFilters();render();break;
      case 'rules':rules();break;
      case 'retry':s.options&&s.store?loadSummary():init();break;
      case 'more':loadDetails();break;
      case 'export':exportReport(target);break;
      case 'prevAttachment':s.attachmentIndex--;renderAttachment();break;
      case 'nextAttachment':s.attachmentIndex++;renderAttachment();break;
    }
  });
  document.addEventListener('submit',event=>{if(event.target.id==='sourceEditForm')void saveSourceEdit(event);});
  for(const id of ['detailDialog','rulesDialog','attachmentDialog','sourceReportDialog','sourceEditDialog']){
    $(id).addEventListener('cancel',event=>{if((id==='sourceEditDialog'||id==='sourceReportDialog')&&s.sourceSaving)event.preventDefault();});
    $(id).addEventListener('click',e=>{if(e.target===$(id)){if(id==='sourceReportDialog'){closeDialog(id);return;}const r=$(id).getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closeDialog(id);}});
    $(id).addEventListener('close',()=>{
      if(id==='sourceReportDialog'){s.sourceSerial++;s.sourceAbort?.abort();const changed=s.sourceChanged;s.sourceChanged=false;s.sourceReport=null;closeDialog('sourceEditDialog');s.sourceReturnFocus?.focus({preventScroll:true});if(changed)void refreshAfterSourceEdit();}
      if(id==='sourceEditDialog'){s.editSerial++;if($('sourceReportDialog').open)$('sourceReportDialog').querySelector('[data-detail-edit]')?.focus({preventScroll:true});}
      if(id==='detailDialog'){s.group=null;s.detailSerial++;s.detailAbort?.abort();s.detailLoading=false;closeDialog('attachmentDialog');closeDialog('sourceReportDialog');}
      if(id==='attachmentDialog'&&$('detailDialog').open)s.attachmentFocus?.focus({preventScroll:true});
      if(!document.querySelector('dialog[open]'))document.body.classList.remove('dialog-open');
    });
  }
  init();
})();
