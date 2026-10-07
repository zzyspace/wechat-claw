/*
 * Full-screen reimbursement attachment viewer, shared by the expense list (admin.html)
 * and the monthly report. The page supplies the items and how to describe them; the
 * viewer owns loading, zoom, rotation, the photo-style carousel and touch gestures.
 */
(function (global) {
  "use strict";

  const ORIGINAL_CACHE_LIMIT = 6;
  const THUMBNAIL_CACHE_LIMIT = 8;
  const MAX_ZOOM = 8;
  const SWIPE_DISTANCE = 60;
  const DISMISS_DISTANCE = 120;
  const SLIDE_GAP = 16;
  const SLIDE_MS = 230;
  const ROTATION_STORAGE_KEY = "reimbursement-attachment-rotations";
  const ROTATION_STORAGE_LIMIT = 300;
  const INFO_STORAGE_KEY = "reimbursement-attachment-viewer-info";

  const icon = (paths) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const ICONS = {
    zoomOut: icon('<circle cx="11" cy="11" r="7"/><path d="M8 11h6M20 20l-4-4"/>'),
    zoomIn: icon('<circle cx="11" cy="11" r="7"/><path d="M8 11h6M11 8v6M20 20l-4-4"/>'),
    fit: icon('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
    rotate: icon('<path d="M20 12a8 8 0 1 1-3-6.2M20 4v5h-5"/>'),
    open: icon('<path d="M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'),
    panel: icon('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>'),
    close: icon('<path d="M6 6l12 12M18 6 6 18"/>'),
    previous: icon('<path d="M15 5l-7 7 7 7"/>'),
    next: icon('<path d="M9 5l7 7-7 7"/>'),
  };

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }

  function capitalize(value) {
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  function loadRotations() {
    try {
      const stored = JSON.parse(global.localStorage.getItem(ROTATION_STORAGE_KEY) || "[]");
      return new Map(Array.isArray(stored)
        ? stored.filter(([id, degrees]) => Number.isInteger(id) && [90, 180, 270].includes(degrees))
        : []);
    } catch {
      return new Map();
    }
  }

  /**
   * options:
   *   getItems()            items that have a viewable attachment, in display order
   *   keyOf(item)           stable item key (the report id)
   *   attachmentIdOf(item)  attachment id used for /api/attachments/:id/{content,thumbnail}
   *   describe(item)        { title, alt, amount: { missing, text, currency }, tagsHtml, store,
   *                           reporter, createdAt, createdAtShort, note, needsReview }
   *   actions               [{ key, label, primary, visible(item), run(item) }]
   *   createThumbnailUrl(src)  optional: an owned object URL for an already-cached thumbnail
   *   isBlocked()           optional: true while another dialog sits on top of the viewer
   *   modal                 open with showModal() so the viewer sits above other modal dialogs
   *   basePath              defaults to "/expense"
   */
  function create(options) {
    const basePath = options.basePath || "/expense";
    const actions = options.actions || [];
    const compactQuery = global.matchMedia("(max-width: 620px)");
    const reducedMotionQuery = global.matchMedia("(prefers-reduced-motion: reduce)");
    const originals = new Map();
    const thumbnails = new Map();
    const rotations = loadRotations();
    const view = {
      key: null, request: null, zoom: 1, x: 0, y: 0, offsetX: 0, offsetY: 0,
      pointers: new Map(), gesture: null, lastTap: null, lastPointerType: "mouse",
      sides: new Map(), sliding: false, slideTimer: null, animationTimer: null, noticeTimer: null,
      returnFocus: null, stripItems: null, stripUrls: [],
    };

    const root = document.createElement("dialog");
    root.className = "attachment-viewer";
    root.id = "attachmentPreviewModal";
    root.setAttribute("aria-labelledby", "attachmentPreviewTitle");
    root.setAttribute("aria-modal", "true");
    root.hidden = true;
    root.innerHTML = `
      <div class="attachment-viewer-main">
        <div class="attachment-viewer-toolbar">
          <div class="attachment-viewer-heading">
            <span class="attachment-viewer-count" id="attachmentPreviewCount"></span>
            <h2 id="attachmentPreviewTitle">附件预览</h2>
          </div>
          <button class="attachment-viewer-tool" data-viewer-tool="zoom-out" type="button" aria-label="缩小" title="缩小（-）">${ICONS.zoomOut}</button>
          <button class="attachment-viewer-tool attachment-viewer-zoom" data-viewer-tool="zoom-toggle" id="attachmentPreviewZoom" type="button" title="当前显示比例，点击在适应窗口和原始大小之间切换">--</button>
          <button class="attachment-viewer-tool" data-viewer-tool="zoom-in" type="button" aria-label="放大" title="放大（+）">${ICONS.zoomIn}</button>
          <button class="attachment-viewer-tool" data-viewer-tool="fit" type="button" aria-label="适应窗口" title="适应窗口（0）">${ICONS.fit}<span class="attachment-viewer-tool-label">适应</span></button>
          <span class="attachment-viewer-divider"></span>
          <button class="attachment-viewer-tool" data-viewer-tool="rotate" type="button" aria-label="顺时针旋转 90 度" title="旋转（R）">${ICONS.rotate}<span class="attachment-viewer-tool-label">旋转</span></button>
          <a class="attachment-viewer-tool" id="attachmentPreviewOriginalLink" target="_blank" rel="noreferrer" aria-label="在新标签页打开原图" title="在新标签页打开原图">${ICONS.open}<span class="attachment-viewer-tool-label">原图</span></a>
          <button class="attachment-viewer-tool" data-viewer-tool="info" id="attachmentPreviewInfoToggle" type="button" aria-label="报账信息" aria-pressed="true" title="报账信息（I）">${ICONS.panel}</button>
          <button class="attachment-viewer-tool" id="attachmentPreviewClose" type="button" aria-label="关闭附件预览" title="关闭（Esc）">${ICONS.close}</button>
        </div>
        <div class="attachment-viewer-stage" id="attachmentPreviewStage" tabindex="-1" autofocus>
          <div class="attachment-viewer-progress" aria-hidden="true"></div>
          <div class="attachment-viewer-chip" id="attachmentPreviewLoading" hidden>缩略图 · 正在加载原图</div>
          <img id="attachmentPreviewImage" alt="附件预览" />
          <button class="attachment-viewer-nav previous" id="attachmentPreviewPrevious" type="button" aria-label="上一个报账的附件">${ICONS.previous}</button>
          <button class="attachment-viewer-nav next" id="attachmentPreviewNext" type="button" aria-label="下一个报账的附件">${ICONS.next}</button>
          <div class="attachment-viewer-notice" id="attachmentPreviewNotice" role="status" hidden>
            <span id="attachmentPreviewNoticeText"></span>
            <button id="attachmentPreviewRetry" type="button" hidden>重试</button>
          </div>
          <div class="attachment-viewer-hint" aria-hidden="true"><span>← → 翻页</span><span>滚轮缩放</span><span>双击原始大小</span><span>R 旋转</span></div>
        </div>
        <div class="attachment-viewer-strip" id="attachmentPreviewStrip" role="group" aria-label="当前列表的附件"></div>
      </div>
      <aside class="attachment-viewer-info" id="attachmentPreviewInfo" aria-label="报账信息">
        <div class="attachment-viewer-info-body" id="attachmentPreviewInfoBody"></div>
        <div class="attachment-viewer-actions">
          ${actions.map((action) => `<button class="attachment-viewer-action${action.primary ? " is-primary" : ""}" id="attachmentPreview${capitalize(action.key)}" data-viewer-action="${escapeHtml(action.key)}" type="button">${escapeHtml(action.label)}</button>`).join("")}
        </div>
      </aside>
    `;
    document.body.append(root);

    const $ = (id) => root.querySelector(`#${id}`);
    const el = {
      count: $("attachmentPreviewCount"), title: $("attachmentPreviewTitle"), zoom: $("attachmentPreviewZoom"),
      originalLink: $("attachmentPreviewOriginalLink"), infoToggle: $("attachmentPreviewInfoToggle"), close: $("attachmentPreviewClose"),
      stage: $("attachmentPreviewStage"), loading: $("attachmentPreviewLoading"), image: $("attachmentPreviewImage"),
      previous: $("attachmentPreviewPrevious"), next: $("attachmentPreviewNext"), notice: $("attachmentPreviewNotice"),
      noticeText: $("attachmentPreviewNoticeText"), retry: $("attachmentPreviewRetry"), strip: $("attachmentPreviewStrip"),
      infoBody: $("attachmentPreviewInfoBody"), actions: root.querySelector(".attachment-viewer-actions"),
    };
    el.actions.hidden = actions.length === 0;
    try {
      if (global.localStorage.getItem(INFO_STORAGE_KEY) === "hidden") {
        root.classList.add("is-info-hidden");
        el.infoToggle.setAttribute("aria-pressed", "false");
      }
    } catch {}

    const isOpen = () => !root.hidden;
    const originalUrl = (attachmentId) => `${basePath}/api/attachments/${attachmentId}/content`;
    const thumbnailUrl = (attachmentId) => `${basePath}/api/attachments/${attachmentId}/thumbnail`;
    const rotationOf = (attachmentId) => rotations.get(attachmentId) || 0;
    const currentRotation = () => rotationOf(view.request?.attachmentId);
    const items = () => options.getItems() || [];
    const indexOf = (list, key) => list.findIndex((item) => options.keyOf(item) === key);

    // ---------- Image loading ----------

    // Originals are cached per attachment so neighbours can be preloaded and reused without a second download.
    function loadOriginal(attachmentId, priority = "high") {
      const cached = originals.get(attachmentId);
      if (cached && cached.status !== "error") {
        originals.delete(attachmentId);
        originals.set(attachmentId, cached);
        return cached;
      }
      const image = new Image();
      const entry = { image, status: "loading", listeners: new Set() };
      const settle = (status) => {
        image.onload = null;
        image.onerror = null;
        entry.status = status;
        for (const listener of entry.listeners) listener(entry);
        entry.listeners.clear();
      };
      image.decoding = "async";
      image.fetchPriority = priority;
      image.onload = async () => {
        try { await image.decode(); } catch { settle("error"); return; }
        settle("ready");
      };
      image.onerror = () => settle("error");
      image.src = originalUrl(attachmentId);
      originals.set(attachmentId, entry);
      for (const [id, old] of originals) {
        if (originals.size <= ORIGINAL_CACHE_LIMIT) break;
        if (id === attachmentId || id === view.request?.attachmentId) continue;
        originals.delete(id);
        old.listeners.clear();
        old.image.onload = null;
        old.image.onerror = null;
        if (!old.image.isConnected) old.image.removeAttribute("src");
      }
      return entry;
    }

    // Thumbnails stand in while an original loads and fill the carousel slots beside the current image.
    function loadThumbnail(attachmentId) {
      const cached = thumbnails.get(attachmentId);
      if (cached) {
        thumbnails.delete(attachmentId);
        thumbnails.set(attachmentId, cached);
        return cached;
      }
      const src = thumbnailUrl(attachmentId);
      const url = options.createThumbnailUrl?.(src) || null;
      const image = new Image();
      image.decoding = "async";
      image.src = url || src;
      const record = { image, url, ready: image.decode().then(() => true, () => false) };
      thumbnails.set(attachmentId, record);
      for (const [id, old] of thumbnails) {
        if (thumbnails.size <= THUMBNAIL_CACHE_LIMIT) break;
        if (id === attachmentId || old.image.isConnected) continue;
        thumbnails.delete(id);
        if (old.url) URL.revokeObjectURL(old.url);
      }
      return record;
    }

    function clearThumbnails() {
      for (const record of thumbnails.values()) {
        if (record.url) URL.revokeObjectURL(record.url);
      }
      thumbnails.clear();
    }

    function preloadNeighbours(key) {
      const list = items();
      const index = indexOf(list, key);
      for (const neighbour of [list[index + 1], list[index - 1]]) {
        if (!neighbour) continue;
        const attachmentId = options.attachmentIdOf(neighbour);
        if (loadOriginal(attachmentId, "low").status !== "ready") loadThumbnail(attachmentId);
      }
    }

    function setImage(image) {
      const previous = el.image;
      image.id = "attachmentPreviewImage";
      image.draggable = false;
      image.classList.remove("attachment-viewer-side");
      if (previous !== image) {
        previous.replaceWith(image);
        previous.removeAttribute("id");
      }
      el.image = image;
      layout();
    }

    // ---------- Open, close, navigate ----------

    function clearRequest() {
      const request = view.request;
      view.request = null;
      if (request?.listener) request.entry.listeners.delete(request.listener);
    }

    function open(key) {
      const list = items();
      const index = indexOf(list, key);
      if (index < 0) return;
      const item = list[index];
      const attachmentId = options.attachmentIdOf(item);
      const info = options.describe(item);
      if (!isOpen()) {
        view.returnFocus = document.activeElement;
        root.hidden = false;
        if (options.modal) root.showModal(); else root.show();
        document.documentElement.classList.add("attachment-viewer-open");
      }
      clearRequest();
      clearSides();
      hideNotice();
      view.key = key;
      resetView();
      renderInfo(item, info, index, list.length);
      renderStrip(list);
      el.originalLink.href = originalUrl(attachmentId);
      el.previous.disabled = index <= 0;
      el.next.disabled = index >= list.length - 1;

      const entry = loadOriginal(attachmentId);
      const request = { attachmentId, entry, listener: null, originalShown: false, placeholderShown: false, showPlaceholder: null };
      view.request = request;
      const showOriginal = () => {
        if (view.request !== request) return;
        el.stage.classList.remove("is-loading");
        el.loading.hidden = true;
        if (entry.status === "ready") {
          entry.image.alt = info.alt;
          request.originalShown = true;
          setImage(entry.image);
        } else {
          // Keep the thumbnail visible when the original cannot be loaded or decoded.
          request.showPlaceholder?.();
          showNotice("原图加载失败，当前显示的是缩略图", { retry: true });
        }
        preloadNeighbours(key);
      };

      if (entry.status === "ready") {
        showOriginal();
      } else {
        const thumbnail = loadThumbnail(attachmentId);
        // The previous image stays on screen until the thumbnail is decoded, so switching never flashes blank.
        request.showPlaceholder = () => {
          request.showPlaceholder = null;
          if (view.request !== request || request.originalShown || request.placeholderShown) return;
          request.placeholderShown = true;
          thumbnail.image.alt = info.alt;
          setImage(thumbnail.image);
        };
        if (thumbnail.image.complete && thumbnail.image.naturalWidth) request.showPlaceholder();
        else thumbnail.ready.then(() => request.showPlaceholder?.());
        if (entry.status === "error") {
          showOriginal();
        } else {
          el.stage.classList.add("is-loading");
          el.loading.hidden = false;
          request.listener = showOriginal;
          entry.listeners.add(showOriginal);
        }
      }
      if (!root.contains(document.activeElement)) el.stage.focus({ preventScroll: true });
    }

    function close() {
      if (!isOpen()) return;
      clearRequest();
      clearSides();
      hideNotice();
      endGestures();
      global.clearTimeout(view.slideTimer);
      view.sliding = false;
      view.key = null;
      root.hidden = true;
      if (root.open) root.close();
      document.documentElement.classList.remove("attachment-viewer-open");
      const empty = new Image();
      empty.alt = "附件预览";
      setImage(empty);
      el.title.textContent = "附件预览";
      el.infoBody.innerHTML = "";
      clearStrip();
      el.stage.classList.remove("is-loading");
      el.loading.hidden = true;
      setOffset(0, 0);
      const returnFocus = view.returnFocus;
      view.returnFocus = null;
      if (returnFocus?.isConnected && returnFocus.getClientRects().length) returnFocus.focus({ preventScroll: true });
      options.onClose?.();
    }

    function hasNeighbour(direction) {
      const list = items();
      const index = indexOf(list, view.key) + direction;
      return index >= 0 && index < list.length;
    }

    function navigate(direction) {
      const list = items();
      const index = indexOf(list, view.key);
      if (index < 0) return;
      const target = list[index + direction];
      if (!target) {
        showNotice(direction < 0 ? "已是当前列表第一张" : `已是当前列表最后一张（共 ${list.length} 张）`, { timeout: 2200 });
        return;
      }
      open(options.keyOf(target));
    }

    function retry() {
      const request = view.request;
      if (!request) return;
      originals.delete(request.attachmentId);
      open(view.key);
    }

    // Keeps the viewer in step with a reloaded list, e.g. after an edit.
    function sync() {
      if (!isOpen()) return;
      const list = items();
      const index = indexOf(list, view.key);
      if (index < 0) {
        close();
        return;
      }
      renderInfo(list[index], options.describe(list[index]), index, list.length);
      renderStrip(list);
      el.previous.disabled = index <= 0;
      el.next.disabled = index >= list.length - 1;
    }

    // ---------- Info panel and strip ----------

    function renderInfo(item, info, index, total) {
      const amount = info.amount?.missing
        ? '<strong class="is-missing">待复核</strong>'
        : `<strong>${info.amount.currency === "CNY" ? "<small>¥</small>" : ""}${escapeHtml(info.amount.text)}${info.amount.currency === "CNY" ? "" : ` <small>${escapeHtml(info.amount.currency)}</small>`}</strong>`;
      const note = String(info.note || "").trim();
      el.count.innerHTML = `${index + 1} <small>/ ${total}</small>`;
      el.title.textContent = info.title;
      el.infoBody.innerHTML = `
        <div class="attachment-viewer-summary">
          <div class="attachment-viewer-amount"><span>报账金额</span>${amount}</div>
          <div class="attachment-viewer-tags">${info.tagsHtml || ""}</div>
        </div>
        <dl class="attachment-viewer-fields">
          ${info.store ? `<div><dt>门店</dt><dd>${escapeHtml(info.store)}</dd></div>` : ""}
          <div><dt>报账人</dt><dd>${escapeHtml(info.reporter || "未填写")}</dd></div>
          <div><dt>提交时间</dt><dd><span class="attachment-viewer-time-full">${escapeHtml(info.createdAt)}</span><span class="attachment-viewer-time-short">${escapeHtml(info.createdAtShort || info.createdAt)}</span></dd></div>
          <div class="attachment-viewer-note${note ? "" : " is-empty"}"><dt>备注</dt><dd>${note ? escapeHtml(note) : '<span class="attachment-viewer-muted">无</span>'}</dd></div>
        </dl>
      `;
      for (const action of actions) {
        const button = el.actions.querySelector(`[data-viewer-action="${action.key}"]`);
        button.hidden = action.visible ? !action.visible(item) : false;
      }
    }

    function renderStrip(list) {
      if (compactQuery.matches) {
        clearStrip();
        return;
      }
      if (view.stripItems !== list.map((item) => options.keyOf(item)).join(",")) {
        clearStrip();
        view.stripItems = list.map((item) => options.keyOf(item)).join(",");
        el.strip.innerHTML = list.map((item) => {
          const info = options.describe(item);
          const src = thumbnailUrl(options.attachmentIdOf(item));
          const cachedUrl = options.createThumbnailUrl?.(src) || null;
          if (cachedUrl) view.stripUrls.push(cachedUrl);
          return `<button type="button" class="attachment-viewer-thumb${info.needsReview ? " needs-review" : ""}" data-viewer-key="${escapeHtml(options.keyOf(item))}" aria-label="${escapeHtml(info.alt)}${info.needsReview ? "（需复核）" : ""}"><img src="${escapeHtml(cachedUrl || src)}" alt="" loading="lazy" decoding="async" /></button>`;
        }).join("");
      }
      let active = null;
      for (const thumb of el.strip.children) {
        const current = thumb.getAttribute("data-viewer-key") === String(view.key);
        thumb.setAttribute("aria-current", String(current));
        if (current) active = thumb;
      }
      if (active) {
        const left = active.offsetLeft - (el.strip.clientWidth - active.offsetWidth) / 2;
        el.strip.scrollTo({ left, behavior: reducedMotionQuery.matches ? "auto" : "smooth" });
      }
    }

    function clearStrip() {
      for (const url of view.stripUrls) URL.revokeObjectURL(url);
      view.stripUrls = [];
      view.stripItems = null;
      el.strip.replaceChildren();
    }

    function showNotice(message, { retry: canRetry = false, timeout = 0 } = {}) {
      global.clearTimeout(view.noticeTimer);
      el.noticeText.textContent = message;
      el.retry.hidden = !canRetry;
      el.notice.classList.toggle("is-error", canRetry);
      el.notice.hidden = false;
      if (timeout) view.noticeTimer = global.setTimeout(hideNotice, timeout);
    }

    function hideNotice() {
      global.clearTimeout(view.noticeTimer);
      el.notice.hidden = true;
    }

    // ---------- Layout, zoom and rotation ----------

    // Size an image to fit the stage (accounting for rotation); zoom and pan are applied on top as a transform.
    function fitImage(image, rotation) {
      const width = image.naturalWidth;
      const height = image.naturalHeight;
      if (!width || !height || !el.stage.clientWidth) {
        image.style.width = image.style.height = "";
        return false;
      }
      const quarterTurn = rotation % 180 !== 0;
      const fit = Math.min(
        (el.stage.clientWidth - 24) / (quarterTurn ? height : width),
        (el.stage.clientHeight - 24) / (quarterTurn ? width : height),
      );
      image.style.width = `${width * fit}px`;
      image.style.height = `${height * fit}px`;
      return true;
    }

    function layout() {
      if (!fitImage(el.image, currentRotation())) {
        el.image.style.transform = "";
        updateZoomLabel();
        positionSides();
        return;
      }
      applyTransform();
    }

    function bounds() {
      const quarterTurn = currentRotation() % 180 !== 0;
      const width = (quarterTurn ? el.image.offsetHeight : el.image.offsetWidth) * view.zoom;
      const height = (quarterTurn ? el.image.offsetWidth : el.image.offsetHeight) * view.zoom;
      return { x: Math.max(0, (width - el.stage.clientWidth) / 2 + 24), y: Math.max(0, (height - el.stage.clientHeight) / 2 + 24) };
    }

    function applyTransform() {
      const limit = bounds();
      view.x = Math.min(limit.x, Math.max(-limit.x, view.x));
      view.y = Math.min(limit.y, Math.max(-limit.y, view.y));
      el.image.style.transform =
        `translate(-50%, -50%) translate(${view.x + view.offsetX}px, ${view.y + view.offsetY}px) rotate(${currentRotation()}deg) scale(${view.zoom})`;
      el.stage.classList.toggle("can-pan", view.zoom > 1.001);
      updateZoomLabel();
      positionSides();
    }

    function isOriginalShown() {
      const request = view.request;
      return Boolean(request && request.entry.status === "ready" && el.image === request.entry.image);
    }

    // Zoom that shows the original at 1:1 pixels; falls back to 2x while only the thumbnail is shown.
    function actualSizeZoom() {
      if (!isOriginalShown() || !el.image.offsetWidth) return 2;
      const zoom = el.image.naturalWidth / el.image.offsetWidth;
      return zoom > 1.2 ? Math.min(zoom, MAX_ZOOM) : 2;
    }

    function updateZoomLabel() {
      el.zoom.textContent = isOriginalShown() && el.image.offsetWidth
        ? `${Math.round((el.image.offsetWidth * view.zoom / el.image.naturalWidth) * 100)}%`
        : view.zoom <= 1.001 ? "--" : `${view.zoom.toFixed(1)}×`;
    }

    function animate() {
      el.stage.classList.add("is-animating");
      global.clearTimeout(view.animationTimer);
      view.animationTimer = global.setTimeout(() => el.stage.classList.remove("is-animating"), SLIDE_MS - 10);
    }

    // Zoom keeping the stage point (px, py), relative to the stage centre, fixed on screen.
    function zoomTo(zoom, px = 0, py = 0, withAnimation = true) {
      const next = Math.min(MAX_ZOOM, Math.max(1, zoom));
      const ratio = next / view.zoom;
      view.x = px - (px - view.x) * ratio;
      view.y = py - (py - view.y) * ratio;
      view.zoom = next;
      if (withAnimation) animate();
      applyTransform();
    }

    function resetView() {
      view.zoom = 1;
      view.x = 0;
      view.y = 0;
      setOffset(0, 0);
      layout();
    }

    function toggleZoom(px = 0, py = 0) {
      if (view.zoom > 1.001) {
        animate();
        resetView();
      } else {
        zoomTo(actualSizeZoom(), px, py);
      }
    }

    function rotate() {
      const attachmentId = view.request?.attachmentId;
      if (!attachmentId) return;
      const degrees = currentRotation() + 90;
      rotations.delete(attachmentId);
      rotations.set(attachmentId, degrees);
      while (rotations.size > ROTATION_STORAGE_LIMIT) rotations.delete(rotations.keys().next().value);
      try {
        const stored = [...rotations].map(([id, value]) => [id, ((value % 360) + 360) % 360]).filter(([, value]) => value);
        global.localStorage.setItem(ROTATION_STORAGE_KEY, JSON.stringify(stored));
      } catch {}
      animate();
      resetView();
    }

    function toggleInfo() {
      const hidden = root.classList.toggle("is-info-hidden");
      el.infoToggle.setAttribute("aria-pressed", String(!hidden));
      try { global.localStorage.setItem(INFO_STORAGE_KEY, hidden ? "hidden" : "shown"); } catch {}
      resetView();
    }

    function setOffset(x, y) {
      view.offsetX = x;
      view.offsetY = y;
      const dismiss = y > 0 ? Math.min(0.85, y / (DISMISS_DISTANCE * 3)) : 0;
      root.style.setProperty("--viewer-dismiss", String(dismiss));
    }

    // ---------- Photo-style carousel ----------

    // While swiping, the neighbours sit one stage-width (plus a gap) to either side and follow the finger.
    function prepareSides() {
      const list = items();
      const index = indexOf(list, view.key);
      for (const direction of [-1, 1]) {
        const neighbour = list[index + direction];
        const existing = view.sides.get(direction);
        const attachmentId = neighbour ? options.attachmentIdOf(neighbour) : null;
        if (existing && existing.attachmentId === attachmentId) continue;
        if (existing) removeSide(direction);
        if (!neighbour) continue;
        const entry = originals.get(attachmentId);
        const image = entry?.status === "ready" ? entry.image : loadThumbnail(attachmentId).image;
        if (image === el.image || image.isConnected) continue;
        image.removeAttribute("id");
        image.alt = "";
        image.classList.add("attachment-viewer-side");
        image.style.transform = "";
        el.stage.insertBefore(image, el.previous);
        const side = { attachmentId, image, onload: null };
        if (!fitImage(image, rotationOf(attachmentId))) {
          side.onload = () => {
            side.onload = null;
            fitImage(image, rotationOf(attachmentId));
            positionSides();
          };
          image.addEventListener("load", side.onload, { once: true });
        }
        view.sides.set(direction, side);
      }
      positionSides();
    }

    function positionSides() {
      const width = el.stage.clientWidth;
      for (const [direction, side] of view.sides) {
        side.image.style.transform =
          `translate(-50%, -50%) translate(${direction * (width + SLIDE_GAP) + view.offsetX}px, 0px) rotate(${rotationOf(side.attachmentId)}deg)`;
      }
    }

    function removeSide(direction) {
      const side = view.sides.get(direction);
      if (!side) return;
      view.sides.delete(direction);
      if (side.onload) side.image.removeEventListener("load", side.onload);
      side.image.classList.remove("attachment-viewer-side");
      if (side.image !== el.image) side.image.remove();
    }

    function clearSides() {
      for (const direction of [...view.sides.keys()]) removeSide(direction);
    }

    // The neighbour slides into the centre; the same element then becomes the current image, so nothing reloads.
    function commitSwipe(direction) {
      const width = el.stage.clientWidth;
      view.sliding = true;
      animate();
      setOffset(-direction * (width + SLIDE_GAP), 0);
      applyTransform();
      global.clearTimeout(view.slideTimer);
      view.slideTimer = global.setTimeout(() => {
        view.sliding = false;
        if (!isOpen()) return;
        const list = items();
        const target = list[indexOf(list, view.key) + direction];
        if (!target) {
          settleOffset();
          return;
        }
        setImage(new Image());
        open(options.keyOf(target));
      }, SLIDE_MS);
    }

    function settleOffset() {
      animate();
      setOffset(0, 0);
      applyTransform();
    }

    // ---------- Pointer gestures ----------

    function stagePoint(event) {
      const rect = el.stage.getBoundingClientRect();
      return [event.clientX - rect.left - rect.width / 2, event.clientY - rect.top - rect.height / 2];
    }

    function endGestures() {
      view.pointers.clear();
      view.gesture = null;
      el.stage.classList.remove("is-panning");
    }

    function startPinch() {
      const [a, b] = [...view.pointers.values()];
      setOffset(0, 0);
      view.gesture = {
        type: "pinch",
        distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2,
        zoom: view.zoom, x: view.x, y: view.y,
      };
    }

    function startPan(pointer) {
      view.gesture = { type: "pan", startX: pointer.x, startY: pointer.y, x: view.x, y: view.y };
      el.stage.classList.add("is-panning");
    }

    // Touch double-tap: two taps within 300ms and 30px toggle between fit and actual size.
    function handleTap(pointer) {
      const now = performance.now();
      const last = view.lastTap;
      if (last && now - last.time < 300 && Math.hypot(pointer.x - last.x, pointer.y - last.y) < 30) {
        view.lastTap = null;
        toggleZoom(pointer.x, pointer.y);
        return;
      }
      view.lastTap = { time: now, x: pointer.x, y: pointer.y };
    }

    function finishSwipe(gesture) {
      if (gesture.type === "swipe") {
        const direction = gesture.dx < 0 ? 1 : -1;
        if (Math.abs(gesture.dx) >= SWIPE_DISTANCE) {
          if (hasNeighbour(direction)) {
            commitSwipe(direction);
            return;
          }
          navigate(direction);
        }
      } else if (gesture.type === "dismiss" && view.offsetY >= DISMISS_DISTANCE) {
        close();
        return;
      }
      settleOffset();
    }

    // One pointer pans a zoomed image, or on touch swipes sideways to change attachment and down to close.
    // Two pointers pinch-zoom around their midpoint.
    el.stage.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      if (event.target instanceof Element && event.target.closest("button")) return;
      if (view.sliding) return;
      // The image follows the finger directly, so stop any snap-back still in progress.
      global.clearTimeout(view.animationTimer);
      el.stage.classList.remove("is-animating");
      const [x, y] = stagePoint(event);
      view.lastPointerType = event.pointerType;
      try { el.stage.setPointerCapture(event.pointerId); } catch {}
      view.pointers.set(event.pointerId, { x, y, startX: x, startY: y });
      if (view.pointers.size === 2) {
        startPinch();
      } else if (view.pointers.size === 1) {
        if (view.zoom > 1.001) startPan(view.pointers.get(event.pointerId));
        else if (event.pointerType !== "mouse") view.gesture = { type: "pending", startX: x, startY: y };
        else view.gesture = null;
      }
    });

    el.stage.addEventListener("pointermove", (event) => {
      const pointer = view.pointers.get(event.pointerId);
      const gesture = view.gesture;
      if (!pointer || !gesture) return;
      [pointer.x, pointer.y] = stagePoint(event);
      if (gesture.type === "pinch") {
        const [a, b] = [...view.pointers.values()];
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;
        const zoom = Math.min(MAX_ZOOM, Math.max(1, gesture.zoom * Math.hypot(a.x - b.x, a.y - b.y) / gesture.distance));
        const ratio = zoom / gesture.zoom;
        view.zoom = zoom;
        view.x = midX - (gesture.midX - gesture.x) * ratio;
        view.y = midY - (gesture.midY - gesture.y) * ratio;
        applyTransform();
        return;
      }
      const dx = pointer.x - gesture.startX;
      const dy = pointer.y - gesture.startY;
      if (gesture.type === "pan") {
        view.x = gesture.x + dx;
        view.y = gesture.y + dy;
        applyTransform();
      } else if (gesture.type === "pending" && Math.hypot(dx, dy) > 10) {
        gesture.type = Math.abs(dx) > Math.abs(dy) ? "swipe" : dy > 0 ? "dismiss" : "ignored";
        if (gesture.type === "swipe") prepareSides();
      }
      gesture.dx = dx;
      if (gesture.type === "swipe") {
        setOffset(hasNeighbour(dx < 0 ? 1 : -1) ? dx : dx * 0.3, 0);
        applyTransform();
      } else if (gesture.type === "dismiss") {
        setOffset(dx * 0.3, Math.max(0, dy));
        applyTransform();
      }
    });

    function releasePointer(event) {
      const pointer = view.pointers.get(event.pointerId);
      if (!pointer) return;
      view.pointers.delete(event.pointerId);
      const gesture = view.gesture;
      if (gesture?.type === "pinch") {
        if (view.zoom <= 1.001) {
          view.gesture = null;
          animate();
          resetView();
        } else if (view.pointers.size === 1) {
          startPan([...view.pointers.values()][0]);
        } else {
          view.gesture = null;
        }
        return;
      }
      if (view.pointers.size) return;
      view.gesture = null;
      el.stage.classList.remove("is-panning");
      if (event.type === "pointercancel") {
        if (gesture?.type === "swipe" || gesture?.type === "dismiss") settleOffset();
        return;
      }
      if (gesture?.type === "pending") handleTap(pointer);
      else if (gesture?.type === "swipe" || gesture?.type === "dismiss") finishSwipe(gesture);
      else if (gesture?.type === "pan" && event.pointerType !== "mouse" &&
        Math.hypot(pointer.x - pointer.startX, pointer.y - pointer.startY) < 10) handleTap(pointer);
    }

    el.stage.addEventListener("pointerup", releasePointer);
    el.stage.addEventListener("pointercancel", releasePointer);

    el.stage.addEventListener("dblclick", (event) => {
      // Touch double-taps are handled from pointer events so they also work where dblclick does not fire.
      if (view.lastPointerType !== "mouse") return;
      if (event.target instanceof Element && event.target.closest("button")) return;
      toggleZoom(...stagePoint(event));
    });

    el.stage.addEventListener("wheel", (event) => {
      event.preventDefault();
      const [px, py] = stagePoint(event);
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      zoomTo(view.zoom * Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.0015)), px, py, false);
    }, { passive: false });

    // ---------- Controls ----------

    root.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const tool = target?.closest("[data-viewer-tool]");
      if (tool) {
        const action = tool.getAttribute("data-viewer-tool");
        if (action === "zoom-in") zoomTo(view.zoom * 1.25);
        else if (action === "zoom-out") zoomTo(view.zoom / 1.25);
        else if (action === "zoom-toggle") toggleZoom();
        else if (action === "fit") { animate(); resetView(); }
        else if (action === "rotate") rotate();
        else if (action === "info") toggleInfo();
        return;
      }
      const actionButton = target?.closest("[data-viewer-action]");
      if (actionButton) {
        const action = actions.find((candidate) => candidate.key === actionButton.getAttribute("data-viewer-action"));
        const list = items();
        const item = list[indexOf(list, view.key)];
        if (action && item) action.run(item, api);
        return;
      }
      const thumb = target?.closest("[data-viewer-key]");
      if (thumb && thumb.getAttribute("data-viewer-key") !== String(view.key)) {
        const list = items();
        const item = list.find((candidate) => String(options.keyOf(candidate)) === thumb.getAttribute("data-viewer-key"));
        if (item) open(options.keyOf(item));
      }
    });
    el.close.addEventListener("click", close);
    el.previous.addEventListener("click", () => navigate(-1));
    el.next.addEventListener("click", () => navigate(1));
    el.retry.addEventListener("click", retry);
    root.addEventListener("cancel", (event) => {
      event.preventDefault();
      if (!options.isBlocked?.()) close();
    });

    // Capture phase, so the page's own Escape handling does not also run while the viewer is on top.
    global.addEventListener("keydown", (event) => {
      if (!isOpen() || options.isBlocked?.() || event.ctrlKey || event.metaKey || event.altKey) return;
      const keyActions = {
        ArrowLeft: () => navigate(-1),
        ArrowRight: () => navigate(1),
        Escape: close,
        "+": () => zoomTo(view.zoom * 1.25),
        "=": () => zoomTo(view.zoom * 1.25),
        "-": () => zoomTo(view.zoom / 1.25),
        0: () => { animate(); resetView(); },
        r: rotate,
        R: rotate,
        i: toggleInfo,
        I: toggleInfo,
      };
      const action = keyActions[event.key];
      if (!action) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      action();
    }, true);

    new ResizeObserver(() => {
      if (isOpen()) layout();
    }).observe(el.stage);
    compactQuery.addEventListener("change", () => {
      if (isOpen()) renderStrip(items());
    });

    const api = {
      open,
      close,
      sync,
      isOpen,
      currentKey: () => view.key,
      rotation: rotationOf,
      focus: () => el.stage.focus({ preventScroll: true }),
      focusAction: (key) => el.actions.querySelector(`[data-viewer-action="${key}"]`)?.focus({ preventScroll: true }),
      clearCache: clearThumbnails,
      element: root,
    };
    return api;
  }

  global.ReimbursementAttachmentViewer = { create };
})(globalThis);
