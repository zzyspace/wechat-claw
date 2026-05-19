import { getAppConfig } from "../core/config/env.js";
import { logger } from "../core/logging/logger.js";
import { HealthReporter } from "../core/runtime/health.js";
import { assertStateDirWritable } from "../core/runtime/state-paths.js";
import { startLossSummaryScheduler } from "../core/runtime/summary-scheduler.js";
import { startBot } from "../bot/wechaty-client.js";
import type { WechatyInstance } from "../bot/types.js";

async function main() {
  let bot: WechatyInstance | undefined;
  let stopScheduler = () => {
    // no-op
  };
  let shuttingDown = false;
  let healthReporter: HealthReporter | undefined;

  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info("Received shutdown signal", { signal });
    stopScheduler();

    if (bot) {
      try {
        await bot.stop();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("Failed to stop bot cleanly", { message });
      }
    }

    healthReporter?.setStatus("stopped");
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    healthReporter?.markError(error, {
      status: "degraded",
    });
    logger.error("Application failed to start", { message });
    process.exitCode = 1;
  }
}

void main();
