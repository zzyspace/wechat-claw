import { execFileSync } from "node:child_process";

import { getAppConfig, validateAppConfig } from "../core/config/env.js";
import { createLogger } from "../core/logging/logger.js";
import { sendSmtpMail } from "../core/alerts/smtp-client.js";
import {
  createWatchdogAlertEmail,
  readRuntimeHealthSnapshot,
  readRuntimeWatchdogSnapshot,
  readWatchdogPersistentState,
  runWatchdogCheck,
  writeWatchdogPersistentState,
  type ServiceStatusSnapshot,
} from "../core/runtime/watchdog-check.js";
import { assertLogDirWritable, assertStateDirWritable } from "../core/runtime/state-paths.js";

const SERVICE_NAME = "wechat-claw";
const logger = createLogger({
  appendFile() {
    // Watchdog logs should stay in journald only. If this process writes the shared
    // app log file as root, it can steal ownership from the main service after date rollover.
  },
  ensureDir() {
    // no-op: watchdog does not use file sinks
  },
});

function parseSystemctlShowOutput(output: string): ServiceStatusSnapshot {
  const snapshot: ServiceStatusSnapshot = {
    activeState: "unknown",
  };

  for (const line of output.split(/\r?\n/)) {
    const [key, ...rest] = line.split("=");
    const value = rest.join("=");

    if (!key) {
      continue;
    }

    if (key === "ActiveState") {
      snapshot.activeState = value;
    } else if (key === "SubState") {
      snapshot.subState = value;
    } else if (key === "Result") {
      snapshot.result = value;
    } else if (key === "MainPID") {
      const mainPid = Number(value);
      snapshot.mainPid = Number.isFinite(mainPid) ? mainPid : 0;
    } else if (key === "ExecMainStatus") {
      const execMainStatus = Number(value);
      snapshot.execMainStatus = Number.isFinite(execMainStatus) ? execMainStatus : 0;
    }
  }

  return snapshot;
}

function readServiceStatus(serviceName: string): ServiceStatusSnapshot {
  const output = execFileSync(
    "systemctl",
    [
      "show",
      serviceName,
      "--property=ActiveState,SubState,Result,MainPID,ExecMainStatus",
    ],
    { encoding: "utf8" },
  );

  return parseSystemctlShowOutput(output);
}

function restartService(serviceName: string) {
  execFileSync("systemctl", ["restart", serviceName], { encoding: "utf8" });
}

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
    assertLogDirWritable(config);
  } catch (error) {
    logger.error("Watchdog preflight failed", {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exitCode = 1;
    return;
  }

  const healthResult = readRuntimeHealthSnapshot(config);
  const watchdogResult = readRuntimeWatchdogSnapshot(config);

  try {
    const result = await runWatchdogCheck({
      config,
      healthSnapshot: healthResult.snapshot,
      healthSnapshotError: healthResult.error,
      persistentState: readWatchdogPersistentState(config),
      readServiceStatus: () => readServiceStatus(SERVICE_NAME),
      restartService: () => restartService(SERVICE_NAME),
      sendAlertEmail: config.alertEmailEnabled
        ? (message) =>
            sendSmtpMail({
              from: config.alertEmailFrom ?? "",
              host: config.alertSmtpHost ?? "",
              password: config.alertSmtpPassword,
              port: config.alertSmtpPort,
              secure: config.alertSmtpSecure,
              subject: message.subject,
              text: message.text,
              to: config.alertEmailTo,
              username: config.alertSmtpUsername,
            })
        : undefined,
      serviceName: SERVICE_NAME,
      watchdogSnapshot: watchdogResult.snapshot,
      watchdogSnapshotError: watchdogResult.error,
    });

    writeWatchdogPersistentState(config, result.persistentState);

    if (result.effectiveEvaluation.severity === "ok") {
      logger.debug("Watchdog check ok", {
        serviceName: SERVICE_NAME,
      });
    } else if (result.effectiveEvaluation.severity === "warn") {
      logger.warn("Watchdog detected a warning condition", {
        message: result.effectiveEvaluation.message,
        reasonCode: result.effectiveEvaluation.reasonCode ?? "(none)",
        serviceName: SERVICE_NAME,
      });
    } else {
      logger.error("Watchdog detected an abnormal condition", {
        message: result.effectiveEvaluation.message,
        reasonCode: result.effectiveEvaluation.reasonCode ?? "(none)",
        serviceName: SERVICE_NAME,
        severity: result.effectiveEvaluation.severity,
      });
    }

    if (result.emailSuppressed) {
      logger.info("Watchdog alert email suppressed", {
        fingerprint: result.effectiveEvaluation.fingerprint ?? "(none)",
        reasonCode: result.effectiveEvaluation.reasonCode ?? "(none)",
      });
    } else if (result.emailSent) {
      logger.info("Watchdog alert email sent", {
        reasonCode: result.effectiveEvaluation.reasonCode ?? "(none)",
        recipients: config.alertEmailTo,
        subject: createWatchdogAlertEmail({
          config,
          evaluation: result.effectiveEvaluation,
        }).subject,
      });
    } else if (result.emailAttempted && result.emailError) {
      logger.error("Watchdog alert email failed", {
        message: result.emailError,
        reasonCode: result.effectiveEvaluation.reasonCode ?? "(none)",
      });
    } else if (
      result.effectiveEvaluation.action !== "none" &&
      !config.alertEmailEnabled
    ) {
      logger.warn("Watchdog alert email is disabled", {
        reasonCode: result.effectiveEvaluation.reasonCode ?? "(none)",
      });
    }

    if (result.restartSuppressed) {
      logger.warn("Watchdog automatic restart suppressed", {
        reasonCode: result.effectiveEvaluation.reasonCode ?? "(none)",
        recentRestartCount: result.persistentState.recentRestartAts.length,
      });
    } else if (result.restartPerformed) {
      logger.warn("Watchdog restarted the main service", {
        reasonCode: result.effectiveEvaluation.reasonCode ?? "(none)",
        serviceName: SERVICE_NAME,
      });
    } else if (result.restartAttempted && result.restartError) {
      logger.error("Watchdog service restart failed", {
        message: result.restartError,
        reasonCode: result.effectiveEvaluation.reasonCode ?? "(none)",
        serviceName: SERVICE_NAME,
      });
      process.exitCode = 1;
    }
  } catch (error) {
    logger.error("Watchdog check failed", {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      serviceName: SERVICE_NAME,
    });
    process.exitCode = 1;
  }
}

void main();
