const options = [{
  key: 'a',
  name: '行内折叠',
  brief: '熟悉的表单，一次展开全部条件。',
  description: '门店与创建日期上下排列，保留完整标签。点“更多条件”展开四个输入框，查询后自动收起，并显示可移除的条件标签。',
  tradeoff: '适合最小改动。操作路径直观，展开时会把报账列表向下推。'
}, {
  key: 'b',
  name: '紧凑工具栏',
  brief: '标签与内容横排，首屏更省空间。',
  description: '将门店、创建日期改为两行设置项。更多条件在原位置展开，报账人与类别双列排布；同年日期省略重复年份。',
  tradeoff: '适合高频查看记录。整体更紧凑，较长的输入内容需要横向移动光标查看。'
}, {
  key: 'c',
  name: '底部面板',
  brief: '基础条件留在页面，复杂筛选单独操作。',
  description: '点“更多筛选”从底部打开面板，四项条件有完整输入空间。点“应用筛选”才生效；关闭面板会放弃面板内未应用的编辑。',
  tradeoff: '适合一次填写多个条件。需要多一次打开面板的操作，手机键盘出现时可滚动。'
}, {
  key: 'd',
  name: '按项展开',
  brief: '四个条件入口，只展开当前需要的一项。',
  description: '门店与创建日期采用设置列表；下方四个小入口分别展开关键词、报账人、类别和备注。切换入口会保留已填内容。',
  tradeoff: '适合只调整一两个条件。可快速定位字段，同时核对多项内容需要切换入口。'
}];
function CanvasTools() {
  const [scale, setScale] = React.useState(1);
  React.useEffect(() => {
    const handler = e => {
      if (e.origin === location.origin && e.data?.type === '__dc_zoom') setScale(e.data.scale);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);
  return /*#__PURE__*/React.createElement("div", {
    className: "canvas-tools"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => window.postMessage({
      type: '__dc_fit'
    }, location.origin)
  }, "\u9002\u5E94\u7A97\u53E3"), /*#__PURE__*/React.createElement("button", {
    "aria-label": "\u7F29\u5C0F\u753B\u5E03",
    onClick: () => window.postMessage({
      type: '__dc_set_zoom',
      scale: scale / 1.2
    }, location.origin)
  }, "\u2212"), /*#__PURE__*/React.createElement("span", null, Math.round(scale * 100), "%"), /*#__PURE__*/React.createElement("button", {
    "aria-label": "\u653E\u5927\u753B\u5E03",
    onClick: () => window.postMessage({
      type: '__dc_set_zoom',
      scale: scale * 1.2
    }, location.origin)
  }, "+"));
}
function Review() {
  const [selected, setSelected] = React.useState('a'),
    [theme, setTheme] = React.useState('light'),
    [view, setView] = React.useState('live'),
    [width, setWidth] = React.useState('390');
  const frame = React.useRef(null);
  const current = options.find(o => o.key === selected);
  function send(type) {
    frame.current?.contentWindow?.postMessage({
      type,
      theme
    }, location.origin);
  }
  React.useEffect(() => {
    send('expense-preview-theme');
  }, [theme]);
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("header", {
    className: "review-header"
  }, /*#__PURE__*/React.createElement("div", {
    className: "review-title"
  }, /*#__PURE__*/React.createElement("span", {
    className: "eyebrow"
  }, "/EXPENSE \xB7 MOBILE FILTERS"), /*#__PURE__*/React.createElement("h1", null, "\u8BA9\u5E38\u7528\u7B5B\u9009\uFF0C\u5148\u88AB\u770B\u89C1\u3002")), /*#__PURE__*/React.createElement("div", {
    className: "review-actions"
  }, /*#__PURE__*/React.createElement("button", {
    "aria-pressed": view === 'live',
    onClick: () => setView('live')
  }, "\u4EA4\u4E92\u9884\u89C8"), /*#__PURE__*/React.createElement("button", {
    "aria-pressed": view === 'compare',
    onClick: () => setView('compare')
  }, "\u56DB\u7248\u5BF9\u6BD4"), /*#__PURE__*/React.createElement("button", {
    "aria-label": theme === 'light' ? '切换深色' : '切换浅色',
    onClick: () => setTheme(theme === 'light' ? 'dark' : 'light')
  }, theme === 'light' ? '◐' : '◑'))), view === 'live' ? /*#__PURE__*/React.createElement("main", {
    className: "workspace"
  }, /*#__PURE__*/React.createElement("aside", {
    className: "sidebar"
  }, /*#__PURE__*/React.createElement("p", {
    className: "sidebar-intro"
  }, "\u95E8\u5E97\u3001\u521B\u5EFA\u65E5\u671F\u59CB\u7EC8\u663E\u793A\u3002", /*#__PURE__*/React.createElement("br", null), "\u5176\u4F59\u56DB\u9879\u9ED8\u8BA4\u6536\u8D77\uFF0C\u6CBF\u7528\u73B0\u6709\u89C6\u89C9\u98CE\u683C\u3002"), /*#__PURE__*/React.createElement("div", {
    className: "variant-list",
    "aria-label": "\u9009\u62E9\u8BBE\u8BA1\u7248\u672C"
  }, options.map(o => /*#__PURE__*/React.createElement("button", {
    key: o.key,
    className: "variant-card",
    "aria-pressed": selected === o.key,
    onClick: () => setSelected(o.key)
  }, /*#__PURE__*/React.createElement("span", {
    className: "variant-letter"
  }, o.key.toUpperCase()), /*#__PURE__*/React.createElement("span", {
    className: "variant-copy"
  }, /*#__PURE__*/React.createElement("strong", null, o.name, o.key === 'a' && /*#__PURE__*/React.createElement("span", {
    className: "recommend"
  }, "\u63A8\u8350")), /*#__PURE__*/React.createElement("small", null, o.brief))))), /*#__PURE__*/React.createElement("div", {
    className: "design-note"
  }, /*#__PURE__*/React.createElement("h2", null, current.key.toUpperCase(), " / ", current.name), /*#__PURE__*/React.createElement("p", null, current.description), /*#__PURE__*/React.createElement("p", {
    className: "tradeoff"
  }, current.tradeoff), /*#__PURE__*/React.createElement("p", {
    className: "sample-note"
  }, "\u72EC\u7ACB\u4EA4\u4E92\u9884\u89C8 \xB7 \u5217\u8868\u4E3A\u865A\u6784\u793A\u4F8B\u6570\u636E", /*#__PURE__*/React.createElement("br", null), "\u53EF\u4F53\u9A8C\u65E5\u671F\u9009\u62E9\u3001\u590D\u5408\u7B5B\u9009\u3001\u67E5\u8BE2\u3001\u91CD\u7F6E\u4E0E\u6761\u4EF6\u79FB\u9664\u3002\u5C1A\u672A\u5E94\u7528\u5230\u4E1A\u52A1\u9875\u9762\u3002"))), /*#__PURE__*/React.createElement("section", {
    className: "stage",
    "aria-label": "\u624B\u673A\u4EA4\u4E92\u9884\u89C8"
  }, /*#__PURE__*/React.createElement("div", {
    className: "stage-tools"
  }, /*#__PURE__*/React.createElement("label", null, "\u5C4F\u5E55\u5BBD\u5EA6", /*#__PURE__*/React.createElement("select", {
    value: width,
    onChange: e => setWidth(e.target.value),
    "aria-label": "\u5C4F\u5E55\u5BBD\u5EA6"
  }, /*#__PURE__*/React.createElement("option", {
    value: "375"
  }, "375 px"), /*#__PURE__*/React.createElement("option", {
    value: "390"
  }, "390 px"), /*#__PURE__*/React.createElement("option", {
    value: "430"
  }, "430 px"))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("button", {
    onClick: () => send('expense-preview-example')
  }, "\u9884\u586B\u6761\u4EF6"), /*#__PURE__*/React.createElement("button", {
    onClick: () => send('expense-preview-reset')
  }, "\u6062\u590D\u521D\u59CB"))), /*#__PURE__*/React.createElement("div", {
    className: "preview-window",
    style: {
      width: Number(width)
    }
  }, /*#__PURE__*/React.createElement("iframe", {
    ref: frame,
    key: selected,
    src: `${selected}.html`,
    title: `方案 ${selected.toUpperCase()} ${current.name}`,
    onLoad: () => send('expense-preview-theme')
  })), /*#__PURE__*/React.createElement("a", {
    className: "direct-link",
    href: `${selected}.html?theme=${theme}`,
    target: "_blank",
    rel: "noreferrer"
  }, "\u5355\u72EC\u6253\u5F00 ", selected.toUpperCase(), " \u7248 \u2197"))) : /*#__PURE__*/React.createElement("div", {
    className: "canvas-host"
  }, /*#__PURE__*/React.createElement(CanvasTools, null), /*#__PURE__*/React.createElement(DesignCanvas, {
    style: {
      height: '100%'
    }
  }, /*#__PURE__*/React.createElement(DCSection, {
    id: "filters",
    title: "\u95E8\u5E97\u4E0E\u521B\u5EFA\u65E5\u671F\u5E38\u9A7B \xB7 \u56DB\u79CD\u6298\u53E0\u65B9\u5F0F",
    subtitle: "\u70B9\u51FB\u753B\u9762\u8FDB\u5165\u5BF9\u5E94\u4EA4\u4E92\u7248\u672C\uFF1B\u9ED8\u8BA4\u6536\u8D77\u72B6\u6001\uFF0C\u5C4F\u5E55\u5BBD\u5EA6 390 px\u3002",
    gap: 28
  }, options.map(o => /*#__PURE__*/React.createElement(DCArtboard, {
    key: o.key,
    id: o.key,
    label: `${o.key.toUpperCase()} · ${o.name}`,
    width: 390,
    height: 844
  }, /*#__PURE__*/React.createElement("a", {
    href: `${o.key}.html?theme=${theme}`,
    target: "_blank",
    rel: "noreferrer",
    "aria-label": `打开 ${o.name} 交互预览`
  }, /*#__PURE__*/React.createElement("img", {
    src: `previews/${o.key}-${theme}.png`,
    width: "390",
    height: "844",
    alt: `${o.name}手机端默认收起效果`
  })))))), /*#__PURE__*/React.createElement("div", {
    className: "canvas-hint"
  }, "\u6EDA\u8F6E\u7F29\u653E \xB7 \u62D6\u52A8\u753B\u5E03 \xB7 \u53CC\u51FB\u7A7A\u767D\u5904\u9002\u5E94\u753B\u9762")));
}
ReactDOM.createRoot(document.getElementById('root')).render(/*#__PURE__*/React.createElement(Review, null));
