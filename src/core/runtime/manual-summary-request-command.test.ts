import assert from "node:assert/strict";
import { test } from "node:test";

import type { ChannelConfig } from "../channels/types.js";
import {
  parseSendLossSummaryCliArgs,
  resolveLossSummaryRequestChannels,
} from "./manual-summary-request-command.js";

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
  };
}

test("parseSendLossSummaryCliArgs applies timezone-based default date", () => {
  const options = parseSendLossSummaryCliArgs([], {
    now: new Date("2026-05-20T23:30:00.000Z"),
    timeZone: "Asia/Shanghai",
  });

  assert.equal(options.targetDate, "2026-05-21");
  assert.equal(options.waitTimeoutMs, 20_000);
  assert.equal(options.sendAll, false);
});

test("parseSendLossSummaryCliArgs rejects using --all and --channel together", () => {
  assert.throws(
    () => parseSendLossSummaryCliArgs(["--all", "--channel", "loss_a"]),
    /either --all or --channel/i,
  );
});

test("resolveLossSummaryRequestChannels selects the only enabled channel by default", () => {
  const channels = [createChannel("loss_a")];

  assert.deepEqual(resolveLossSummaryRequestChannels(channels, { sendAll: false }), channels);
});

test("resolveLossSummaryRequestChannels requires an explicit selector for multiple channels", () => {
  assert.throws(
    () =>
      resolveLossSummaryRequestChannels([createChannel("loss_a"), createChannel("loss_b")], {
        sendAll: false,
      }),
    /Use --channel <code> or --all/i,
  );
});
