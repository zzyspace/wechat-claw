import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import type { Logger } from "../core/logging/logger.js";
import { countSuccessfulDeliveries, sendTextToTargets } from "./delivery-contact.js";
import type { WechatyInstance } from "./types.js";

const logger = {
  debug() {
    // no-op
  },
  error() {
    // no-op
  },
  info() {
    // no-op
  },
  warn() {
    // no-op
  },
} satisfies Logger;

const originalSuppressRoomTextDelivery = process.env.WECHATY_SUPPRESS_ROOM_TEXT_DELIVERY;

beforeEach(() => {
  process.env.WECHATY_SUPPRESS_ROOM_TEXT_DELIVERY = "false";
});

afterEach(() => {
  if (originalSuppressRoomTextDelivery === undefined) {
    delete process.env.WECHATY_SUPPRESS_ROOM_TEXT_DELIVERY;
  } else {
    process.env.WECHATY_SUPPRESS_ROOM_TEXT_DELIVERY = originalSuppressRoomTextDelivery;
  }
});

test("sendTextToTargets supports contact_name and room_topic without aborting on failures", async () => {
  const delivered: string[] = [];
  const bot = {
    Contact: {
      find: async (query: Record<string, unknown>) =>
        query.name === "店长A"
          ? {
              async say(text: string) {
                delivered.push(`contact:${text}`);
              },
            }
          : null,
    },
    Room: {
      find: async (query: Record<string, unknown>) =>
        query.topic === "门店A日报群"
          ? {
              async say(text: string) {
                delivered.push(`room:${text}`);
              },
            }
          : null,
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
  const results = await sendTextToTargets(
    bot,
    [
      { type: "contact_name", value: "店长A" },
      { type: "contact_name", value: "店长A" },
      { type: "room_topic", value: "门店A日报群" },
      { type: "room_topic", value: "不存在的日报群" },
    ],
    "hello",
    logger,
  );

  assert.equal(results.length, 3);
  assert.equal(countSuccessfulDeliveries(results), 2);
  assert.deepEqual(delivered, ["contact:hello", "room:hello"]);
  assert.equal(results[2]?.delivered, false);
});

test("sendTextToTargets resolves 文件传输助手 via filehelper contact id", async () => {
  const delivered: string[] = [];
  const bot = {
    Contact: {
      find: async (query: Record<string, unknown>) => {
        if (query.id === "filehelper") {
          return {
            async say(text: string) {
              delivered.push(`filehelper:${text}`);
            },
          };
        }

        if (query.name === "文件传输助手") {
          return null;
        }

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

  const results = await sendTextToTargets(
    bot,
    [{ type: "contact_name", value: "文件传输助手" }],
    "ping",
    logger,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0]?.delivered, true);
  assert.deepEqual(delivered, ["filehelper:ping"]);
});

test("sendTextToTargets suppresses room text while preserving contact delivery", async () => {
  const previous = process.env.WECHATY_SUPPRESS_ROOM_TEXT_DELIVERY;
  process.env.WECHATY_SUPPRESS_ROOM_TEXT_DELIVERY = "true";
  const delivered: string[] = [];
  const bot = {
    Contact: {
      find: async () => ({
        async say(text: string) {
          delivered.push(`contact:${text}`);
        },
      }),
    },
    Room: {
      find: async () => ({
        async say(text: string) {
          delivered.push(`room:${text}`);
        },
      }),
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

  try {
    const results = await sendTextToTargets(
      bot,
      [
        { type: "contact_name", value: "店长A" },
        { type: "room_topic", value: "门店A日报群" },
      ],
      "hello",
      logger,
    );

    assert.deepEqual(delivered, ["contact:hello"]);
    assert.equal(results[0]?.delivered, true);
    assert.equal(results[1]?.delivered, false);
    assert.match(results[1]?.error ?? "", /WECHATY_SUPPRESS_ROOM_TEXT_DELIVERY/);
  } finally {
    if (previous === undefined) {
      delete process.env.WECHATY_SUPPRESS_ROOM_TEXT_DELIVERY;
    } else {
      process.env.WECHATY_SUPPRESS_ROOM_TEXT_DELIVERY = previous;
    }
  }
});
