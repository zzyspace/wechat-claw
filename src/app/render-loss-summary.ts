import { getAppConfig } from "../core/config/env.js";
import { getChannelDisplayName, getEnabledScenarioChannels } from "../core/channels/router.js";
import { renderLossDailySummaryForDate } from "../scenarios/loss-report/summary-service.js";

function resolveDateArg(): string {
  return process.argv[2] || new Date().toISOString().slice(0, 10);
}

function main() {
  const targetDate = resolveDateArg();
  const config = getAppConfig();
  const channels = getEnabledScenarioChannels(config.channels, "loss-report");

  if (channels.length === 0) {
    console.log("No enabled loss-report channels configured.");
    process.exitCode = 1;
    return;
  }

  console.log(`timezone=${config.timeZone}`);
  console.log(`merge_window_seconds=${config.lossMergeWindowSeconds}`);
  console.log(`channels=${channels.length}`);

  for (const channel of channels) {
    console.log("----");
    console.log(`channel_code=${channel.code}`);
    console.log(`channel_name=${getChannelDisplayName(channel)}`);
    console.log(`summary_cron=${channel.summarySchedule || "(disabled)"}`);
    console.log(
      renderLossDailySummaryForDate(targetDate, {
        summaryCron: channel.summarySchedule,
        summaryPromptTemplate: config.summaryPromptTemplate,
        mergeWindowSeconds: config.lossMergeWindowSeconds,
        timeZone: config.timeZone,
        channelCode: channel.code,
        channelName: getChannelDisplayName(channel),
      }),
    );
  }
}

main();
