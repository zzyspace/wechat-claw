import assert from "node:assert/strict";
import { test } from "node:test";

import type { ChannelConfig } from "../channels/types.js";
import {
  parsePrintLossSummaryCliArgs,
  resolveLossSummaryPrintChannels,
} from "./summary-print-command.js";

function createChannel(code: string): ChannelConfig {
  return {
    code,
    deliveryTargets: [{ type: "contact_name", value: `店长-${code}` }],
    enabled: true,
    match: {
      type: "room_topic",
      value: `群聊-${code}`,
    },
    scenario: "loss-report",
    summarySchedule: "",
    weeklySummarySchedule: "",
  };
}

test("parsePrintLossSummaryCliArgs applies timezone-based default date", () => {
  const options = parsePrintLossSummaryCliArgs([], {
    now: new Date("2026-05-20T23:30:00.000Z"),
    timeZone: "Asia/Shanghai",
  });

  assert.equal(options.targetDate, "2026-05-21");
  assert.equal(options.summaryType, "daily");
  assert.equal(options.printAll, false);
});

test("parsePrintLossSummaryCliArgs supports weekly summary type", () => {
  const options = parsePrintLossSummaryCliArgs(["--type", "weekly", "--date", "2026-05-24"]);

  assert.equal(options.summaryType, "weekly");
  assert.equal(options.targetDate, "2026-05-24");
});

test("parsePrintLossSummaryCliArgs rejects using --all and --channel together", () => {
  assert.throws(
    () => parsePrintLossSummaryCliArgs(["--all", "--channel", "loss_a"]),
    /either --all or --channel/i,
  );
});

test("resolveLossSummaryPrintChannels selects all enabled channels by default", () => {
  const channels = [createChannel("loss_a"), createChannel("loss_b")];

  assert.deepEqual(resolveLossSummaryPrintChannels(channels, { printAll: false }), channels);
});

test("resolveLossSummaryPrintChannels supports selecting a single channel", () => {
  const channels = [createChannel("loss_a"), createChannel("loss_b")];

  assert.deepEqual(resolveLossSummaryPrintChannels(channels, { channelCode: "loss_b", printAll: false }), [
    channels[1],
  ]);
});
