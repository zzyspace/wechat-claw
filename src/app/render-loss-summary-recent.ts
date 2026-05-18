import { getAppConfig } from "../core/config/env.js";
import { getDatabase } from "../core/storage/database.js";
import { getLossReportScenarioConfig } from "../scenarios/loss-report/config.js";
import { buildLossDailySummaryWithMergeWindow, renderLossDailySummaryText } from "../scenarios/loss-report/daily-summary.js";

function resolveMinutesArg(): number {
  const value = Number(process.argv[2] ?? "10");
  return Number.isFinite(value) && value > 0 ? value : 10;
}

function main() {
  const recentMinutes = resolveMinutesArg();
  const config = getAppConfig();
  const scenarioConfig = getLossReportScenarioConfig({
    summaryCron: config.summaryCron,
    summaryPromptTemplate: config.summaryPromptTemplate,
    mergeWindowSeconds: config.lossMergeWindowSeconds,
  });
  const db = getDatabase();
  const now = new Date();
  const since = new Date(now.getTime() - recentMinutes * 60 * 1000);
  const targetDate = now.toISOString().slice(0, 10);

  const rows = db
    .prepare(`
      SELECT
        rm.sender_name as senderName,
        rm.text_content as textContent,
        rm.event_received_at as eventReceivedAt,
        se.id,
        se.raw_message_id as rawMessageId,
        se.scenario_code as scenarioCode,
        se.extractor_code as extractorCode,
        se.status,
        se.confidence,
        se.needs_review as needsReview,
        se.result_json as resultJson,
        se.created_at as createdAt
      FROM scenario_extractions se
      INNER JOIN raw_messages rm ON rm.id = se.raw_message_id
      WHERE rm.event_received_at >= ?
      ORDER BY rm.sender_name ASC, rm.event_received_at ASC, rm.id ASC
    `)
    .all(since.toISOString()) as Array<{
    senderName: string;
    textContent: string;
    eventReceivedAt: string;
    id: number;
    rawMessageId: number;
    scenarioCode: string;
    extractorCode: string;
    status: string;
    confidence: number;
    needsReview: number;
    resultJson: string;
    createdAt: string;
  }>;

  const summary = buildLossDailySummaryWithMergeWindow(
    targetDate,
    rows.map((row) => ({
      senderName: row.senderName,
      textContent: row.textContent,
      eventReceivedAt: row.eventReceivedAt,
      extraction: {
        id: row.id,
        rawMessageId: row.rawMessageId,
        scenarioCode: row.scenarioCode,
        extractorCode: row.extractorCode,
        status: row.status,
        confidence: row.confidence,
        needsReview: Boolean(row.needsReview),
        resultJson: JSON.parse(row.resultJson),
        createdAt: row.createdAt,
      },
    })),
    scenarioConfig.mergeWindowSeconds,
  );

  console.log(`summary_recent_minutes=${recentMinutes}`);
  console.log(`summary_from=${since.toISOString()}`);
  console.log(`merge_window_seconds=${scenarioConfig.mergeWindowSeconds}`);
  console.log(renderLossDailySummaryText(summary, scenarioConfig.summaryPromptTemplate));
}

main();
