import assert from "node:assert/strict";
import { test } from "node:test";

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
