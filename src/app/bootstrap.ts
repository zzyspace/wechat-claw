import { getAppConfig } from "../core/config/env.js";
import { sendSmtpMail } from "../core/alerts/smtp-client.js";
import { logger } from "../core/logging/logger.js";
import { startLogRetentionManager } from "../core/runtime/log-retention.js";
import { startRawAttachmentRetentionManager } from "../core/runtime/raw-attachment-retention.js";
import { HealthReporter } from "../core/runtime/health.js";
import { startManualSummaryRequestPoller } from "../core/runtime/manual-summary-request-poller.js";
import { assertLogDirWritable, assertStateDirWritable } from "../core/runtime/state-paths.js";
import {
  backupAndDisableMemoryCard,
  extractSelfCanaryToken,
  startSelfCanaryManager,
} from "../core/runtime/self-canary.js";
import { startLossSummaryScheduler } from "../core/runtime/summary-scheduler.js";
import { createWaitingForScanAlertEmail } from "../core/runtime/watchdog-check.js";
import {
  createRuntimeRunId,
  startWatchdogHeartbeatManager,
} from "../core/runtime/watchdog-heartbeat.js";
import { shouldSendWaitingForScanAlert, startBot } from "../bot/wechaty-client.js";
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
  let stopLogRetentionManager = () => {
    // no-op
  };
  let stopSelfCanaryManager = () => {
    // no-op
  };
  let notifySelfCanaryLogin = () => {
    // no-op
  };
  let notifySelfCanaryLogout = () => {
    // no-op
  };
  let observeSelfCanaryMessage = async (_message: any) => {
    // no-op
  };
  let stopWatchdogHeartbeatManager = () => {
    // no-op
  };
  let touchWatchdogHeartbeat = () => {
    // no-op
  };
  let shuttingDown = false;
  let supervisorRestartRequested = false;
  let healthReporter: HealthReporter | undefined;
  let shutdownPromise: Promise<void> | undefined;
  const processStartedAt = new Date();
  const runtimeRunId = createRuntimeRunId(processStartedAt, process.pid);

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
      stopLogRetentionManager();
      stopSelfCanaryManager();

      if (bot) {
        try {
          await stopBotWithTimeout(bot, SHUTDOWN_TIMEOUT_MS);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error("Failed to stop bot cleanly", {
            message,
            stack: error instanceof Error ? error.stack : undefined,
            timeoutMs: SHUTDOWN_TIMEOUT_MS,
          });
        }
      }

      healthReporter?.setStatus("stopped");
      touchWatchdogHeartbeat();
      logger.info("Runtime shutdown completed", {
        finalStatus: healthReporter?.getSnapshot().status ?? "stopped",
        signal,
        runtimeRunId,
        uptimeMs: Date.now() - processStartedAt.getTime(),
      });
      stopWatchdogHeartbeatManager();
    })();

    return shutdownPromise;
  };

  const requestSupervisorRestart = (reason: string, details: Record<string, unknown> = {}) => {
    if (shuttingDown || supervisorRestartRequested) {
      return;
    }

    supervisorRestartRequested = true;
    logger.error("Requesting supervisor restart after fatal bot runtime failure", {
      reason,
      runtimeRunId,
      ...details,
    });

    const forceExitHandle = setTimeout(() => {
      logger.error("Forced process exit after supervisor restart timeout", {
        reason,
        timeoutMs: SHUTDOWN_TIMEOUT_MS + 1_000,
      });
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS + 1_000);
    forceExitHandle.unref();

    // When Wechaty/Puppeteer enters a logout loop, let systemd restart a clean process.
    void shutdown(reason).finally(() => {
      clearTimeout(forceExitHandle);
      process.exit(1);
    });
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
    assertLogDirWritable(config);

    logger.info("Runtime starting", {
      botName: config.botName,
      enabledChannels: config.channels.filter((channel) => channel.enabled).length,
      alertEmailEnabled: config.alertEmailEnabled,
      alertEmailRecipients: config.alertEmailTo.length,
      debugMessageSnapshotEnabled: config.debugMessageSnapshotEnabled,
      logDir: config.logDir,
      logLevel: config.logLevel,
      puppet: config.puppet ?? "(empty)",
      stateDir: config.stateDir,
      timeZone: config.timeZone,
      watchdogMemoryLimitMb: config.watchdogMemoryLimitMb,
      watchdogMemoryPersistenceSeconds: config.watchdogMemoryPersistenceSeconds,
    });

    healthReporter = new HealthReporter(config, logger);
    healthReporter.initialize();
    healthReporter.setStatus("starting");
    const watchdogHeartbeatManager = startWatchdogHeartbeatManager({
      config,
      getHealthSnapshot: () => healthReporter?.getSnapshot() ?? {
        status: "starting",
        pid: process.pid,
        botName: config.botName,
        puppet: config.puppet,
        startedAt: processStartedAt.toISOString(),
        degradedSinceAt: null,
        lastScanAt: null,
        lastLoginAt: null,
        lastMessageAt: null,
        lastSummaryAt: null,
        lastError: null,
      },
      logger,
      runId: runtimeRunId,
      startedAt: processStartedAt.toISOString(),
    });
    stopWatchdogHeartbeatManager = () => watchdogHeartbeatManager.stop();
    touchWatchdogHeartbeat = () => {
      watchdogHeartbeatManager.touch();
    };
    touchWatchdogHeartbeat();

    bot = await startBot(logger, {
      async onScan({ artifactPath, qrcodeUrl, statusName }) {
        healthReporter?.markScan();
        touchWatchdogHeartbeat();

        if (
          shouldSendWaitingForScanAlert(statusName) &&
          config.alertEmailEnabled &&
          config.alertEmailTo.length > 0
        ) {
          try {
            const message = createWaitingForScanAlertEmail({
              artifactPath,
              config,
              qrcodeUrl,
            });
            await sendSmtpMail({
              attachments: message.attachments,
              from: config.alertEmailFrom ?? "",
              host: config.alertSmtpHost ?? "",
              password: config.alertSmtpPassword,
              port: config.alertSmtpPort,
              secure: config.alertSmtpSecure,
              subject: message.subject,
              text: message.text,
              to: config.alertEmailTo,
              username: config.alertSmtpUsername,
            });
            logger.info("Waiting-for-scan alert email sent", {
              artifactPath,
              qrcodeUrl,
              recipients: config.alertEmailTo,
            });
          } catch (error) {
            logger.error("Waiting-for-scan alert email failed", {
              artifactPath,
              message: error instanceof Error ? error.message : String(error),
              qrcodeUrl,
              stack: error instanceof Error ? error.stack : undefined,
            });
          }
        }
      },
      onLogin() {
        healthReporter?.markLogin();
        touchWatchdogHeartbeat();
        notifySelfCanaryLogin();
      },
      onLogout({ name }) {
        notifySelfCanaryLogout();
        healthReporter?.markError(new Error(`Bot logged out: ${name}`), {
          status: "degraded",
          category: "login_state_invalid",
        });
        touchWatchdogHeartbeat();
        requestSupervisorRestart("BOT_LOGOUT", { name });
      },
      onError(error) {
        healthReporter?.markError(error, {
          status: "degraded",
        });
        touchWatchdogHeartbeat();
      },
      async onMessage(message) {
        const text = typeof message?.text === "function" ? String(message.text()) : "";
        const isSelfCanaryMessage =
          Boolean(message?.self && typeof message.self === "function" && message.self()) &&
          Boolean(extractSelfCanaryToken(text));

        if (!isSelfCanaryMessage) {
          healthReporter?.markExternalMessage();
        }
        touchWatchdogHeartbeat();
        await observeSelfCanaryMessage(message);
      },
    });

    const selfCanaryManager = startSelfCanaryManager({
      bot,
      config,
      logger,
      onFailureThresholdReached(payload) {
        try {
          const resetResult = backupAndDisableMemoryCard(config);
          healthReporter?.markError(new Error("Self canary failed and fresh login reset was requested."), {
            status: "degraded",
            category: "login_state_invalid",
          });
          touchWatchdogHeartbeat();
          requestSupervisorRestart("SELF_CANARY_FAILURE", {
            ...payload,
            backupPath: resetResult.backupPath ?? "(none)",
            disabledPath: resetResult.disabledPath ?? "(none)",
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          healthReporter?.markError(error, {
            status: "degraded",
          });
          touchWatchdogHeartbeat();
          logger.error("Failed to prepare self canary fresh login reset", {
            ...payload,
            message,
            stack: error instanceof Error ? error.stack : undefined,
          });
          requestSupervisorRestart("SELF_CANARY_FAILURE_PREP_ERROR", payload);
        }
      },
    });
    stopSelfCanaryManager = () => selfCanaryManager.stop();
    notifySelfCanaryLogin = () => selfCanaryManager.notifyLogin();
    notifySelfCanaryLogout = () => selfCanaryManager.notifyLogout();
    observeSelfCanaryMessage = (message: any) => selfCanaryManager.observeMessage(message);

    if (bot.isLoggedIn) {
      notifySelfCanaryLogin();
    }

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

    const logRetentionManager = startLogRetentionManager({
      config,
      logger,
    });
    stopLogRetentionManager = () => logRetentionManager.stop();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    healthReporter?.markError(error, {
      status: "degraded",
    });
    touchWatchdogHeartbeat();
    logger.error("Application failed to start", {
      message,
      stack: error instanceof Error ? error.stack : undefined,
    });
    if (!shuttingDown) {
      process.exit(1);
    }
  }
}

void main();
