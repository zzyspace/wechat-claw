import { getAppConfig, validateAppConfig } from "../core/config/env.js";
import { getChannelDisplayName } from "../core/channels/router.js";
import {
  buildPrintUsageText,
  parsePrintLossSummaryCliArgs,
  resolveLossSummaryPrintChannels,
} from "../core/runtime/summary-print-command.js";
import {
  renderLossDailySummaryForDate,
  renderLossWeeklySummaryForDate,
} from "../scenarios/loss-report/summary-service.js";

function main() {
  const config = getAppConfig();
  const validation = validateAppConfig(config);

  if (validation.errors.length > 0) {
    for (const error of validation.errors) {
      console.error(`Config error: ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  let cliOptions: ReturnType<typeof parsePrintLossSummaryCliArgs>;

  try {
    cliOptions = parsePrintLossSummaryCliArgs(process.argv.slice(2), {
      timeZone: config.timeZone,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes("Usage:")) {
      console.log(message);
      return;
    }

    console.error(message);
    console.log("");
    console.log(buildPrintUsageText());
    process.exitCode = 1;
    return;
  }

  let selectedChannels;

  try {
    selectedChannels = resolveLossSummaryPrintChannels(config.channels, cliOptions);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    console.log("");
    console.log(buildPrintUsageText());
    process.exitCode = 1;
    return;
  }

  console.log(`summary_type=${cliOptions.summaryType}`);
  console.log(`target_date=${cliOptions.targetDate}`);
  console.log(`timezone=${config.timeZone}`);
  console.log(`merge_window_seconds=${config.lossMergeWindowSeconds}`);
  console.log(`channels=${selectedChannels.length}`);

  for (const channel of selectedChannels) {
    console.log("----");
    console.log(`channel_code=${channel.code}`);
    console.log(`channel_name=${getChannelDisplayName(channel)}`);
    console.log(
      `summary_schedule=${
        cliOptions.summaryType === "weekly"
          ? channel.weeklySummarySchedule || "(disabled)"
          : channel.summarySchedule || "(disabled)"
      }`,
    );

    const text =
      cliOptions.summaryType === "weekly"
        ? renderLossWeeklySummaryForDate(cliOptions.targetDate, {
            summaryCron: channel.weeklySummarySchedule ?? "",
            summaryPromptTemplate: config.summaryPromptTemplate,
            mergeWindowSeconds: config.lossMergeWindowSeconds,
            timeZone: config.timeZone,
            channelCode: channel.code,
            channelName: getChannelDisplayName(channel),
          })
        : renderLossDailySummaryForDate(cliOptions.targetDate, {
            summaryCron: channel.summarySchedule,
            summaryPromptTemplate: config.summaryPromptTemplate,
            mergeWindowSeconds: config.lossMergeWindowSeconds,
            timeZone: config.timeZone,
            channelCode: channel.code,
            channelName: getChannelDisplayName(channel),
          });

    console.log(text);
  }
}

main();
