import { getAppConfig, validateAppConfig } from "../core/config/env.js";
import type { Logger } from "../core/logging/logger.js";
import { loadWechatyModule } from "./wechaty-loader.js";
import { handleMessage } from "./message-handler.js";
import { renderTerminalQrcode } from "./terminal-qrcode.js";

function resolveScanStatusName(scanStatus: Record<string, string | number>, value: unknown) {
  for (const [key, statusValue] of Object.entries(scanStatus)) {
    if (statusValue === value) {
      return key;
    }
  }

  return String(value);
}

export async function startBot(logger: Logger) {
  const config = getAppConfig();
  const validation = validateAppConfig(config);

  for (const warning of validation.warnings) {
    logger.warn("Startup config warning", { warning });
  }

  if (validation.errors.length > 0) {
    throw new Error(`Invalid startup config: ${validation.errors.join("; ")}`);
  }

  const { WechatyBuilder, ScanStatus, log } = await loadWechatyModule();

  log.info("Wechaty", "Starting bot with configured puppet");
  logger.info("Startup config loaded", {
    botName: config.botName,
    puppet: config.puppet,
    targetRoomTopic: config.targetRoomTopic,
    deliveryContactName: config.deliveryContactName,
    puppetServiceTokenConfigured: Boolean(config.puppetServiceToken),
  });

  const botOptions: Record<string, unknown> = {
    name: config.botName,
    puppet: config.puppet,
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

    logger.info("Scan event received", {
      status: statusName,
      qrcodeUrl,
    });

    const rendered = await renderTerminalQrcode(qrcode);

    if (!rendered) {
      logger.warn("Terminal QR rendering unavailable", {
        reason: "qrcode-terminal package not installed",
        qrcodeUrl,
      });
    }
  });

  bot.on("login", async (user: any) => {
    const name = user && typeof user.name === "function" ? user.name() : "unknown";
    logger.info("Bot logged in", { name });

    if (!config.deliveryContactName) {
      return;
    }

    try {
      const deliveryContact =
        typeof bot.Contact?.find === "function"
          ? await bot.Contact.find({ name: config.deliveryContactName })
          : null;

      if (!deliveryContact) {
        logger.warn("Delivery contact not found after login", {
          deliveryContactName: config.deliveryContactName,
        });
        return;
      }

      await deliveryContact.say(
        `[wechat-claw] bot 已上线\n监听群: ${config.targetRoomTopic}\n当前账号: ${name}`,
      );
      logger.info("Sent online notice", {
        deliveryContactName: config.deliveryContactName,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Failed to send online notice", { message });
    }
  });

  bot.on("logout", (user: any) => {
    const name = user && typeof user.name === "function" ? user.name() : "unknown";
    logger.warn("Bot logged out", { name });
  });

  bot.on("error", (error: Error) => {
    logger.error("Bot error", {
      message: error.message,
      stack: error.stack,
    });
  });

  bot.on("message", async (message: any) => {
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
}
