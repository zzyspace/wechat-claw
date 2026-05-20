import { hostname } from "node:os";

import { getChannelDisplayName } from "../core/channels/router.js";
import type { ChannelConfig } from "../core/channels/types.js";
import { getAppConfig, validateAppConfig } from "../core/config/env.js";
import { logger } from "../core/logging/logger.js";
import {
  buildUsageText,
  parseSendLossSummaryCliArgs,
  resolveLossSummaryRequestChannels,
  type SendLossSummaryCliOptions,
} from "../core/runtime/manual-summary-request-command.js";
import {
  createSummarySendRequest,
  getSummarySendRequestById,
  type SummarySendRequestRecord,
} from "../core/runtime/manual-summary-request.js";
import { getManualSummaryRequestGateResult } from "../core/runtime/manual-summary-request-gate.js";
import { assertStateDirWritable } from "../core/runtime/state-paths.js";

const REQUEST_POLL_INTERVAL_MS = 1_000;

async function main() {
  const config = getAppConfig();
  const validation = validateAppConfig(config);

  for (const warning of validation.warnings) {
    logger.warn("Config warning", { warning });
  }

  if (validation.errors.length > 0) {
    for (const error of validation.errors) {
      logger.error("Config error", { error });
    }

    process.exitCode = 1;
    return;
  }

  try {
    assertStateDirWritable(config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("State directory check failed", { message });
    process.exitCode = 1;
    return;
  }

  let cliOptions: SendLossSummaryCliOptions;

  try {
    cliOptions = parseSendLossSummaryCliArgs(process.argv.slice(2), {
      timeZone: config.timeZone,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes("Usage:")) {
      logger.info("Summary send command usage", {
        message,
      });
      process.exitCode = 0;
      return;
    }

    logger.error("Summary send command arguments", {
      message,
    });
    process.exitCode = 1;
    return;
  }

  const requestedBy =
    cliOptions.requestedBy === "cli"
      ? `cli:${hostname()}:${process.pid}`
      : cliOptions.requestedBy;

  let selectedChannels: ChannelConfig[];

  try {
    selectedChannels = resolveLossSummaryRequestChannels(config.channels, cliOptions);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Failed to resolve summary send channels", {
      message,
      usage: buildUsageText(),
    });
    process.exitCode = 1;
    return;
  }

  const gateResult = getManualSummaryRequestGateResult(config);

  if (!gateResult.allowed) {
    logger.warn("Manual daily summary request discarded", {
      message: gateResult.reason,
      runtimeStatus: gateResult.status ?? "unknown",
    });
    process.exitCode = 1;
    return;
  }

  const requests = selectedChannels.map((channel) =>
    createSummarySendRequest({
      channelCode: channel.code,
      requestedBy,
      scenarioCode: "loss-report",
      targetDate: cliOptions.targetDate,
    }),
  );
  const channelNameByCode = new Map(selectedChannels.map((channel) => [channel.code, getChannelDisplayName(channel)]));

  logger.info("Manual daily summary request queued", {
    requests: requests.map((request) => ({
      channelCode: request.channelCode,
      channelName: channelNameByCode.get(request.channelCode) ?? request.channelCode,
      requestId: request.id,
      requestedBy,
      targetDate: request.targetDate,
    })),
  });

  if (cliOptions.waitTimeoutMs === 0) {
    logger.info("Summary send command finished without waiting", {
      nextStep: "Keep the bot service running so it can consume the queued requests.",
    });
    return;
  }

  const completedRequests = await waitForSummarySendRequests(requests, cliOptions.waitTimeoutMs);
  const incompleteRequests = completedRequests.filter(
    (request) => request.status === "pending" || request.status === "processing",
  );
  const failedRequests = completedRequests.filter((request) => request.status === "failed");

  if (incompleteRequests.length > 0) {
    logger.warn("Summary send command timed out while waiting for completion", {
      requests: incompleteRequests.map((request) => ({
        channelCode: request.channelCode,
        requestId: request.id,
        status: request.status,
        targetDate: request.targetDate,
      })),
      waitTimeoutMs: cliOptions.waitTimeoutMs,
    });
    process.exitCode = 1;
    return;
  }

  if (failedRequests.length > 0) {
    logger.error("Summary send command completed with failures", {
      requests: failedRequests.map((request) => ({
        channelCode: request.channelCode,
        errorMessage: request.errorMessage,
        requestId: request.id,
        targetDate: request.targetDate,
      })),
    });
    process.exitCode = 1;
    return;
  }

  logger.info("Summary send command completed", {
    requests: completedRequests.map((request) => ({
      channelCode: request.channelCode,
      channelName: channelNameByCode.get(request.channelCode) ?? request.channelCode,
      requestId: request.id,
      status: request.status,
      targetDate: request.targetDate,
    })),
  });
}

async function waitForSummarySendRequests(
  requests: SummarySendRequestRecord[],
  waitTimeoutMs: number,
) {
  const deadline = Date.now() + waitTimeoutMs;
  let latestRequests = requests;

  while (Date.now() <= deadline) {
    latestRequests = requests.map((request) => getSummarySendRequestById(request.id) ?? request);

    if (latestRequests.every((request) => request.status === "sent" || request.status === "failed")) {
      return latestRequests;
    }

    await sleep(REQUEST_POLL_INTERVAL_MS);
  }

  return latestRequests;
}

function sleep(delayMs: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

void main();
