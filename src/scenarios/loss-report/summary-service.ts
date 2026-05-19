import { getDatabase } from "../../core/storage/database.js";
import { formatZonedDate, getUtcRangeForZonedDate } from "../../core/runtime/timezone.js";
import { buildLossDailySummaryWithMergeWindow, renderLossDailySummaryText } from "./daily-summary.js";
import { getLossReportScenarioConfig } from "./config.js";

interface SummaryRow {
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
}

export interface LossSummaryRenderOptions {
  summaryCron: string;
  summaryPromptTemplate: string;
  mergeWindowSeconds: number;
  timeZone: string;
}

function mapRows(rows: SummaryRow[]) {
  return rows.map((row) => ({
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
  }));
}

function queryRowsByUtcRange(startInclusiveIso: string, endExclusiveIso: string): SummaryRow[] {
  const db = getDatabase();

  return db
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
      WHERE rm.event_received_at >= ? AND rm.event_received_at < ?
      ORDER BY rm.sender_name ASC, rm.event_received_at ASC, rm.id ASC
    `)
    .all(startInclusiveIso, endExclusiveIso) as SummaryRow[];
}

export function renderLossDailySummaryForDate(
  targetDate: string,
  options: LossSummaryRenderOptions,
): string {
  const scenarioConfig = getLossReportScenarioConfig({
    summaryCron: options.summaryCron,
    summaryPromptTemplate: options.summaryPromptTemplate,
    mergeWindowSeconds: options.mergeWindowSeconds,
  });
  const range = getUtcRangeForZonedDate(targetDate, options.timeZone);
  const rows = queryRowsByUtcRange(range.startInclusiveIso, range.endExclusiveIso);
  const summary = buildLossDailySummaryWithMergeWindow(
    targetDate,
    mapRows(rows),
    scenarioConfig.mergeWindowSeconds,
  );

  return renderLossDailySummaryText(summary, scenarioConfig.summaryPromptTemplate);
}

export function renderRecentLossSummary(
  recentMinutes: number,
  options: LossSummaryRenderOptions,
): {
  summaryFromIso: string;
  targetDate: string;
  text: string;
} {
  const scenarioConfig = getLossReportScenarioConfig({
    summaryCron: options.summaryCron,
    summaryPromptTemplate: options.summaryPromptTemplate,
    mergeWindowSeconds: options.mergeWindowSeconds,
  });
  const now = new Date();
  const since = new Date(now.getTime() - recentMinutes * 60 * 1000);
  const rows = queryRowsByUtcRange(since.toISOString(), now.toISOString());
  const targetDate = formatZonedDate(now, options.timeZone);
  const summary = buildLossDailySummaryWithMergeWindow(
    targetDate,
    mapRows(rows),
    scenarioConfig.mergeWindowSeconds,
  );

  return {
    summaryFromIso: since.toISOString(),
    targetDate,
    text: renderLossDailySummaryText(summary, scenarioConfig.summaryPromptTemplate),
  };
}
