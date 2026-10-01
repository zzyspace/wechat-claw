/* Shared by the list page and its browser tests. No persistent client cache. */
(function (global) {
  function createRequestGate() {
    let active = null;
    return {
      run(key, execute, { force = false } = {}) {
        if (!force && active?.key === key) return active.promise;
        active?.controller.abort();
        const request = { key, controller: new AbortController(), promise: null };
        active = request;
        request.promise = Promise.resolve().then(() => {
          if (request.controller.signal.aborted) return;
          return execute(request.controller.signal, () => active === request);
        }).finally(() => { if (active === request) active = null; });
        return request.promise;
      },
    };
  }

  function createThumbnailLoader({ concurrency = 3 } = {}) {
    let observer = null;
    let generation = 0;
    let queue = [];
    let active = 0;
    const controllers = new Set();
    const images = new Map();
    // Object URLs live only for the current result set and are revoked on filter changes.
    const urls = new Map();

    function display(image, url) {
      image.src = url;
      image.style.opacity = "1";
      image.parentElement.querySelector("[data-thumbnail-status]").hidden = true;
    }

    function pump() {
      while (active < concurrency && queue.length) {
        const entry = queue.shift();
        const version = generation;
        const controller = new AbortController();
        controllers.add(controller);
        active += 1;
        fetch(entry.url, { signal: controller.signal, headers: { Accept: "image/webp" } })
          .then(async (response) => {
            if (!response.ok || !response.headers.get("Content-Type")?.startsWith("image/")) throw new Error("thumbnail unavailable");
            const blob = await response.blob();
            if (version !== generation || controller.signal.aborted) return;
            const url = URL.createObjectURL(blob);
            urls.set(entry.url, url);
            for (const image of entry.images) if (image.isConnected) display(image, url);
          })
          .catch(() => {
            if (version !== generation || controller.signal.aborted) return;
            for (const image of entry.images) {
              if (!image.isConnected) continue;
              image.parentElement.querySelector("[data-thumbnail-status]").textContent = "查看原图";
            }
          })
          .finally(() => {
            controllers.delete(controller);
            active -= 1;
            pump();
          });
      }
    }

    function enqueue(image) {
      const url = image.dataset.thumbnailUrl;
      if (urls.has(url)) { display(image, urls.get(url)); return; }
      const existing = images.get(url);
      if (existing) { existing.images.add(image); return; }
      const entry = { url, images: new Set([image]) };
      images.set(url, entry);
      queue.push(entry);
      pump();
    }

    function reset({ clearCache = true } = {}) {
      generation += 1;
      observer?.disconnect();
      observer = null;
      queue = [];
      if (clearCache) {
        for (const entry of images.values()) for (const image of entry.images) {
          if (!image.isConnected) continue;
          image.removeAttribute("src");
          image.style.opacity = "0";
          const status = image.parentElement.querySelector("[data-thumbnail-status]");
          status.hidden = false;
          status.textContent = "加载中";
        }
      }
      images.clear();
      for (const controller of controllers) controller.abort();
      if (clearCache) {
        for (const url of urls.values()) URL.revokeObjectURL(url);
        urls.clear();
      }
    }

    function mount(container) {
      reset({ clearCache: false });
      const mountedGeneration = generation;
      observer = new IntersectionObserver((entries) => {
        if (mountedGeneration !== generation) return;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          observer?.unobserve(entry.target);
          enqueue(entry.target);
        }
      }, { rootMargin: "160px 0px" });
      for (const image of container.querySelectorAll("[data-thumbnail-url]")) observer.observe(image);
    }

    return { mount, reset };
  }

  global.ReimbursementListLoading = { createRequestGate, createThumbnailLoader };
})(globalThis);
