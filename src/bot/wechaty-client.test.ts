import assert from "node:assert/strict";
import { test } from "node:test";

import type { Logger } from "../core/logging/logger.js";
import { sendOnlineNoticeWithRetry, shouldSendWaitingForScanAlert } from "./wechaty-client.js";
import type { WechatyInstance } from "./types.js";

function createLogger(records: Array<{ level: string; message: string; context?: Record<string, unknown> }>) {
  return {
    debug(message: string, context?: Record<string, unknown>) {
      records.push({ level: "debug", message, context });
    },
    error(message: string, context?: Record<string, unknown>) {
      records.push({ level: "error", message, context });
    },
    info(message: string, context?: Record<string, unknown>) {
      records.push({ level: "info", message, context });
    },
    warn(message: string, context?: Record<string, unknown>) {
      records.push({ level: "warn", message, context });
    },
  } satisfies Logger;
}

test("shouldSendWaitingForScanAlert only returns true for Waiting scan events", () => {
  assert.equal(shouldSendWaitingForScanAlert("Waiting"), true);
  assert.equal(shouldSendWaitingForScanAlert("Timeout"), false);
  assert.equal(shouldSendWaitingForScanAlert("Scanned"), false);
  assert.equal(shouldSendWaitingForScanAlert("Confirmed"), false);
});

test("sendOnlineNoticeWithRetry retries contact lookup misses and eventually delivers", async () => {
  const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
  const deliveredTexts: string[] = [];
  let contactFindCallCount = 0;

  const bot = {
    Contact: {
      find: async () => {
        contactFindCallCount += 1;

        if (contactFindCallCount === 1) {
          return null;
        }

        return {
          async say(text: string) {
            deliveredTexts.push(text);
          },
        };
      },
    },
    on() {
      return this;
    },
    async start() {
      // no-op
    },
    async stop() {
      // no-op
    },
  } satisfies WechatyInstance;

  const slept: number[] = [];
  const result = await sendOnlineNoticeWithRetry(
    bot,
    "Ryan。",
    "[wechat-claw] bot 已上线",
    createLogger(logs),
    {
      retryDelaysMs: [10, 20],
      async sleep(ms: number) {
        slept.push(ms);
      },
    },
  );

  assert.equal(result.delivered, true);
  assert.equal(contactFindCallCount, 2);
  assert.deepEqual(slept, [10]);
  assert.deepEqual(deliveredTexts, ["[wechat-claw] bot 已上线"]);
  assert(
    logs.some(
      (entry) =>
        entry.message === "Retrying online notice delivery after contact lookup miss" &&
        entry.context?.debugContactName === "Ryan。",
    ),
  );
});

test("sendOnlineNoticeWithRetry stops after configured retries when contact lookup keeps missing", async () => {
  const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
  let contactFindCallCount = 0;

  const bot = {
    Contact: {
      find: async () => {
        contactFindCallCount += 1;
        return null;
      },
    },
    on() {
      return this;
    },
    async start() {
      // no-op
    },
    async stop() {
      // no-op
    },
  } satisfies WechatyInstance;

  const slept: number[] = [];
  const result = await sendOnlineNoticeWithRetry(
    bot,
    "Ryan。",
    "[wechat-claw] bot 已上线",
    createLogger(logs),
    {
      retryDelaysMs: [10, 20],
      async sleep(ms: number) {
        slept.push(ms);
      },
    },
  );

  assert.equal(result.delivered, false);
  assert.match(result.error ?? "", /Delivery target not found/);
  assert.equal(contactFindCallCount, 3);
  assert.deepEqual(slept, [10, 20]);
  assert.equal(
    logs.filter((entry) => entry.message === "Retrying online notice delivery after contact lookup miss").length,
    2,
  );
});

test("sendOnlineNoticeWithRetry does not retry non-lookup delivery failures", async () => {
  const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
  let contactFindCallCount = 0;

  const bot = {
    Contact: {
      find: async () => {
        contactFindCallCount += 1;
        return {
          async say() {
            throw new Error("network down");
          },
        };
      },
    },
    on() {
      return this;
    },
    async start() {
      // no-op
    },
    async stop() {
      // no-op
    },
  } satisfies WechatyInstance;

  const slept: number[] = [];
  const result = await sendOnlineNoticeWithRetry(
    bot,
    "Ryan。",
    "[wechat-claw] bot 已上线",
    createLogger(logs),
    {
      retryDelaysMs: [10, 20],
      async sleep(ms: number) {
        slept.push(ms);
      },
    },
  );

  assert.equal(result.delivered, false);
  assert.equal(result.error, "network down");
  assert.equal(contactFindCallCount, 1);
  assert.deepEqual(slept, []);
  assert.equal(
    logs.some((entry) => entry.message === "Retrying online notice delivery after contact lookup miss"),
    false,
  );
});
