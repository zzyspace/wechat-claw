/* Design study of /expense, based on src/admin/public/admin.html (2026-09-27).
   Scope: four mobile filter layouts, existing tokens and compound-input grammar.
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
  search: '群聊、商户、单号、OCR 或 ID',
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
    className: `field ${name === 'search' || name === 'note' ? 'wide' : ''}`
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
function App() {
  const [draft, setDraft] = useState({
      ...base
    }),
    [applied, setApplied] = useState({
      ...base
    }),
    [open, setOpen] = useState(false),
    [group, setGroup] = useState(''),
    [dateOpen, setDateOpen] = useState(false),
    [error, setError] = useState(''),
    [toast, setToast] = useState(''),
    [detail, setDetail] = useState(null);
  const [theme, setTheme] = useState(new URLSearchParams(location.search).get('theme') || 'light');
  const [sheetDraft, setSheetDraft] = useState({
    ...base
  });
  const moreRef = useRef(null);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    function receive(e) {
      if (e.origin !== location.origin) return;
      if (e.data?.type === 'expense-preview-theme') setTheme(e.data.theme);
      if (e.data?.type === 'expense-preview-example') {
        const next = {
          ...base,
          reporter: '张||李',
          category: '食材||房租',
          note: '!平'
        };
        setDraft(next);
        setApplied(next);
        setOpen(false);
        setGroup('');
        setError('');
      }
      if (e.data?.type === 'expense-preview-reset') {
        reset();
      }
    }
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 2400);
    return () => clearTimeout(t);
  }, [toast]);
  const update = (key, value) => {
    setDraft(d => ({
      ...d,
      [key]: value
    }));
    setError('');
  };
  const updateSheet = (key, value) => {
    setSheetDraft(d => ({
      ...d,
      [key]: value
    }));
    setError('');
  };
  const active = extraKeys.filter(k => applied[k].trim()),
    draftCount = extraKeys.filter(k => draft[k].trim()).length;
  const records = getRecords(applied),
    total = records.reduce((sum, r) => sum + r.amount, 0);
  function reset() {
    setDraft({
      ...base
    });
    setApplied({
      ...base
    });
    setSheetDraft({
      ...base
    });
    setError('');
    setOpen(false);
    setGroup('');
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
      setOpen(false);
      setGroup('');
      setToast('筛选已更新');
    } catch (e) {
      setError(e.message);
      if (variant === 'c' && !open) {
        setSheetDraft({
          ...next
        });
        setOpen(true);
      } else if (variant === 'd') {
        const invalid = extraKeys.find(k => e.message.startsWith(labels[k]));
        setGroup(invalid || 'reporter');
      } else setOpen(true);
      return false;
    }
    return true;
  }
  function toggleMore() {
    setError('');
    if (variant === 'c') setSheetDraft({
      ...draft
    });
    setOpen(!open);
  }
  function remove(key) {
    const next = {
      ...applied,
      [key]: ''
    };
    setApplied(next);
    setDraft(d => ({
      ...d,
      [key]: ''
    }));
    setError('');
  }
  const MoreButton = /*#__PURE__*/React.createElement("button", {
    ref: moreRef,
    className: `text-button more ${open ? 'is-open' : ''}`,
    type: "button",
    "aria-expanded": open,
    "aria-controls": variant === 'c' ? 'extra-sheet' : 'extra-fields',
    "aria-haspopup": variant === 'c' ? 'dialog' : undefined,
    onClick: toggleMore
  }, variant === 'b' ? '更多' : variant === 'c' ? '更多筛选' : '更多条件', /*#__PURE__*/React.createElement(Count, {
    value: draftCount
  }), /*#__PURE__*/React.createElement(Chevron, null));
  return /*#__PURE__*/React.createElement("div", {
    className: `page variant-${variant}`,
    "data-screen-label": `方案 ${variant.toUpperCase()}：手机端筛选`
  }, /*#__PURE__*/React.createElement("nav", {
    className: "topbar",
    "aria-label": "\u62A5\u8D26\u4E2D\u5FC3"
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
    className: "theme-button",
    onClick: () => setTheme(theme === 'light' ? 'dark' : 'light'),
    "aria-label": theme === 'light' ? '切换到深色模式' : '切换到浅色模式'
  }, theme === 'light' ? '◐' : '◑'), /*#__PURE__*/React.createElement("button", {
    onClick: () => setToast('这是设计预览，不会退出实际账号')
  }, "\u9000\u51FA\u767B\u5F55"))), /*#__PURE__*/React.createElement("header", {
    className: "hero"
  }, /*#__PURE__*/React.createElement("h1", null, "\u62A5\u8D26\u67E5\u770B\u540E\u53F0"), /*#__PURE__*/React.createElement("p", null, "\u67E5\u770B\u5DF2\u5165\u5E93\u7684\u62A5\u8D26\u8BB0\u5F55\uFF0C\u6309\u95E8\u5E97\u3001\u62A5\u8D26\u4EBA\u3001\u7C7B\u522B\u3001\u65E5\u671F\u548C\u5907\u6CE8\u6587\u5B57\u7B5B\u9009\uFF0C\u5E76\u5C55\u5F00\u8BE6\u60C5\u67E5\u770B OCR\u3001\u539F\u59CB\u6D88\u606F\u3001\u9644\u4EF6\u548C\u56DE\u6267\u8BB0\u5F55\u3002"), /*#__PURE__*/React.createElement("div", {
    className: "hero-actions"
  }, /*#__PURE__*/React.createElement("button", {
    className: "primary",
    onClick: () => setToast('当前预览聚焦筛选模块')
  }, "\u624B\u5DE5\u8865\u5F55"), /*#__PURE__*/React.createElement("button", {
    className: "primary",
    onClick: () => setToast('当前预览聚焦筛选模块')
  }, "\u6279\u91CF\u8865\u5F55"))), /*#__PURE__*/React.createElement("section", {
    className: "panel filter-panel",
    "aria-label": "\u62A5\u8D26\u7B5B\u9009"
  }, /*#__PURE__*/React.createElement("form", {
    onSubmit: e => {
      e.preventDefault();
      apply();
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "always-fields"
  }, /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", {
    htmlFor: "store"
  }, "\u95E8\u5E97"), /*#__PURE__*/React.createElement("select", {
    id: "store",
    name: "store",
    value: draft.store,
    onChange: e => update('store', e.target.value)
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "\u5168\u90E8\u95E8\u5E97"), stores.map(store => /*#__PURE__*/React.createElement("option", {
    key: store
  }, store)))), /*#__PURE__*/React.createElement("div", {
    className: "field"
  }, /*#__PURE__*/React.createElement("label", {
    htmlFor: "created-date"
  }, "\u521B\u5EFA\u65E5\u671F"), /*#__PURE__*/React.createElement("button", {
    id: "created-date",
    className: "date-trigger",
    type: "button",
    "aria-haspopup": "dialog",
    "aria-expanded": dateOpen,
    onClick: () => {
      setError('');
      setDateOpen(true);
    }
  }, /*#__PURE__*/React.createElement("span", null, dateLabel(draft.from, draft.to, variant === 'b' || variant === 'd')), /*#__PURE__*/React.createElement(CalendarIcon, null)))), (variant === 'a' || variant === 'b') && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    id: "extra-fields",
    className: "advanced-fields",
    hidden: !open,
    style: !open ? {
      display: 'none'
    } : undefined
  }, /*#__PURE__*/React.createElement(ExtraFields, {
    values: draft,
    onChange: update
  }), /*#__PURE__*/React.createElement(ExprHelp, null))), variant === 'd' && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "condition-tabs",
    "aria-label": "\u5C55\u5F00\u5355\u9879\u7B5B\u9009"
  }, extraKeys.map(key => /*#__PURE__*/React.createElement("button", {
    key: key,
    type: "button",
    "aria-controls": "single-condition",
    "aria-expanded": group === key,
    className: group === key ? 'is-open' : '',
    onClick: () => setGroup(group === key ? '' : key)
  }, shortLabels[key], draft[key] && /*#__PURE__*/React.createElement("span", {
    className: "dot",
    "aria-label": "\u5DF2\u586B\u5199"
  }), /*#__PURE__*/React.createElement(Chevron, null)))), group && /*#__PURE__*/React.createElement("div", {
    className: "single-condition",
    id: "single-condition"
  }, /*#__PURE__*/React.createElement(Field, {
    name: group,
    value: draft[group],
    onChange: update
  }), group !== 'search' && /*#__PURE__*/React.createElement(ExprHelp, null))), /*#__PURE__*/React.createElement("div", {
    className: "filter-actions"
  }, variant === 'd' ? /*#__PURE__*/React.createElement("span", {
    className: "quiet-caption"
  }, draftCount ? `已填写 ${draftCount} 项条件` : '按需展开条件') : MoreButton, /*#__PURE__*/React.createElement("button", {
    className: "text-button muted-button",
    type: "button",
    onClick: reset
  }, "\u91CD\u7F6E"), /*#__PURE__*/React.createElement("button", {
    className: "primary",
    type: "submit"
  }, "\u67E5\u8BE2")), error && variant !== 'c' && /*#__PURE__*/React.createElement("p", {
    className: "error",
    role: "alert"
  }, error)), active.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "applied",
    "aria-label": "\u5DF2\u751F\u6548\u7684\u66F4\u591A\u6761\u4EF6"
  }, active.map(key => /*#__PURE__*/React.createElement("button", {
    key: key,
    "aria-label": `移除${shortLabels[key]}条件`,
    title: `${shortLabels[key]}：${applied[key]}`,
    onClick: () => remove(key)
  }, /*#__PURE__*/React.createElement("span", null, shortLabels[key], "\uFF1A", applied[key]), /*#__PURE__*/React.createElement("span", {
    "aria-hidden": "true"
  }, "\xD7"))))), /*#__PURE__*/React.createElement("div", {
    className: "filter-status",
    role: "status",
    "aria-live": "polite"
  }, /*#__PURE__*/React.createElement("span", null, "\u5171 ", /*#__PURE__*/React.createElement("strong", null, records.length), " \u6761\u62A5\u8D26"), /*#__PURE__*/React.createElement("span", null, "\u5408\u8BA1 ", /*#__PURE__*/React.createElement("strong", null, "\xA5", total.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })))), /*#__PURE__*/React.createElement("section", {
    className: "panel records",
    "aria-label": "\u62A5\u8D26\u8BB0\u5F55"
  }, records.length === 0 ? /*#__PURE__*/React.createElement("div", {
    className: "empty"
  }, "\u6CA1\u6709\u5339\u914D\u7684\u62A5\u8D26\u8BB0\u5F55\u3002", /*#__PURE__*/React.createElement("br", null), /*#__PURE__*/React.createElement("button", {
    className: "text-button",
    onClick: reset
  }, "\u91CD\u7F6E\u7B5B\u9009")) : records.map(record => /*#__PURE__*/React.createElement("article", {
    className: "record",
    key: record.id
  }, /*#__PURE__*/React.createElement("div", {
    className: "record-heading"
  }, /*#__PURE__*/React.createElement("div", {
    className: "record-identity"
  }, /*#__PURE__*/React.createElement("strong", null, record.reporter), /*#__PURE__*/React.createElement("span", {
    className: `tag ${record.category === '房租' ? 'rent' : record.category === '其他' ? 'other' : ''}`
  }, record.category)), /*#__PURE__*/React.createElement("span", {
    className: "amount"
  }, /*#__PURE__*/React.createElement("small", null, "\xA5 "), record.amount.toLocaleString('en-US', {
    minimumFractionDigits: 2
  }))), /*#__PURE__*/React.createElement("div", {
    className: "record-meta"
  }, /*#__PURE__*/React.createElement("span", null, record.store), /*#__PURE__*/React.createElement("span", null, "\u5DF2\u5165\u5E93")), /*#__PURE__*/React.createElement("p", {
    className: "record-note"
  }, record.note), /*#__PURE__*/React.createElement("div", {
    className: "record-footer"
  }, /*#__PURE__*/React.createElement("time", null, record.date.replaceAll('-', '/'), " ", record.time), /*#__PURE__*/React.createElement("button", {
    onClick: () => setToast('设计预览中的示例记录，无真实附件')
  }, "\u9644\u4EF6 ", record.files), /*#__PURE__*/React.createElement("button", {
    onClick: () => setDetail(record)
  }, "\u8BE6\u60C5"), /*#__PURE__*/React.createElement("button", {
    className: "icon-button",
    "aria-label": `更多操作 ${record.id}`,
    onClick: () => setToast('筛选预览不提供记录编辑操作')
  }, "\xB7\xB7\xB7"))))), /*#__PURE__*/React.createElement("div", {
    className: "pagination"
  }, /*#__PURE__*/React.createElement("span", null, records.length ? `1 – ${records.length}` : '0 – 0', " / ", records.length), /*#__PURE__*/React.createElement("span", null, "\u6BCF\u9875 200 \u6761"), /*#__PURE__*/React.createElement("button", {
    disabled: true
  }, "\u4E0A\u4E00\u9875"), /*#__PURE__*/React.createElement("button", {
    disabled: true
  }, "\u4E0B\u4E00\u9875")), variant === 'c' && /*#__PURE__*/React.createElement(Modal, {
    open: open,
    onClose: () => {
      setOpen(false);
      setError('');
    },
    sheet: true,
    title: "\u66F4\u591A\u7B5B\u9009"
  }, /*#__PURE__*/React.createElement("div", {
    id: "extra-sheet"
  }, /*#__PURE__*/React.createElement("div", {
    className: "sheet-context"
  }, /*#__PURE__*/React.createElement("span", null, draft.store || '全部门店'), /*#__PURE__*/React.createElement("span", null, "\xB7"), /*#__PURE__*/React.createElement("span", null, dateLabel(draft.from, draft.to, true))), /*#__PURE__*/React.createElement("form", {
    className: "sheet-form",
    onSubmit: e => {
      e.preventDefault();
      apply({
        ...draft,
        ...Object.fromEntries(extraKeys.map(k => [k, sheetDraft[k]]))
      });
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "sheet-fields"
  }, /*#__PURE__*/React.createElement(ExtraFields, {
    values: sheetDraft,
    onChange: updateSheet
  })), /*#__PURE__*/React.createElement(ExprHelp, null), error && /*#__PURE__*/React.createElement("p", {
    className: "error",
    role: "alert"
  }, error), /*#__PURE__*/React.createElement("div", {
    className: "sheet-actions"
  }, /*#__PURE__*/React.createElement("button", {
    type: "button",
    onClick: () => {
      setSheetDraft(d => ({
        ...d,
        search: '',
        reporter: '',
        category: '',
        note: ''
      }));
      setError('');
    }
  }, "\u6E05\u7A7A\u6761\u4EF6"), /*#__PURE__*/React.createElement("button", {
    type: "submit",
    className: "primary"
  }, "\u5E94\u7528\u7B5B\u9009"))))), /*#__PURE__*/React.createElement(DatePicker, {
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
  }, detail && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("strong", null, detail.reporter, " \xB7 ", detail.store), /*#__PURE__*/React.createElement("p", null, detail.category, " \xB7 \xA5", detail.amount.toFixed(2)), /*#__PURE__*/React.createElement("p", null, detail.note), /*#__PURE__*/React.createElement("p", null, "\u793A\u4F8B\u8BB0\u5F55 #", detail.id, "\uFF0C\u4EC5\u7528\u4E8E\u7B5B\u9009\u6548\u679C\u6F14\u793A\u3002")))), toast && /*#__PURE__*/React.createElement("div", {
    className: "toast",
    role: "status"
  }, toast));
}
ReactDOM.createRoot(document.getElementById('root')).render(/*#__PURE__*/React.createElement(App, null));
