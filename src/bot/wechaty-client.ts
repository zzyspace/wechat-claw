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
  onScan?: (payload: { statusName: string; qrcodeUrl: string; artifactPath: string }) => void;
  onLogin?: (payload: { name: string }) => void;
  onLogout?: (payload: { name: string }) => void;
  onError?: (error: Error) => void;
  onMessage?: () => void;
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

export function createWechatyMessageDebugSnapshot(message: unknown) {
  const ownPropertyNames =
    message && (typeof message === "object" || typeof message === "function")
      ? Object.getOwnPropertyNames(message)
      : [];
  const ownSymbols =
    message && (typeof message === "object" || typeof message === "function")
      ? Object.getOwnPropertySymbols(message).map((symbol) => symbol.toString())
      : [];
  const ownProperties: Record<string, unknown> = {};
  const prototypeChain: Array<{
    constructorName: string;
    propertyNames: string[];
  }> = [];
  const seen = new WeakSet<object>();

  if (message && (typeof message === "object" || typeof message === "function")) {
    for (const propertyName of ownPropertyNames) {
      try {
        ownProperties[propertyName] = readSnapshotValue((message as Record<string, unknown>)[propertyName], {
          depth: 0,
          maxDepth: 2,
          maxEntries: 30,
          seen,
        });
      } catch (error) {
        ownProperties[propertyName] = `[Thrown ${error instanceof Error ? error.message : String(error)}]`;
      }
    }

    let currentPrototype = Object.getPrototypeOf(message);

    while (currentPrototype && currentPrototype !== Object.prototype) {
      prototypeChain.push({
        constructorName: currentPrototype.constructor?.name ?? "Object",
        propertyNames: Object.getOwnPropertyNames(currentPrototype),
      });
      currentPrototype = Object.getPrototypeOf(currentPrototype);
    }
  }

  return {
    constructorName:
      message && (typeof message === "object" || typeof message === "function")
        ? (message as { constructor?: { name?: string } }).constructor?.name ?? "Object"
        : typeof message,
    ownPropertyNames,
    ownSymbols,
    ownProperties,
    prototypeChain,
  };
}

function resolveScanStatusName(scanStatus: Record<string, string | number>, value: unknown) {
  for (const [key, statusValue] of Object.entries(scanStatus)) {
    if (statusValue === value) {
      return key;
    }
  }

  return String(value);
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
    hooks.onScan?.({
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

    const deliveryResult = await sendTextToTarget(
      bot,
      {
        type: "contact_name",
        value: config.debugContactName,
      },
      [
        "[wechat-claw] bot 已上线",
        `当前账号: ${name}`,
        "监听群:",
        ...enabledChannels.map((channel) => `- ${getChannelDisplayName(channel)} (${channel.code})`),
      ].join("\n"),
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
    hooks.onMessage?.();

    logger.info("[ CUSTOM LOG ] Raw wechaty message snapshot", {
      wechatyMessage: createWechatyMessageDebugSnapshot(message),
    });

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
