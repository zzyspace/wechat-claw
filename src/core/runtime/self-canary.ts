import fs from "node:fs";
import path from "node:path";

import { sendTextToTarget } from "../../bot/delivery-contact.js";
import type { WechatyInstance } from "../../bot/types.js";
import type { AppConfig } from "../config/env.js";
import type { Logger } from "../logging/logger.js";
import { ensureStateDir, getMemoryCardFilePath, getSelfCanaryStatePath, getStateDirPath } from "./state-paths.js";

const DEFAULT_INITIAL_DELAY_MS = 60_000;
const CANARY_PREFIX = "[wechat-claw][self-canary]";

export interface SelfCanaryState {
  status: "disabled" | "idle" | "pending" | "acked" | "failed" | "reset_requested";
  targetContactName: string;
  enabled: boolean;
  autoResetEnabled: boolean;
  intervalMinSeconds: number;
  intervalMaxSeconds: number;
  lastScheduledIntervalSeconds: number | null;
  ackTimeoutSeconds: number;
  failureThreshold: number;
  lastSentAt: string | null;
  lastSentToken: string | null;
  lastSentText: string | null;
  pendingSinceAt: string | null;
  lastAckAt: string | null;
  lastAckToken: string | null;
  consecutiveFailureCount: number;
  lastFailureAt: string | null;
  lastFailureReason: string | null;
  lastDeliveryError: string | null;
  lastResetRequestedAt: string | null;
}

function writeJsonFile(filePath: string, value: unknown) {
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function createState(config: AppConfig): SelfCanaryState {
  const canary = config.selfCanary;

  return {
    status: canary?.enabled ? "idle" : "disabled",
    targetContactName: canary?.targetContactName ?? "",
    enabled: canary?.enabled ?? false,
    autoResetEnabled: canary?.autoResetEnabled ?? false,
    intervalMinSeconds: canary?.intervalMinSeconds ?? 0,
    intervalMaxSeconds: canary?.intervalMaxSeconds ?? 0,
    lastScheduledIntervalSeconds: null,
    ackTimeoutSeconds: canary?.ackTimeoutSeconds ?? 0,
    failureThreshold: canary?.failureThreshold ?? 0,
    lastSentAt: null,
    lastSentToken: null,
    lastSentText: null,
    pendingSinceAt: null,
    lastAckAt: null,
    lastAckToken: null,
    consecutiveFailureCount: 0,
    lastFailureAt: null,
    lastFailureReason: null,
    lastDeliveryError: null,
    lastResetRequestedAt: null,
  };
}

function persistState(config: AppConfig, state: SelfCanaryState) {
  ensureStateDir(config);
  writeJsonFile(getSelfCanaryStatePath(config), state);
}

function createToken() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function isSelfMessage(message: any) {
  return Boolean(message?.self && typeof message.self === "function" && message.self());
}

function readMessageText(message: any) {
  return typeof message?.text === "function" ? String(message.text()) : "";
}

export function buildSelfCanaryMessage(token: string) {
  return `${CANARY_PREFIX} token=${token}`;
}

export function extractSelfCanaryToken(text: string) {
  const match = text.match(/^\[wechat-claw\]\[self-canary\] token=([a-z0-9-]+)$/i);
  return match?.[1] ?? null;
}

export function backupAndDisableMemoryCard(config: AppConfig) {
  const stateDir = getStateDirPath(config);
  const cardPath = getMemoryCardFilePath(config);
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const backupDir = path.join(stateDir, "backups");
  const backupPath = path.join(backupDir, `${config.botName}.memory-card.${timestamp}.json`);
  const disabledPath = `${cardPath}.disabled.${timestamp}`;

  ensureStateDir(config);
  fs.mkdirSync(backupDir, { recursive: true });

  if (!fs.existsSync(cardPath)) {
    return {
      backupPath: null,
      disabledPath: null,
    };
  }

  fs.copyFileSync(cardPath, backupPath);
  fs.renameSync(cardPath, disabledPath);

  return {
    backupPath,
    disabledPath,
  };
}

export function startSelfCanaryManager(input: {
  bot: WechatyInstance;
  config: AppConfig;
  logger: Logger;
  initialDelayMs?: number;
  onFailureThresholdReached?: (payload: {
    consecutiveFailureCount: number;
    lastFailureReason: string;
    lastSentToken: string | null;
    lastSentText: string | null;
    targetContactName: string;
  }) => void;
}) {
  const { bot, config, logger } = input;
  const canary = config.selfCanary;
  const initialDelayMs = input.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const intervalMinMs = (canary?.intervalMinSeconds ?? 0) * 1000;
  const intervalMaxMs = (canary?.intervalMaxSeconds ?? 0) * 1000;
  const ackTimeoutMs = (canary?.ackTimeoutSeconds ?? 0) * 1000;
  let stopped = false;
  let running = false;
  let sendTimer: NodeJS.Timeout | null = null;
  let ackTimer: NodeJS.Timeout | null = null;
  let state = createState(config);

  persistState(config, state);

  function updateState(patch: Partial<SelfCanaryState>) {
    state = {
      ...state,
      ...patch,
    };
    persistState(config, state);
  }

  function clearAckTimer() {
    if (ackTimer) {
      clearTimeout(ackTimer);
      ackTimer = null;
    }
  }

  function scheduleNextSend(delayMs: number) {
    if (stopped || !canary?.enabled) {
      return;
    }

    updateState({
      lastScheduledIntervalSeconds: Math.max(1, Math.round(delayMs / 1000)),
    });

    if (sendTimer) {
      clearTimeout(sendTimer);
    }

    sendTimer = setTimeout(() => {
      void sendCanary();
    }, delayMs);
    sendTimer.unref();
  }

  function pickRandomIntervalMs() {
    if (intervalMaxMs <= intervalMinMs) {
      return intervalMinMs;
    }

    return intervalMinMs + Math.floor(Math.random() * (intervalMaxMs - intervalMinMs + 1));
  }

  function handleFailure(reason: string, deliveryError?: string) {
    clearAckTimer();
    const nextFailureCount = state.consecutiveFailureCount + 1;
    const thresholdReached = nextFailureCount >= (canary?.failureThreshold ?? 1);

    updateState({
      status: thresholdReached && canary?.autoResetEnabled ? "reset_requested" : "failed",
      consecutiveFailureCount: nextFailureCount,
      lastFailureAt: new Date().toISOString(),
      lastFailureReason: reason,
      lastDeliveryError: deliveryError ?? null,
      pendingSinceAt: null,
      lastResetRequestedAt:
        thresholdReached && canary?.autoResetEnabled ? new Date().toISOString() : state.lastResetRequestedAt,
    });

    if (thresholdReached) {
      if (canary?.autoResetEnabled) {
        logger.error("Self canary failure threshold reached; requesting fresh login reset", {
          consecutiveFailureCount: nextFailureCount,
          lastDeliveryError: deliveryError ?? "(none)",
          reason,
          targetContactName: canary.targetContactName,
        });
        input.onFailureThresholdReached?.({
          consecutiveFailureCount: nextFailureCount,
          lastFailureReason: reason,
          lastSentToken: state.lastSentToken,
          lastSentText: state.lastSentText,
          targetContactName: canary.targetContactName,
        });
        return;
      }

      logger.error("Self canary failure threshold reached, but auto reset is disabled", {
        consecutiveFailureCount: nextFailureCount,
        lastDeliveryError: deliveryError ?? "(none)",
        reason,
        targetContactName: canary?.targetContactName ?? "(empty)",
      });
    } else {
      logger.warn("Self canary acknowledgement missing", {
        consecutiveFailureCount: nextFailureCount,
        lastDeliveryError: deliveryError ?? "(none)",
        reason,
        targetContactName: canary?.targetContactName ?? "(empty)",
      });
    }

    scheduleNextSend(pickRandomIntervalMs());
  }

  async function sendCanary() {
    if (stopped || running || !canary?.enabled) {
      return;
    }

    if (state.pendingSinceAt) {
      return;
    }

    if (!bot.isLoggedIn) {
      scheduleNextSend(initialDelayMs);
      return;
    }

    running = true;

    try {
      const token = createToken();
      const text = buildSelfCanaryMessage(token);
      const now = new Date().toISOString();

      updateState({
        status: "pending",
        lastSentAt: now,
        lastSentToken: token,
        lastSentText: text,
        pendingSinceAt: now,
        lastDeliveryError: null,
      });

      const result = await sendTextToTarget(
        bot,
        {
          type: "contact_name",
          value: canary.targetContactName,
        },
        text,
        logger,
      );

      if (!result.delivered) {
        handleFailure("delivery_failed", result.error);
        return;
      }

      logger.info("Self canary sent", {
        targetContactName: canary.targetContactName,
        token,
      });

      clearAckTimer();
      ackTimer = setTimeout(() => {
        handleFailure("ack_timeout");
      }, ackTimeoutMs);
      ackTimer.unref();
    } finally {
      running = false;
    }
  }

  async function observeMessage(message: any) {
    if (stopped || !canary?.enabled || !state.pendingSinceAt || !state.lastSentToken) {
      return;
    }

    if (!(await isSelfMessage(message))) {
      return;
    }

    const token = extractSelfCanaryToken(readMessageText(message));

    if (!token || token !== state.lastSentToken) {
      return;
    }

    clearAckTimer();
    updateState({
      status: "acked",
      lastAckAt: new Date().toISOString(),
      lastAckToken: token,
      consecutiveFailureCount: 0,
      lastFailureAt: null,
      lastFailureReason: null,
      lastDeliveryError: null,
      pendingSinceAt: null,
    });

    logger.info("Self canary acknowledged", {
      targetContactName: canary.targetContactName,
      token,
    });

    scheduleNextSend(pickRandomIntervalMs());
  }

  function notifyLogin() {
    if (!canary?.enabled) {
      return;
    }

    clearAckTimer();
    updateState({
      status: "idle",
      pendingSinceAt: null,
    });
    scheduleNextSend(initialDelayMs);
  }

  function notifyLogout() {
    if (!canary?.enabled) {
      return;
    }

    clearAckTimer();
    updateState({
      status: "idle",
      pendingSinceAt: null,
    });
  }

  if (canary?.enabled && bot.isLoggedIn) {
    scheduleNextSend(initialDelayMs);
  }

  return {
    notifyLogin,
    notifyLogout,
    observeMessage,
    stop() {
      stopped = true;
      clearAckTimer();
      if (sendTimer) {
        clearTimeout(sendTimer);
        sendTimer = null;
      }
    },
  };
}
