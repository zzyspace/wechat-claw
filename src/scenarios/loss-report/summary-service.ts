import { getDatabase } from "../../core/storage/database.js";
import { formatZonedDate, getUtcRangeForZonedDate, getUtcRangeForZonedWeek } from "../../core/runtime/timezone.js";
import {
  buildLossDailySummaryWithMergeWindow,
  buildLossWeeklySummaryWithMergeWindow,
  renderLossDailySummaryText,
  renderLossWeeklySummaryText,
} from "./daily-summary.js";
import { getLossReportScenarioConfig } from "./config.js";

interface SummaryRow {
  channelCode?: string;
  channelName: string;
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
  channelCode?: string;
  channelName?: string;
}

function mapRows(rows: SummaryRow[]) {
  return rows.map((row) => ({
    channelCode: row.channelCode,
    channelName: row.channelName,
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

function queryRowsByUtcRange(
  startInclusiveIso: string,
  endExclusiveIso: string,
  channelCode?: string,
): SummaryRow[] {
  const db = getDatabase();

  const selectSql = `
    SELECT
      rm.channel_code as channelCode,
      rm.channel_name as channelName,
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
  `;
  const orderSql = `
    ORDER BY rm.channel_name ASC, rm.sender_name ASC, rm.event_received_at ASC, rm.id ASC
  `;

  if (channelCode) {
    return db
      .prepare(`${selectSql} AND rm.channel_code = ? ${orderSql}`)
      .all(startInclusiveIso, endExclusiveIso, channelCode) as SummaryRow[];
  }

  return db
    .prepare(`${selectSql} ${orderSql}`)
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
  const rows = queryRowsByUtcRange(range.startInclusiveIso, range.endExclusiveIso, options.channelCode);
  const summary = buildLossDailySummaryWithMergeWindow(
    targetDate,
    mapRows(rows),
    scenarioConfig.mergeWindowSeconds,
  );
  summary.channelCode = options.channelCode ?? summary.channelCode;
  summary.channelName = options.channelName ?? summary.channelName;

  return renderLossDailySummaryText(summary, scenarioConfig.summaryPromptTemplate);
}

export function renderLossWeeklySummaryForDate(
  targetDate: string,
  options: LossSummaryRenderOptions,
): string {
  const scenarioConfig = getLossReportScenarioConfig({
    summaryCron: options.summaryCron,
    summaryPromptTemplate: options.summaryPromptTemplate,
    mergeWindowSeconds: options.mergeWindowSeconds,
  });
  const range = getUtcRangeForZonedWeek(targetDate, options.timeZone);
  const rows = queryRowsByUtcRange(range.startInclusiveIso, range.endExclusiveIso, options.channelCode);
  const summary = buildLossWeeklySummaryWithMergeWindow(
    range.startDate,
    range.endDate,
    mapRows(rows),
    scenarioConfig.mergeWindowSeconds,
  );
  summary.channelCode = options.channelCode ?? summary.channelCode;
  summary.channelName = options.channelName ?? summary.channelName;

  return renderLossWeeklySummaryText(summary, scenarioConfig.summaryPromptTemplate);
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
  const rows = queryRowsByUtcRange(since.toISOString(), now.toISOString(), options.channelCode);
  const targetDate = formatZonedDate(now, options.timeZone);
  const summary = buildLossDailySummaryWithMergeWindow(
    targetDate,
    mapRows(rows),
    scenarioConfig.mergeWindowSeconds,
  );
  summary.channelCode = options.channelCode ?? summary.channelCode;
  summary.channelName = options.channelName ?? summary.channelName;

  return {
    summaryFromIso: since.toISOString(),
    targetDate,
    text: renderLossDailySummaryText(summary, scenarioConfig.summaryPromptTemplate),
  };
}
