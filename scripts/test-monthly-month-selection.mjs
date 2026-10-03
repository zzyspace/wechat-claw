import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import puppeteer from "puppeteer";

// Isolated public assets and fake reports; no application state or credentials.
const root = new URL("../dist/admin/public/monthly/", import.meta.url);
const assets = new Map(await Promise.all(["index.html", "app.js", "styles.css", "report-detail.js", "report-detail.css"].map(async name => [name, await fs.readFile(new URL(name, root))])));
let currentMonth = "2026-10", defaultMonth = "2026-09";
const requestedMonths = [];
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://fixture");
  const json = value => { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(value)); };
  if (url.pathname === "/expense/api/monthly-reports/options") {
    json({ success: true, currentMonth, defaultMonth, minMonth: "2026-09", timeZone: "Asia/Shanghai", stores: [{ id: "fuzzy", name: "Fuzzy", partial: false }], projects: [], reporters: [], canAttachment: false });
  } else if (url.pathname === "/expense/api/monthly-reports") {
    const month = url.searchParams.get("month"); requestedMonths.push(month);
    json({ success: true, month, store: { id: "fuzzy", name: "Fuzzy", partial: false }, groups: [], totals: [{ currency: "CNY", amountCents: 0, recordCount: 0, missingAmountCount: 0, groupCount: 0, projectCount: 0 }] });
  } else {
    const name = url.pathname === "/expense/monthly" ? "index.html" : url.pathname.slice("/expense/monthly/".length);
    if (!url.pathname.startsWith("/expense/monthly") || !assets.has(name)) { response.writeHead(404).end(); return; }
    response.setHeader("Content-Type", name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html");
    response.end(assets.get(name));
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
let browser;
try {
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
  const page = await browser.newPage(), errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  await page.emulateTimezone("America/Los_Angeles");
  await page.setViewport({ width: 1440, height: 1000 });
  const base = `http://127.0.0.1:${server.address().port}/expense/monthly`;
  const selected = month => page.waitForFunction(value => document.getElementById("month")?.value === value && document.getElementById("reportRegion")?.getAttribute("aria-busy") === "false", {}, month);
  const visit = async (query, month) => { await page.goto(base + query); await selected(month); };
  const changeMonth = month => page.$eval("#month", (input, value) => { input.value = value; input.dispatchEvent(new Event("change", { bubbles: true })); }, month);

  await visit("", "2026-09");
  assert.equal(await page.$eval("#month", input => input.min), "2026-09");
  assert.equal(await page.$eval('[data-action="prevMonth"]', button => button.disabled), true);
  assert.deepEqual(requestedMonths, ["2026-09"]);
  for (const month of ["2026-08", "2025-12", "2026-13"]) {
    const count = requestedMonths.length;
    await changeMonth(month);
    await selected("2026-09");
    assert.equal(requestedMonths.length, count, "invalid input must not query another month");
  }
  const count = requestedMonths.length;
  await page.$eval('[data-action="prevMonth"]', button => { button.disabled = false; button.click(); });
  await selected("2026-09");
  assert.equal(requestedMonths.length, count, "navigation also enforces the minimum");
  await page.click('[data-action="nextMonth"]'); await selected("2026-10");
  await page.click('[data-action="prevMonth"]'); await selected("2026-09");
  assert.equal(await page.$eval('[data-action="prevMonth"]', button => button.disabled), true);

  for (const month of ["2026-08", "2025-12", "2026-9"]) {
    await visit(`?month=${month}`, "2026-09");
    assert.equal(new URL(page.url()).searchParams.get("month"), "2026-09");
  }
  await visit("?month=2026-10", "2026-10");
  currentMonth = "2027-01"; defaultMonth = "2026-12";
  await visit("", "2026-12");
  await page.click('[data-action="nextMonth"]'); await selected("2027-01");
  await page.click('[data-action="prevMonth"]'); await selected("2026-12");

  currentMonth = "2026-10"; defaultMonth = "2026-09";
  await page.setViewport({ width: 390, height: 844 });
  await visit("", "2026-09");
  await changeMonth("2026-08"); await selected("2026-09");
  assert.equal(await page.$eval("#month", input => input.min), "2026-09");
  assert.equal(await page.$eval('[data-action="prevMonth"]', button => button.disabled), true);
  assert.ok(requestedMonths.every(month => month >= "2026-09"));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, previousMonthDefault: true, minimumAndInputGuard: true, navigationBoundary: true, urlMonths: true, yearRollover: true, mobile: true }, null, 2));
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
