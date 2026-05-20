import { getAppConfig } from "../core/config/env.js";
import { getChannelDisplayName, getEnabledScenarioChannels } from "../core/channels/router.js";
import { renderRecentLossSummary } from "../scenarios/loss-report/summary-service.js";

function resolveMinutesArg(): number {
  const value = Number(process.argv[2] ?? "10");
  return Number.isFinite(value) && value > 0 ? value : 10;
}

function main() {
  const recentMinutes = resolveMinutesArg();
  const config = getAppConfig();
  const channels = getEnabledScenarioChannels(config.channels, "loss-report");

  if (channels.length === 0) {
    console.log("No enabled loss-report channels configured.");
    process.exitCode = 1;
    return;
  }

  console.log(`summary_recent_minutes=${recentMinutes}`);
  console.log(`timezone=${config.timeZone}`);
  console.log(`merge_window_seconds=${config.lossMergeWindowSeconds}`);
  console.log(`channels=${channels.length}`);

  for (const channel of channels) {
    const summary = renderRecentLossSummary(recentMinutes, {
      summaryCron: channel.summarySchedule,
      summaryPromptTemplate: config.summaryPromptTemplate,
      mergeWindowSeconds: config.lossMergeWindowSeconds,
      timeZone: config.timeZone,
      channelCode: channel.code,
      channelName: getChannelDisplayName(channel),
    });

    console.log("----");
    console.log(`channel_code=${channel.code}`);
    console.log(`channel_name=${getChannelDisplayName(channel)}`);
    console.log(`summary_from=${summary.summaryFromIso}`);
    console.log(summary.text);
  }
}

main();
