import { getEnabledScenarioChannels } from "../channels/router.js";
import type { ChannelConfig } from "../channels/types.js";
import type { SummarySendRequestType } from "./manual-summary-request.js";
import { formatZonedDate, parseDateString } from "./timezone.js";

export interface PrintLossSummaryCliOptions {
  channelCode?: string;
  printAll: boolean;
  summaryType: SummarySendRequestType;
  targetDate: string;
}

export function parsePrintLossSummaryCliArgs(
  argv: string[],
  options?: {
    now?: Date;
    timeZone?: string;
  },
): PrintLossSummaryCliOptions {
  const timeZone = options?.timeZone ?? "Asia/Shanghai";
  let channelCode: string | undefined;
  let printAll = false;
  let summaryType: SummarySendRequestType = "daily";
  let targetDate = formatZonedDate(options?.now ?? new Date(), timeZone);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      throw new Error(buildPrintUsageText());
    }

    if (arg === "--all") {
      printAll = true;
      continue;
    }

    if (arg.startsWith("--channel=")) {
      channelCode = arg.slice("--channel=".length).trim();
      continue;
    }

    if (arg === "--channel") {
      channelCode = readNextValue(argv, index, "--channel");
      index += 1;
      continue;
    }

    if (arg.startsWith("--date=")) {
      targetDate = arg.slice("--date=".length).trim();
      continue;
    }

    if (arg === "--date") {
      targetDate = readNextValue(argv, index, "--date");
      index += 1;
      continue;
    }

    if (arg.startsWith("--type=")) {
      summaryType = parseSummaryType(arg.slice("--type=".length).trim());
      continue;
    }

    if (arg === "--type") {
      summaryType = parseSummaryType(readNextValue(argv, index, "--type"));
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}\n\n${buildPrintUsageText()}`);
  }

  if (printAll && channelCode) {
    throw new Error("Use either --all or --channel, not both.");
  }

  parseDateString(targetDate);

  return {
    ...(channelCode ? { channelCode } : {}),
    printAll,
    summaryType,
    targetDate,
  };
}

export function resolveLossSummaryPrintChannels(
  channels: ChannelConfig[],
  options: Pick<PrintLossSummaryCliOptions, "channelCode" | "printAll">,
): ChannelConfig[] {
  const enabledChannels = getEnabledScenarioChannels(channels, "loss-report");

  if (enabledChannels.length === 0) {
    throw new Error("No enabled loss-report channels configured.");
  }

  if (options.channelCode) {
    const channel = enabledChannels.find((item) => item.code === options.channelCode);

    if (!channel) {
      throw new Error(`Enabled loss-report channel not found: ${options.channelCode}`);
    }

    return [channel];
  }

  return enabledChannels;
}

export function buildPrintUsageText() {
  return [
    "Usage: npm run summary:print -- [--channel <code> | --all] [--type daily|weekly] [--date YYYY-MM-DD]",
    "",
    "Examples:",
    "  npm run summary:print -- --type daily",
    "  npm run summary:print -- --channel loss_a --date 2026-05-20",
    "  npm run summary:print -- --channel loss_a --type weekly --date 2026-05-24",
    "  npm run summary:print:weekly -- --channel loss_a",
  ].join("\n");
}

function readNextValue(argv: string[], index: number, flag: string) {
  const value = argv[index + 1]?.trim();

  if (!value) {
    throw new Error(`Missing value for ${flag}`);
  }

  return value;
}

function parseSummaryType(raw: string): SummarySendRequestType {
  if (raw === "daily" || raw === "weekly") {
    return raw;
  }

  throw new Error(`Invalid --type value: ${raw}. Expected daily or weekly.`);
}
