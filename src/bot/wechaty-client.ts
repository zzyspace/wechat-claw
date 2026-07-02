import { getChannelDisplayName, getEnabledChannels } from "../core/channels/router.js";
import { getAppConfig, validateAppConfig } from "../core/config/env.js";
import type { Logger } from "../core/logging/logger.js";
import { getMemoryCardFilePath } from "../core/runtime/state-paths.js";
import { shouldIgnoreColdStartMessage } from "./cold-start-filter.js";
import { loadWechatyModule } from "./wechaty-loader.js";
import { sendTextToTarget } from "./delivery-contact.js";
import { handleMessage } from "./message-handler.js";
import { writeLatestQrcodeArtifact } from "./qrcode-artifact.js";
import { renderTerminalQrcode } from "./terminal-qrcode.js";
import type { WechatyInstance } from "./types.js";

export interface BotLifecycleHooks {
  onScan?: (payload: { statusName: string; qrcodeUrl: string; artifactPath: string }) => Promise<void> | void;
  onLogin?: (payload: { name: string }) => void;
  onLogout?: (payload: { name: string }) => void;
  onError?: (error: Error) => void;
  onMessage?: (message: any) => void;
}

const MESSAGE_MIXIN_DETAIL_PROPERTIES = [
  "constructor",
  "toString",
  "conversation",
  "talker",
  "listener",
  "room",
  "text",
  "toRecalled",
  "type",
  "self",
  "mentionList",
  "mentionText",
  "mentionSelf",
  "isReady",
  "date",
  "age",
] as const;

type MessageMixinDetailProperty = (typeof MESSAGE_MIXIN_DETAIL_PROPERTIES)[number];

const ONLINE_NOTICE_CONTACT_RETRY_DELAYS_MS = [1_000, 2_000];

export interface OnlineNoticeRetryOptions {
  retryDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
}

export function shouldSendWaitingForScanAlert(statusName: string) {
  return statusName === "Waiting";
}

function readSnapshotValue(
  value: unknown,
  options: {
    depth: number;
    maxDepth: number;
    maxEntries: number;
    seen: WeakSet<object>;
  },
): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return value;
  }

  if (typeof value === "function") {
    return `[Function ${value.name || "anonymous"}]`;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    return {
      message: value.message,
      name: value.name,
      stack: value.stack,
    };
  }

  if (typeof value !== "object") {
    return String(value);
  }

  if (options.seen.has(value)) {
    return "[Circular]";
  }

  options.seen.add(value);

  if (Array.isArray(value)) {
    if (options.depth >= options.maxDepth) {
      return {
        length: value.length,
        type: "array",
      };
    }

    return value.slice(0, options.maxEntries).map((item) =>
      readSnapshotValue(item, {
        ...options,
        depth: options.depth + 1,
      }),
    );
  }

  const ownPropertyNames = Object.getOwnPropertyNames(value);

  if (options.depth >= options.maxDepth) {
    return {
      constructorName: (value as { constructor?: { name?: string } }).constructor?.name ?? "Object",
      ownPropertyNames,
      type: "object",
    };
  }

  const snapshot: Record<string, unknown> = {
    constructorName: (value as { constructor?: { name?: string } }).constructor?.name ?? "Object",
  };

  for (const propertyName of ownPropertyNames.slice(0, options.maxEntries)) {
    try {
      snapshot[propertyName] = readSnapshotValue((value as Record<string, unknown>)[propertyName], {
        ...options,
        depth: options.depth + 1,
      });
    } catch (error) {
      snapshot[propertyName] = `[Thrown ${error instanceof Error ? error.message : String(error)}]`;
    }
  }

  if (ownPropertyNames.length > options.maxEntries) {
    snapshot.__truncatedPropertyCount = ownPropertyNames.length - options.maxEntries;
  }

  return snapshot;
}

function formatInvocationError(error: unknown) {
  return `[Thrown ${error instanceof Error ? error.message : String(error)}]`;
}

function summarizeMessageDetailValue(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => summarizeMessageDetailValue(item));
  }

  if (value && typeof value === "object") {
    const seen = new WeakSet<object>();
    const summary = readSnapshotValue(value, {
      depth: 0,
      maxDepth: 1,
      maxEntries: 10,
      seen,
    });

    return summary;
  }

  return value;
}

function resolveMessageTypeDetail(message: any) {
  const typeValue = message.type();
  const typeName = message?.constructor?.Type?.[typeValue];

  return {
    code: typeValue,
    name: typeof typeName === "string" ? typeName : undefined,
  };
}

async function readMessageMixinDetailPropertyValue(
  message: any,
  propertyName: MessageMixinDetailProperty,
): Promise<unknown> {
  try {
    switch (propertyName) {
      case "constructor":
        return message?.constructor?.name ?? "(unknown)";
      case "toString":
        return message.toString();
      case "conversation":
        return summarizeMessageDetailValue(message.conversation());
      case "talker":
        return summarizeMessageDetailValue(message.talker());
      case "listener":
        return summarizeMessageDetailValue(message.listener());
      case "room":
        return summarizeMessageDetailValue(message.room());
      case "text":
        return message.text();
      case "toRecalled":
        return summarizeMessageDetailValue(await message.toRecalled());
      case "type":
        return resolveMessageTypeDetail(message);
      case "self":
        return message.self();
      case "mentionList":
        return summarizeMessageDetailValue(await message.mentionList());
      case "mentionText":
        return await message.mentionText();
      case "mentionSelf":
        return await message.mentionSelf();
      case "isReady":
        return message.isReady();
      case "date":
        return summarizeMessageDetailValue(message.date());
      case "age":
        return message.age();
      default:
        return "[Unsupported property]";
    }
  } catch (error) {
    return formatInvocationError(error);
  }
}

export async function createWechatyMessageMixinDebugDetails(message: unknown) {
  const details: Record<string, unknown> = {};

  if (!message || (typeof message !== "object" && typeof message !== "function")) {
    for (const propertyName of MESSAGE_MIXIN_DETAIL_PROPERTIES) {
      details[propertyName] = "[Message unavailable]";
    }
    return details;
  }

  for (const propertyName of MESSAGE_MIXIN_DETAIL_PROPERTIES) {
    details[propertyName] = await readMessageMixinDetailPropertyValue(message, propertyName);
  }

  return details;
}

function resolveScanStatusName(scanStatus: Record<string, string | number>, value: unknown) {
  for (const [key, statusValue] of Object.entries(scanStatus)) {
    if (statusValue === value) {
      return key;
    }
  }

  return String(value);
}

async function sleep(ms: number) {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function shouldRetryOnlineNoticeDelivery(error?: string) {
  return typeof error === "string" && error.startsWith("Delivery target not found:");
}

export async function sendOnlineNoticeWithRetry(
  bot: WechatyInstance,
  debugContactName: string,
  text: string,
  logger: Logger,
  options: OnlineNoticeRetryOptions = {},
) {
  const retryDelaysMs = options.retryDelaysMs ?? ONLINE_NOTICE_CONTACT_RETRY_DELAYS_MS;
  const sleepFn = options.sleep ?? sleep;
  const target = {
    type: "contact_name" as const,
    value: debugContactName,
  };

  let deliveryResult = await sendTextToTarget(bot, target, text, logger);

  for (const delayMs of retryDelaysMs) {
    if (deliveryResult.delivered || !shouldRetryOnlineNoticeDelivery(deliveryResult.error)) {
      return deliveryResult;
    }

    logger.warn("Retrying online notice delivery after contact lookup miss", {
      attemptDelayMs: delayMs,
      debugContactName,
    });
    await sleepFn(delayMs);
    deliveryResult = await sendTextToTarget(bot, target, text, logger);
  }

  return deliveryResult;
}

export async function startBot(
  logger: Logger,
  hooks: BotLifecycleHooks = {},
): Promise<WechatyInstance> {
  const config = getAppConfig();
  const validation = validateAppConfig(config);
  const botStartedAt = new Date().toISOString();

  for (const warning of validation.warnings) {
    logger.warn("Startup config warning", { warning });
  }

  if (validation.errors.length > 0) {
    throw new Error(`Invalid startup config: ${validation.errors.join("; ")}`);
  }

  const { WechatyBuilder, ScanStatus, log } = await loadWechatyModule();
  const { MemoryCard } = await import("memory-card");
  const enabledChannels = getEnabledChannels(config.channels);

  log.info("Wechaty", "Starting bot with configured puppet");
  logger.info("Startup config loaded", {
    botName: config.botName,
    debugContactName: config.debugContactName ?? "(empty)",
    debugMessageSnapshotEnabled: config.debugMessageSnapshotEnabled,
    debugReceivedRoomMessageEnabled: config.debugReceivedRoomMessageEnabled,
    channels: enabledChannels.map((channel) => ({
      code: channel.code,
      deliveryTargets: channel.deliveryTargets,
      roomTopic: channel.match.value,
      scenario: channel.scenario,
      summarySchedule: channel.summarySchedule || "(disabled)",
      weeklySummarySchedule: channel.weeklySummarySchedule || "(disabled)",
    })),
    channelsSource: config.channelsSource,
    coldStartIgnoreWindowSeconds: config.coldStartIgnoreWindowSeconds,
    logDir: config.logDir,
    logLevel: config.logLevel,
    puppet: config.puppet,
    stateDir: config.stateDir,
    timeZone: config.timeZone,
    puppetServiceTokenConfigured: Boolean(config.puppetServiceToken),
  });

  const memory = new MemoryCard({
    name: getMemoryCardFilePath(config),
    storageOptions: {
      type: "file",
    },
  });
  await memory.load();

  const botOptions: Record<string, unknown> = {
    name: config.botName,
    puppet: config.puppet,
    memory,
  };

  if (config.puppetServiceToken) {
    botOptions.puppetOptions = {
      token: config.puppetServiceToken,
    };
  }

  const bot = WechatyBuilder.build(botOptions);

  bot.on("scan", async (qrcode: string, status: unknown) => {
    const statusName = resolveScanStatusName(ScanStatus, status);
    const qrcodeUrl = `https://wechaty.js.org/qrcode/${encodeURIComponent(qrcode)}`;
    const artifactPath = writeLatestQrcodeArtifact(qrcodeUrl, qrcode);

    logger.info("Scan event received", {
      status: statusName,
      artifactPath,
      qrcodeUrl,
    });
    await hooks.onScan?.({
      statusName,
      qrcodeUrl,
      artifactPath,
    });

    const rendered = await renderTerminalQrcode(qrcode);

    if (!rendered) {
      logger.warn("Terminal QR rendering unavailable", {
        artifactPath,
        reason: "qrcode-terminal package not installed",
        qrcodeUrl,
      });
    }
  });

  bot.on("login", async (user: any) => {
    const name = user && typeof user.name === "function" ? user.name() : "unknown";

    logger.info("Bot logged in", { name });
    hooks.onLogin?.({ name });

    if (!config.debugContactName) {
      return;
    }

    const onlineNoticeText = [
      "[wechat-claw] bot 已上线",
      `当前账号: ${name}`,
      "监听群:",
      ...enabledChannels.map((channel) => `- ${getChannelDisplayName(channel)} (${channel.code})`),
    ].join("\n");
    const deliveryResult = await sendOnlineNoticeWithRetry(
      bot,
      config.debugContactName,
      onlineNoticeText,
      logger,
    );

    logger.info("Sent online notice", {
      debugContactName: config.debugContactName,
      delivered: deliveryResult.delivered,
    });
  });

  bot.on("logout", (user: any) => {
    const name = user && typeof user.name === "function" ? user.name() : "unknown";
    logger.warn("Bot logged out", { name });
    hooks.onLogout?.({ name });
  });

  bot.on("error", (error: Error) => {
    logger.error("Bot error", {
      message: error.message,
      stack: error.stack,
    });
    hooks.onError?.(error);
  });

  bot.on("message", async (message: any) => {
    hooks.onMessage?.(message);

    if (config.debugMessageSnapshotEnabled) {
      logger.debug("[ CUSTOM LOG ] Raw wechaty message snapshot", {
        details: JSON.stringify(await createWechatyMessageMixinDebugDetails(message), null, 2),
      });
    }

    const coldStartDecision = shouldIgnoreColdStartMessage(message, {
      botStartedAt,
      coldStartIgnoreWindowSeconds: config.coldStartIgnoreWindowSeconds,
    });

    if (coldStartDecision.ignored) {
      const messageId = typeof message.id === "function" ? message.id() : message?.id;
      logger.debug("Ignored message during cold start window", {
        botStartedAt,
        coldStartIgnoreWindowSeconds: config.coldStartIgnoreWindowSeconds,
        cutoffAt: coldStartDecision.cutoffAt,
        messageAgeSeconds: coldStartDecision.messageAgeSeconds,
        messageId: messageId ? String(messageId) : "(unknown)",
        messageSentAt: coldStartDecision.messageSentAt,
      });
      return;
    }

    try {
      await handleMessage(
        message,
        {
          channels: config.channels,
          debugContactName: config.debugContactName,
          manualReimbursementContactName: config.manualReimbursementContactName,
          debugReceivedRoomMessageEnabled: config.debugReceivedRoomMessageEnabled,
          timeZone: config.timeZone,
          lossMergeWindowSeconds: config.lossMergeWindowSeconds,
          reimbursementBackwardTextMergeWindowSeconds: config.reimbursementBackwardTextMergeWindowSeconds,
          lossExtractionProvider: config.lossExtractionProvider,
          lossExtractionModel: config.lossExtractionModel,
          lossExtractionApiKey: config.lossExtractionApiKey,
          lossExtractionBaseUrl: config.lossExtractionBaseUrl,
          reimbursementExtractionProvider: config.reimbursementExtractionProvider,
          reimbursementExtractionModel: config.reimbursementExtractionModel,
          reimbursementExtractionApiKey: config.reimbursementExtractionApiKey,
          reimbursementExtractionBaseUrl: config.reimbursementExtractionBaseUrl,
        },
        logger,
      );
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      logger.error("Failed to handle message", {
        message: messageText,
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
  });

  await bot.start();
  logger.info("Bot started", {
    listeningChannels: enabledChannels.map((channel) => ({
      code: channel.code,
      roomTopic: channel.match.value,
    })),
    nextStep: "Scan the QR code with the bot account and wait for the online notice.",
  });

  return bot;
}
