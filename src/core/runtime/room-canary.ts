import fs from "node:fs";

import { sendTextToTarget } from "../../bot/delivery-contact.js";
import type { WechatyInstance } from "../../bot/types.js";
import type { AppConfig } from "../config/env.js";
import type { Logger } from "../logging/logger.js";
import { ensureStateDir, getRoomCanaryStatePath } from "./state-paths.js";

const DEFAULT_INITIAL_DELAY_MS = 60_000;
const CANARY_PREFIX = "[wechat-claw][room-canary]";

export interface RoomCanaryState {
  status: "disabled" | "idle" | "pending" | "acked" | "failed" | "restart_requested";
  targetRoomTopic: string;
  enabled: boolean;
  autoRestartEnabled: boolean;
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
  lastRestartRequestedAt: string | null;
}

function writeJsonFile(filePath: string, value: unknown) {
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function createState(config: AppConfig): RoomCanaryState {
  const canary = config.roomCanary;

  return {
    status: canary?.enabled ? "idle" : "disabled",
    targetRoomTopic: canary?.targetRoomTopic ?? "",
    enabled: canary?.enabled ?? false,
    autoRestartEnabled: canary?.autoRestartEnabled ?? false,
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
    lastRestartRequestedAt: null,
  };
}

function persistState(config: AppConfig, state: RoomCanaryState) {
  ensureStateDir(config);
  writeJsonFile(getRoomCanaryStatePath(config), state);
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

async function readRoomTopic(message: any) {
  const room = typeof message?.room === "function" ? await message.room() : null;
  return room && typeof room.topic === "function" ? String(await room.topic()) : "";
}

export function buildRoomCanaryMessage(token: string) {
  return `${CANARY_PREFIX} token=${token}`;
}

export function extractRoomCanaryToken(text: string) {
  const match = text.match(/^\[wechat-claw\]\[room-canary\] token=([a-z0-9-]+)$/i);
  return match?.[1] ?? null;
}

export function readRoomCanaryState(
  config: AppConfig,
): { error?: "invalid" | "missing"; state?: RoomCanaryState } {
  const statePath = getRoomCanaryStatePath(config);

  if (!fs.existsSync(statePath)) {
    return {
      error: "missing",
    };
  }

  try {
    return {
      state: JSON.parse(fs.readFileSync(statePath, "utf8")) as RoomCanaryState,
    };
  } catch {
    return {
      error: "invalid",
    };
  }
}

export function startRoomCanaryManager(input: {
  bot: WechatyInstance;
  config: AppConfig;
  logger: Logger;
  initialDelayMs?: number;
  onFailureThresholdReached?: (payload: {
    consecutiveFailureCount: number;
    lastFailureReason: string;
    lastSentToken: string | null;
    lastSentText: string | null;
    targetRoomTopic: string;
  }) => void;
}) {
  const { bot, config, logger } = input;
  const canary = config.roomCanary;
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

  function updateState(patch: Partial<RoomCanaryState>) {
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
    const shouldRestart = thresholdReached && Boolean(canary?.autoRestartEnabled);

    updateState({
      status: shouldRestart ? "restart_requested" : "failed",
      consecutiveFailureCount: nextFailureCount,
      lastFailureAt: new Date().toISOString(),
      lastFailureReason: reason,
      lastDeliveryError: deliveryError ?? null,
      pendingSinceAt: null,
      lastRestartRequestedAt: shouldRestart ? new Date().toISOString() : state.lastRestartRequestedAt,
    });

    if (thresholdReached) {
      if (shouldRestart) {
        logger.error("Room canary failure threshold reached; requesting service restart", {
          consecutiveFailureCount: nextFailureCount,
          lastDeliveryError: deliveryError ?? "(none)",
          reason,
          targetRoomTopic: canary?.targetRoomTopic ?? "(empty)",
        });
        input.onFailureThresholdReached?.({
          consecutiveFailureCount: nextFailureCount,
          lastFailureReason: reason,
          lastSentToken: state.lastSentToken,
          lastSentText: state.lastSentText,
          targetRoomTopic: canary?.targetRoomTopic ?? "",
        });
        return;
      }

      logger.error("Room canary failure threshold reached, but auto restart is disabled", {
        consecutiveFailureCount: nextFailureCount,
        lastDeliveryError: deliveryError ?? "(none)",
        reason,
        targetRoomTopic: canary?.targetRoomTopic ?? "(empty)",
      });
    } else {
      logger.warn("Room canary acknowledgement missing", {
        consecutiveFailureCount: nextFailureCount,
        lastDeliveryError: deliveryError ?? "(none)",
        reason,
        targetRoomTopic: canary?.targetRoomTopic ?? "(empty)",
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
      const text = buildRoomCanaryMessage(token);
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
          type: "room_topic",
          value: canary.targetRoomTopic,
        },
        text,
        logger,
      );

      if (!result.delivered) {
        handleFailure("delivery_failed", result.error);
        return;
      }

      logger.info("Room canary sent", {
        targetRoomTopic: canary.targetRoomTopic,
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

    const token = extractRoomCanaryToken(readMessageText(message));

    if (!token || token !== state.lastSentToken) {
      return;
    }

    const roomTopic = await readRoomTopic(message);

    if (roomTopic !== canary.targetRoomTopic) {
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

    logger.info("Room canary acknowledged", {
      targetRoomTopic: canary.targetRoomTopic,
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
