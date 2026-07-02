import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { ChannelConfig, DeliveryTarget } from "../core/channels/types.js";
import type { Logger } from "../core/logging/logger.js";
import { getReimbursementRawStorageDir } from "../core/runtime/state-paths.js";
import { getZonedDateParts, zonedDateTimeToUtc } from "../core/runtime/timezone.js";
import { listRecentRawMessages } from "../core/storage/raw-message-repository.js";
import { listReimbursementReportDetails, listRecentReimbursementReports } from "../scenarios/reimbursement/repository.js";
import { handleMessage } from "./message-handler.js";
import { createWechatyMessageMixinDebugDetails } from "./wechaty-client.js";
import type { WechatyInstance } from "./types.js";

process.env.WECHATY_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claw-message-handler-"));
const originalFetch = globalThis.fetch;

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

function formatLocalTimestamp(value: string, timeZone: string) {
  const date = new Date(`${value.replace(" ", "T")}Z`);
  const parts = getZonedDateParts(date, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")} ${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}:${String(parts.second).padStart(2, "0")}`;
}

function resolveExpectedMonthlyLedgerLocalTimestamp(note: string, referenceDateTime: string, timeZone: string) {
  const match = note.match(/(\d{1,2})月账/);
  assert(match);
  const month = Number(match[1]);
  const referenceDate = new Date(referenceDateTime);
  const anchorDate = new Date(referenceDate.getTime() - 15 * 24 * 60 * 60 * 1000);
  const anchorYear = getZonedDateParts(anchorDate, timeZone).year;
  const lastDay = new Date(Date.UTC(anchorYear, month, 0)).getUTCDate();
  const utcDate = zonedDateTimeToUtc(anchorYear, month, lastDay, 0, 0, 0, timeZone);
  return formatLocalTimestamp(utcDate.toISOString().slice(0, 19).replace("T", " "), timeZone);
}

function createChannel(): ChannelConfig {
  return {
    code: "loss_a",
    deliveryTargets: [{ type: "contact_name", value: "Ryan。" }],
    enabled: true,
    match: {
      type: "room_topic",
      value: "AI测试群",
    },
    scenario: "loss-report",
    summarySchedule: "",
  };
}

function createReimbursementChannel(): ChannelConfig {
  return createReimbursementChannelWithTargets([]);
}

function createReimbursementChannelWithTargets(deliveryTargets: DeliveryTarget[]): ChannelConfig {
  return {
    code: "reimbursement_a",
    deliveryTargets,
    enabled: true,
    match: {
      type: "room_topic",
      value: "AI报账群",
    },
    scenario: "reimbursement",
    summarySchedule: "",
  };
}

interface DeliveredMessage {
  targetType: "contact_name" | "room_topic";
  targetValue: string;
  text: string;
}

function createWechatyMock(
  delivered: DeliveredMessage[],
  options?: {
    missingContactNames?: string[];
    missingRoomTopics?: string[];
    rawPayloadByMessageId?: Record<string, Record<string, unknown>>;
  },
) {
  const missingContactNames = new Set(options?.missingContactNames ?? []);
  const missingRoomTopics = new Set(options?.missingRoomTopics ?? []);
  const rawPayloadByMessageId = options?.rawPayloadByMessageId ?? {};

  return {
    Contact: {
      find: async (query: Record<string, unknown>) => {
        const name = String(query.name ?? "");

        if (missingContactNames.has(name)) {
          return null;
        }

        return {
          async say(text: string) {
            delivered.push({
              targetType: "contact_name",
              targetValue: name,
              text,
            });
          },
        };
      },
    },
    Room: {
      find: async (query: Record<string, unknown>) => {
        const topic = String(query.topic ?? "");

        if (missingRoomTopics.has(topic)) {
          return null;
        }

        return {
          async say(text: string) {
            delivered.push({
              targetType: "room_topic",
              targetValue: topic,
              text,
            });
          },
        };
      },
    },
    puppet: {
      async messageRawPayload(messageId: string) {
        return rawPayloadByMessageId[messageId] ?? null;
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
}

function createMessageContext(channels: ChannelConfig[]) {
  return {
    channels,
    lossMergeWindowSeconds: 30,
    reimbursementBackwardTextMergeWindowSeconds: 3,
    lossExtractionBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    reimbursementExtractionBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    reimbursementExtractionModel: "qwen3.5-flash",
    reimbursementExtractionProvider: "qwen",
    timeZone: "Asia/Shanghai",
  };
}

test(
  "handleMessage skips storing text-only room messages",
  { concurrency: false },
  async () => {
    const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
    const beforeMessages = listRecentRawMessages(1000);

    await handleMessage(
      {
        id: () => "text-only-skip-test",
        room: async () => ({
          alias: async () => null,
          id: () => "room_1",
          topic: async () => "AI测试群",
        }),
        self: () => false,
        talker: async () => ({
          id: () => "talker_1",
          name: () => "Ryan。",
        }),
        text: () => "玻璃破了",
        type: () => 7,
      },
      {
        ...createMessageContext([createChannel()]),
        debugContactName: "Ryan。",
      },
      createLogger(logs),
    );

    const afterMessages = listRecentRawMessages(1000);

    assert.equal(afterMessages.length, beforeMessages.length);
    assert.equal(
      afterMessages.some((message) => message.messageExternalId === "text-only-skip-test"),
      false,
    );
    assert(logs.some((entry) => entry.message === "Skipped text-only room message"));
    assert.equal(logs.some((entry) => entry.message === "Received room message"), false);
  },
);

test("createWechatyMessageMixinDebugDetails captures requested values without invoking side-effect methods", async () => {
  class FakeMessageMixin {
    static Type = {
      7: "Text",
    };

    constructor() {
      // no-op
    }

    toString() {
      return "fake-message";
    }

    conversation() {
      return { id: "conversation_1" };
    }

    talker() {
      return { id: "talker_1" };
    }

    listener() {
      return { id: "listener_1" };
    }

    room() {
      return { id: "room_1" };
    }

    text() {
      return "hello";
    }

    async toRecalled() {
      return undefined;
    }

    type() {
      return 7;
    }

    self() {
      return false;
    }

    async mentionList() {
      return [{ id: "mention_1" }];
    }

    async mentionText() {
      return "hello";
    }

    async mentionSelf() {
      return false;
    }

    isReady() {
      return true;
    }

    date() {
      return new Date("2026-05-21T10:11:12.345Z");
    }

    age() {
      return 12;
    }
  }

  const details = await createWechatyMessageMixinDebugDetails(new FakeMessageMixin());

  assert.equal(details.constructor, "FakeMessageMixin");
  assert.equal(details.toString, "fake-message");
  assert.deepEqual(details.conversation, {
    constructorName: "Object",
    id: "conversation_1",
  });
  assert.deepEqual(details.talker, {
    constructorName: "Object",
    id: "talker_1",
  });
  assert.deepEqual(details.listener, {
    constructorName: "Object",
    id: "listener_1",
  });
  assert.deepEqual(details.room, {
    constructorName: "Object",
    id: "room_1",
  });
  assert.equal(details.text, "hello");
  assert.deepEqual(details.type, {
    code: 7,
    name: "Text",
  });
  assert.equal(details.self, false);
  assert.deepEqual(details.mentionList, [
    {
      constructorName: "Object",
      id: "mention_1",
    },
  ]);
  assert.equal(details.mentionText, "hello");
  assert.equal(details.mentionSelf, false);
  assert.equal(details.isReady, true);
  assert.equal(details.date, "2026-05-21T10:11:12.345Z");
  assert.equal(details.age, 12);
  assert.equal("from" in details, false);
  assert.equal("to" in details, false);
  assert.equal("say" in details, false);
  assert.equal("recall" in details, false);
  assert.equal("mention" in details, false);
  assert.equal("ready" in details, false);
  assert.equal("forward" in details, false);
});

test(
  "handleMessage keeps text-only messages when a recent image from the same sender exists",
  { concurrency: false },
  async () => {
    const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
    const imageMessageId = "image-before-text-test";
    const textMessageId = "text-after-image-test";

    await handleMessage(
      {
        id: () => imageMessageId,
        room: async () => ({
          alias: async () => null,
          id: () => "room_1",
          topic: async () => "AI测试群",
        }),
        self: () => false,
        talker: async () => ({
          id: () => "talker_1",
          name: () => "Ryan。",
        }),
        text: () => "",
        toFileBox: async () => ({
          name: "sample.jpg",
          toBuffer: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
        }),
        type: () => 6,
        wechaty: {
          Contact: {
            find: async () => null,
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
        },
      },
      {
        ...createMessageContext([createChannel()]),
        debugContactName: "Ryan。",
      },
      createLogger(logs),
    );

    await handleMessage(
      {
        id: () => textMessageId,
        room: async () => ({
          alias: async () => null,
          id: () => "room_1",
          topic: async () => "AI测试群",
        }),
        self: () => false,
        talker: async () => ({
          id: () => "talker_1",
          name: () => "Ryan。",
        }),
        text: () => "玻璃破了",
        type: () => 7,
        wechaty: {
          Contact: {
            find: async () => null,
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
        },
      },
      {
        ...createMessageContext([createChannel()]),
        debugContactName: "Ryan。",
      },
      createLogger(logs),
    );

    const recentMessages = listRecentRawMessages(1000);

    assert.equal(
      recentMessages.some((message) => message.messageExternalId === imageMessageId),
      true,
    );
    assert.equal(
      recentMessages.some((message) => message.messageExternalId === textMessageId),
      true,
    );
    assert.equal(logs.some((entry) => entry.message === "Skipped text-only room message"), false);
  },
);

test("handleMessage does not send received-room debug notification by default", { concurrency: false }, async () => {
  const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
  const delivered: DeliveredMessage[] = [];

  await handleMessage(
    {
      id: () => "received-room-debug-disabled-test",
      room: async () => ({
        alias: async () => null,
        id: () => "room_debug_disabled",
        topic: async () => "AI测试群",
      }),
      self: () => false,
      talker: async () => ({
        id: () => "talker_debug_disabled",
        name: () => "Ryan。",
      }),
      text: () => "",
      toFileBox: async () => ({
        name: "debug-disabled.jpg",
        toBuffer: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      }),
      type: () => 6,
      wechaty: createWechatyMock(delivered),
    },
    {
      ...createMessageContext([createChannel()]),
      debugContactName: "Ryan。",
    },
    createLogger(logs),
  );

  assert.equal(
    delivered.some((item) => item.text.startsWith("[wechat-claw] 已收到群消息")),
    false,
  );
  assert(logs.some((entry) => entry.message === "Received room message"));
});

test("handleMessage sends received-room debug notification when explicitly enabled", { concurrency: false }, async () => {
  const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
  const delivered: DeliveredMessage[] = [];

  await handleMessage(
    {
      id: () => "received-room-debug-enabled-test",
      room: async () => ({
        alias: async () => null,
        id: () => "room_debug_enabled",
        topic: async () => "AI测试群",
      }),
      self: () => false,
      talker: async () => ({
        id: () => "talker_debug_enabled",
        name: () => "Ryan。",
      }),
      text: () => "",
      toFileBox: async () => ({
        name: "debug-enabled.jpg",
        toBuffer: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      }),
      type: () => 6,
      wechaty: createWechatyMock(delivered),
    },
    {
      ...createMessageContext([createChannel()]),
      debugContactName: "Ryan。",
      debugReceivedRoomMessageEnabled: true,
    },
    createLogger(logs),
  );

  assert.equal(
    delivered.some(
      (item) =>
        item.targetType === "contact_name" &&
        item.targetValue === "Ryan。" &&
        item.text.startsWith("[wechat-claw] 已收到群消息"),
    ),
    true,
  );
  assert(logs.some((entry) => entry.message === "Sent room message delivery notifications"));
});

test("handleMessage stores reimbursement text-only messages without recent image context", { concurrency: false }, async () => {
  const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
  const messageId = "reimbursement-text-test";
  const delivered: DeliveredMessage[] = [];

  await handleMessage(
    {
      id: () => messageId,
      room: async () => ({
        alias: async () => "小王",
        id: () => "reimbursement_room_1",
        topic: async () => "AI报账群",
      }),
      self: () => false,
      talker: async () => ({
        id: () => "reimbursement_talker_text",
        name: () => "Ryan。",
      }),
      text: () => "食材采购报账 36.5元",
      type: () => 7,
      wechaty: createWechatyMock(delivered),
    },
    createMessageContext([
      createReimbursementChannelWithTargets([{ type: "room_topic", value: "AI报账群" }]),
    ]),
    createLogger(logs),
  );

  const recentMessages = listRecentRawMessages(1000);
  const recentReports = listRecentReimbursementReports(1000);
  const report = recentReports.find((item) => item.note === "食材采购报账 36.5元");

  assert.equal(recentMessages.some((message) => message.messageExternalId === messageId), true);
  assert(report);
  assert.equal(report.amount, 36.5);
  assert.equal(report.expenseCategory, "food");
  assert.equal(report.reporter, "小王");
  assert.equal(report.evidenceType, "text");
  assert.equal(report.needsReview, false);
  assert(logs.some((entry) => entry.message === "Started reimbursement message processing"));
  assert(logs.some((entry) => entry.message === "Persisted reimbursement raw message"));
  assert(logs.some((entry) => entry.message === "Starting reimbursement extraction"));
  assert(logs.some((entry) => entry.message === "Completed reimbursement extraction"));
  assert(logs.some((entry) => entry.message === "Persisted reimbursement report"));
  assert(logs.some((entry) => entry.message === "Persisted reimbursement scenario extraction"));
  assert.deepEqual(delivered, []);
});

test("handleMessage ignores reimbursement text-only URL messages", { concurrency: false }, async () => {
  const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
  const messageId = "reimbursement-url-skip-test";
  const beforeReports = listRecentReimbursementReports(1000);

  await handleMessage(
    {
      id: () => messageId,
      room: async () => ({
        alias: async () => "小王",
        id: () => "reimbursement_room_1",
        topic: async () => "AI报账群",
      }),
      self: () => false,
      talker: async () => ({
        id: () => "reimbursement_talker_url",
        name: () => "Ryan。",
      }),
      text: () => "https://example.com/pay?id=1 金额 99元",
      type: () => 7,
    },
    createMessageContext([createReimbursementChannel()]),
    createLogger(logs),
  );

  const afterMessages = listRecentRawMessages(1000);
  const afterReports = listRecentReimbursementReports(1000);

  assert.equal(afterMessages.some((message) => message.messageExternalId === messageId), false);
  assert.equal(afterReports.length, beforeReports.length);
  assert(logs.some((entry) => entry.message === "Skipped reimbursement text-only URL message"));
});

test("handleMessage stores reimbursement images under reimbursement raw dir and merges following remark", { concurrency: false }, async () => {
  const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
  const imageMessageId = "reimbursement-image-before-remark-test";
  const remarkMessageId = "reimbursement-remark-after-image-test";
  const delivered: DeliveredMessage[] = [];
  const context = createMessageContext([
    createReimbursementChannelWithTargets([{ type: "room_topic", value: "AI报账群" }]),
  ]);
  const wechaty = createWechatyMock(delivered);

  await handleMessage(
    {
      id: () => imageMessageId,
      room: async () => ({
        alias: async () => "小李",
        id: () => "reimbursement_room_1",
        topic: async () => "AI报账群",
      }),
      self: () => false,
      talker: async () => ({
        id: () => "reimbursement_talker_merge",
        name: () => "Ryan。",
      }),
      text: () => "",
      toFileBox: async () => ({
        name: "receipt.jpg",
        toBuffer: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      }),
      type: () => 6,
      wechaty,
    },
    context,
    createLogger(logs),
  );

  const imageRawMessage = listRecentRawMessages(1000).find(
    (message) => message.messageExternalId === imageMessageId,
  );
  const imageReport = listRecentReimbursementReports(1000).find((report) => report.reporter === "小李");

  assert(imageRawMessage);
  assert(imageReport);
  assert.equal(imageRawMessage.attachments.length, 1);
  assert.equal(imageRawMessage.attachments[0]?.localPath.startsWith(getReimbursementRawStorageDir()), true);
  assert.equal(imageReport.evidenceType, "image");
  assert(logs.some((entry) => entry.message === "Detected reimbursement image-like message"));
  assert(logs.some((entry) => entry.message === "Saved reimbursement image attachment"));
  assert.deepEqual(delivered, [
    {
      targetType: "room_topic",
      targetValue: "AI报账群",
      text: "此次报账待核验",
    },
  ]);

  await handleMessage(
    {
      id: () => remarkMessageId,
      room: async () => ({
        alias: async () => "小李",
        id: () => "reimbursement_room_1",
        topic: async () => "AI报账群",
      }),
      self: () => false,
      talker: async () => ({
        id: () => "reimbursement_talker_merge",
        name: () => "Ryan。",
      }),
      text: () => "这张是昨天晚餐食材",
      type: () => 7,
      wechaty,
    },
    context,
    createLogger(logs),
  );

  const updatedReport = listRecentReimbursementReports(1000).find((report) => report.id === imageReport.id);
  const remarkRawMessage = listRecentRawMessages(1000).find(
    (message) => message.messageExternalId === remarkMessageId,
  );

  assert(updatedReport);
  assert(remarkRawMessage);
  assert.equal(updatedReport.evidenceType, "image+text");
  assert.equal(updatedReport.note, "这张是昨天晚餐食材");
  assert.equal(listRecentReimbursementReports(1000).filter((report) => report.id === imageReport.id).length, 1);
  assert(logs.some((entry) => entry.message === "Checking recent reimbursement image raw context for remark merge"));
  assert(logs.some((entry) => entry.message === "Matched reimbursement image context for remark merge"));
  assert(logs.some((entry) => entry.message === "Updated reimbursement report with merged remark"));
  assert(logs.some((entry) => entry.message === "Persisted reimbursement remark linkage extraction"));
  assert.equal(delivered.length, 1);
});

test("handleMessage includes merchant in pending reimbursement receipt when merchant is available", { concurrency: false }, async () => {
  const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
  const delivered: DeliveredMessage[] = [];
  const context = {
    ...createMessageContext([
      createReimbursementChannelWithTargets([{ type: "room_topic", value: "AI报账群" }]),
    ]),
    reimbursementExtractionApiKey: "test-key",
  };

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                amount: null,
                confidence: 0.91,
                currency: "人民币",
                document_no: null,
                expense_category: "other",
                merchant: "苏州厨芯科技有限公司",
                ocr_text: "账单待支付 2550",
                voucher_date: "2026-05-22",
                voucher_type: "bill",
              }),
            },
          },
        ],
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    )) as typeof fetch;

  try {
    await handleMessage(
      {
        id: () => "reimbursement-pending-receipt-merchant-test",
        room: async () => ({
          alias: async () => "小商户",
          id: () => "reimbursement_room_pending_merchant",
          topic: async () => "AI报账群",
        }),
        self: () => false,
        talker: async () => ({
          id: () => "reimbursement_talker_pending_merchant",
          name: () => "Ryan。",
        }),
        text: () => "",
        toFileBox: async () => ({
          name: "pending-merchant.jpg",
          toBuffer: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
        }),
        type: () => 6,
        wechaty: createWechatyMock(delivered),
      },
      context,
      createLogger(logs),
    );

    assert.equal(
      delivered.some(
        (item) =>
          item.targetType === "room_topic" &&
          item.targetValue === "AI报账群" &&
          item.text === "此次报账待核验(商户: 苏州厨芯科技有限公司)",
      ),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleMessage includes OCR in pending reimbursement receipt when merchant is empty", { concurrency: false }, async () => {
  const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
  const delivered: DeliveredMessage[] = [];
  const context = {
    ...createMessageContext([
      createReimbursementChannelWithTargets([{ type: "room_topic", value: "AI报账群" }]),
    ]),
    reimbursementExtractionApiKey: "test-key",
  };

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                amount: null,
                confidence: 0.91,
                currency: "人民币",
                document_no: null,
                expense_category: "other",
                merchant: null,
                ocr_text: "账单待支付 2550",
                voucher_date: "2026-05-22",
                voucher_type: "bill",
              }),
            },
          },
        ],
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    )) as typeof fetch;

  try {
    await handleMessage(
      {
        id: () => "reimbursement-pending-receipt-ocr-test",
        room: async () => ({
          alias: async () => "小OCR",
          id: () => "reimbursement_room_pending_ocr",
          topic: async () => "AI报账群",
        }),
        self: () => false,
        talker: async () => ({
          id: () => "reimbursement_talker_pending_ocr",
          name: () => "Ryan。",
        }),
        text: () => "",
        toFileBox: async () => ({
          name: "pending-ocr.jpg",
          toBuffer: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
        }),
        type: () => 6,
        wechaty: createWechatyMock(delivered),
      },
      context,
      createLogger(logs),
    );

    assert.equal(
      delivered.some(
        (item) =>
          item.targetType === "room_topic" &&
          item.targetValue === "AI报账群" &&
          item.text === "此次报账待核验(OCR: 账单待支付 2550)",
      ),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleMessage merges reimbursement text followed by image within 3 seconds", { concurrency: false }, async () => {
  const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
  const textMessageId = "reimbursement-text-before-image-test";
  const imageMessageId = "reimbursement-image-after-text-test";
  const delivered: DeliveredMessage[] = [];
  const context = createMessageContext([
    createReimbursementChannelWithTargets([{ type: "room_topic", value: "AI报账群" }]),
  ]);
  const wechaty = createWechatyMock(delivered);
  const beforeReportCount = listRecentReimbursementReports(1000).length;

  await handleMessage(
    {
      id: () => textMessageId,
      room: async () => ({
        alias: async () => "小赵",
        id: () => "reimbursement_room_2",
        topic: async () => "AI报账群",
      }),
      self: () => false,
      talker: async () => ({
        id: () => "reimbursement_talker_text_first",
        name: () => "Ryan。",
      }),
      text: () => "昨晚外卖报账 42元",
      type: () => 7,
      wechaty,
    },
    context,
    createLogger(logs),
  );

  const textReport = listRecentReimbursementReports(1000).find(
    (report) => report.reporter === "小赵" && report.note === "昨晚外卖报账 42元",
  );
  assert(textReport);
  assert.equal(textReport.evidenceType, "text");
  assert.equal(textReport.amount, 42);
  assert.equal(listRecentReimbursementReports(1000).length, beforeReportCount + 1);

  await handleMessage(
    {
      id: () => imageMessageId,
      room: async () => ({
        alias: async () => "小赵",
        id: () => "reimbursement_room_2",
        topic: async () => "AI报账群",
      }),
      self: () => false,
      talker: async () => ({
        id: () => "reimbursement_talker_text_first",
        name: () => "Ryan。",
      }),
      text: () => "",
      toFileBox: async () => ({
        name: "order.jpg",
        toBuffer: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      }),
      type: () => 6,
      wechaty,
    },
    context,
    createLogger(logs),
  );

  const reports = listRecentReimbursementReports(1000).filter(
    (report) => report.reporter === "小赵" && report.note === "昨晚外卖报账 42元",
  );
  const mergedReport = reports.find((report) => report.id === textReport.id);
  const imageRawMessage = listRecentRawMessages(1000).find(
    (message) => message.messageExternalId === imageMessageId,
  );

  assert.equal(reports.length, 1);
  assert(mergedReport);
  assert(imageRawMessage);
  assert.equal(mergedReport.evidenceType, "image+text");
  assert.equal(mergedReport.note, "昨晚外卖报账 42元");
  assert.equal(mergedReport.amount, 42);
  assert.equal(listRecentReimbursementReports(1000).length, beforeReportCount + 1);
  assert(logs.some((entry) => entry.message === "Checking recent reimbursement text context for image merge"));
  assert(logs.some((entry) => entry.message === "Matched recent reimbursement text context for image merge"));
  assert.deepEqual(delivered, [
    {
      targetType: "room_topic",
      targetValue: "AI报账群",
      text: "报账42元已录入(分类: 其他)",
    },
  ]);
});

test("handleMessage reassigns a recent text-only remark to the newer image within 3 seconds", { concurrency: false }, async () => {
  const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
  const delivered: DeliveredMessage[] = [];
  const context = createMessageContext([
    createReimbursementChannelWithTargets([{ type: "room_topic", value: "AI报账群" }]),
  ]);
  const wechaty = createWechatyMock(delivered);

  await handleMessage(
    {
      id: () => "reimbursement-image-first-for-remark-reassign-test",
      room: async () => ({
        alias: async () => "小卢",
        id: () => "reimbursement_room_reassign",
        topic: async () => "AI报账群",
      }),
      self: () => false,
      talker: async () => ({
        id: () => "reimbursement_talker_reassign",
        name: () => "Ryan。",
      }),
      text: () => "",
      toFileBox: async () => ({
        name: "first-image.jpg",
        toBuffer: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      }),
      type: () => 6,
      wechaty,
    },
    context,
    createLogger(logs),
  );

  const firstReport = listRecentReimbursementReports(1000).find((report) => report.reporter === "小卢");
  assert(firstReport);
  assert.equal(firstReport.evidenceType, "image");

  await new Promise((resolve) => setTimeout(resolve, 50));

  await handleMessage(
    {
      id: () => "reimbursement-text-between-images-reassign-test",
      room: async () => ({
        alias: async () => "小卢",
        id: () => "reimbursement_room_reassign",
        topic: async () => "AI报账群",
      }),
      self: () => false,
      talker: async () => ({
        id: () => "reimbursement_talker_reassign",
        name: () => "Ryan。",
      }),
      text: () => "平",
      type: () => 7,
      wechaty,
    },
    context,
    createLogger(logs),
  );

  const reportAfterRemark = listRecentReimbursementReports(1000).find((report) => report.id === firstReport.id);
  assert(reportAfterRemark);
  assert.equal(reportAfterRemark.evidenceType, "image+text");
  assert.equal(reportAfterRemark.note, "平");

  await new Promise((resolve) => setTimeout(resolve, 50));

  await handleMessage(
    {
      id: () => "reimbursement-image-second-for-remark-reassign-test",
      room: async () => ({
        alias: async () => "小卢",
        id: () => "reimbursement_room_reassign",
        topic: async () => "AI报账群",
      }),
      self: () => false,
      talker: async () => ({
        id: () => "reimbursement_talker_reassign",
        name: () => "Ryan。",
      }),
      text: () => "",
      toFileBox: async () => ({
        name: "second-image.jpg",
        toBuffer: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      }),
      type: () => 6,
      wechaty,
    },
    context,
    createLogger(logs),
  );

  const reports = listReimbursementReportDetails({
    channelCode: "reimbursement_a",
    limit: 10,
  }).filter((report) => report.reporter === "小卢");
  const updatedFirstReport = reports.find((report) => report.id === firstReport.id);
  const secondReport = reports.find((report) => report.id !== firstReport.id);

  assert.equal(reports.length, 2);
  assert(updatedFirstReport);
  assert(secondReport);
  assert.equal(updatedFirstReport.evidenceType, "image");
  assert.equal(updatedFirstReport.note, "");
  assert.equal(secondReport.evidenceType, "image+text");
  assert.equal(secondReport.note, "平");
  assert.equal(secondReport.sources.some((source) => source.textContent === "平" && source.role === "remark"), true);
  assert(logs.some((entry) => entry.message === "Matched recent reimbursement remark context for image merge"));
  assert(logs.some((entry) => entry.message === "Reassigned reimbursement remark context to newer image report"));
});

test("handleMessage deletes a reimbursement when replying delete to the receipt text", { concurrency: false }, async () => {
  const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
  const delivered: DeliveredMessage[] = [];
  const commandMessageId = "reimbursement-delete-reply-command";
  const receiptMessageId = "reimbursement-delete-self-receipt";
  const rawPayloadByMessageId = {
    [commandMessageId]: {
      AppMsgType: 57,
      Content:
        "<msg><appmsg><title><![CDATA[delete]]></title><refermsg><svrid><![CDATA[" +
        receiptMessageId +
        "]]></svrid><displayname><![CDATA[机器人]]></displayname><content><![CDATA[报账4201.5元已录入(分类: 其他)]]></content></refermsg></appmsg></msg>",
      MsgType: 49,
    },
  };
  const context = createMessageContext([
    createReimbursementChannelWithTargets([{ type: "room_topic", value: "AI报账群" }]),
  ]);
  const wechaty = createWechatyMock(delivered, {
    rawPayloadByMessageId,
  });

  await handleMessage(
    {
      id: () => "reimbursement-delete-text-first",
      room: async () => ({
        alias: async () => "小删",
        id: () => "reimbursement_room_delete",
        topic: async () => "AI报账群",
      }),
      self: () => false,
      talker: async () => ({
        id: () => "reimbursement_talker_delete",
        name: () => "Ryan。",
      }),
      text: () => "晚餐报账 4201.5元",
      type: () => 7,
      wechaty,
    },
    context,
    createLogger(logs),
  );

  await handleMessage(
    {
      id: () => "reimbursement-delete-image-second",
      room: async () => ({
        alias: async () => "小删",
        id: () => "reimbursement_room_delete",
        topic: async () => "AI报账群",
      }),
      self: () => false,
      talker: async () => ({
        id: () => "reimbursement_talker_delete",
        name: () => "Ryan。",
      }),
      text: () => "",
      toFileBox: async () => ({
        name: "delete-order.jpg",
        toBuffer: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      }),
      type: () => 6,
      wechaty,
    },
    context,
    createLogger(logs),
  );

  const createdReport = listRecentReimbursementReports(1000).find((report) => report.reporter === "小删");
  assert(createdReport);
  assert.equal(createdReport.amount, 4201.5);
  assert.equal(delivered.some((item) => item.text === "报账4201.5元已录入(分类: 其他)"), true);

  await handleMessage(
    {
      id: () => receiptMessageId,
      room: async () => ({
        alias: async () => "机器人",
        id: () => "reimbursement_room_delete",
        topic: async () => "AI报账群",
      }),
      self: () => true,
      talker: async () => ({
        id: () => "bot_self_delete",
        name: () => "Bot",
      }),
      text: () => "报账4201.5元已录入(分类: 其他)",
      type: () => 7,
      wechaty,
    },
    context,
    createLogger(logs),
  );

  await handleMessage(
    {
      id: () => commandMessageId,
      room: async () => ({
        alias: async () => "小删",
        id: () => "reimbursement_room_delete",
        topic: async () => "AI报账群",
      }),
      self: () => false,
      talker: async () => ({
        id: () => "reimbursement_talker_delete",
        name: () => "Ryan。",
      }),
      text: () => "<msg><appmsg><title>delete</title></appmsg></msg>",
      type: () => 49,
      wechaty,
    },
    context,
    createLogger(logs),
  );

  const reportsAfterDelete = listRecentReimbursementReports(1000).filter((report) => report.reporter === "小删");
  const rawCommandMessage = listRecentRawMessages(1000).find(
    (message) => message.messageExternalId === "reimbursement-delete-reply-command",
  );

  assert.equal(reportsAfterDelete.length, 0);
  assert(rawCommandMessage);
  assert.equal(rawCommandMessage.textContent, "delete");
  assert(logs.some((entry) => entry.message === "Processed self reimbursement receipt message"));
  assert(logs.some((entry) => entry.message === "Executed reimbursement receipt command"));
  assert.equal(
    delivered.some(
      (item) => item.targetType === "room_topic" && item.targetValue === "AI报账群" && item.text === "已处理",
    ),
    true,
  );
});

test("handleMessage deletes a negative reimbursement when replying delete to a negative receipt", { concurrency: false }, async () => {
  const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
  const delivered: DeliveredMessage[] = [];
  const commandMessageId = "reimbursement-negative-delete-reply-command";
  const receiptMessageId = "reimbursement-negative-delete-self-receipt";
  const receiptText = "报账-36.5元已录入(分类: 其他)";
  const rawPayloadByMessageId = {
    [commandMessageId]: {
      AppMsgType: 57,
      Content:
        "<msg><appmsg><title><![CDATA[delete]]></title><refermsg><svrid><![CDATA[" +
        receiptMessageId +
        "]]></svrid><displayname><![CDATA[机器人]]></displayname><content><![CDATA[" +
        receiptText +
        "]]></content></refermsg></appmsg></msg>",
      MsgType: 49,
    },
  };
  const context = {
    ...createMessageContext([
      createReimbursementChannelWithTargets([{ type: "room_topic", value: "AI报账群" }]),
    ]),
    reimbursementExtractionApiKey: "test-key",
  };
  const wechaty = createWechatyMock(delivered, {
    rawPayloadByMessageId,
  });

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                amount: -36.5,
                confidence: 0.91,
                currency: "人民币",
                document_no: null,
                expense_category: "other",
                merchant: "退款测试商户",
                ocr_text: "退款到账 36.5",
                voucher_date: "2026-05-22",
                voucher_type: "refund",
              }),
            },
          },
        ],
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    )) as typeof fetch;

  try {
    await handleMessage(
      {
        id: () => "reimbursement-negative-delete-image-first",
        room: async () => ({
          alias: async () => "小负删",
          id: () => "reimbursement_room_negative_delete",
          topic: async () => "AI报账群",
        }),
        self: () => false,
        talker: async () => ({
          id: () => "reimbursement_talker_negative_delete",
          name: () => "Ryan。",
        }),
        text: () => "",
        toFileBox: async () => ({
          name: "negative-delete-order.jpg",
          toBuffer: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
        }),
        type: () => 6,
        wechaty,
      },
      context,
      createLogger(logs),
    );

    const createdReport = listRecentReimbursementReports(1000).find((report) => report.reporter === "小负删");
    assert(createdReport);
    assert.equal(createdReport.amount, -36.5);
    assert.equal(delivered.some((item) => item.text === receiptText), true);

    await handleMessage(
      {
        id: () => receiptMessageId,
        room: async () => ({
          alias: async () => "机器人",
          id: () => "reimbursement_room_negative_delete",
          topic: async () => "AI报账群",
        }),
        self: () => true,
        talker: async () => ({
          id: () => "bot_self_negative_delete",
          name: () => "Bot",
        }),
        text: () => receiptText,
        type: () => 7,
        wechaty,
      },
      context,
      createLogger(logs),
    );

    await handleMessage(
      {
        id: () => commandMessageId,
        room: async () => ({
          alias: async () => "小负删",
          id: () => "reimbursement_room_negative_delete",
          topic: async () => "AI报账群",
        }),
        self: () => false,
        talker: async () => ({
          id: () => "reimbursement_talker_negative_delete",
          name: () => "Ryan。",
        }),
        text: () => "<msg><appmsg><title>delete</title></appmsg></msg>",
        type: () => 49,
        wechaty,
      },
      context,
      createLogger(logs),
    );

    const reportsAfterDelete = listRecentReimbursementReports(1000).filter((report) => report.reporter === "小负删");
    const rawCommandMessage = listRecentRawMessages(1000).find(
      (message) => message.messageExternalId === commandMessageId,
    );

    assert.equal(reportsAfterDelete.length, 0);
    assert(rawCommandMessage);
    assert.equal(rawCommandMessage.textContent, "delete");
    assert(logs.some((entry) => entry.message === "Processed self reimbursement receipt message"));
    assert(logs.some((entry) => entry.message === "Executed reimbursement receipt command"));
    assert.equal(
      delivered.some(
        (item) => item.targetType === "room_topic" && item.targetValue === "AI报账群" && item.text === "已处理",
      ),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleMessage updates reimbursement amount and clears review when replying a number to a receipt", { concurrency: false }, async () => {
  const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
  const delivered: DeliveredMessage[] = [];
  const commandMessageId = "reimbursement-update-reply-command";
  const receiptMessageId = "reimbursement-update-self-receipt";
  const rawPayloadByMessageId = {
    [commandMessageId]: {
      AppMsgType: 57,
      Content:
        "<msg><appmsg><title><![CDATA[88.5]]></title><refermsg><svrid><![CDATA[" +
        receiptMessageId +
        "]]></svrid><displayname><![CDATA[机器人]]></displayname><content><![CDATA[此次报账待核验]]></content></refermsg></appmsg></msg>",
      MsgType: 49,
    },
  };
  const context = createMessageContext([
    createReimbursementChannelWithTargets([{ type: "room_topic", value: "AI报账群" }]),
  ]);
  const wechaty = createWechatyMock(delivered, {
    rawPayloadByMessageId,
  });

  await handleMessage(
    {
      id: () => "reimbursement-update-image-first",
      room: async () => ({
        alias: async () => "小改",
        id: () => "reimbursement_room_update",
        topic: async () => "AI报账群",
      }),
      self: () => false,
      talker: async () => ({
        id: () => "reimbursement_talker_update",
        name: () => "Ryan。",
      }),
      text: () => "",
      toFileBox: async () => ({
        name: "update-order.jpg",
        toBuffer: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      }),
      type: () => 6,
      wechaty,
    },
    context,
    createLogger(logs),
  );

  const initialReport = listRecentReimbursementReports(1000).find((report) => report.reporter === "小改");
  assert(initialReport);
  assert.equal(initialReport.amount, null);
  assert.equal(initialReport.needsReview, true);
  assert.equal(delivered.some((item) => item.text === "此次报账待核验"), true);

  await handleMessage(
    {
      id: () => receiptMessageId,
      room: async () => ({
        alias: async () => "机器人",
        id: () => "reimbursement_room_update",
        topic: async () => "AI报账群",
      }),
      self: () => true,
      talker: async () => ({
        id: () => "bot_self_update",
        name: () => "Bot",
      }),
      text: () => "此次报账待核验",
      type: () => 7,
      wechaty,
    },
    context,
    createLogger(logs),
  );

  await handleMessage(
    {
      id: () => commandMessageId,
      room: async () => ({
        alias: async () => "小改",
        id: () => "reimbursement_room_update",
        topic: async () => "AI报账群",
      }),
      self: () => false,
      talker: async () => ({
        id: () => "reimbursement_talker_update",
        name: () => "Ryan。",
      }),
      text: () => "<msg><appmsg><title>88.5</title></appmsg></msg>",
      type: () => 49,
      wechaty,
    },
    context,
    createLogger(logs),
  );

  const updatedReport = listRecentReimbursementReports(1000).find((report) => report.id === initialReport.id);
  const selfReceiptRawMessage = listRecentRawMessages(1000).find(
    (message) => message.messageExternalId === receiptMessageId,
  );
  const commandRawMessage = listRecentRawMessages(1000).find(
    (message) => message.messageExternalId === commandMessageId,
  );

  assert(updatedReport);
  assert.equal(updatedReport.amount, 88.5);
  assert.equal(updatedReport.needsReview, false);
  assert(selfReceiptRawMessage);
  assert(commandRawMessage);
  assert.equal(commandRawMessage.textContent, "88.5");
  assert(logs.some((entry) => entry.message === "Processed self reimbursement receipt message"));
  assert(logs.some((entry) => entry.message === "Executed reimbursement receipt command"));
  assert.equal(
    delivered.some(
      (item) => item.targetType === "room_topic" && item.targetValue === "AI报账群" && item.text === "已处理",
    ),
    true,
  );
});

test("handleMessage updates reimbursement amount to a negative value when replying a negative number to a receipt", { concurrency: false }, async () => {
  const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
  const delivered: DeliveredMessage[] = [];
  const commandMessageId = "reimbursement-negative-update-reply-command";
  const receiptMessageId = "reimbursement-negative-update-self-receipt";
  const rawPayloadByMessageId = {
    [commandMessageId]: {
      AppMsgType: 57,
      Content:
        "<msg><appmsg><title><![CDATA[-88.5]]></title><refermsg><svrid><![CDATA[" +
        receiptMessageId +
        "]]></svrid><displayname><![CDATA[机器人]]></displayname><content><![CDATA[此次报账待核验]]></content></refermsg></appmsg></msg>",
      MsgType: 49,
    },
  };
  const context = createMessageContext([
    createReimbursementChannelWithTargets([{ type: "room_topic", value: "AI报账群" }]),
  ]);
  const wechaty = createWechatyMock(delivered, {
    rawPayloadByMessageId,
  });

  await handleMessage(
    {
      id: () => "reimbursement-negative-update-image-first",
      room: async () => ({
        alias: async () => "小负改",
        id: () => "reimbursement_room_negative_update",
        topic: async () => "AI报账群",
      }),
      self: () => false,
      talker: async () => ({
        id: () => "reimbursement_talker_negative_update",
        name: () => "Ryan。",
      }),
      text: () => "",
      toFileBox: async () => ({
        name: "negative-update-order.jpg",
        toBuffer: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      }),
      type: () => 6,
      wechaty,
    },
    context,
    createLogger(logs),
  );

  const initialReport = listRecentReimbursementReports(1000).find((report) => report.reporter === "小负改");
  assert(initialReport);
  assert.equal(initialReport.amount, null);
  assert.equal(initialReport.needsReview, true);

  await handleMessage(
    {
      id: () => receiptMessageId,
      room: async () => ({
        alias: async () => "机器人",
        id: () => "reimbursement_room_negative_update",
        topic: async () => "AI报账群",
      }),
      self: () => true,
      talker: async () => ({
        id: () => "bot_self_negative_update",
        name: () => "Bot",
      }),
      text: () => "此次报账待核验",
      type: () => 7,
      wechaty,
    },
    context,
    createLogger(logs),
  );

  await handleMessage(
    {
      id: () => commandMessageId,
      room: async () => ({
        alias: async () => "小负改",
        id: () => "reimbursement_room_negative_update",
        topic: async () => "AI报账群",
      }),
      self: () => false,
      talker: async () => ({
        id: () => "reimbursement_talker_negative_update",
        name: () => "Ryan。",
      }),
      text: () => "<msg><appmsg><title>-88.5</title></appmsg></msg>",
      type: () => 49,
      wechaty,
    },
    context,
    createLogger(logs),
  );

  const updatedReport = listRecentReimbursementReports(1000).find((report) => report.id === initialReport.id);
  const commandRawMessage = listRecentRawMessages(1000).find(
    (message) => message.messageExternalId === commandMessageId,
  );

  assert(updatedReport);
  assert.equal(updatedReport.amount, -88.5);
  assert.equal(updatedReport.needsReview, false);
  assert(commandRawMessage);
  assert.equal(commandRawMessage.textContent, "-88.5");
  assert(logs.some((entry) => entry.message === "Executed reimbursement receipt command"));
  assert.equal(
    delivered.some(
      (item) => item.targetType === "room_topic" && item.targetValue === "AI报账群" && item.text === "已处理",
    ),
    true,
  );
});

test("handleMessage updates reimbursement category when replying category command to a receipt", { concurrency: false }, async () => {
  const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
  const delivered: DeliveredMessage[] = [];
  const commandMessageId = "reimbursement-category-reply-command";
  const receiptMessageId = "reimbursement-category-self-receipt";
  const rawPayloadByMessageId = {
    [commandMessageId]: {
      AppMsgType: 57,
      Content:
        "<msg><appmsg><title><![CDATA[分类: 水电]]></title><refermsg><svrid><![CDATA[" +
        receiptMessageId +
        "]]></svrid><displayname><![CDATA[机器人]]></displayname><content><![CDATA[报账36.5元已录入(分类: 其他)]]></content></refermsg></appmsg></msg>",
      MsgType: 49,
    },
  };
  const context = createMessageContext([
    createReimbursementChannelWithTargets([{ type: "room_topic", value: "AI报账群" }]),
  ]);
  const wechaty = createWechatyMock(delivered, {
    rawPayloadByMessageId,
  });

  await handleMessage(
    {
      id: () => "reimbursement-category-text-first",
      room: async () => ({
        alias: async () => "小类目",
        id: () => "reimbursement_room_category",
        topic: async () => "AI报账群",
      }),
      self: () => false,
      talker: async () => ({
        id: () => "reimbursement_talker_category",
        name: () => "Ryan。",
      }),
      text: () => "办公用品报账 36.5元",
      type: () => 7,
      wechaty,
    },
    context,
    createLogger(logs),
  );

  await handleMessage(
    {
      id: () => "reimbursement-category-image-second",
      room: async () => ({
        alias: async () => "小类目",
        id: () => "reimbursement_room_category",
        topic: async () => "AI报账群",
      }),
      self: () => false,
      talker: async () => ({
        id: () => "reimbursement_talker_category",
        name: () => "Ryan。",
      }),
      text: () => "",
      toFileBox: async () => ({
        name: "category-order.jpg",
        toBuffer: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      }),
      type: () => 6,
      wechaty,
    },
    context,
    createLogger(logs),
  );

  const initialReport = listRecentReimbursementReports(1000).find((report) => report.reporter === "小类目");
  assert(initialReport);
  assert.equal(initialReport.expenseCategory, "other");
  assert.equal(delivered.some((item) => item.text === "报账36.5元已录入(分类: 其他)"), true);

  await handleMessage(
    {
      id: () => receiptMessageId,
      room: async () => ({
        alias: async () => "机器人",
        id: () => "reimbursement_room_category",
        topic: async () => "AI报账群",
      }),
      self: () => true,
      talker: async () => ({
        id: () => "bot_self_category",
        name: () => "Bot",
      }),
      text: () => "报账36.5元已录入(分类: 其他)",
      type: () => 7,
      wechaty,
    },
    context,
    createLogger(logs),
  );

  await handleMessage(
    {
      id: () => commandMessageId,
      room: async () => ({
        alias: async () => "小类目",
        id: () => "reimbursement_room_category",
        topic: async () => "AI报账群",
      }),
      self: () => false,
      talker: async () => ({
        id: () => "reimbursement_talker_category",
        name: () => "Ryan。",
      }),
      text: () => "<msg><appmsg><title>分类: 水电</title></appmsg></msg>",
      type: () => 49,
      wechaty,
    },
    context,
    createLogger(logs),
  );

  const updatedReport = listRecentReimbursementReports(1000).find((report) => report.id === initialReport.id);
  const commandRawMessage = listRecentRawMessages(1000).find(
    (message) => message.messageExternalId === commandMessageId,
  );

  assert(updatedReport);
  assert.equal(updatedReport.expenseCategory, "utilities");
  assert(commandRawMessage);
  assert.equal(commandRawMessage.textContent, "分类: 水电");
  assert(logs.some((entry) => entry.message === "Executed reimbursement receipt command"));
  assert.equal(
    delivered.some(
      (item) => item.targetType === "room_topic" && item.targetValue === "AI报账群" && item.text === "已处理",
    ),
    true,
  );
});

test("handleMessage appends monthly ledger note when replying x月账 to a receipt", { concurrency: false }, async () => {
  const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
  const delivered: DeliveredMessage[] = [];
  const commandMessageId = "reimbursement-monthly-ledger-reply-command";
  const receiptMessageId = "reimbursement-monthly-ledger-self-receipt";
  const rawPayloadByMessageId = {
    [commandMessageId]: {
      AppMsgType: 57,
      Content:
        "<msg><appmsg><title><![CDATA[4月账]]></title><refermsg><svrid><![CDATA[" +
        receiptMessageId +
        "]]></svrid><displayname><![CDATA[机器人]]></displayname><content><![CDATA[报账30元已录入(分类: 其他)]]></content></refermsg></appmsg></msg>",
      MsgType: 49,
    },
  };
  const context = createMessageContext([
    createReimbursementChannelWithTargets([{ type: "room_topic", value: "AI报账群" }]),
  ]);
  const wechaty = createWechatyMock(delivered, {
    rawPayloadByMessageId,
  });

  await handleMessage(
    {
      id: () => "reimbursement-monthly-ledger-text-first",
      room: async () => ({
        alias: async () => "小月账",
        id: () => "reimbursement_room_monthly_ledger",
        topic: async () => "AI报账群",
      }),
      self: () => false,
      talker: async () => ({
        id: () => "reimbursement_talker_monthly_ledger",
        name: () => "Ryan。",
      }),
      text: () => "午餐报账 30元",
      type: () => 7,
      wechaty,
    },
    context,
    createLogger(logs),
  );

  await handleMessage(
    {
      id: () => "reimbursement-monthly-ledger-image-second",
      room: async () => ({
        alias: async () => "小月账",
        id: () => "reimbursement_room_monthly_ledger",
        topic: async () => "AI报账群",
      }),
      self: () => false,
      talker: async () => ({
        id: () => "reimbursement_talker_monthly_ledger",
        name: () => "Ryan。",
      }),
      text: () => "",
      toFileBox: async () => ({
        name: "monthly-ledger-order.jpg",
        toBuffer: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      }),
      type: () => 6,
      wechaty,
    },
    context,
    createLogger(logs),
  );

  const initialReport = listRecentReimbursementReports(1000).find((report) => report.reporter === "小月账");
  assert(initialReport);
  assert.equal(initialReport.amount, 30);
  assert.equal(delivered.some((item) => item.text === "报账30元已录入(分类: 其他)"), true);

  await handleMessage(
    {
      id: () => receiptMessageId,
      room: async () => ({
        alias: async () => "机器人",
        id: () => "reimbursement_room_monthly_ledger",
        topic: async () => "AI报账群",
      }),
      self: () => true,
      talker: async () => ({
        id: () => "bot_self_monthly_ledger",
        name: () => "Bot",
      }),
      text: () => "报账30元已录入(分类: 其他)",
      type: () => 7,
      wechaty,
    },
    context,
    createLogger(logs),
  );

  await handleMessage(
    {
      id: () => commandMessageId,
      room: async () => ({
        alias: async () => "小月账",
        id: () => "reimbursement_room_monthly_ledger",
        topic: async () => "AI报账群",
      }),
      self: () => false,
      talker: async () => ({
        id: () => "reimbursement_talker_monthly_ledger",
        name: () => "Ryan。",
      }),
      text: () => "<msg><appmsg><title>4月账</title></appmsg></msg>",
      type: () => 49,
      wechaty,
    },
    context,
    createLogger(logs),
  );

  const updatedReport = listRecentReimbursementReports(1000).find((report) => report.id === initialReport.id);
  const reportDetails = listReimbursementReportDetails({ channelCode: "reimbursement_a", limit: 20 }).find(
    (report) => report.id === initialReport.id,
  );
  const commandRawMessage = listRecentRawMessages(1000).find(
    (message) => message.messageExternalId === commandMessageId,
  );

  assert(updatedReport);
  assert.equal(updatedReport.note, "午餐报账 30元；4月账");
  assert(commandRawMessage);
  assert.equal(commandRawMessage.textContent, "4月账");
  assert.equal(
    formatLocalTimestamp(updatedReport.createdAt, "Asia/Shanghai"),
    resolveExpectedMonthlyLedgerLocalTimestamp("4月账", commandRawMessage.eventReceivedAt, "Asia/Shanghai"),
  );
  assert(reportDetails);
  assert.equal(reportDetails.sources.some((source) => source.role === "remark" && source.textContent === "4月账"), true);
  assert(logs.some((entry) => entry.message === "Executed reimbursement receipt command"));
  assert.equal(
    delivered.some(
      (item) => item.targetType === "room_topic" && item.targetValue === "AI报账群" && item.text === "已处理",
    ),
    true,
  );
});

test("handleMessage appends note when replying note command to a receipt", { concurrency: false }, async () => {
  const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
  const delivered: DeliveredMessage[] = [];
  const commandMessageId = "reimbursement-note-reply-command";
  const receiptMessageId = "reimbursement-note-self-receipt";
  const rawPayloadByMessageId = {
    [commandMessageId]: {
      AppMsgType: 57,
      Content:
        "<msg><appmsg><title><![CDATA[note: 补开发票]]></title><refermsg><svrid><![CDATA[" +
        receiptMessageId +
        "]]></svrid><displayname><![CDATA[机器人]]></displayname><content><![CDATA[报账30元已录入(分类: 其他)]]></content></refermsg></appmsg></msg>",
      MsgType: 49,
    },
  };
  const context = createMessageContext([
    createReimbursementChannelWithTargets([{ type: "room_topic", value: "AI报账群" }]),
  ]);
  const wechaty = createWechatyMock(delivered, {
    rawPayloadByMessageId,
  });

  await handleMessage(
    {
      id: () => "reimbursement-note-text-first",
      room: async () => ({
        alias: async () => "小备注",
        id: () => "reimbursement_room_note",
        topic: async () => "AI报账群",
      }),
      self: () => false,
      talker: async () => ({
        id: () => "reimbursement_talker_note",
        name: () => "Ryan。",
      }),
      text: () => "午餐报账 30元",
      type: () => 7,
      wechaty,
    },
    context,
    createLogger(logs),
  );

  await handleMessage(
    {
      id: () => "reimbursement-note-image-second",
      room: async () => ({
        alias: async () => "小备注",
        id: () => "reimbursement_room_note",
        topic: async () => "AI报账群",
      }),
      self: () => false,
      talker: async () => ({
        id: () => "reimbursement_talker_note",
        name: () => "Ryan。",
      }),
      text: () => "",
      toFileBox: async () => ({
        name: "note-order.jpg",
        toBuffer: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      }),
      type: () => 6,
      wechaty,
    },
    context,
    createLogger(logs),
  );

  const initialReport = listRecentReimbursementReports(1000).find((report) => report.reporter === "小备注");
  assert(initialReport);
  assert.equal(initialReport.amount, 30);

  await handleMessage(
    {
      id: () => receiptMessageId,
      room: async () => ({
        alias: async () => "机器人",
        id: () => "reimbursement_room_note",
        topic: async () => "AI报账群",
      }),
      self: () => true,
      talker: async () => ({
        id: () => "bot_self_note",
        name: () => "Bot",
      }),
      text: () => "报账30元已录入(分类: 其他)",
      type: () => 7,
      wechaty,
    },
    context,
    createLogger(logs),
  );

  await handleMessage(
    {
      id: () => commandMessageId,
      room: async () => ({
        alias: async () => "小备注",
        id: () => "reimbursement_room_note",
        topic: async () => "AI报账群",
      }),
      self: () => false,
      talker: async () => ({
        id: () => "reimbursement_talker_note",
        name: () => "Ryan。",
      }),
      text: () => "<msg><appmsg><title>note: 补开发票</title></appmsg></msg>",
      type: () => 49,
      wechaty,
    },
    context,
    createLogger(logs),
  );

  const updatedReport = listRecentReimbursementReports(1000).find((report) => report.id === initialReport.id);
  const reportDetails = listReimbursementReportDetails({ channelCode: "reimbursement_a", limit: 20 }).find(
    (report) => report.id === initialReport.id,
  );
  const commandRawMessage = listRecentRawMessages(1000).find(
    (message) => message.messageExternalId === commandMessageId,
  );

  assert(updatedReport);
  assert.equal(updatedReport.note, "午餐报账 30元；补开发票");
  assert(commandRawMessage);
  assert.equal(commandRawMessage.textContent, "note: 补开发票");
  assert(reportDetails);
  assert.equal(reportDetails.sources.some((source) => source.role === "remark" && source.textContent === "note: 补开发票"), true);
  assert(logs.some((entry) => entry.message === "Executed reimbursement receipt command"));
  assert.equal(
    delivered.some(
      (item) => item.targetType === "room_topic" && item.targetValue === "AI报账群" && item.text === "已处理",
    ),
    true,
  );
});

test("handleMessage fallback receipt matching prefers the same reporter when pending receipts repeat", { concurrency: false }, async () => {
  const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
  const delivered: DeliveredMessage[] = [];
  const context = createMessageContext([
    createReimbursementChannelWithTargets([{ type: "room_topic", value: "AI报账群" }]),
  ]);
  const wechaty = createWechatyMock(delivered);

  await handleMessage(
    {
      id: () => "reimbursement-fallback-reporter-a-image",
      room: async () => ({
        alias: async () => "甲同学",
        id: () => "reimbursement_room_reporter_preference",
        topic: async () => "AI报账群",
      }),
      self: () => false,
      talker: async () => ({
        id: () => "reimbursement_talker_reporter_a",
        name: () => "Ryan。",
      }),
      text: () => "",
      toFileBox: async () => ({
        name: "reporter-a-order.jpg",
        toBuffer: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      }),
      type: () => 6,
      wechaty,
    },
    context,
    createLogger(logs),
  );

  await handleMessage(
    {
      id: () => "reimbursement-fallback-reporter-b-image",
      room: async () => ({
        alias: async () => "乙同学",
        id: () => "reimbursement_room_reporter_preference",
        topic: async () => "AI报账群",
      }),
      self: () => false,
      talker: async () => ({
        id: () => "reimbursement_talker_reporter_b",
        name: () => "Ryan。",
      }),
      text: () => "",
      toFileBox: async () => ({
        name: "reporter-b-order.jpg",
        toBuffer: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      }),
      type: () => 6,
      wechaty,
    },
    context,
    createLogger(logs),
  );

  const reportA = listRecentReimbursementReports(1000).find((report) => report.reporter === "甲同学");
  const reportB = listRecentReimbursementReports(1000).find((report) => report.reporter === "乙同学");
  assert(reportA);
  assert(reportB);
  assert.equal(reportA.amount, null);
  assert.equal(reportB.amount, null);

  await handleMessage(
    {
      id: () => "reimbursement-fallback-reporter-a-command",
      room: async () => ({
        alias: async () => "甲同学",
        id: () => "reimbursement_room_reporter_preference",
        topic: async () => "AI报账群",
      }),
      self: () => false,
      talker: async () => ({
        id: () => "reimbursement_talker_reporter_a",
        name: () => "Ryan。",
      }),
      text: () => "「Claw：此次报账待核验」<br/>- - - - - - - - - - - - - - -<br/>2550",
      type: () => 7,
      wechaty,
    },
    context,
    createLogger(logs),
  );

  const updatedReportA = listRecentReimbursementReports(1000).find((report) => report.id === reportA.id);
  const updatedReportB = listRecentReimbursementReports(1000).find((report) => report.id === reportB.id);

  assert(updatedReportA);
  assert(updatedReportB);
  assert.equal(updatedReportA.amount, 2550);
  assert.equal(updatedReportA.needsReview, false);
  assert.equal(updatedReportB.amount, null);
  assert.equal(updatedReportB.needsReview, true);
});

test("handleMessage replies unsupported message for unsupported reimbursement receipt command", { concurrency: false }, async () => {
  const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
  const delivered: DeliveredMessage[] = [];
  const context = createMessageContext([
    createReimbursementChannelWithTargets([{ type: "room_topic", value: "AI报账群" }]),
  ]);
  const wechaty = createWechatyMock(delivered);

  await handleMessage(
    {
      id: () => "reimbursement-unsupported-text-first",
      room: async () => ({
        alias: async () => "小错",
        id: () => "reimbursement_room_unsupported",
        topic: async () => "AI报账群",
      }),
      self: () => false,
      talker: async () => ({
        id: () => "reimbursement_talker_unsupported",
        name: () => "Ryan。",
      }),
      text: () => "午餐报账 30元",
      type: () => 7,
      wechaty,
    },
    context,
    createLogger(logs),
  );

  await handleMessage(
    {
      id: () => "reimbursement-unsupported-image-second",
      room: async () => ({
        alias: async () => "小错",
        id: () => "reimbursement_room_unsupported",
        topic: async () => "AI报账群",
      }),
      self: () => false,
      talker: async () => ({
        id: () => "reimbursement_talker_unsupported",
        name: () => "Ryan。",
      }),
      text: () => "",
      toFileBox: async () => ({
        name: "unsupported-order.jpg",
        toBuffer: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      }),
      type: () => 6,
      wechaty,
    },
    context,
    createLogger(logs),
  );

  const reportBeforeCommand = listRecentReimbursementReports(1000).find((report) => report.reporter === "小错");
  assert(reportBeforeCommand);
  assert.equal(reportBeforeCommand.amount, 30);

  await handleMessage(
    {
      id: () => "reimbursement-unsupported-command",
      room: async () => ({
        alias: async () => "小错",
        id: () => "reimbursement_room_unsupported",
        topic: async () => "AI报账群",
      }),
      self: () => false,
      talker: async () => ({
        id: () => "reimbursement_talker_unsupported",
        name: () => "Ryan。",
      }),
      text: () => "「机器人：报账30元已录入(category: other)」\n- - - - - - - - - - - - - - -\n30元",
      type: () => 7,
      wechaty,
    },
    context,
    createLogger(logs),
  );

  const reportAfterCommand = listRecentReimbursementReports(1000).find((report) => report.id === reportBeforeCommand.id);

  assert(reportAfterCommand);
  assert.equal(reportAfterCommand.amount, 30);
  assert.equal(
    delivered.some(
      (item) =>
        item.targetType === "room_topic" &&
        item.targetValue === "AI报账群" &&
        item.text === "不支持的指令",
    ),
    true,
  );
  assert(logs.some((entry) => entry.message === "Ignored unsupported reimbursement receipt command"));
});

test("handleMessage replies not found message for valid reimbursement receipt command without matched report", { concurrency: false }, async () => {
  const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
  const delivered: DeliveredMessage[] = [];
  const commandMessageId = "reimbursement-not-found-command";
  const rawPayloadByMessageId = {
    [commandMessageId]: {
      AppMsgType: 57,
      Content:
        "<msg><appmsg><title><![CDATA[delete]]></title><refermsg><svrid><![CDATA[missing-receipt-id]]></svrid><displayname><![CDATA[机器人]]></displayname><content><![CDATA[报账999元已录入(category: other)]]></content></refermsg></appmsg></msg>",
      MsgType: 49,
    },
  };
  const context = createMessageContext([
    createReimbursementChannelWithTargets([{ type: "room_topic", value: "AI报账群" }]),
  ]);
  const wechaty = createWechatyMock(delivered, {
    rawPayloadByMessageId,
  });

  await handleMessage(
    {
      id: () => commandMessageId,
      room: async () => ({
        alias: async () => "小查",
        id: () => "reimbursement_room_not_found",
        topic: async () => "AI报账群",
      }),
      self: () => false,
      talker: async () => ({
        id: () => "reimbursement_talker_not_found",
        name: () => "Ryan。",
      }),
      text: () => "<msg><appmsg><title>delete</title></appmsg></msg>",
      type: () => 49,
      wechaty,
    },
    context,
    createLogger(logs),
  );

  assert.equal(
    delivered.some(
      (item) =>
        item.targetType === "room_topic" &&
        item.targetValue === "AI报账群" &&
        item.text === "未找到对应报账",
    ),
    true,
  );
  assert(logs.some((entry) => entry.message === "Failed to match reimbursement receipt command to a report"));
});

test("handleMessage ignores replies that quote bot command response text", { concurrency: false }, async () => {
  const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
  const delivered: DeliveredMessage[] = [];
  const reporterName = "回复已处理专测";
  const context = createMessageContext([
    createReimbursementChannelWithTargets([{ type: "room_topic", value: "AI报账群" }]),
  ]);
  const wechaty = createWechatyMock(delivered);

  await handleMessage(
    {
      id: () => "reimbursement-ignore-command-response-image",
      room: async () => ({
        alias: async () => reporterName,
        id: () => "reimbursement_room_ignore_command_response",
        topic: async () => "AI报账群",
      }),
      self: () => false,
      talker: async () => ({
        id: () => "reimbursement_talker_ignore_command_response",
        name: () => "Ryan。",
      }),
      text: () => "",
      toFileBox: async () => ({
        name: "ignore-command-response.jpg",
        toBuffer: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      }),
      type: () => 6,
      wechaty,
    },
    context,
    createLogger(logs),
  );

  const initialReports = listRecentReimbursementReports(1000).filter((report) => report.reporter === reporterName);
  assert.equal(initialReports.length, 1);

  await handleMessage(
    {
      id: () => "reimbursement-ignore-command-response-reply",
      room: async () => ({
        alias: async () => reporterName,
        id: () => "reimbursement_room_ignore_command_response",
        topic: async () => "AI报账群",
      }),
      self: () => false,
      talker: async () => ({
        id: () => "reimbursement_talker_ignore_command_response",
        name: () => "Ryan。",
      }),
      text: () => "「Claw：已处理」<br/>- - - - - - - - - - - - - - -<br/>2550",
      type: () => 7,
      wechaty,
    },
    context,
    createLogger(logs),
  );

  const reportsAfterReply = listRecentReimbursementReports(1000).filter((report) => report.reporter === reporterName);
  const rawReplyMessage = listRecentRawMessages(1000).find(
    (message) => message.messageExternalId === "reimbursement-ignore-command-response-reply",
  );

  assert.equal(reportsAfterReply.length, 1);
  assert.equal(rawReplyMessage, undefined);
  assert(logs.some((entry) => entry.message === "Ignored reimbursement reply to bot command response"));
});

test("handleMessage skips reimbursement receipt when deliveryTargets are empty", { concurrency: false }, async () => {
  const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];

  await handleMessage(
    {
      id: () => "reimbursement-image-no-receipt-targets-test",
      room: async () => ({
        alias: async () => "小吴",
        id: () => "reimbursement_room_no_targets",
        topic: async () => "AI报账群",
      }),
      self: () => false,
      talker: async () => ({
        id: () => "reimbursement_talker_no_targets",
        name: () => "Ryan。",
      }),
      text: () => "",
      toFileBox: async () => ({
        name: "receipt-no-targets.jpg",
        toBuffer: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      }),
      type: () => 6,
    },
    createMessageContext([createReimbursementChannel()]),
    createLogger(logs),
  );

  assert(logs.some((entry) => entry.message === "Skipped reimbursement receipt notification"));
});

test("handleMessage keeps reimbursement persistence when receipt delivery fails", { concurrency: false }, async () => {
  const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
  const messageId = "reimbursement-image-receipt-delivery-fails-test";

  await handleMessage(
    {
      id: () => messageId,
      room: async () => ({
        alias: async () => "小郑",
        id: () => "reimbursement_room_delivery_fail",
        topic: async () => "AI报账群",
      }),
      self: () => false,
      talker: async () => ({
        id: () => "reimbursement_talker_delivery_fail",
        name: () => "Ryan。",
      }),
      text: () => "",
      toFileBox: async () => ({
        name: "receipt-delivery-fail.jpg",
        toBuffer: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      }),
      type: () => 6,
      wechaty: createWechatyMock([], {
        missingRoomTopics: ["不存在的回执群"],
      }),
    },
    createMessageContext([
      createReimbursementChannelWithTargets([{ type: "room_topic", value: "不存在的回执群" }]),
    ]),
    createLogger(logs),
  );

  const report = listRecentReimbursementReports(1000).find((item) => item.reporter === "小郑");

  assert(report);
  assert.equal(report.evidenceType, "image");
  assert(logs.some((entry) => entry.message === "Failed to deliver reimbursement receipt to any target"));
});

test("handleMessage does not merge reimbursement text followed by image after 3 seconds", { concurrency: false }, async () => {
  const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
  const textMessageId = "reimbursement-text-before-image-too-late-test";
  const imageMessageId = "reimbursement-image-too-late-test";
  const context = createMessageContext([createReimbursementChannel()]);
  const beforeReportCount = listRecentReimbursementReports(1000).length;

  await handleMessage(
    {
      id: () => textMessageId,
      room: async () => ({
        alias: async () => "小钱",
        id: () => "reimbursement_room_3",
        topic: async () => "AI报账群",
      }),
      self: () => false,
      talker: async () => ({
        id: () => "reimbursement_talker_text_too_late",
        name: () => "Ryan。",
      }),
      text: () => "办公用品报账 58元",
      type: () => 7,
    },
    context,
    createLogger(logs),
  );

  await new Promise((resolve) => setTimeout(resolve, 3100));

  await handleMessage(
    {
      id: () => imageMessageId,
      room: async () => ({
        alias: async () => "小钱",
        id: () => "reimbursement_room_3",
        topic: async () => "AI报账群",
      }),
      self: () => false,
      talker: async () => ({
        id: () => "reimbursement_talker_text_too_late",
        name: () => "Ryan。",
      }),
      text: () => "",
      toFileBox: async () => ({
        name: "late-order.jpg",
        toBuffer: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      }),
      type: () => 6,
    },
    context,
    createLogger(logs),
  );

  const reports = listRecentReimbursementReports(1000).filter((report) => report.reporter === "小钱");

  assert.equal(reports.length, 2);
  assert.equal(reports.some((report) => report.note === "办公用品报账 58元" && report.evidenceType === "text"), true);
  assert.equal(reports.some((report) => report.id && report.evidenceType === "image"), true);
  assert.equal(listRecentReimbursementReports(1000).length, beforeReportCount + 2);
  assert(logs.some((entry) => entry.message === "No recent reimbursement text context matched for image merge"));
});

test.skip("handleMessage merges reimbursement image sent first even when text is processed first", { concurrency: false }, async () => {
  const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
  const imageMessageId = "reimbursement-image-sent-first-text-processed-first-image";
  const textMessageId = "reimbursement-text-processed-first-after-image";
  const context = createMessageContext([createReimbursementChannel()]);
  const beforeReportCount = listRecentReimbursementReports(1000).length;
  let releaseImageProcessing!: () => void;
  const blockImageProcessing = new Promise<void>((resolve) => {
    releaseImageProcessing = resolve;
  });

  const imageTask = handleMessage(
    {
      id: () => imageMessageId,
      room: async () => ({
        alias: async () => "小孙",
        id: () => "reimbursement_room_3",
        topic: async () => "AI报账群",
      }),
      self: () => false,
      talker: async () => ({
        id: () => "reimbursement_talker_race",
        name: () => "Ryan。",
      }),
      text: () => "",
      toFileBox: async () => {
        await blockImageProcessing;
        return {
        name: "meal.jpg",
        toBuffer: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
        };
      },
      type: () => 6,
    },
    context,
    createLogger(logs),
  );

  await Promise.resolve();

  await handleMessage(
    {
      id: () => textMessageId,
      room: async () => ({
        alias: async () => "小孙",
        id: () => "reimbursement_room_3",
        topic: async () => "AI报账群",
      }),
      self: () => false,
      talker: async () => ({
        id: () => "reimbursement_talker_race",
        name: () => "Ryan。",
      }),
      text: () => "午餐外卖 35元",
      type: () => 7,
    },
    context,
    createLogger(logs),
  );

  releaseImageProcessing();
  await imageTask;

  const reports = listRecentReimbursementReports(1000).filter(
    (report) => report.reporter === "小孙" && report.note === "午餐外卖 35元",
  );

  assert.equal(reports.length, 1);
  assert.equal(reports[0]?.evidenceType, "image+text");
  assert.equal(reports[0]?.amount, 35);
  assert.equal(listRecentReimbursementReports(1000).length, beforeReportCount + 1);
  assert(logs.some((entry) => entry.message === "Matched forward reimbursement text context for image merge"));
});

test("handleMessage merges reimbursement image and text when they share the same second timestamp", { concurrency: false }, async () => {
  const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
  const imageMessageId = "reimbursement-image-same-second-test";
  const textMessageId = "reimbursement-text-same-second-test";
  const context = createMessageContext([createReimbursementChannel()]);
  const sameSecond = new Date("2026-05-22T10:10:10.000Z");
  const beforeReportCount = listRecentReimbursementReports(1000).length;

  await handleMessage(
    {
      id: () => imageMessageId,
      date: () => sameSecond,
      room: async () => ({
        alias: async () => "小周",
        id: () => "reimbursement_room_4",
        topic: async () => "AI报账群",
      }),
      self: () => false,
      talker: async () => ({
        id: () => "reimbursement_talker_same_second",
        name: () => "Ryan。",
      }),
      text: () => "",
      toFileBox: async () => ({
        name: "same-second.jpg",
        toBuffer: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      }),
      type: () => 6,
    },
    context,
    createLogger(logs),
  );

  await handleMessage(
    {
      id: () => textMessageId,
      date: () => sameSecond,
      room: async () => ({
        alias: async () => "小周",
        id: () => "reimbursement_room_4",
        topic: async () => "AI报账群",
      }),
      self: () => false,
      talker: async () => ({
        id: () => "reimbursement_talker_same_second",
        name: () => "Ryan。",
      }),
      text: () => "平",
      type: () => 7,
    },
    context,
    createLogger(logs),
  );

  const reports = listRecentReimbursementReports(1000).filter((report) => report.reporter === "小周");

  assert.equal(reports.length, 1);
  assert.equal(reports[0]?.evidenceType, "image+text");
  assert.equal(reports[0]?.note, "平");
  assert.equal(listRecentReimbursementReports(1000).length, beforeReportCount + 1);
  assert(logs.some((entry) => entry.message === "Matched reimbursement image context for remark merge"));
});

test("handleMessage rechecks forward reimbursement text after image extraction", { concurrency: false }, async () => {
  const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
  const imageMessageId = "reimbursement-image-recheck-test";
  const textMessageId = "reimbursement-text-during-image-extraction-test";
  const context = {
    ...createMessageContext([createReimbursementChannel()]),
    reimbursementExtractionApiKey: "test-key",
  };
  const imageSentAt = new Date("2026-05-22T10:20:00.000Z");
  const textSentAt = new Date("2026-05-22T10:20:05.000Z");
  const beforeReportCount = listRecentReimbursementReports(1000).length;

  globalThis.fetch = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));

    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                amount: "88.00",
                currency: "人民币",
                expense_category: "other",
                voucher_date: "2026-05-22",
                merchant: "测试商户",
                document_no: null,
                voucher_type: "order",
                ocr_text: "总实付88.00",
                confidence: 0.91,
              }),
            },
          },
        ],
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  }) as typeof fetch;

  try {
    const imageTask = handleMessage(
      {
        id: () => imageMessageId,
        date: () => imageSentAt,
        room: async () => ({
          alias: async () => "小韩",
          id: () => "reimbursement_room_5",
          topic: async () => "AI报账群",
        }),
        self: () => false,
        talker: async () => ({
          id: () => "reimbursement_talker_recheck",
          name: () => "Ryan。",
        }),
        text: () => "",
        toFileBox: async () => ({
          name: "delayed.jpg",
          toBuffer: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
        }),
        type: () => 6,
      },
      context,
      createLogger(logs),
    );

    await new Promise((resolve) => setTimeout(resolve, 5));

    await handleMessage(
      {
        id: () => textMessageId,
        date: () => textSentAt,
        room: async () => ({
          alias: async () => "小韩",
          id: () => "reimbursement_room_5",
          topic: async () => "AI报账群",
        }),
        self: () => false,
        talker: async () => ({
          id: () => "reimbursement_talker_recheck",
          name: () => "Ryan。",
        }),
        text: () => "补充备注",
        type: () => 7,
      },
      context,
      createLogger(logs),
    );

    await imageTask;

    const reports = listRecentReimbursementReports(1000).filter((report) => report.reporter === "小韩");

    assert.equal(reports.length, 1);
    assert.equal(reports[0]?.evidenceType, "image+text");
    assert.equal(reports[0]?.note, "补充备注");
    assert.equal(reports[0]?.amount, 88);
    assert.equal(listRecentReimbursementReports(1000).length, beforeReportCount + 1);
    assert(logs.some((entry) => entry.message === "Recent reimbursement image raw message has no persisted report yet"));
    assert(logs.some((entry) => entry.message === "Rechecking forward reimbursement text context after extraction"));
    assert(logs.some((entry) => entry.message === "Matched forward reimbursement text context after extraction"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleMessage imports reimbursement from configured private command sender and replies processed", { concurrency: false }, async () => {
  const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
  const replies: string[] = [];
  const beforeReportCount = listRecentReimbursementReports(1000).length;

  await handleMessage(
    {
      id: () => "private-manual-import-success",
      date: () => new Date("2026-07-02T06:32:00.000Z"),
      room: async () => null,
      self: () => false,
      talker: async () => ({
        id: () => "private_manual_import_sender",
        name: () => "补录操作员",
        say: async (text: string) => {
          replies.push(text);
        },
      }),
      text: () =>
        [
          "补录报账",
          "channel_code: reimbursement_fuzzy",
          "reporter: 张三",
          "amount: 36.5",
          "category: 食材",
          "note: 午餐报账",
          "sent_at: 2026-07-02T14:32:00+08:00",
        ].join("\n"),
      type: () => 7,
    },
    {
      ...createMessageContext([
        {
          code: "reimbursement_fuzzy",
          deliveryTargets: [],
          enabled: true,
          match: {
            type: "room_topic",
            value: "模糊报账群",
          },
          scenario: "reimbursement",
          summarySchedule: "",
        },
      ]),
      manualReimbursementContactName: "补录操作员",
    },
    createLogger(logs),
  );

  const reports = listRecentReimbursementReports(1000).filter((report) => report.reporter === "张三");

  assert.equal(replies.at(-1), "已处理");
  assert.equal(reports.length, 1);
  assert.equal(reports[0]?.channelCode, "reimbursement_fuzzy");
  assert.equal(reports[0]?.channelName, "模糊报账群");
  assert.equal(reports[0]?.amount, 36.5);
  assert.equal(reports[0]?.expenseCategory, "food");
  assert.equal(reports[0]?.note, "午餐报账");
  assert.equal(reports[0]?.voucherDate, "2026-07-02");
  assert.equal(listRecentReimbursementReports(1000).length, beforeReportCount + 1);
  assert(logs.some((entry) => entry.message === "Imported reimbursement report from private manual command"));
});

test("handleMessage replies with format example for malformed private reimbursement command", { concurrency: false }, async () => {
  const replies: string[] = [];
  const beforeReportCount = listRecentReimbursementReports(1000).length;

  await handleMessage(
    {
      id: () => "private-manual-import-invalid",
      room: async () => null,
      self: () => false,
      talker: async () => ({
        id: () => "private_manual_import_sender_invalid",
        name: () => "补录操作员",
        say: async (text: string) => {
          replies.push(text);
        },
      }),
      text: () =>
        [
          "补录报账",
          "channel_code: reimbursement_fuzzy",
          "amount: abc",
        ].join("\n"),
      type: () => 7,
    },
    {
      ...createMessageContext([createReimbursementChannel()]),
      manualReimbursementContactName: "补录操作员",
    },
    createLogger([]),
  );

  assert.match(replies.at(-1) ?? "", /^格式错误，请按以下格式发送：/);
  assert.equal(listRecentReimbursementReports(1000).length, beforeReportCount);
});

test("handleMessage logs sender mismatch for private reimbursement-like command", { concurrency: false }, async () => {
  const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];

  await handleMessage(
    {
      id: () => "private-manual-import-sender-mismatch",
      room: async () => null,
      self: () => false,
      talker: async () => ({
        id: () => "private_manual_import_sender_mismatch",
        name: () => "真实发送人",
        say: async () => {
          throw new Error("should not reply");
        },
      }),
      text: () =>
        [
          "补录报账",
          "channel_code: reimbursement_fuzzy",
          "reporter: 张三",
          "amount: 36.5",
          "category: 食材",
        ].join("\n"),
      type: () => 7,
    },
    {
      ...createMessageContext([createReimbursementChannel()]),
      manualReimbursementContactName: "Ryan。",
    },
    createLogger(logs),
  );

  assert(
    logs.some(
      (entry) =>
        entry.message === "Ignored private manual reimbursement command due to sender mismatch" &&
        entry.context?.senderName === "真实发送人" &&
        entry.context?.expectedSenderName === "Ryan。",
    ),
  );
});

test("handleMessage logs command header mismatch for configured private reimbursement contact", { concurrency: false }, async () => {
  const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];

  await handleMessage(
    {
      id: () => "private-manual-import-header-mismatch",
      room: async () => null,
      self: () => false,
      talker: async () => ({
        id: () => "private_manual_import_header_mismatch",
        name: () => "补录操作员",
        say: async () => {
          throw new Error("should not reply");
        },
      }),
      text: () => "帮我补录一下",
      type: () => 7,
    },
    {
      ...createMessageContext([createReimbursementChannel()]),
      manualReimbursementContactName: "补录操作员",
    },
    createLogger(logs),
  );

  assert(
    logs.some(
      (entry) =>
        entry.message === "Ignored private message from manual reimbursement contact because command header did not match" &&
        entry.context?.firstLine === "帮我补录一下",
    ),
  );
});
