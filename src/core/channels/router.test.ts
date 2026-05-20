import assert from "node:assert/strict";
import { test } from "node:test";

import { collectChannelDeliveryTargets, matchChannelByRoomTopic } from "./router.js";
import type { ChannelConfig } from "./types.js";

const channels: ChannelConfig[] = [
  {
    code: "loss_a",
    enabled: true,
    scenario: "loss-report",
    match: { type: "room_topic", value: "门店A报损群" },
    deliveryTargets: [
      { type: "contact_name", value: "店长A" },
      { type: "room_topic", value: "门店A日报群" },
    ],
    summarySchedule: "0 22 * * *",
  },
  {
    code: "loss_b",
    enabled: false,
    scenario: "loss-report",
    match: { type: "room_topic", value: "门店B报损群" },
    deliveryTargets: [{ type: "contact_name", value: "店长B" }],
    summarySchedule: "0 22 * * *",
  },
  {
    code: "loss_c",
    enabled: true,
    scenario: "loss-report",
    match: { type: "room_topic", value: "门店C报损群" },
    deliveryTargets: [
      { type: "contact_name", value: "店长A" },
      { type: "room_topic", value: "门店A日报群" },
      { type: "room_topic", value: "门店C日报群" },
    ],
    summarySchedule: "",
  },
];

test("matchChannelByRoomTopic only matches enabled channels", () => {
  assert.equal(matchChannelByRoomTopic(channels, "门店A报损群")?.code, "loss_a");
  assert.equal(matchChannelByRoomTopic(channels, "门店B报损群"), null);
  assert.equal(matchChannelByRoomTopic(channels, "不存在的群"), null);
});

test("collectChannelDeliveryTargets dedupes identical targets across channels", () => {
  assert.deepEqual(collectChannelDeliveryTargets(channels), [
    { type: "contact_name", value: "店长A" },
    { type: "room_topic", value: "门店A日报群" },
    { type: "room_topic", value: "门店C日报群" },
  ]);
});
