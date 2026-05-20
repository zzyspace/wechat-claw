import assert from "node:assert/strict";
import { test } from "node:test";

import type { ScenarioExtractionRecord } from "../../core/scenarios/scenario-extraction-repository.js";
import { buildLossDailySummaryWithMergeWindow, renderLossDailySummaryText } from "./daily-summary.js";

function createExtractionRecord(rawMessageId: number, eventReceivedAt: string): ScenarioExtractionRecord {
  return {
    id: rawMessageId,
    rawMessageId,
    scenarioCode: "loss-report",
    extractorCode: "heuristic",
    status: "extracted",
    confidence: 0.95,
    needsReview: false,
    resultJson: {
      rawMessageId,
      reportedAt: eventReceivedAt,
      isRelevant: true,
      evidenceType: "image+text",
      reporterSummary: "生菜 1份",
      notes: "变质",
      reasonCategory: "变质",
      items: [{ name: "生菜", quantity: 1, unit: "份", confidence: 0.95 }],
    },
    createdAt: eventReceivedAt,
  };
}

test("buildLossDailySummaryWithMergeWindow does not merge same sender across channels", () => {
  const eventReceivedAt = "2026-05-20T10:00:00.000Z";
  const summary = buildLossDailySummaryWithMergeWindow(
    "2026-05-20",
    [
      {
        channelCode: "loss_a",
        channelName: "门店A报损群",
        senderName: "小王",
        textContent: "生菜坏了",
        eventReceivedAt,
        extraction: createExtractionRecord(1, eventReceivedAt),
      },
      {
        channelCode: "loss_b",
        channelName: "门店B报损群",
        senderName: "小王",
        textContent: "生菜坏了",
        eventReceivedAt: "2026-05-20T10:00:30.000Z",
        extraction: createExtractionRecord(2, "2026-05-20T10:00:30.000Z"),
      },
    ],
    60,
  );

  assert.equal(summary.totalRelevantMessages, 2);
  assert.equal(summary.reporters.length, 2);
  assert.equal(summary.reporters[0]?.reportItems[0]?.channelName, "门店A报损群");
  assert.equal(summary.reporters[1]?.reportItems[0]?.channelName, "门店B报损群");
});

test("renderLossDailySummaryText includes channel name when provided", () => {
  const text = renderLossDailySummaryText(
    {
      date: "2026-05-20",
      channelCode: "loss_a",
      channelName: "门店A报损群",
      totalRelevantMessages: 1,
      totalReporters: 1,
      totalNeedsReview: 0,
      reporters: [
        {
          reporter: "小王",
          messageCount: 1,
          reportItems: [
            {
              rawMessageId: 1,
              channelCode: "loss_a",
              channelName: "门店A报损群",
              reportedAt: "2026-05-20T10:00:00.000Z",
              evidenceType: "text",
              reporterSummary: "生菜 1份",
              sourceTexts: ["生菜坏了"],
              notes: "变质",
              reasonCategory: "变质",
              items: [{ name: "生菜", quantity: 1, unit: "份", confidence: 0.95 }],
              needsReview: false,
            },
          ],
        },
      ],
    },
    "请汇总",
  );

  assert.match(text, /群聊：门店A报损群/);
});
