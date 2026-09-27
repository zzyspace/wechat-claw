const options = [{
  key: 'a',
  name: '全项紧凑',
  brief: '全部字段可见，大屏单行完成筛选。',
  note: '适合频繁组合多个条件；1440px 单行排列，窄一些的电脑窗口自动换行。'
}, {
  key: 'b',
  name: '常用条件优先',
  brief: '门店、日期常驻，四项条件按需展开。',
  note: '与手机端 A 版一致。适合主要按门店和日期查看记录，筛选后会保留可移除的条件标签。'
}, {
  key: 'c',
  name: '两行分组',
  brief: '六项始终可见，范围与内容分开排列。',
  note: '第一行：门店、日期、关键词。第二行：报账人、类别、备注。输入框更宽，便于填写复合条件。'
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
  const [selected, setSelected] = React.useState('b'),
    [view, setView] = React.useState('live'),
    [theme, setTheme] = React.useState('light'),
    [width, setWidth] = React.useState(1440),
    [scale, setScale] = React.useState(1);
  const frame = React.useRef(null),
    stage = React.useRef(null),
    current = options.find(o => o.key === selected);
  function send(type) {
    frame.current?.contentWindow?.postMessage({
      type,
      theme
    }, location.origin);
  }
  React.useEffect(() => {
    send('desktop-theme');
  }, [theme]);
  React.useEffect(() => {
    if (!stage.current) return;
    const observer = new ResizeObserver(entries => setScale(Math.min(1, entries[0].contentRect.width / width)));
    observer.observe(stage.current);
    return () => observer.disconnect();
  }, [width, view]);
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("header", {
    className: "review-head"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h1", null, "/expense \xB7 \u7535\u8111\u7AEF\u7B5B\u9009\u5E03\u5C40"), /*#__PURE__*/React.createElement("p", null, "\u6CBF\u7528\u73B0\u6709\u98CE\u683C\uFF0C\u6BD4\u8F83\u4FE1\u606F\u5BC6\u5EA6\u4E0E\u6761\u4EF6\u5C55\u5F00\u65B9\u5F0F\u3002")), /*#__PURE__*/React.createElement("div", {
    className: "top-tools"
  }, /*#__PURE__*/React.createElement("button", {
    "aria-pressed": view === 'live',
    onClick: () => setView('live')
  }, "\u4EA4\u4E92\u9884\u89C8"), /*#__PURE__*/React.createElement("button", {
    "aria-pressed": view === 'compare',
    onClick: () => setView('compare')
  }, "\u6548\u679C\u56FE\u5BF9\u6BD4"), /*#__PURE__*/React.createElement("button", {
    "aria-label": theme === 'light' ? '切换深色' : '切换浅色',
    onClick: () => setTheme(theme === 'light' ? 'dark' : 'light')
  }, theme === 'light' ? '◐ 深色' : '◑ 浅色'), /*#__PURE__*/React.createElement("a", {
    className: "download-link",
    href: "previews/comparison.png",
    target: "_blank",
    rel: "noreferrer"
  }, "\u67E5\u770B\u603B\u89C8\u56FE \u2197"))), /*#__PURE__*/React.createElement("nav", {
    className: "variant-row",
    "aria-label": "\u9009\u62E9\u684C\u9762\u65B9\u6848"
  }, options.map(o => /*#__PURE__*/React.createElement("button", {
    key: o.key,
    className: "variant-choice",
    "aria-pressed": selected === o.key,
    onClick: () => {
      setSelected(o.key);
      setView('live');
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "letter"
  }, o.key.toUpperCase()), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("strong", null, o.name, o.key === 'b' && /*#__PURE__*/React.createElement("span", {
    className: "recommended"
  }, "\u63A8\u8350")), /*#__PURE__*/React.createElement("small", null, o.brief))))), view === 'live' ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "stage-meta"
  }, /*#__PURE__*/React.createElement("p", null, current.note), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("select", {
    "aria-label": "\u7535\u8111\u5C4F\u5E55\u5BBD\u5EA6",
    value: width,
    onChange: e => setWidth(Number(e.target.value))
  }, /*#__PURE__*/React.createElement("option", {
    value: "1280"
  }, "1280 px"), /*#__PURE__*/React.createElement("option", {
    value: "1440"
  }, "1440 px"), /*#__PURE__*/React.createElement("option", {
    value: "1600"
  }, "1600 px")), /*#__PURE__*/React.createElement("button", {
    onClick: () => send('desktop-example')
  }, "\u9884\u586B\u6761\u4EF6"), /*#__PURE__*/React.createElement("button", {
    onClick: () => send('desktop-reset')
  }, "\u6062\u590D\u521D\u59CB"), /*#__PURE__*/React.createElement("a", {
    href: `${selected}.html?theme=${theme}`,
    target: "_blank",
    rel: "noreferrer"
  }, "\u5B9E\u9645\u5C3A\u5BF8 \u2197"))), /*#__PURE__*/React.createElement("main", {
    className: "stage-outer"
  }, /*#__PURE__*/React.createElement("div", {
    className: "stage",
    ref: stage
  }, /*#__PURE__*/React.createElement("div", {
    className: "preview-window",
    style: {
      width: Math.min(width, width * scale),
      height: 900 * scale
    }
  }, /*#__PURE__*/React.createElement("iframe", {
    ref: frame,
    key: selected,
    src: `${selected}.html`,
    onLoad: () => send('desktop-theme'),
    title: `${selected.toUpperCase()} ${current.name}`,
    style: {
      width,
      height: 900,
      transform: `scale(${scale})`
    }
  })))), /*#__PURE__*/React.createElement("p", {
    className: "review-note"
  }, "\u72EC\u7ACB\u8BBE\u8BA1\u9884\u89C8 \xB7 \u865A\u6784\u793A\u4F8B\u6570\u636E \xB7 \u53EF\u4F53\u9A8C\u65E5\u671F\u9009\u62E9\u3001\u590D\u5408\u7B5B\u9009\u4E0E\u91CD\u7F6E \xB7 \u5C1A\u672A\u5B9E\u65BD\u684C\u9762\u7AEF\u6539\u52A8")) : /*#__PURE__*/React.createElement("div", {
    className: "canvas-host"
  }, /*#__PURE__*/React.createElement(CanvasTools, null), /*#__PURE__*/React.createElement(DesignCanvas, {
    style: {
      height: '100%'
    }
  }, /*#__PURE__*/React.createElement(DCSection, {
    id: "desktop",
    title: "\u4E09\u79CD\u5E03\u5C40 \xB7 \u540C\u4E00\u7EC4\u7B5B\u9009\u5B57\u6BB5",
    subtitle: "\u53EF\u62D6\u52A8\u3001\u7F29\u653E\u4E0E\u653E\u5927\u5355\u7248\uFF1B\u70B9\u51FB\u753B\u9762\u6253\u5F00\u4EA4\u4E92\u7248\u672C\u3002",
    gap: 30
  }, options.map(o => /*#__PURE__*/React.createElement(DCArtboard, {
    key: o.key,
    id: o.key,
    label: `${o.key.toUpperCase()} · ${o.name}`,
    width: 1440,
    height: 940
  }, /*#__PURE__*/React.createElement("a", {
    href: `${o.key}.html?theme=${theme}`,
    target: "_blank",
    rel: "noreferrer"
  }, /*#__PURE__*/React.createElement("img", {
    src: `previews/${o.key}-${theme}.png`,
    width: "1440",
    height: "940",
    alt: `${o.name}电脑端效果图`
  })))))), /*#__PURE__*/React.createElement("div", {
    className: "canvas-hint"
  }, "\u6EDA\u8F6E\u7F29\u653E \xB7 \u62D6\u52A8\u753B\u5E03 \xB7 \u53CC\u51FB\u7A7A\u767D\u5904\u9002\u5E94\u753B\u9762")));
}
ReactDOM.createRoot(document.getElementById('root')).render(/*#__PURE__*/React.createElement(Review, null));
