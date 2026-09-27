/* Desktop design study of /expense, based on src/admin/public/admin.html (2026-09-27).
   Scope: three desktop filter layouts, existing tokens and compound-input grammar.
   All records are fictional. No API requests, authentication, writes or uploads. */
const {
  useState,
  useEffect,
  useRef
} = React;
const variant = document.body.dataset.variant || 'a';
const base = {
  store: '',
  from: '2026-09-01',
  to: '2026-09-27',
  search: '',
  reporter: '',
  category: '',
  note: ''
};
const extraKeys = ['search', 'reporter', 'category', 'note'];
const labels = {
  search: '关键词 / 报账 ID',
  reporter: '报账人',
  category: '类别',
  note: '备注'
};
const shortLabels = {
  search: '关键词',
  reporter: '报账人',
  category: '类别',
  note: '备注'
};
const hints = {
  search: '关键词 / 报账 ID',
  reporter: '如 张||李',
  category: '如 食材||房租',
  note: '如 采购&!平'
};
const stores = ['Fuzzy', 'Fuzzy店长报账群', 'Peanut', 'Peanut店长报账群', 'Fuzzy泉州店', 'Fuzzy泉州店长报账群'];
const demoRecords = [{
  id: '26092701',
  store: 'Fuzzy',
  reporter: '林晓',
  category: '食材',
  amount: 328.50,
  note: '日常食材采购',
  date: '2026-09-27',
  time: '09:42',
  files: 2
}, {
  id: '26092702',
  store: 'Peanut',
  reporter: '陈悦',
  category: '其他',
  amount: 86,
  note: '日用品补充',
  date: '2026-09-27',
  time: '08:36',
  files: 1
}, {
  id: '26092601',
  store: 'Fuzzy泉州店',
  reporter: '李宁',
  category: '食材',
  amount: 216.80,
  note: '蔬菜采购 农',
  date: '2026-09-26',
  time: '17:20',
  files: 1
}, {
  id: '26092501',
  store: 'Fuzzy',
  reporter: '张晨',
  category: '房租',
  amount: 6500,
  note: '九月门店房租',
  date: '2026-09-25',
  time: '14:08',
  files: 1
}, {
  id: '26092001',
  store: 'Peanut',
  reporter: '张晨',
  category: '食材',
  amount: 152,
  note: '调料采购 平',
  date: '2026-09-20',
  time: '10:30',
  files: 2
}, {
  id: '26091801',
  store: 'Fuzzy泉州店',
  reporter: '李宁',
  category: '其他',
  amount: 45,
  note: '补票 待确认',
  date: '2026-09-18',
  time: '12:06',
  files: 1
}];
function CalendarIcon() {
  return /*#__PURE__*/React.createElement("svg", {
    className: "icon",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.7",
    "aria-hidden": "true"
  }, /*#__PURE__*/React.createElement("rect", {
    x: "3",
    y: "5",
    width: "18",
    height: "16",
    rx: "3"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M7 3v4M17 3v4M3 11h18"
  }));
}
function Chevron() {
  return /*#__PURE__*/React.createElement("i", {
    className: "chevron",
    "aria-hidden": "true"
  });
}
function Count({
  value
}) {
  return value > 0 ? /*#__PURE__*/React.createElement("span", {
    className: "count"
  }, value) : null;
}
function ExprHelp() {
  return /*#__PURE__*/React.createElement("p", {
    className: "expression-help"
  }, /*#__PURE__*/React.createElement("code", null, "!"), " \u6392\u9664 \xB7 ", /*#__PURE__*/React.createElement("code", null, "&"), " \u540C\u65F6\u6EE1\u8DB3 \xB7 ", /*#__PURE__*/React.createElement("code", null, "||"), " \u4EFB\u4E00\u6EE1\u8DB3");
}
function parseExpr(value, key) {
  if (!value.trim()) return null;
  if (/[()（）]/.test(value) || value.replaceAll('||', '').includes('|')) throw Error(`${labels[key]}：请使用 !、&、|| 组合条件`);
  return value.split('||').map(group => group.split('&').map(term => {
    const clean = term.trim(),
      exclude = clean.startsWith('!'),
      token = (exclude ? clean.slice(1) : clean).trim();
    if (!token || token.includes('!')) throw Error(`${labels[key]}：请补全筛选条件`);
    if (key === 'category' && !['食材', '房租', '水电', '工资', '其他', 'food', 'rent', 'utilities', 'salary', 'other'].includes(token)) throw Error('类别：请输入有效类别，如 食材、房租、其他');
    return {
      exclude,
      token
    };
  }));
}
function matches(value, expr, key) {
  if (!expr) return true;
  return expr.some(group => group.every(({
    exclude,
    token
  }) => {
    const aliases = {
      food: '食材',
      rent: '房租',
      utilities: '水电',
      salary: '工资',
      other: '其他'
    };
    const found = key === 'category' ? value === (aliases[token] || token) : value.toLowerCase().includes(token.toLowerCase());
    return exclude ? !found : found;
  }));
}
function getRecords(filters) {
  const parsed = Object.fromEntries(['reporter', 'category', 'note'].map(key => [key, parseExpr(filters[key], key)]));
  return demoRecords.filter(r => (!filters.store || r.store === filters.store) && (!filters.from || r.date >= filters.from) && (!filters.to || r.date <= filters.to) && (!filters.search || Object.values(r).join(' ').toLowerCase().includes(filters.search.toLowerCase())) && ['reporter', 'category', 'note'].every(key => matches(r[key], parsed[key], key)));
}
function dateLabel(from, to, compact = false) {
  const format = v => v.replaceAll('-', '/');
  if (!from && !to) return '不限日期';
  if (from && to) return compact && from.slice(0, 4) === to.slice(0, 4) ? `${format(from)} — ${format(to).slice(5)}` : `${format(from)} — ${format(to)}`;
  return from ? `${format(from)} 起` : `截至 ${format(to)}`;
}
function Modal({
  open,
  onClose,
  title,
  sheet = false,
  children
}) {
  const ref = useRef(null),
    closeRef = useRef(onClose),
    titleId = React.useId();
  closeRef.current = onClose;
  useEffect(() => {
    const d = ref.current;
    if (open) {
      d.showModal();
      const old = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        d.close();
        document.body.style.overflow = old;
      };
    }
  }, [open]);
  return /*#__PURE__*/React.createElement("dialog", {
    ref: ref,
    className: sheet ? 'sheet' : '',
    "aria-labelledby": titleId,
    onCancel: e => {
      e.preventDefault();
      closeRef.current();
    },
    onClick: e => {
      if (e.target === ref.current) {
        const b = ref.current.getBoundingClientRect();
        if (e.clientX < b.left || e.clientX > b.right || e.clientY < b.top || e.clientY > b.bottom) closeRef.current();
      }
    }
  }, sheet && /*#__PURE__*/React.createElement("div", {
    className: "sheet-handle"
  }), /*#__PURE__*/React.createElement("div", {
    className: "dialog-heading"
  }, /*#__PURE__*/React.createElement("h2", {
    id: titleId
  }, title), /*#__PURE__*/React.createElement("button", {
    className: "icon-button",
    "aria-label": "\u5173\u95ED",
    onClick: onClose
  }, "\xD7")), children);
}
function DatePicker({
  open,
  value,
  onClose,
  onApply
}) {
  const [range, setRange] = useState({
    from: value.from,
    to: value.to
  });
  const [month, setMonth] = useState('2026-09');
  useEffect(() => {
    if (open) {
      setRange({
        from: value.from,
        to: value.to
      });
      setMonth((value.from || '2026-09').slice(0, 7));
    }
  }, [open]);
  const [year, mo] = month.split('-').map(Number);
  const count = new Date(year, mo, 0).getDate(),
    offset = (new Date(year, mo - 1, 1).getDay() + 6) % 7;
  const move = n => {
    const d = new Date(year, mo - 1 + n, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  };
  function choose(date) {
    if (!range.from || range.to) setRange({
      from: date,
      to: ''
    });else setRange({
      from: date < range.from ? date : range.from,
      to: date < range.from ? range.from : date
    });
  }
  function preset(kind) {
    const ranges = {
      today: ['2026-09-27', '2026-09-27'],
      week: ['2026-09-21', '2026-09-27'],
      month: ['2026-09-01', '2026-09-30'],
      last: ['2026-08-01', '2026-08-31']
    };
    const [from, to] = ranges[kind];
    setRange({
      from,
      to
    });
    setMonth(from.slice(0, 7));
  }
  return /*#__PURE__*/React.createElement(Modal, {
    open: open,
    onClose: onClose,
    title: "\u9009\u62E9\u521B\u5EFA\u65E5\u671F"
  }, /*#__PURE__*/React.createElement("div", {
    className: "date-body"
  }, /*#__PURE__*/React.createElement("div", {
    className: "shortcuts"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => preset('today')
  }, "\u4ECA\u5929"), /*#__PURE__*/React.createElement("button", {
    onClick: () => preset('week')
  }, "\u8FD1 7 \u5929"), /*#__PURE__*/React.createElement("button", {
    onClick: () => preset('month')
  }, "\u672C\u6708"), /*#__PURE__*/React.createElement("button", {
    onClick: () => preset('last')
  }, "\u4E0A\u6708")), /*#__PURE__*/React.createElement("div", {
    className: "calendar-heading"
  }, /*#__PURE__*/React.createElement("button", {
    className: "icon-button",
    "aria-label": "\u4E0A\u4E2A\u6708",
    onClick: () => move(-1)
  }, "\u2039"), /*#__PURE__*/React.createElement("strong", null, year, " \u5E74 ", mo, " \u6708"), /*#__PURE__*/React.createElement("button", {
    className: "icon-button",
    "aria-label": "\u4E0B\u4E2A\u6708",
    onClick: () => move(1)
  }, "\u203A")), /*#__PURE__*/React.createElement("div", {
    className: "calendar-week"
  }, ['一', '二', '三', '四', '五', '六', '日'].map(d => /*#__PURE__*/React.createElement("span", {
    key: d
  }, d))), /*#__PURE__*/React.createElement("div", {
    className: "calendar-days"
  }, Array.from({
    length: offset
  }, (_, i) => /*#__PURE__*/React.createElement("span", {
    key: `blank-${i}`
  })), Array.from({
    length: count
  }, (_, i) => {
    const date = `${month}-${String(i + 1).padStart(2, '0')}`,
      selected = date === range.from || date === range.to,
      between = range.from && range.to && date > range.from && date < range.to;
    return /*#__PURE__*/React.createElement("button", {
      key: date,
      "aria-label": date,
      "aria-pressed": selected,
      className: selected ? 'selected' : between ? 'between' : '',
      onClick: () => choose(date)
    }, i + 1);
  })), /*#__PURE__*/React.createElement("div", {
    className: "date-draft",
    "aria-live": "polite"
  }, dateLabel(range.from, range.to)), /*#__PURE__*/React.createElement("p", {
    className: "date-instruction"
  }, range.from && !range.to ? '再选一天作为结束日期' : '依次选择开始日期和结束日期')), /*#__PURE__*/React.createElement("div", {
    className: "date-bottom"
  }, /*#__PURE__*/React.createElement("button", {
    className: "text-button",
    onClick: () => onApply({
      from: '',
      to: ''
    })
  }, "\u4E0D\u9650\u65E5\u671F"), /*#__PURE__*/React.createElement("button", {
    onClick: onClose
  }, "\u53D6\u6D88"), /*#__PURE__*/React.createElement("button", {
    className: "primary",
    disabled: !range.from || !range.to,
    onClick: () => onApply(range)
  }, "\u5E94\u7528\u65E5\u671F")));
}
function Field({
  name,
  value,
  onChange
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: `field field-${name} ${name === 'search' || name === 'note' ? 'wide' : ''}`
  }, /*#__PURE__*/React.createElement("label", {
    htmlFor: `field-${name}`
  }, labels[name]), /*#__PURE__*/React.createElement("input", {
    id: `field-${name}`,
    name: name,
    value: value,
    autoComplete: "off",
    placeholder: hints[name],
    onChange: e => onChange(name, e.target.value)
  }));
}
function ExtraFields({
  values,
  onChange
}) {
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(Field, {
    name: "search",
    value: values.search,
    onChange: onChange
  }), /*#__PURE__*/React.createElement(Field, {
    name: "reporter",
    value: values.reporter,
    onChange: onChange
  }), /*#__PURE__*/React.createElement(Field, {
    name: "category",
    value: values.category,
    onChange: onChange
  }), /*#__PURE__*/React.createElement(Field, {
    name: "note",
    value: values.note,
    onChange: onChange
  }));
}
function DesktopApp() {
  const [draft, setDraft] = useState({
      ...base
    }),
    [applied, setApplied] = useState({
      ...base
    }),
    [expanded, setExpanded] = useState(false),
    [dateOpen, setDateOpen] = useState(false),
    [error, setError] = useState(''),
    [toast, setToast] = useState(''),
    [detail, setDetail] = useState(null);
  const [theme, setTheme] = useState(new URLSearchParams(location.search).get('theme') || 'light');
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    const handler = e => {
      if (e.origin !== location.origin) return;
      switch (e.data?.type) {
        case 'desktop-theme':
          setTheme(e.data.theme);
          break;
        case 'desktop-example':
          {
            const sample = {
              ...base,
              reporter: '张||李',
              category: '食材||房租',
              note: '!平'
            };
            setDraft(sample);
            setApplied(sample);
            setError('');
            setExpanded(false);
            break;
          }
        case 'desktop-reset':
          reset();
          break;
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 2200);
    return () => clearTimeout(timer);
  }, [toast]);
  const records = getRecords(applied),
    total = records.reduce((n, r) => n + r.amount, 0),
    active = extraKeys.filter(k => applied[k]),
    draftCount = extraKeys.filter(k => draft[k].trim()).length;
  function update(key, value) {
    setDraft(v => ({
      ...v,
      [key]: value
    }));
    setError('');
  }
  function apply(next = draft) {
    try {
      getRecords(next);
      setDraft({
        ...next
      });
      setApplied({
        ...next
      });
      setError('');
      setExpanded(false);
    } catch (e) {
      setError(e.message);
      setExpanded(true);
    }
  }
  function reset() {
    setDraft({
      ...base
    });
    setApplied({
      ...base
    });
    setExpanded(false);
    setError('');
  }
  function clear(key) {
    setDraft(v => ({
      ...v,
      [key]: ''
    }));
    setApplied(v => ({
      ...v,
      [key]: ''
    }));
    setError('');
  }
  const fields = /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(Field, {
    name: "search",
    value: draft.search,
    onChange: update
  }), /*#__PURE__*/React.createElement(Field, {
    name: "reporter",
    value: draft.reporter,
    onChange: update
  }), /*#__PURE__*/React.createElement(Field, {
    name: "category",
    value: draft.category,
    onChange: update
  }), /*#__PURE__*/React.createElement(Field, {
    name: "note",
    value: draft.note,
    onChange: update
  }));
  const actions = /*#__PURE__*/React.createElement("div", {
    className: "desktop-actions"
  }, /*#__PURE__*/React.createElement("button", {
    className: "primary",
    type: "submit"
  }, "\u67E5\u8BE2"), /*#__PURE__*/React.createElement("button", {
    className: "reset",
    type: "button",
    onClick: reset
  }, "\u91CD\u7F6E"));
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("nav", {
    className: "topbar desk-topbar"
  }, /*#__PURE__*/React.createElement("div", {
    className: "brand"
  }, /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 32 32",
    "aria-hidden": "true",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2.2",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, /*#__PURE__*/React.createElement("rect", {
    x: "5",
    y: "7",
    width: "22",
    height: "19",
    rx: "4",
    fill: "currentColor",
    fillOpacity: ".16"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M8 7V5.5A2.5 2.5 0 0 1 10.5 3H22M10 13h8m-6 4 2.2 2.2 3.5-3.7"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "24",
    cy: "24",
    r: "4",
    fill: "currentColor",
    stroke: "none"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M24 22v4M22 24h4",
    stroke: "white",
    strokeWidth: "1.8"
  })), /*#__PURE__*/React.createElement("span", null, "\u62A5\u8D26\u4E2D\u5FC3")), /*#__PURE__*/React.createElement("div", {
    className: "top-actions"
  }, /*#__PURE__*/React.createElement("button", {
    "aria-label": "\u5207\u6362\u4E3B\u9898",
    onClick: () => setTheme(theme === 'light' ? 'dark' : 'light')
  }, theme === 'light' ? '◐' : '◑'), /*#__PURE__*/React.createElement("button", {
    onClick: () => setToast('设计预览，不会退出实际账号')
  }, "\u9000\u51FA\u767B\u5F55"))), /*#__PURE__*/React.createElement("main", {
    className: `desk-page design-${variant}`,
    "data-screen-label": `桌面方案 ${variant.toUpperCase()}`
  }, /*#__PURE__*/React.createElement("header", {
    className: "desk-hero"
  }, /*#__PURE__*/React.createElement("h1", null, "\u62A5\u8D26\u67E5\u770B\u540E\u53F0"), /*#__PURE__*/React.createElement("p", null, "\u67E5\u770B\u5DF2\u5165\u5E93\u7684\u62A5\u8D26\u8BB0\u5F55\uFF0C\u6309\u95E8\u5E97\u3001\u62A5\u8D26\u4EBA\u3001\u7C7B\u522B\u3001\u65E5\u671F\u548C\u5907\u6CE8\u6587\u5B57\u7B5B\u9009\uFF0C\u5E76\u5C55\u5F00\u8BE6\u60C5\u67E5\u770B OCR\u3001\u539F\u59CB\u6D88\u606F\u3001\u9644\u4EF6\u548C\u56DE\u6267\u8BB0\u5F55\u3002"), /*#__PURE__*/React.createElement("div", {
    className: "hero-actions"
  }, /*#__PURE__*/React.createElement("button", {
    className: "primary",
    onClick: () => setToast('本次预览聚焦筛选模块')
  }, "\u624B\u5DE5\u8865\u5F55"), /*#__PURE__*/React.createElement("button", {
    className: "primary",
    onClick: () => setToast('本次预览聚焦筛选模块')
  }, "\u6279\u91CF\u8865\u5F55"))), /*#__PURE__*/React.createElement("section", {
    className: "desk-filters",
    "aria-label": "\u7B5B\u9009\u62A5\u8D26"
  }, /*#__PURE__*/React.createElement("form", {
    onSubmit: e => {
      e.preventDefault();
      apply();
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "desktop-grid"
  }, /*#__PURE__*/React.createElement("div", {
    className: "field store-field"
  }, /*#__PURE__*/React.createElement("label", {
    htmlFor: "store"
  }, "\u95E8\u5E97"), /*#__PURE__*/React.createElement("select", {
    id: "store",
    value: draft.store,
    onChange: e => update('store', e.target.value)
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "\u5168\u90E8\u95E8\u5E97"), stores.map(store => /*#__PURE__*/React.createElement("option", {
    key: store
  }, store)))), /*#__PURE__*/React.createElement("div", {
    className: "field date-field"
  }, /*#__PURE__*/React.createElement("label", {
    htmlFor: "created-date"
  }, "\u521B\u5EFA\u65E5\u671F"), /*#__PURE__*/React.createElement("button", {
    id: "created-date",
    className: "date-trigger",
    type: "button",
    "aria-haspopup": "dialog",
    "aria-expanded": dateOpen,
    onClick: () => setDateOpen(true)
  }, /*#__PURE__*/React.createElement("span", null, dateLabel(draft.from, draft.to)), /*#__PURE__*/React.createElement(CalendarIcon, null))), variant === 'b' ? /*#__PURE__*/React.createElement("button", {
    className: "more-desktop",
    type: "button",
    "aria-expanded": expanded,
    "aria-controls": "secondary-fields",
    onClick: () => setExpanded(v => !v)
  }, "\u66F4\u591A\u6761\u4EF6", /*#__PURE__*/React.createElement(Count, {
    value: draftCount
  }), /*#__PURE__*/React.createElement(Chevron, null)) : fields, actions), variant === 'b' && /*#__PURE__*/React.createElement("div", {
    id: "secondary-fields",
    className: "secondary-grid",
    hidden: !expanded,
    style: !expanded ? {
      display: 'none'
    } : undefined
  }, fields), error && /*#__PURE__*/React.createElement("p", {
    role: "alert",
    className: "error"
  }, error)), active.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "desktop-chips",
    "aria-label": "\u5DF2\u751F\u6548\u7684\u6761\u4EF6"
  }, active.map(key => /*#__PURE__*/React.createElement("button", {
    key: key,
    onClick: () => clear(key),
    "aria-label": `移除${shortLabels[key]}条件`,
    title: `${shortLabels[key]}：${applied[key]}`
  }, /*#__PURE__*/React.createElement("span", null, shortLabels[key], "\uFF1A", applied[key]), /*#__PURE__*/React.createElement("span", {
    "aria-hidden": "true"
  }, "\xD7")))), /*#__PURE__*/React.createElement("div", {
    className: "filter-foot"
  }, /*#__PURE__*/React.createElement("span", {
    className: "result-status",
    role: "status",
    "aria-live": "polite"
  }, "\u5DF2\u52A0\u8F7D ", records.length, " \u6761\u8BB0\u5F55\uFF0C\u603B\u8BA1\u91D1\u989D ", total.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }), " \u5143"), variant === 'b' && !expanded ? /*#__PURE__*/React.createElement("span", {
    className: "scope-help"
  }, active.length ? `已应用 ${active.length} 项更多条件` : '更多条件：关键词、报账人、类别、备注') : /*#__PURE__*/React.createElement(ExprHelp, null))), /*#__PURE__*/React.createElement("section", {
    className: "panel desk-records",
    "aria-label": "\u62A5\u8D26\u8BB0\u5F55"
  }, /*#__PURE__*/React.createElement("div", {
    className: "table-overflow"
  }, /*#__PURE__*/React.createElement("table", {
    className: "desk-table"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "\u95E8\u5E97"), /*#__PURE__*/React.createElement("th", null, "\u521B\u5EFA\u65F6\u95F4"), /*#__PURE__*/React.createElement("th", null, "\u62A5\u8D26\u4EBA"), /*#__PURE__*/React.createElement("th", null, "\u91D1\u989D"), /*#__PURE__*/React.createElement("th", null, "\u7C7B\u522B"), /*#__PURE__*/React.createElement("th", null, "\u5907\u6CE8"), /*#__PURE__*/React.createElement("th", null, "\u9644\u4EF6"), /*#__PURE__*/React.createElement("th", null, "\u9700\u590D\u6838"), /*#__PURE__*/React.createElement("th", null, "\u66F4\u65B0\u65F6\u95F4"), /*#__PURE__*/React.createElement("th", null, "\u62A5\u8D26 ID"))), /*#__PURE__*/React.createElement("tbody", null, records.map(r => /*#__PURE__*/React.createElement("tr", {
    key: r.id
  }, /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("span", {
    className: "store-name"
  }, r.store)), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("time", null, r.date.slice(5).replace('-', '/'), /*#__PURE__*/React.createElement("small", null, r.time))), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("span", {
    className: "tag reporter-tag"
  }, r.reporter)), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("span", {
    className: "money"
  }, /*#__PURE__*/React.createElement("small", null, "\xA5"), r.amount.toLocaleString('en-US', {
    minimumFractionDigits: 2
  }))), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("span", {
    className: `tag ${r.category === '房租' ? 'rent' : r.category === '其他' ? 'other' : ''}`
  }, r.category)), /*#__PURE__*/React.createElement("td", {
    className: "remark"
  }, r.note), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("button", {
    className: "bill-button",
    onClick: () => setToast('示例记录，不包含真实附件')
  }, "\u67E5\u770B\u9644\u4EF6")), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("span", {
    className: "confirmed"
  }, "\u2713 \u5DF2\u786E\u8BA4")), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("time", null, r.date.slice(5).replace('-', '/'), /*#__PURE__*/React.createElement("small", null, r.time))), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("button", {
    className: "id-button",
    onClick: () => setDetail(r)
  }, "#", r.id.slice(-4)))))))), records.length === 0 && /*#__PURE__*/React.createElement("div", {
    className: "empty"
  }, "\u6CA1\u6709\u5339\u914D\u7684\u62A5\u8D26\u8BB0\u5F55\u3002", /*#__PURE__*/React.createElement("button", {
    className: "text-button",
    onClick: reset
  }, "\u91CD\u7F6E\u7B5B\u9009")), /*#__PURE__*/React.createElement("div", {
    className: "desk-pagination"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", null, records.length ? `1 – ${records.length}` : '0 – 0', " / ", records.length), /*#__PURE__*/React.createElement("span", null, "\u6BCF\u9875"), /*#__PURE__*/React.createElement("select", {
    "aria-label": "\u6BCF\u9875\u6761\u6570",
    defaultValue: "200",
    onChange: () => setToast('预览只有 6 条示例记录')
  }, /*#__PURE__*/React.createElement("option", null, "20"), /*#__PURE__*/React.createElement("option", null, "50"), /*#__PURE__*/React.createElement("option", null, "200"))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("button", {
    disabled: true
  }, "\u4E0A\u4E00\u9875"), /*#__PURE__*/React.createElement("button", {
    disabled: true
  }, "\u4E0B\u4E00\u9875"))))), /*#__PURE__*/React.createElement(DatePicker, {
    open: dateOpen,
    value: draft,
    onClose: () => setDateOpen(false),
    onApply: range => {
      setDateOpen(false);
      apply({
        ...draft,
        ...range
      });
    }
  }), /*#__PURE__*/React.createElement(Modal, {
    open: !!detail,
    onClose: () => setDetail(null),
    title: "\u62A5\u8D26\u8BE6\u60C5"
  }, /*#__PURE__*/React.createElement("div", {
    className: "record-preview"
  }, detail && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("strong", null, detail.reporter, " \xB7 ", detail.store), /*#__PURE__*/React.createElement("p", null, detail.category, " \xB7 \xA5", detail.amount.toFixed(2)), /*#__PURE__*/React.createElement("p", null, detail.note), /*#__PURE__*/React.createElement("p", null, "\u865A\u6784\u793A\u4F8B\u8BB0\u5F55\uFF0C\u4EC5\u7528\u4E8E\u7B5B\u9009\u6548\u679C\u6F14\u793A\u3002")))), toast && /*#__PURE__*/React.createElement("div", {
    className: "toast preview-toast",
    role: "status"
  }, toast));
}
ReactDOM.createRoot(document.getElementById('root')).render(/*#__PURE__*/React.createElement(DesktopApp, null));
