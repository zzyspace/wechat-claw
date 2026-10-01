import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";

const source = fs.readFileSync(path.resolve("src/admin/public/list-loading.js"), "utf8");
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function load(extra: Record<string, unknown> = {}) {
  const context = { AbortController, ...extra };
  runInNewContext(source, context);
  return (context as any).ReimbursementListLoading;
}

test("list requests coalesce only while pending, cancel predecessors and ignore late results", async () => {
  const gate = load().createRequestGate();
  const pending: Array<{ signal: AbortSignal; done: () => void }> = [];
  const rendered: string[] = [];
  function execute(name: string) {
    return async (signal: AbortSignal, current: () => boolean) => {
      await new Promise<void>((resolve) => pending.push({ signal, done: resolve }));
      if (current() && !signal.aborted) rendered.push(name);
    };
  }
  const first = gate.run("old", execute("old"));
  assert.equal(gate.run("old", execute("duplicate")), first);
  await tick();
  assert.equal(pending.length, 1);
  const next = gate.run("new", execute("new"));
  await tick();
  assert.equal(pending[0].signal.aborted, true);
  pending[1].done();
  await next;
  pending[0].done();
  await first;
  assert.deepEqual(rendered, ["new"]);
  const reload = gate.run("new", execute("reload"));
  await tick();
  const forced = gate.run("new", execute("after-edit"), { force: true });
  await tick();
  assert.equal(pending[2].signal.aborted, true);
  pending[2].done(); pending[3].done();
  await Promise.all([reload, forced]);
  assert.deepEqual(rendered, ["new", "after-edit"]);
});

test("thumbnail loader bounds concurrency, observes visibility, cancels old work and releases URLs", async () => {
  const observers: any[] = [];
  const requests: any[] = [];
  const revoked: string[] = [];
  let id = 0;
  const library = load({
    IntersectionObserver: class {
      callback: (entries: unknown[]) => void;
      constructor(callback: (entries: unknown[]) => void) { this.callback = callback; observers.push(this); }
      observe() {} unobserve() {} disconnect() {}
    },
    URL: { createObjectURL: () => `blob:test-${++id}`, revokeObjectURL: (url: string) => revoked.push(url) },
    fetch: (url: string, options: { signal: AbortSignal }) => new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted")));
      requests.push({ url, signal: options.signal, resolve, reject });
    }),
  });
  const image = (url: string) => {
    const status = { hidden: false, textContent: "加载中" };
    return { dataset: { thumbnailUrl: url }, style: { opacity: "0" }, isConnected: true, src: "", status,
      parentElement: { querySelector: () => status }, removeAttribute() { this.src = ""; } };
  };
  const oldImages = Array.from({ length: 8 }, (_, i) => image(`/thumbnail/${i}`));
  const loader = library.createThumbnailLoader();
  loader.mount({ querySelectorAll: () => oldImages });
  assert.equal(requests.length, 0, "hidden/offscreen images must not fetch");
  observers[0].callback(oldImages.map((target) => ({ target, isIntersecting: true })));
  assert.equal(requests.length, 3);
  requests[0].resolve({ ok: true, headers: new Headers({ "Content-Type": "image/webp" }), blob: async () => new Blob(["thumb"]) });
  await tick();
  assert.equal(requests.length, 4);
  assert.equal(oldImages[0].src, "blob:test-1");
  loader.reset();
  assert.equal(requests.slice(1).every((request) => request.signal.aborted), true);
  assert.deepEqual(revoked, ["blob:test-1"]);
  assert.equal(oldImages[0].src, "");
  const nextImage = image("/thumbnail/new");
  loader.mount({ querySelectorAll: () => [nextImage] });
  observers[1].callback([{ target: nextImage, isIntersecting: true }]);
  await tick();
  assert.equal(requests.length, 5, "the previous queued images must never start");
  requests[4].resolve({ ok: false, headers: new Headers() });
  await tick();
  assert.equal(nextImage.status.textContent, "查看原图");
  assert.equal(nextImage.src, "", "failure must not automatically download the original");
  loader.reset();
});
