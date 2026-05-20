import { getChannelDisplayName, getEnabledChannels } from "../core/channels/router.js";
import { getAppConfig, validateAppConfig } from "../core/config/env.js";
import type { Logger } from "../core/logging/logger.js";
import { getMemoryCardFilePath } from "../core/runtime/state-paths.js";
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
    })),
    channelsSource: config.channelsSource,
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
    try {
      await handleMessage(
        message,
        {
          channels: config.channels,
          debugContactName: config.debugContactName,
          lossMergeWindowSeconds: config.lossMergeWindowSeconds,
          lossExtractionProvider: config.lossExtractionProvider,
          lossExtractionModel: config.lossExtractionModel,
          lossExtractionApiKey: config.lossExtractionApiKey,
          lossExtractionBaseUrl: config.lossExtractionBaseUrl,
        },
        logger,
      );
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      logger.error("Failed to handle message", { message: messageText });
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
