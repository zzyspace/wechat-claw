import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { ChannelConfig } from "../core/channels/types.js";
import type { Logger } from "../core/logging/logger.js";
import { getReimbursementRawStorageDir } from "../core/runtime/state-paths.js";
import { listRecentRawMessages } from "../core/storage/raw-message-repository.js";
import { listRecentReimbursementReports } from "../scenarios/reimbursement/repository.js";
import { handleMessage } from "./message-handler.js";

process.env.WECHATY_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claw-message-handler-"));

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
  return {
    code: "reimbursement_a",
    deliveryTargets: [],
    enabled: true,
    match: {
      type: "room_topic",
      value: "AI报账群",
    },
    scenario: "reimbursement",
    summarySchedule: "",
  };
}

function createMessageContext(channels: ChannelConfig[]) {
  return {
    channels,
    lossMergeWindowSeconds: 30,
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

test("handleMessage stores reimbursement text-only messages without recent image context", { concurrency: false }, async () => {
  const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
  const messageId = "reimbursement-text-test";

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
    },
    createMessageContext([createReimbursementChannel()]),
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
  const context = createMessageContext([createReimbursementChannel()]);

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
});

test("handleMessage does not merge reimbursement text followed by image", { concurrency: false }, async () => {
  const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
  const textMessageId = "reimbursement-text-before-image-test";
  const imageMessageId = "reimbursement-image-after-text-test";
  const context = createMessageContext([createReimbursementChannel()]);
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
    },
    context,
    createLogger(logs),
  );

  const reports = listRecentReimbursementReports(1000).filter(
    (report) => report.reporter === "小赵" && report.note === "昨晚外卖报账 42元",
  );
  const originalTextReport = reports.find((report) => report.id === textReport.id);
  const imageRawMessage = listRecentRawMessages(1000).find(
    (message) => message.messageExternalId === imageMessageId,
  );
  const imageOnlyReport = listRecentReimbursementReports(1000).find(
    (report) => report.reporter === "小赵" && report.id !== textReport.id && report.evidenceType === "image",
  );

  assert.equal(reports.length, 1);
  assert(originalTextReport);
  assert(imageRawMessage);
  assert(imageOnlyReport);
  assert.equal(originalTextReport.evidenceType, "text");
  assert.equal(originalTextReport.note, "昨晚外卖报账 42元");
  assert.equal(originalTextReport.amount, 42);
  assert.equal(imageOnlyReport.evidenceType, "image");
  assert.equal(listRecentReimbursementReports(1000).length, beforeReportCount + 2);
  assert(logs.some((entry) => entry.message === "No forward reimbursement text context matched for image merge"));
});

test("handleMessage merges reimbursement image sent first even when text is processed first", { concurrency: false }, async () => {
  const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
  const imageMessageId = "reimbursement-image-sent-first-text-processed-first-image";
  const textMessageId = "reimbursement-text-processed-first-after-image";
  const context = createMessageContext([createReimbursementChannel()]);
  const imageSentAt = new Date("2026-05-22T10:00:00.000Z");
  const textSentAt = new Date("2026-05-22T10:00:05.000Z");
  const beforeReportCount = listRecentReimbursementReports(1000).length;

  await handleMessage(
    {
      id: () => textMessageId,
      date: () => textSentAt,
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

  await handleMessage(
    {
      id: () => imageMessageId,
      date: () => imageSentAt,
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
      toFileBox: async () => ({
        name: "meal.jpg",
        toBuffer: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      }),
      type: () => 6,
    },
    context,
    createLogger(logs),
  );

  const reports = listRecentReimbursementReports(1000).filter(
    (report) => report.reporter === "小孙" && report.note === "午餐外卖 35元",
  );

  assert.equal(reports.length, 1);
  assert.equal(reports[0]?.evidenceType, "image+text");
  assert.equal(reports[0]?.amount, 35);
  assert.equal(listRecentReimbursementReports(1000).length, beforeReportCount + 1);
  assert(logs.some((entry) => entry.message === "Matched forward reimbursement text context for image merge"));
});
