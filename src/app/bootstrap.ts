import { getAppConfig } from "../core/config/env.js";
import { logger } from "../core/logging/logger.js";
import { startRawAttachmentRetentionManager } from "../core/runtime/raw-attachment-retention.js";
import { HealthReporter } from "../core/runtime/health.js";
import { startManualSummaryRequestPoller } from "../core/runtime/manual-summary-request-poller.js";
import { assertStateDirWritable } from "../core/runtime/state-paths.js";
import { startLossSummaryScheduler } from "../core/runtime/summary-scheduler.js";
import { startBot } from "../bot/wechaty-client.js";
import type { WechatyInstance } from "../bot/types.js";

const SHUTDOWN_TIMEOUT_MS = 15_000;

function createTimeoutError(timeoutMs: number) {
  return new Error(`Timed out after ${timeoutMs} ms while waiting for bot shutdown`);
}

async function stopBotWithTimeout(bot: WechatyInstance, timeoutMs: number) {
  let timeoutHandle: NodeJS.Timeout | undefined;

  try {
    await Promise.race([
      bot.stop(),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(createTimeoutError(timeoutMs));
        }, timeoutMs);
        timeoutHandle.unref();
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

async function main() {
  let bot: WechatyInstance | undefined;
  let stopScheduler = () => {
    // no-op
  };
  let stopManualSummaryRequestPoller = () => {
    // no-op
  };
  let stopRawAttachmentRetentionManager = () => {
    // no-op
  };
  let shuttingDown = false;
  let healthReporter: HealthReporter | undefined;
  let shutdownPromise: Promise<void> | undefined;

  const shutdown = async (signal: string) => {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    shutdownPromise = (async () => {
      shuttingDown = true;

      logger.info("Received shutdown signal", { signal });
      stopScheduler();
      stopManualSummaryRequestPoller();
      stopRawAttachmentRetentionManager();

      if (bot) {
        try {
          await stopBotWithTimeout(bot, SHUTDOWN_TIMEOUT_MS);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error("Failed to stop bot cleanly", {
            message,
            timeoutMs: SHUTDOWN_TIMEOUT_MS,
          });
        }
      }

      healthReporter?.setStatus("stopped");
    })();

    return shutdownPromise;
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT").then(
      () => {
        process.exit(0);
      },
      () => {
        process.exit(1);
      },
    );
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM").then(
      () => {
        process.exit(0);
      },
      () => {
        process.exit(1);
      },
    );
  });

  try {
    const config = getAppConfig();
    assertStateDirWritable(config);

    healthReporter = new HealthReporter(config, logger);
    healthReporter.initialize();
    healthReporter.setStatus("starting");

    bot = await startBot(logger, {
      onScan() {
        healthReporter?.markScan();
      },
      onLogin() {
        healthReporter?.markLogin();
      },
      onLogout({ name }) {
        healthReporter?.markError(new Error(`Bot logged out: ${name}`), {
          status: "degraded",
          category: "login_state_invalid",
        });
      },
      onError(error) {
        healthReporter?.markError(error, {
          status: "degraded",
        });
      },
      onMessage() {
        healthReporter?.markMessage();
      },
    });

    const scheduler = startLossSummaryScheduler({
      bot,
      config,
      logger,
      healthReporter,
    });
    stopScheduler = () => scheduler.stop();

    const manualSummaryRequestPoller = startManualSummaryRequestPoller({
      bot,
      config,
      logger,
      healthReporter,
    });
    stopManualSummaryRequestPoller = () => manualSummaryRequestPoller.stop();

    const rawAttachmentRetentionManager = startRawAttachmentRetentionManager({
      config,
      logger,
    });
    stopRawAttachmentRetentionManager = () => rawAttachmentRetentionManager.stop();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    healthReporter?.markError(error, {
      status: "degraded",
    });
    logger.error("Application failed to start", { message });
    if (!shuttingDown) {
      process.exit(1);
    }
  }
}

void main();
