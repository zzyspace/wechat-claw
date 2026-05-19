import { getAppConfig } from "../core/config/env.js";
import { getLossReportScenarioConfig } from "../scenarios/loss-report/config.js";
import { renderRecentLossSummary } from "../scenarios/loss-report/summary-service.js";

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
  const summary = renderRecentLossSummary(recentMinutes, {
    summaryCron: scenarioConfig.summaryCron,
    summaryPromptTemplate: scenarioConfig.summaryPromptTemplate,
    mergeWindowSeconds: scenarioConfig.mergeWindowSeconds,
    timeZone: config.timeZone,
  });

  console.log(`summary_recent_minutes=${recentMinutes}`);
  console.log(`summary_from=${summary.summaryFromIso}`);
  console.log(`timezone=${config.timeZone}`);
  console.log(`merge_window_seconds=${scenarioConfig.mergeWindowSeconds}`);
  console.log(summary.text);
}

main();
