import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import puppeteer from "puppeteer";
import sharp from "sharp";

// Isolated browser fixture: no application database, credentials or external requests.
const html = await fs.readFile(new URL("../src/admin/public/admin.html", import.meta.url));
const script = await fs.readFile(new URL("../src/admin/public/list-loading.js", import.meta.url));
const thumbnail = await sharp({ create: { width: 240, height: 180, channels: 3, background: "#3388aa" } }).webp().toBuffer();
const requests = [];
let activeImages = 0;
let maxImages = 0;
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://fixture");
  const entry = { path: url.pathname, query: url.search, completed: false };
  requests.push(entry);
  response.on("finish", () => { entry.completed = true; });
  const json = (value) => { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(value)); };
  if (url.pathname === "/expense") { response.setHeader("Content-Type", "text/html"); response.end(html); }
  else if (url.pathname === "/expense/list-loading.js") { response.setHeader("Content-Type", "text/javascript"); response.end(script); }
  else if (url.pathname === "/auth/api/session") json({ apps: ["expense"] });
  else if (url.pathname === "/expense/api/session") json({ success: true, account: { role: "partner", username: "fixture" }, permissions: { canWrite: false, canAttachment: true, canSubmit: false } });
  else if (url.pathname === "/expense/api/reports") {
    const from = url.searchParams.get("createdDateFrom");
    const base = from === "2026-09-01" ? 2000 : from === "2026-09-25" ? 1000 : 0;
    const timer = setTimeout(() => json({ success: true, total: 200, limit: 200, offset: 0, timeZone: "Asia/Shanghai",
      items: Array.from({ length: 200 }, (_, i) => ({
        id: base + i + 1, reporter: `测试${base}`, channelCode: "reimbursement_fuzzy", channelName: "Fuzzy",
        amount: 12, currency: "CNY", expenseCategory: "food", expenseCategoryLabel: "食材", note: "图片加载测试",
        createdAt: "2026-09-25 01:00:00", updatedAt: "2026-09-25 01:00:00", needsReview: false,
        billAttachment: { id: base + i + 1, exists: true }, permissions: { canDelete: false },
      })),
    }), from === "2026-09-25" ? 1200 : 30);
    response.on("close", () => clearTimeout(timer));
  } else if (url.pathname.endsWith("/thumbnail")) {
    activeImages += 1; maxImages = Math.max(maxImages, activeImages);
    const timer = setTimeout(() => { response.setHeader("Content-Type", "image/webp"); response.end(thumbnail); }, 200);
    response.on("close", () => { activeImages -= 1; clearTimeout(timer); });
  } else { response.statusCode = 404; response.end(); }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
let browser;
try {
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${server.address().port}/expense`);
  await page.waitForSelector('img[data-thumbnail-url][src^="blob:"]');
  assert.equal(requests.some((request) => request.path.endsWith("/content")), false);
  assert.ok(maxImages <= 3, `image concurrency ${maxImages}`);
  assert.ok(requests.filter((request) => request.path.endsWith("/thumbnail")).length < 30, "only nearby images should load");
  const apply = (from) => page.evaluate((date) => {
    const start = document.getElementById("createdDateFrom");
    start.value = date;
    document.getElementById("createdDateTo").value = "2026-09-30";
    start.closest("form").requestSubmit();
  }, from);
  await Promise.all([
    page.waitForRequest((request) => request.url().includes("api/reports?") && request.url().includes("2026-09-25")),
    apply("2026-09-25"),
  ]);
  await apply("2026-09-25"); // identical in-flight submission should coalesce
  await apply("2026-09-01");
  await page.waitForFunction(() => document.querySelector('tr[data-report-id="2001"]'));
  await page.waitForTimeout(1400);
  assert.equal(await page.$('tr[data-report-id="1001"]'), null);
  assert.equal(requests.filter((request) => request.path === "/expense/api/reports" && request.query.includes("createdDateFrom=2026-09-25")).length, 1);
  assert.equal(requests.find((request) => request.path === "/expense/api/reports" && request.query.includes("createdDateFrom=2026-09-25")).completed, false);
  assert.equal(requests.some((request) => request.path.endsWith("/content")), false);
  assert.ok(maxImages <= 3, `image concurrency after switching ${maxImages}`);
  const measurements = await page.evaluate(() => performance.getEntriesByType("measure").filter((entry) => entry.name.startsWith("expense:list:")).map(({ name, duration }) => ({ name, duration })));
  assert.equal(measurements.length, 2);
  const beforeMobile = requests.filter((request) => request.path.endsWith("/thumbnail")).length;
  await page.setViewport({ width: 390, height: 844 });
  await page.reload();
  await page.waitForFunction(() => document.getElementById("statusText").textContent.includes("已加载"));
  await page.waitForTimeout(300);
  assert.equal(requests.filter((request) => request.path.endsWith("/thumbnail")).length, beforeMobile, "hidden desktop table must not load images on mobile");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, maxImageConcurrency: maxImages, measurements, originalImageRequests: 0, rapidSwitch: "passed", mobileHiddenImages: "passed" }, null, 2));
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
