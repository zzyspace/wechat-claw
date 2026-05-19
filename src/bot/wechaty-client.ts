import { getAppConfig, validateAppConfig } from "../core/config/env.js";
import type { Logger } from "../core/logging/logger.js";
import { getMemoryCardFilePath } from "../core/runtime/state-paths.js";
import { loadWechatyModule } from "./wechaty-loader.js";
import { sendTextToNamedContact } from "./delivery-contact.js";
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

  log.info("Wechaty", "Starting bot with configured puppet");
  logger.info("Startup config loaded", {
    botName: config.botName,
    puppet: config.puppet,
    stateDir: config.stateDir,
    timeZone: config.timeZone,
    targetRoomTopic: config.targetRoomTopic,
    deliveryContactName: config.deliveryContactName,
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

    if (!config.deliveryContactName) {
      return;
    }

    try {
      const delivered = await sendTextToNamedContact(
        bot,
        config.deliveryContactName,
        `[wechat-claw] bot 已上线\n监听群: ${config.targetRoomTopic}\n当前账号: ${name}`,
        logger,
      );

      if (delivered) {
        logger.info("Sent online notice", {
          deliveryContactName: config.deliveryContactName,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Failed to send online notice", { message });
    }
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
          targetRoomTopic: config.targetRoomTopic,
          deliveryContactName: config.deliveryContactName,
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
    nextStep: "Scan the QR code with the bot account and wait for the online notice.",
  });

  return bot;
}
