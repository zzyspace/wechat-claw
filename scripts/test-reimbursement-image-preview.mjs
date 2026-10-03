import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import puppeteer from "puppeteer";
import sharp from "sharp";

// Local fixture only: no application database, credentials or production attachments.
const html = await fs.readFile(new URL("../src/admin/public/admin.html", import.meta.url));
const script = await fs.readFile(new URL("../src/admin/public/list-loading.js", import.meta.url));
const thumbnail = await sharp({ create: { width: 120, height: 240, channels: 3, background: "#3388aa" } }).webp().toBuffer();
const original = await sharp({ create: { width: 480, height: 960, channels: 3, background: "#cc6644" } }).png().toBuffer();
const requests = [];
const originals = [];
let phase = "initial load";
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://fixture");
  requests.push(url.pathname);
  response.setHeader("Cache-Control", "no-store");
  const send = (type, body) => { response.setHeader("Content-Type", type); response.end(body); };
  const json = (value) => send("application/json", JSON.stringify(value));
  if (url.pathname === "/expense") send("text/html", html);
  else if (url.pathname === "/expense/api/list-loading.js") send("text/javascript", script);
  else if (url.pathname === "/auth/api/session") json({ apps: ["expense"] });
  else if (url.pathname === "/expense/api/session") json({ success: true, account: { role: "partner", username: "fixture" }, permissions: { canWrite: false, canAttachment: true, canSubmit: false } });
  else if (url.pathname === "/expense/api/reports") json({ success: true, total: 6, limit: 200, offset: 0, timeZone: "Asia/Shanghai",
    items: Array.from({ length: 6 }, (_, i) => ({
      id: i + 1, reporter: "图片预览测试", channelCode: "reimbursement_fuzzy", channelName: "Fuzzy",
      amount: 12, currency: "CNY", expenseCategory: "food", expenseCategoryLabel: "食材", note: "隔离测试",
      createdAt: "2026-10-03 01:00:00", updatedAt: "2026-10-03 01:00:00", needsReview: false,
      billAttachment: { id: i + 1, exists: true }, permissions: { canDelete: false },
    })),
  });
  else if (url.pathname.endsWith("/thumbnail")) send("image/webp", thumbnail);
  else if (url.pathname.endsWith("/content")) {
    const entry = { id: Number(url.pathname.split("/").at(-2)), response, claimed: false };
    originals.push(entry);
    server.emit("fixture-content");
  } else { response.statusCode = 404; response.end(); }
});
async function nextOriginal(id) {
  for (;;) {
    const entry = originals.find((item) => item.id === id && !item.claimed);
    if (entry) { entry.claimed = true; return entry; }
    try {
      await once(server, "fixture-content", { signal: AbortSignal.timeout(5000) });
    } catch (error) {
      const observed = originals.map(({ id: recordId, claimed, response }) => ({ id: recordId, claimed, closed: response.destroyed }));
      throw new Error(`Waiting for original #${id} during ${phase}; observed originals: ${JSON.stringify(observed)}; recent requests: ${JSON.stringify(requests.slice(-12))}`, { cause: error });
    }
  }
}
function release(entry, fail = false) {
  if (entry.response.destroyed) return;
  entry.response.statusCode = fail ? 500 : 200;
  entry.response.setHeader("Content-Type", fail ? "text/plain" : "image/png");
  entry.response.end(fail ? "Fixture original unavailable" : original);
}
server.listen(0, "127.0.0.1");
await once(server, "listening");
let browser;
try {
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
  const page = await browser.newPage();
  await page.setCacheEnabled(false);
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  // Hold decode after a real original load to exercise callbacks that outlive navigation.
  await page.evaluateOnNewDocument(() => {
    const decode = HTMLImageElement.prototype.decode;
    window.__previewDecodeWaiters = [];
    HTMLImageElement.prototype.decode = function () {
      const pending = decode.call(this);
      if (!this.src.endsWith(window.__holdPreviewDecodeSrc || "never-match")) return pending;
      return pending.then(() => new Promise((resolve) => window.__previewDecodeWaiters.push(resolve)));
    };
  });
  await page.setViewport({ width: 1440, height: 1500 });
  await page.goto(`http://127.0.0.1:${server.address().port}/expense`);
  const cacheReady = () => page.waitForFunction(() => {
    const images = [...document.querySelectorAll("img[data-thumbnail-url]")];
    return images.length === 6 && images.every((img) => img.src.startsWith("blob:") && img.naturalWidth > 0);
  });
  await cacheReady();
  assert.equal(requests.some((url) => url.endsWith("/content")), false);
  const open = (id) => page.evaluate((reportId) => openAttachmentPreviewModal(reportId), id);
  const close = () => page.click("#attachmentPreviewClose");
  const shown = (id, width) => page.waitForFunction((reportId, pixels) => {
    const img = document.getElementById("attachmentPreviewImage");
    return !document.getElementById("attachmentPreviewModal").hidden && img.naturalWidth === pixels &&
      document.getElementById("attachmentPreviewTitle").textContent.includes(`报账 #${reportId} `);
  }, {}, id, width);

  phase = "cached placeholder and list reset";
  await open(1);
  const first = await nextOriginal(1);
  await shown(1, 120);
  const ownThumbnailUrl = await page.$eval("#attachmentPreviewImage", (img) => img.src);
  const listThumbnailUrl = await page.$eval('img[data-thumbnail-url="/expense/api/attachments/1/thumbnail"]', (img) => img.src);
  assert.ok(ownThumbnailUrl.startsWith("blob:"));
  assert.notEqual(ownThumbnailUrl, listThumbnailUrl, "preview must own its thumbnail object URL");
  await page.evaluate(async () => {
    const src = document.getElementById("attachmentPreviewImage").src;
    listThumbnails.reset();
    const image = new Image(); image.src = src;
    await image.decode();
    if (image.naturalWidth !== 120) throw new Error("Preview URL invalidated by list reset");
  });
  release(first);
  await shown(1, 480);
  await close();
  await page.evaluate(() => renderTable());
  await cacheReady();

  phase = "rapid navigation during decode";
  await page.evaluate(() => { window.__holdPreviewDecodeSrc = "/2/content"; });
  await open(2);
  release(await nextOriginal(2));
  await page.waitForFunction(() => window.__previewDecodeWaiters.length === 1);
  await page.click("#attachmentPreviewNext");
  const next = await nextOriginal(3);
  await shown(3, 120);
  await page.evaluate(async () => {
    window.__holdPreviewDecodeSrc = "";
    window.__previewDecodeWaiters.splice(0).forEach((resolve) => resolve());
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await shown(3, 120);
  assert.equal(await page.$eval("#attachmentPreviewImage", (img) => img.src.endsWith("/2/content")), false);
  release(next);
  await shown(3, 480);
  await close();

  phase = "close during decode";
  await page.evaluate(() => { window.__holdPreviewDecodeSrc = "/5/content"; });
  await open(5);
  release(await nextOriginal(5));
  await page.waitForFunction(() => window.__previewDecodeWaiters.length === 1);
  await close();
  await page.evaluate(async () => {
    window.__holdPreviewDecodeSrc = "";
    window.__previewDecodeWaiters.splice(0).forEach((resolve) => resolve());
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  assert.equal(await page.$eval("#attachmentPreviewModal", (modal) => modal.hidden), true);
  assert.equal(await page.$eval("#attachmentPreviewImage", (img) => img.hasAttribute("src")), false);

  phase = "original failure";
  await open(4);
  await shown(4, 120);
  const failed = await nextOriginal(4);
  const failedLoad = page.waitForResponse((response) => response.url().endsWith("/4/content") && response.status() === 500);
  release(failed, true);
  await failedLoad;
  await shown(4, 120);
  await close();

  phase = "mobile uncached placeholder";
  await page.setViewport({ width: 390, height: 844 });
  await page.reload();
  await page.waitForFunction(() => document.getElementById("statusText").textContent.includes("已加载"));
  const beforeMobile = requests.filter((url) => url.endsWith("/thumbnail")).length;
  await page.click('[data-attachment-preview-report-id="6"].mobile-report-attachment');
  const mobile = await nextOriginal(6);
  await shown(6, 120);
  assert.equal(await page.$eval("#attachmentPreviewImage", (img) => img.src.endsWith("/6/thumbnail")), true);
  assert.equal(requests.filter((url) => url.endsWith("/thumbnail")).length, beforeMobile + 1);
  release(mobile);
  await shown(6, 480);
  await close();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, cachedPlaceholder: "passed", originalReplacement: "passed", listResetOwnership: "passed", rapidSwitch: "passed", closeDuringDecode: "passed", originalFailure: "passed", mobileUncachedPlaceholder: "passed" }, null, 2));
} finally {
  for (const entry of originals) entry.response.destroy();
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
