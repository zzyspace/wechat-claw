import assert from "node:assert/strict";
import { test } from "node:test";

import { shouldIgnoreColdStartMessage } from "./cold-start-filter.js";

test("shouldIgnoreColdStartMessage ignores replayed messages older than the startup cutoff", () => {
  const decision = shouldIgnoreColdStartMessage(
    {
      date: () => new Date("2026-05-21T02:58:30.000Z"),
      id: () => "history-message",
    },
    {
      botStartedAt: "2026-05-21T03:00:00.000Z",
      coldStartIgnoreWindowSeconds: 30,
      now: new Date("2026-05-21T03:00:05.000Z"),
    },
  );

  assert.equal(decision.ignored, true);
  assert.equal(decision.cutoffAt, "2026-05-21T02:59:30.000Z");
  assert.equal(decision.messageSentAt, "2026-05-21T02:58:30.000Z");
});

test("shouldIgnoreColdStartMessage keeps messages inside the startup tolerance window", () => {
  const decision = shouldIgnoreColdStartMessage(
    {
      date: () => new Date("2026-05-21T02:59:45.000Z"),
    },
    {
      botStartedAt: "2026-05-21T03:00:00.000Z",
      coldStartIgnoreWindowSeconds: 30,
      now: new Date("2026-05-21T03:00:05.000Z"),
    },
  );

  assert.equal(decision.ignored, false);
});

test("shouldIgnoreColdStartMessage can infer sent time from message.age()", () => {
  const decision = shouldIgnoreColdStartMessage(
    {
      age: () => 125,
    },
    {
      botStartedAt: "2026-05-21T03:00:00.000Z",
      coldStartIgnoreWindowSeconds: 30,
      now: new Date("2026-05-21T03:00:05.000Z"),
    },
  );

  assert.equal(decision.ignored, true);
  assert.equal(decision.messageSentAt, "2026-05-21T02:58:00.000Z");
});

test("shouldIgnoreColdStartMessage is disabled when the window is zero", () => {
  const decision = shouldIgnoreColdStartMessage(
    {
      date: () => new Date("2026-05-21T02:00:00.000Z"),
    },
    {
      botStartedAt: "2026-05-21T03:00:00.000Z",
      coldStartIgnoreWindowSeconds: 0,
      now: new Date("2026-05-21T03:00:05.000Z"),
    },
  );

  assert.equal(decision.ignored, false);
});
