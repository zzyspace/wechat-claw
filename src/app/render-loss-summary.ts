import { getAppConfig } from "../core/config/env.js";
import { getLossReportScenarioConfig } from "../scenarios/loss-report/config.js";
import { renderLossDailySummaryForDate } from "../scenarios/loss-report/summary-service.js";

function resolveDateArg(): string {
  return process.argv[2] || new Date().toISOString().slice(0, 10);
}

function main() {
  const targetDate = resolveDateArg();
  const config = getAppConfig();
  const scenarioConfig = getLossReportScenarioConfig({
    summaryCron: config.summaryCron,
    summaryPromptTemplate: config.summaryPromptTemplate,
    mergeWindowSeconds: config.lossMergeWindowSeconds,
  });

  console.log(`summary_cron=${scenarioConfig.summaryCron || "(disabled)"}`);
  console.log(`timezone=${config.timeZone}`);
  console.log(`merge_window_seconds=${scenarioConfig.mergeWindowSeconds}`);
  console.log(
    renderLossDailySummaryForDate(targetDate, {
      summaryCron: scenarioConfig.summaryCron,
      summaryPromptTemplate: scenarioConfig.summaryPromptTemplate,
      mergeWindowSeconds: scenarioConfig.mergeWindowSeconds,
      timeZone: config.timeZone,
    }),
  );
}

main();
