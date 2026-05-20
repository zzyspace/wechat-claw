import { getEnabledScenarioChannels } from "../channels/router.js";
import type { ChannelConfig } from "../channels/types.js";
import type { SummarySendRequestType } from "./manual-summary-request.js";
import { formatZonedDate, parseDateString } from "./timezone.js";

const DEFAULT_WAIT_SECONDS = 20;

export interface SendLossSummaryCliOptions {
  channelCode?: string;
  requestedBy: string;
  sendAll: boolean;
  summaryType: SummarySendRequestType;
  targetDate: string;
  waitTimeoutMs: number;
}

export function parseSendLossSummaryCliArgs(
  argv: string[],
  options?: {
    now?: Date;
    timeZone?: string;
  },
): SendLossSummaryCliOptions {
  const timeZone = options?.timeZone ?? "Asia/Shanghai";
  let channelCode: string | undefined;
  let requestedBy = "cli";
  let sendAll = false;
  let summaryType: SummarySendRequestType = "daily";
  let targetDate = formatZonedDate(options?.now ?? new Date(), timeZone);
  let waitSeconds = DEFAULT_WAIT_SECONDS;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      throw new Error(buildUsageText());
    }

    if (arg === "--all") {
      sendAll = true;
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

    if (arg.startsWith("--wait-seconds=")) {
      waitSeconds = parseWaitSeconds(arg.slice("--wait-seconds=".length).trim());
      continue;
    }

    if (arg === "--wait-seconds") {
      waitSeconds = parseWaitSeconds(readNextValue(argv, index, "--wait-seconds"));
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

    if (arg.startsWith("--requested-by=")) {
      requestedBy = arg.slice("--requested-by=".length).trim();
      continue;
    }

    if (arg === "--requested-by") {
      requestedBy = readNextValue(argv, index, "--requested-by");
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}\n\n${buildUsageText()}`);
  }

  if (sendAll && channelCode) {
    throw new Error("Use either --all or --channel, not both.");
  }

  if (!requestedBy.trim()) {
    throw new Error("requestedBy cannot be empty.");
  }

  parseDateString(targetDate);

  return {
    ...(channelCode ? { channelCode } : {}),
    requestedBy,
    sendAll,
    summaryType,
    targetDate,
    waitTimeoutMs: waitSeconds * 1000,
  };
}

export function resolveLossSummaryRequestChannels(
  channels: ChannelConfig[],
  options: Pick<SendLossSummaryCliOptions, "channelCode" | "sendAll">,
): ChannelConfig[] {
  const enabledChannels = getEnabledScenarioChannels(channels, "loss-report");

  if (enabledChannels.length === 0) {
    throw new Error("No enabled loss-report channels configured.");
  }

  if (options.sendAll) {
    return enabledChannels;
  }

  if (options.channelCode) {
    const channel = enabledChannels.find((item) => item.code === options.channelCode);

    if (!channel) {
      throw new Error(`Enabled loss-report channel not found: ${options.channelCode}`);
    }

    return [channel];
  }

  if (enabledChannels.length === 1) {
    return enabledChannels;
  }

  throw new Error("Multiple enabled loss-report channels found. Use --channel <code> or --all.");
}

export function buildUsageText() {
  return [
    "Usage: npm run summary:send -- [--channel <code> | --all] [--type daily|weekly] [--date YYYY-MM-DD] [--wait-seconds N]",
    "",
    "Examples:",
    "  npm run summary:send -- --channel loss_a",
    "  npm run summary:send -- --channel loss_a --date 2026-05-20",
    "  npm run summary:send -- --channel loss_a --type weekly --date 2026-05-24",
    "  npm run summary:send -- --all --wait-seconds 0",
  ].join("\n");
}

function readNextValue(argv: string[], index: number, flag: string) {
  const value = argv[index + 1]?.trim();

  if (!value) {
    throw new Error(`Missing value for ${flag}`);
  }

  return value;
}

function parseWaitSeconds(raw: string) {
  const value = Number(raw);

  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid --wait-seconds value: ${raw}`);
  }

  return Math.floor(value);
}

function parseSummaryType(raw: string): SummarySendRequestType {
  if (raw === "daily" || raw === "weekly") {
    return raw;
  }

  throw new Error(`Invalid --type value: ${raw}. Expected daily or weekly.`);
}
