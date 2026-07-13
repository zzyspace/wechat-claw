import fs from "node:fs";
import { hostname as getHostname } from "node:os";
import path from "node:path";

import type { AppConfig } from "../config/env.js";
import type { SmtpAttachment } from "../alerts/smtp-client.js";
import { getManagedLogFilePath } from "../logging/log-files.js";
import type { RoomCanaryState } from "./room-canary.js";
import type { RuntimeHealthSnapshot, RuntimeHealthStatus } from "./health.js";
import {
  getHealthArtifactPath,
  getRoomCanaryStatePath,
  getWatchdogArtifactPath,
  getWatchdogStatePath,
} from "./state-paths.js";
import type { RuntimeWatchdogSnapshot } from "./watchdog-heartbeat.js";
import { formatZonedDate } from "./timezone.js";

const HEARTBEAT_STALE_MS = 3 * 60 * 1000;
const DEGRADED_PERSISTENCE_MS = 2 * 60 * 1000;
const WAITING_FOR_SCAN_TIMEOUT_MS = 10 * 60 * 1000;
const ALERT_SUPPRESSION_WINDOW_MS = 15 * 60 * 1000;
const RESTART_THROTTLE_WINDOW_MS = 15 * 60 * 1000;
const MAX_RESTARTS_PER_WINDOW = 2;
const FIRST_OBSERVATION_TTL_MS = 24 * 60 * 60 * 1000;

export type WatchdogReasonCode =
  | "service_not_running"
  | "watchdog_heartbeat_stale"
  | "chromium_dependency_missing"
  | "health_degraded_persistent"
  | "login_waiting_for_scan_timeout"
  | "login_logged_out"
  | "room_canary_failed"
  | "room_canary_state_invalid"
  | "room_canary_state_missing"
  | "host_cpu_step_increase"
  | "service_memory_high"
  | "startup_failed"
  | "restart_throttled"
  | "health_snapshot_missing"
  | "health_snapshot_invalid"
  | "watchdog_snapshot_missing"
  | "watchdog_snapshot_invalid";

export type WatchdogSeverity = "ok" | "warn" | "recoverable_error" | "manual_action_required";

export type WatchdogAction = "none" | "email_only" | "email_and_restart";

export interface ServiceStatusSnapshot {
  activeState: string;
  cpuBaselinePercent?: number;
  cpuIncreasePercentagePoints?: number;
  cpuUtilizationPercent?: number;
  hostCpuIdleTicks?: number;
  hostCpuTotalTicks?: number;
  execMainStatus?: number;
  mainPid?: number;
  memoryCurrentBytes?: number;
  memoryPeakBytes?: number;
  result?: string;
  subState?: string;
}

export interface WatchdogPersistentState {
  cpuBaselinePercent?: number;
  cpuSample?: {
    at: string;
    idleTicks: number;
    totalTicks: number;
  };
  cpuStepCandidate?: {
    alertSentAt?: string;
    baselinePercent: number;
    detectedAt: string;
    latestPercent: number;
    peakPercent: number;
  };
  firstObservedAtByFingerprint: Record<string, string>;
  lastCheckAt: string | null;
  recentAlertsByFingerprint: Record<string, string>;
  recentRestartAts: string[];
}

export interface WatchdogEvaluation {
  action: WatchdogAction;
  fingerprint: string | null;
  healthSnapshot?: RuntimeHealthSnapshot;
  hostName: string;
  message: string;
  reasonCode?: WatchdogReasonCode;
  roomCanaryState?: RoomCanaryState;
  serviceName: string;
  serviceStatus: ServiceStatusSnapshot;
  severity: WatchdogSeverity;
  underlyingReasonCode?: WatchdogReasonCode;
  watchdogSnapshot?: RuntimeWatchdogSnapshot;
}

export interface WatchdogAlertEmail {
  attachments?: SmtpAttachment[];
  subject: string;
  text: string;
}

export interface WatchdogCheckResult {
  effectiveEvaluation: WatchdogEvaluation;
  emailAttempted: boolean;
  emailError?: string;
  emailSent: boolean;
  emailSuppressed: boolean;
  persistentState: WatchdogPersistentState;
  rawEvaluation: WatchdogEvaluation;
  restartAttempted: boolean;
  restartError?: string;
  restartPerformed: boolean;
  restartSuppressed: boolean;
}

function formatBytesAsMiB(bytes: number | undefined) {
  if (!Number.isFinite(bytes) || !bytes || bytes <= 0) {
    return "(unknown)";
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function writeJsonFile(pathValue: string, value: unknown) {
  const tempPath = `${pathValue}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, pathValue);
}

function readJsonFile<T>(pathValue: string): T {
  return JSON.parse(fs.readFileSync(pathValue, "utf8")) as T;
}

function normalizePersistentState(value: Partial<WatchdogPersistentState> | undefined): WatchdogPersistentState {
  const state: WatchdogPersistentState = {
    firstObservedAtByFingerprint:
      value?.firstObservedAtByFingerprint && typeof value.firstObservedAtByFingerprint === "object"
        ? Object.fromEntries(
            Object.entries(value.firstObservedAtByFingerprint).filter((entry): entry is [string, string] => {
              return typeof entry[0] === "string" && typeof entry[1] === "string";
            }),
          )
        : {},
    lastCheckAt: typeof value?.lastCheckAt === "string" ? value.lastCheckAt : null,
    recentAlertsByFingerprint:
      value?.recentAlertsByFingerprint && typeof value.recentAlertsByFingerprint === "object"
        ? Object.fromEntries(
            Object.entries(value.recentAlertsByFingerprint).filter((entry): entry is [string, string] => {
              return typeof entry[0] === "string" && typeof entry[1] === "string";
            }),
          )
        : {},
    recentRestartAts: Array.isArray(value?.recentRestartAts)
      ? value.recentRestartAts.filter((item): item is string => typeof item === "string")
      : [],
  };

  if (Number.isFinite(value?.cpuBaselinePercent) && (value?.cpuBaselinePercent ?? -1) >= 0) {
    state.cpuBaselinePercent = value?.cpuBaselinePercent;
  }

  if (
    typeof value?.cpuSample?.at === "string" &&
    Number.isFinite(value.cpuSample.idleTicks) &&
    value.cpuSample.idleTicks >= 0 &&
    Number.isFinite(value.cpuSample.totalTicks) &&
    value.cpuSample.totalTicks >= 0
  ) {
    state.cpuSample = value.cpuSample;
  }

  if (
    typeof value?.cpuStepCandidate?.detectedAt === "string" &&
    Number.isFinite(value.cpuStepCandidate.baselinePercent) &&
    Number.isFinite(value.cpuStepCandidate.latestPercent) &&
    Number.isFinite(value.cpuStepCandidate.peakPercent)
  ) {
    state.cpuStepCandidate = {
      alertSentAt:
        typeof value.cpuStepCandidate.alertSentAt === "string"
          ? value.cpuStepCandidate.alertSentAt
          : undefined,
      baselinePercent: value.cpuStepCandidate.baselinePercent,
      detectedAt: value.cpuStepCandidate.detectedAt,
      latestPercent: value.cpuStepCandidate.latestPercent,
      peakPercent: value.cpuStepCandidate.peakPercent,
    };
  }

  return state;
}

function ageMsFromIso(iso: string | null | undefined, now: Date) {
  if (!iso) {
    return Number.POSITIVE_INFINITY;
  }

  const timestamp = Date.parse(iso);

  if (Number.isNaN(timestamp)) {
    return Number.POSITIVE_INFINITY;
  }

  return now.getTime() - timestamp;
}

function createFingerprint(input: {
  healthSnapshot?: RuntimeHealthSnapshot;
  reasonCode: WatchdogReasonCode;
  roomCanaryState?: RoomCanaryState;
  serviceStatus: ServiceStatusSnapshot;
  watchdogSnapshot?: RuntimeWatchdogSnapshot;
}) {
  return [
    input.reasonCode,
    input.healthSnapshot?.status ?? "(missing)",
    input.healthSnapshot?.lastError?.category ?? "(none)",
    input.healthSnapshot?.lastError?.message ?? "(none)",
    input.roomCanaryState?.status ?? "(none)",
    input.roomCanaryState?.targetRoomTopic ?? "(none)",
    String(input.watchdogSnapshot?.pid ?? input.serviceStatus.mainPid ?? 0),
    input.watchdogSnapshot?.startedAt ?? input.healthSnapshot?.startedAt ?? "(unknown)",
  ].join("|");
}

function buildEvaluation(input: {
  action: WatchdogAction;
  healthSnapshot?: RuntimeHealthSnapshot;
  hostName: string;
  message: string;
  reasonCode?: WatchdogReasonCode;
  roomCanaryState?: RoomCanaryState;
  serviceName: string;
  serviceStatus: ServiceStatusSnapshot;
  severity: WatchdogSeverity;
  underlyingReasonCode?: WatchdogReasonCode;
  watchdogSnapshot?: RuntimeWatchdogSnapshot;
}): WatchdogEvaluation {
  return {
    action: input.action,
    fingerprint: input.reasonCode
      ? createFingerprint({
          healthSnapshot: input.healthSnapshot,
          reasonCode: input.reasonCode,
          roomCanaryState: input.roomCanaryState,
          serviceStatus: input.serviceStatus,
          watchdogSnapshot: input.watchdogSnapshot,
        })
      : null,
    healthSnapshot: input.healthSnapshot,
    hostName: input.hostName,
    message: input.message,
    reasonCode: input.reasonCode,
    roomCanaryState: input.roomCanaryState,
    serviceName: input.serviceName,
    serviceStatus: input.serviceStatus,
    severity: input.severity,
    underlyingReasonCode: input.underlyingReasonCode,
    watchdogSnapshot: input.watchdogSnapshot,
  };
}

function parseLoggedOutReason(snapshot: RuntimeHealthSnapshot) {
  const message = snapshot.lastError?.message?.toLowerCase() ?? "";
  return message.includes("logged out") || message.includes("logout");
}

function buildQrcodeArtifactAttachment(artifactPath: string): SmtpAttachment | undefined {
  if (!fs.existsSync(artifactPath)) {
    return undefined;
  }

  return {
    content: fs.readFileSync(artifactPath, "utf8"),
    contentType: "text/plain; charset=UTF-8",
    filename: path.basename(artifactPath),
  };
}

export function evaluateWatchdogState(input: {
  config?: AppConfig;
  healthSnapshot?: RuntimeHealthSnapshot;
  healthSnapshotError?: "invalid" | "missing";
  hostName?: string;
  now?: Date;
  roomCanaryState?: RoomCanaryState;
  roomCanaryStateError?: "invalid" | "missing";
  serviceName: string;
  serviceStatus: ServiceStatusSnapshot;
  watchdogSnapshot?: RuntimeWatchdogSnapshot;
  watchdogSnapshotError?: "invalid" | "missing";
}): WatchdogEvaluation {
  const now = input.now ?? new Date();
  const hostName = input.hostName ?? getHostname();
  const serviceStatus = input.serviceStatus;

  if (serviceStatus.activeState === "failed" || serviceStatus.result === "failed") {
    return buildEvaluation({
      action: "email_and_restart",
      healthSnapshot: input.healthSnapshot,
      hostName,
      message: "The main service is in failed state and should be restarted.",
      reasonCode: "startup_failed",
      serviceName: input.serviceName,
      serviceStatus,
      severity: "recoverable_error",
      watchdogSnapshot: input.watchdogSnapshot,
    });
  }

  if (serviceStatus.activeState === "activating") {
    return buildEvaluation({
      action: "none",
      healthSnapshot: input.healthSnapshot,
      hostName,
      message: "The main service is still activating.",
      serviceName: input.serviceName,
      serviceStatus,
      severity: "warn",
      watchdogSnapshot: input.watchdogSnapshot,
    });
  }

  if (serviceStatus.activeState !== "active") {
    return buildEvaluation({
      action: "email_and_restart",
      healthSnapshot: input.healthSnapshot,
      hostName,
      message: "The main service is not active and should be restarted.",
      reasonCode: "service_not_running",
      serviceName: input.serviceName,
      serviceStatus,
      severity: "recoverable_error",
      watchdogSnapshot: input.watchdogSnapshot,
    });
  }

  if (input.healthSnapshotError === "missing") {
    return buildEvaluation({
      action: "email_and_restart",
      hostName,
      message: "The main service is active but health.json is missing.",
      reasonCode: "health_snapshot_missing",
      serviceName: input.serviceName,
      serviceStatus,
      severity: "recoverable_error",
      watchdogSnapshot: input.watchdogSnapshot,
    });
  }

  if (input.healthSnapshotError === "invalid") {
    return buildEvaluation({
      action: "email_and_restart",
      hostName,
      message: "The main service is active but health.json is unreadable.",
      reasonCode: "health_snapshot_invalid",
      serviceName: input.serviceName,
      serviceStatus,
      severity: "recoverable_error",
      watchdogSnapshot: input.watchdogSnapshot,
    });
  }

  if (!input.healthSnapshot) {
    return buildEvaluation({
      action: "none",
      hostName,
      message: "The main service is active but health state is unavailable.",
      serviceName: input.serviceName,
      serviceStatus,
      severity: "warn",
      watchdogSnapshot: input.watchdogSnapshot,
    });
  }

  if (input.watchdogSnapshotError === "missing") {
    return buildEvaluation({
      action: "email_and_restart",
      healthSnapshot: input.healthSnapshot,
      hostName,
      message: "The main service is active but watchdog.json is missing.",
      reasonCode: "watchdog_snapshot_missing",
      serviceName: input.serviceName,
      serviceStatus,
      severity: "recoverable_error",
    });
  }

  if (input.watchdogSnapshotError === "invalid") {
    return buildEvaluation({
      action: "email_and_restart",
      healthSnapshot: input.healthSnapshot,
      hostName,
      message: "The main service is active but watchdog.json is unreadable.",
      reasonCode: "watchdog_snapshot_invalid",
      serviceName: input.serviceName,
      serviceStatus,
      severity: "recoverable_error",
    });
  }

  if (!input.watchdogSnapshot) {
    return buildEvaluation({
      action: "none",
      healthSnapshot: input.healthSnapshot,
      hostName,
      message: "The main service is active but watchdog state is unavailable.",
      serviceName: input.serviceName,
      serviceStatus,
      severity: "warn",
    });
  }

  if (ageMsFromIso(input.watchdogSnapshot.lastHeartbeatAt, now) >= HEARTBEAT_STALE_MS) {
    return buildEvaluation({
      action: "email_and_restart",
      healthSnapshot: input.healthSnapshot,
      hostName,
      message: "The main service heartbeat has stopped updating and the process is likely stuck.",
      reasonCode: "watchdog_heartbeat_stale",
      serviceName: input.serviceName,
      serviceStatus,
      severity: "recoverable_error",
      watchdogSnapshot: input.watchdogSnapshot,
    });
  }

  const roomCanary = input.config?.roomCanary;

  if (roomCanary?.enabled && input.healthSnapshot.status === "logged_in") {
    if (
      input.roomCanaryStateError === "missing" &&
      ageMsFromIso(input.watchdogSnapshot.startedAt, now) >= 2 * 60 * 1000
    ) {
      return buildEvaluation({
        action: "email_only",
        healthSnapshot: input.healthSnapshot,
        hostName,
        message: "Room canary is enabled but room-canary.json is missing.",
        reasonCode: "room_canary_state_missing",
        serviceName: input.serviceName,
        serviceStatus,
        severity: "manual_action_required",
        watchdogSnapshot: input.watchdogSnapshot,
      });
    }

    if (input.roomCanaryStateError === "invalid") {
      return buildEvaluation({
        action: "email_only",
        healthSnapshot: input.healthSnapshot,
        hostName,
        message: "Room canary is enabled but room-canary.json is unreadable.",
        reasonCode: "room_canary_state_invalid",
        serviceName: input.serviceName,
        serviceStatus,
        severity: "manual_action_required",
        watchdogSnapshot: input.watchdogSnapshot,
      });
    }

    if (input.roomCanaryState) {
      const pendingStale =
        input.roomCanaryState.status === "pending" &&
        ageMsFromIso(input.roomCanaryState.pendingSinceAt, now) >=
          (roomCanary.ackTimeoutSeconds + 60) * 1000;
      const failureThresholdReached =
        input.roomCanaryState.consecutiveFailureCount >= roomCanary.failureThreshold;

      if (
        input.roomCanaryState.status === "restart_requested" ||
        failureThresholdReached ||
        pendingStale
      ) {
        return buildEvaluation({
          action: roomCanary.autoRestartEnabled ? "email_and_restart" : "email_only",
          healthSnapshot: input.healthSnapshot,
          hostName,
          message:
            "Room canary failed to receive its own room message acknowledgement; group message listening is likely stuck.",
          reasonCode: "room_canary_failed",
          roomCanaryState: input.roomCanaryState,
          serviceName: input.serviceName,
          serviceStatus,
          severity: roomCanary.autoRestartEnabled ? "recoverable_error" : "manual_action_required",
          watchdogSnapshot: input.watchdogSnapshot,
        });
      }
    }
  }

  if (input.healthSnapshot.status === "waiting_for_scan") {
    const scanAgeMs = input.healthSnapshot.lastScanAt
      ? ageMsFromIso(input.healthSnapshot.lastScanAt, now)
      : ageMsFromIso(input.healthSnapshot.startedAt, now);

    if (scanAgeMs >= WAITING_FOR_SCAN_TIMEOUT_MS) {
      return buildEvaluation({
        action: "email_only",
        healthSnapshot: input.healthSnapshot,
        hostName,
        message: "The bot has been waiting for scan for too long and needs manual login.",
        reasonCode: "login_waiting_for_scan_timeout",
        serviceName: input.serviceName,
        serviceStatus,
        severity: "manual_action_required",
        watchdogSnapshot: input.watchdogSnapshot,
      });
    }

    return buildEvaluation({
      action: "none",
      healthSnapshot: input.healthSnapshot,
      hostName,
      message: "The bot is currently waiting for scan.",
      serviceName: input.serviceName,
      serviceStatus,
      severity: "warn",
      watchdogSnapshot: input.watchdogSnapshot,
    });
  }

  if (input.healthSnapshot.status === "degraded") {
    if (input.healthSnapshot.lastError?.category === "chromium_dependency_missing") {
      return buildEvaluation({
        action: "email_only",
        healthSnapshot: input.healthSnapshot,
        hostName,
        message:
          "The bot failed to launch Chromium and needs manual repair before it can log in again.",
        reasonCode: "chromium_dependency_missing",
        serviceName: input.serviceName,
        serviceStatus,
        severity: "manual_action_required",
        watchdogSnapshot: input.watchdogSnapshot,
      });
    }

    const degradedAgeMs = input.healthSnapshot.degradedSinceAt
      ? ageMsFromIso(input.healthSnapshot.degradedSinceAt, now)
      : input.healthSnapshot.lastError?.at
        ? ageMsFromIso(input.healthSnapshot.lastError.at, now)
      : ageMsFromIso(input.healthSnapshot.startedAt, now);

    if (degradedAgeMs >= DEGRADED_PERSISTENCE_MS) {
      const reasonCode = parseLoggedOutReason(input.healthSnapshot)
        ? "login_logged_out"
        : "health_degraded_persistent";

      return buildEvaluation({
        action: "email_and_restart",
        healthSnapshot: input.healthSnapshot,
        hostName,
        message:
          reasonCode === "login_logged_out"
            ? "The bot logged out and should be restarted."
            : "The bot has stayed in degraded state long enough to trigger recovery.",
        reasonCode,
        serviceName: input.serviceName,
        serviceStatus,
        severity: "recoverable_error",
        watchdogSnapshot: input.watchdogSnapshot,
      });
    }

    return buildEvaluation({
      action: "none",
      healthSnapshot: input.healthSnapshot,
      hostName,
      message: "The bot is degraded, but the persistence threshold has not been reached yet.",
      serviceName: input.serviceName,
      serviceStatus,
      severity: "warn",
      watchdogSnapshot: input.watchdogSnapshot,
    });
  }

  return buildEvaluation({
    action: "none",
    healthSnapshot: input.healthSnapshot,
    hostName,
    message: "The main service and heartbeat look healthy.",
    serviceName: input.serviceName,
    serviceStatus,
    severity: "ok",
    watchdogSnapshot: input.watchdogSnapshot,
  });
}

function prunePersistentState(state: WatchdogPersistentState, now: Date): WatchdogPersistentState {
  const nowMs = now.getTime();

  return {
    cpuBaselinePercent: state.cpuBaselinePercent,
    cpuSample: state.cpuSample,
    cpuStepCandidate: state.cpuStepCandidate,
    firstObservedAtByFingerprint: Object.fromEntries(
      Object.entries(state.firstObservedAtByFingerprint).filter(([, value]) => {
        const age = nowMs - Date.parse(value);
        return !Number.isNaN(age) && age < FIRST_OBSERVATION_TTL_MS;
      }),
    ),
    lastCheckAt: state.lastCheckAt,
    recentAlertsByFingerprint: Object.fromEntries(
      Object.entries(state.recentAlertsByFingerprint).filter(([, value]) => {
        const age = nowMs - Date.parse(value);
        return !Number.isNaN(age) && age < ALERT_SUPPRESSION_WINDOW_MS;
      }),
    ),
    recentRestartAts: state.recentRestartAts.filter((value) => {
      const age = nowMs - Date.parse(value);
      return !Number.isNaN(age) && age < RESTART_THROTTLE_WINDOW_MS;
    }),
  };
}

function updateCpuStepMonitoring(input: {
  config: AppConfig;
  healthSnapshot?: RuntimeHealthSnapshot;
  hostName: string;
  now: Date;
  serviceName: string;
  serviceStatus: ServiceStatusSnapshot;
  state: WatchdogPersistentState;
  watchdogSnapshot?: RuntimeWatchdogSnapshot;
}): WatchdogEvaluation | undefined {
  const { config, now, serviceStatus, state } = input;
  const idleTicks = serviceStatus.hostCpuIdleTicks;
  const totalTicks = serviceStatus.hostCpuTotalTicks;
  const threshold = config.watchdogCpuStepThresholdPercentagePoints ?? 10;
  const minimumPercent = config.watchdogCpuStepMinimumPercent ?? 10;
  const persistenceSeconds = config.watchdogCpuStepPersistenceSeconds ?? 60;

  if (
    threshold <= 0 ||
    serviceStatus.activeState !== "active" ||
    !Number.isFinite(idleTicks) ||
    !Number.isFinite(totalTicks)
  ) {
    return undefined;
  }

  const previousSample = state.cpuSample;
  state.cpuSample = {
    at: now.toISOString(),
    idleTicks: idleTicks ?? 0,
    totalTicks: totalTicks ?? 0,
  };

  if (!previousSample) {
    return undefined;
  }

  const elapsedMs = now.getTime() - Date.parse(previousSample.at);
  const totalDelta = (totalTicks ?? 0) - previousSample.totalTicks;
  const idleDelta = (idleTicks ?? 0) - previousSample.idleTicks;

  if (
    !Number.isFinite(elapsedMs) ||
    elapsedMs <= 0 ||
    totalDelta <= 0 ||
    idleDelta < 0 ||
    idleDelta > totalDelta
  ) {
    delete state.cpuBaselinePercent;
    delete state.cpuStepCandidate;
    return undefined;
  }

  const currentPercent = ((totalDelta - idleDelta) / totalDelta) * 100;
  if (!Number.isFinite(currentPercent) || currentPercent < 0) {
    return undefined;
  }

  serviceStatus.cpuUtilizationPercent = currentPercent;

  if (state.cpuBaselinePercent === undefined) {
    state.cpuBaselinePercent = currentPercent;
    return undefined;
  }

  const candidate = state.cpuStepCandidate;

  if (!candidate) {
    if (
      currentPercent >= minimumPercent &&
      currentPercent - state.cpuBaselinePercent >= threshold
    ) {
      state.cpuStepCandidate = {
        baselinePercent: state.cpuBaselinePercent,
        detectedAt: now.toISOString(),
        latestPercent: currentPercent,
        peakPercent: currentPercent,
      };
    } else {
      state.cpuBaselinePercent = state.cpuBaselinePercent * 0.8 + currentPercent * 0.2;
    }
    return undefined;
  }

  const increase = currentPercent - candidate.baselinePercent;
  if (
    currentPercent < minimumPercent ||
    increase < threshold * 0.5
  ) {
    state.cpuBaselinePercent = currentPercent;
    delete state.cpuStepCandidate;
    return undefined;
  }

  candidate.latestPercent = currentPercent;
  candidate.peakPercent = Math.max(candidate.peakPercent, currentPercent);
  serviceStatus.cpuBaselinePercent = candidate.baselinePercent;
  serviceStatus.cpuIncreasePercentagePoints = increase;

  if (candidate.alertSentAt) {
    return undefined;
  }

  if (ageMsFromIso(candidate.detectedAt, now) < persistenceSeconds * 1000) {
    return undefined;
  }

  return buildEvaluation({
    action: "email_only",
    healthSnapshot: input.healthSnapshot,
    hostName: input.hostName,
    message: `Host CPU increased from a ${candidate.baselinePercent.toFixed(1)}% baseline to ${currentPercent.toFixed(1)}% (+${increase.toFixed(1)} percentage points) and remained elevated for at least ${persistenceSeconds} seconds.`,
    reasonCode: "host_cpu_step_increase",
    serviceName: input.serviceName,
    serviceStatus,
    severity: "manual_action_required",
    watchdogSnapshot: input.watchdogSnapshot,
  });
}

function applyRestartThrottle(
  evaluation: WatchdogEvaluation,
  state: WatchdogPersistentState,
): WatchdogEvaluation {
  if (evaluation.action !== "email_and_restart") {
    return evaluation;
  }

  if (state.recentRestartAts.length < MAX_RESTARTS_PER_WINDOW) {
    return evaluation;
  }

  return buildEvaluation({
    action: "email_only",
    healthSnapshot: evaluation.healthSnapshot,
    hostName: evaluation.hostName,
    message:
      "Automatic restart is throttled because the service has already been restarted too many times in the recent window.",
    reasonCode: "restart_throttled",
    serviceName: evaluation.serviceName,
    serviceStatus: evaluation.serviceStatus,
    severity: "manual_action_required",
    underlyingReasonCode: evaluation.reasonCode,
    watchdogSnapshot: evaluation.watchdogSnapshot,
  });
}

function shouldSuppressAlert(state: WatchdogPersistentState, fingerprint: string | null, now: Date) {
  if (!fingerprint) {
    return false;
  }

  const lastSentAt = state.recentAlertsByFingerprint[fingerprint];

  if (!lastSentAt) {
    return false;
  }

  return ageMsFromIso(lastSentAt, now) < ALERT_SUPPRESSION_WINDOW_MS;
}

export function createWatchdogAlertEmail(input: {
  config: AppConfig;
  evaluation: WatchdogEvaluation;
  now?: Date;
}): WatchdogAlertEmail {
  const now = input.now ?? new Date();
  const subjectStatus =
    input.evaluation.severity === "manual_action_required" ? "manual-action" : "recoverable";
  const plannedAction =
    input.evaluation.action === "email_and_restart"
      ? "Automatic restart will be attempted after this alert."
      : input.evaluation.action === "email_only"
        ? "No automatic restart will be attempted."
        : "No follow-up action is planned.";
  const today = formatZonedDate(now, input.config.timeZone);

  return {
    subject: `[wechat-claw][${subjectStatus}] ${input.evaluation.hostName} ${input.evaluation.reasonCode ?? "runtime-warning"}`,
    text: [
      `Service: ${input.evaluation.serviceName}`,
      `Host: ${input.evaluation.hostName}`,
      `Time: ${now.toISOString()}`,
      `Severity: ${input.evaluation.severity}`,
      `Reason: ${input.evaluation.reasonCode ?? "(none)"}`,
      `Underlying reason: ${input.evaluation.underlyingReasonCode ?? "(none)"}`,
      `Message: ${input.evaluation.message}`,
      `Action: ${plannedAction}`,
      "",
      `Service activeState: ${input.evaluation.serviceStatus.activeState}`,
      `Service subState: ${input.evaluation.serviceStatus.subState ?? "(unknown)"}`,
      `Service result: ${input.evaluation.serviceStatus.result ?? "(unknown)"}`,
      `Service mainPid: ${input.evaluation.serviceStatus.mainPid ?? 0}`,
      `Host CPU utilization: ${input.evaluation.serviceStatus.cpuUtilizationPercent?.toFixed(1) ?? "(unknown)"}%`,
      `Host CPU baseline: ${input.evaluation.serviceStatus.cpuBaselinePercent?.toFixed(1) ?? "(unknown)"}%`,
      `Host CPU increase: ${input.evaluation.serviceStatus.cpuIncreasePercentagePoints?.toFixed(1) ?? "(unknown)"} percentage points`,
      `Service memoryCurrent: ${formatBytesAsMiB(input.evaluation.serviceStatus.memoryCurrentBytes)}`,
      `Service memoryPeak: ${formatBytesAsMiB(input.evaluation.serviceStatus.memoryPeakBytes)}`,
      "",
      `Health status: ${input.evaluation.healthSnapshot?.status ?? "(missing)"}`,
      `Health startedAt: ${input.evaluation.healthSnapshot?.startedAt ?? "(missing)"}`,
      `Health degradedSinceAt: ${input.evaluation.healthSnapshot?.degradedSinceAt ?? "(missing)"}`,
      `Health lastScanAt: ${input.evaluation.healthSnapshot?.lastScanAt ?? "(missing)"}`,
      `Health lastLoginAt: ${input.evaluation.healthSnapshot?.lastLoginAt ?? "(missing)"}`,
      `Health lastMessageAt: ${input.evaluation.healthSnapshot?.lastMessageAt ?? "(missing)"}`,
      `Health lastSummaryAt: ${input.evaluation.healthSnapshot?.lastSummaryAt ?? "(missing)"}`,
      `Health lastError.category: ${input.evaluation.healthSnapshot?.lastError?.category ?? "(none)"}`,
      `Health lastError.message: ${input.evaluation.healthSnapshot?.lastError?.message ?? "(none)"}`,
      "",
      `Room canary status: ${input.evaluation.roomCanaryState?.status ?? "(missing)"}`,
      `Room canary targetRoomTopic: ${input.evaluation.roomCanaryState?.targetRoomTopic ?? "(missing)"}`,
      `Room canary consecutiveFailureCount: ${input.evaluation.roomCanaryState?.consecutiveFailureCount ?? 0}`,
      `Room canary pendingSinceAt: ${input.evaluation.roomCanaryState?.pendingSinceAt ?? "(missing)"}`,
      `Room canary lastSentAt: ${input.evaluation.roomCanaryState?.lastSentAt ?? "(missing)"}`,
      `Room canary lastAckAt: ${input.evaluation.roomCanaryState?.lastAckAt ?? "(missing)"}`,
      `Room canary lastFailureReason: ${input.evaluation.roomCanaryState?.lastFailureReason ?? "(none)"}`,
      "",
      `Watchdog runId: ${input.evaluation.watchdogSnapshot?.runId ?? "(missing)"}`,
      `Watchdog pid: ${input.evaluation.watchdogSnapshot?.pid ?? 0}`,
      `Watchdog startedAt: ${input.evaluation.watchdogSnapshot?.startedAt ?? "(missing)"}`,
      `Watchdog degradedSinceAt: ${input.evaluation.watchdogSnapshot?.degradedSinceAt ?? "(missing)"}`,
      `Watchdog lastHeartbeatAt: ${input.evaluation.watchdogSnapshot?.lastHeartbeatAt ?? "(missing)"}`,
      "",
      `Health file: ${getHealthArtifactPath(input.config)}`,
      `Watchdog file: ${getWatchdogArtifactPath(input.config)}`,
      `Room canary file: ${getRoomCanaryStatePath(input.config)}`,
      `App log: ${getManagedLogFilePath(input.config, "app", today)}`,
      `Error log: ${getManagedLogFilePath(input.config, "error", today)}`,
      "",
      "Suggested commands:",
      `  journalctl -u ${input.evaluation.serviceName} -f -o short-iso`,
      `  tail -f ${getManagedLogFilePath(input.config, "app", today)}`,
      `  tail -f ${getManagedLogFilePath(input.config, "error", today)}`,
      `  cat ${getHealthArtifactPath(input.config)}`,
      `  cat ${getWatchdogArtifactPath(input.config)}`,
      `  cat ${getRoomCanaryStatePath(input.config)}`,
    ].join("\n"),
  };
}

export function createWaitingForScanAlertEmail(input: {
  artifactPath: string;
  config: AppConfig;
  hostName?: string;
  now?: Date;
  qrcodeUrl: string;
}): WatchdogAlertEmail {
  const now = input.now ?? new Date();
  const hostName = input.hostName ?? getHostname();
  const attachment = buildQrcodeArtifactAttachment(input.artifactPath);

  return {
    attachments: attachment ? [attachment] : undefined,
    subject: `[wechat-claw][manual-action] ${hostName} waiting_for_scan`,
    text: [
      "The bot is waiting for scan and needs manual login.",
      "",
      `Bot: ${input.config.botName}`,
      `Host: ${hostName}`,
      `Time: ${now.toISOString()}`,
      `State dir: ${input.config.stateDir}`,
      `QR code URL: ${input.qrcodeUrl}`,
      `QR code artifact: ${input.artifactPath}`,
      attachment
        ? "Attachment: latest-qrcode.txt with QR URL and ASCII QR code."
        : "Attachment: unavailable (latest-qrcode.txt could not be read).",
      "",
      "Suggested action:",
      "1. Open the QR code URL or attachment.",
      "2. Scan it with the bot account.",
      "3. Wait for the online notice.",
    ].join("\n"),
  };
}

export function readRuntimeHealthSnapshot(
  config: AppConfig,
): { error?: "invalid" | "missing"; snapshot?: RuntimeHealthSnapshot } {
  const artifactPath = getHealthArtifactPath(config);

  if (!fs.existsSync(artifactPath)) {
    return {
      error: "missing",
    };
  }

  try {
    return {
      snapshot: readJsonFile<RuntimeHealthSnapshot>(artifactPath),
    };
  } catch {
    return {
      error: "invalid",
    };
  }
}

export function readRuntimeWatchdogSnapshot(
  config: AppConfig,
): { error?: "invalid" | "missing"; snapshot?: RuntimeWatchdogSnapshot } {
  const artifactPath = getWatchdogArtifactPath(config);

  if (!fs.existsSync(artifactPath)) {
    return {
      error: "missing",
    };
  }

  try {
    return {
      snapshot: readJsonFile<RuntimeWatchdogSnapshot>(artifactPath),
    };
  } catch {
    return {
      error: "invalid",
    };
  }
}

export function readWatchdogPersistentState(config: AppConfig): WatchdogPersistentState {
  const statePath = getWatchdogStatePath(config);

  if (!fs.existsSync(statePath)) {
    return normalizePersistentState(undefined);
  }

  try {
    return normalizePersistentState(readJsonFile<WatchdogPersistentState>(statePath));
  } catch {
    return normalizePersistentState(undefined);
  }
}

export function writeWatchdogPersistentState(config: AppConfig, state: WatchdogPersistentState) {
  writeJsonFile(getWatchdogStatePath(config), state);
}

export async function runWatchdogCheck(input: {
  config: AppConfig;
  healthSnapshot?: RuntimeHealthSnapshot;
  healthSnapshotError?: "invalid" | "missing";
  hostName?: string;
  now?: Date;
  persistentState?: WatchdogPersistentState;
  readServiceStatus: () => Promise<ServiceStatusSnapshot> | ServiceStatusSnapshot;
  restartService: () => Promise<void> | void;
  roomCanaryState?: RoomCanaryState;
  roomCanaryStateError?: "invalid" | "missing";
  sendAlertEmail?: (message: WatchdogAlertEmail) => Promise<void> | void;
  serviceName: string;
  watchdogSnapshot?: RuntimeWatchdogSnapshot;
  watchdogSnapshotError?: "invalid" | "missing";
}): Promise<WatchdogCheckResult> {
  const now = input.now ?? new Date();
  const serviceStatus = await input.readServiceStatus();
  let rawEvaluation = evaluateWatchdogState({
    config: input.config,
    healthSnapshot: input.healthSnapshot,
    healthSnapshotError: input.healthSnapshotError,
    hostName: input.hostName,
    now,
    roomCanaryState: input.roomCanaryState,
    roomCanaryStateError: input.roomCanaryStateError,
    serviceName: input.serviceName,
    serviceStatus,
    watchdogSnapshot: input.watchdogSnapshot,
    watchdogSnapshotError: input.watchdogSnapshotError,
  });
  const baseState = prunePersistentState(
    normalizePersistentState(input.persistentState),
    now,
  );
  const cpuEvaluation = updateCpuStepMonitoring({
    config: input.config,
    healthSnapshot: input.healthSnapshot,
    hostName: input.hostName ?? getHostname(),
    now,
    serviceName: input.serviceName,
    serviceStatus,
    state: baseState,
    watchdogSnapshot: input.watchdogSnapshot,
  });

  if (cpuEvaluation && rawEvaluation.action === "none") {
    rawEvaluation = cpuEvaluation;
  }
  const memoryLimitBytes =
    input.config.watchdogMemoryLimitMb > 0
      ? Math.round(input.config.watchdogMemoryLimitMb * 1024 * 1024)
      : 0;

  if (
    memoryLimitBytes > 0 &&
    serviceStatus.activeState === "active" &&
    serviceStatus.memoryCurrentBytes !== undefined &&
    serviceStatus.memoryCurrentBytes >= memoryLimitBytes
  ) {
    rawEvaluation = buildEvaluation({
      action: "email_and_restart",
      healthSnapshot: input.healthSnapshot,
      hostName: input.hostName ?? getHostname(),
      message: `The main service is using ${formatBytesAsMiB(serviceStatus.memoryCurrentBytes)} which exceeds the configured watchdog limit of ${input.config.watchdogMemoryLimitMb} MiB.`,
      reasonCode: "service_memory_high",
      serviceName: input.serviceName,
      serviceStatus,
      severity: "recoverable_error",
      watchdogSnapshot: input.watchdogSnapshot,
    });
  }

  const effectiveEvaluation = applyRestartThrottle(rawEvaluation, baseState);
  const persistentState: WatchdogPersistentState = {
    ...baseState,
    lastCheckAt: now.toISOString(),
  };

  for (const fingerprint of Object.keys(persistentState.firstObservedAtByFingerprint)) {
    if (fingerprint.startsWith("service_memory_high|") && fingerprint !== rawEvaluation.fingerprint) {
      delete persistentState.firstObservedAtByFingerprint[fingerprint];
    }
  }

  let persistenceGatedEvaluation = effectiveEvaluation;

  if (
    rawEvaluation.reasonCode === "service_memory_high" &&
    rawEvaluation.fingerprint &&
    input.config.watchdogMemoryPersistenceSeconds > 0
  ) {
    const firstObservedAt =
      persistentState.firstObservedAtByFingerprint[rawEvaluation.fingerprint] ?? now.toISOString();
    persistentState.firstObservedAtByFingerprint[rawEvaluation.fingerprint] = firstObservedAt;

    if (ageMsFromIso(firstObservedAt, now) < input.config.watchdogMemoryPersistenceSeconds * 1000) {
      persistenceGatedEvaluation = buildEvaluation({
        action: "none",
        healthSnapshot: rawEvaluation.healthSnapshot,
        hostName: rawEvaluation.hostName,
        message: "The main service is above the memory threshold, but the persistence threshold has not been reached yet.",
        reasonCode: rawEvaluation.reasonCode,
        serviceName: rawEvaluation.serviceName,
        serviceStatus: rawEvaluation.serviceStatus,
        severity: "warn",
        watchdogSnapshot: rawEvaluation.watchdogSnapshot,
      });
    }
  }

  let emailAttempted = false;
  let emailSent = false;
  let emailSuppressed = false;
  let emailError: string | undefined;
  let restartAttempted = false;
  let restartPerformed = false;
  let restartSuppressed = false;
  let restartError: string | undefined;

  if (
    persistenceGatedEvaluation.action !== "none" &&
    persistenceGatedEvaluation.fingerprint &&
    shouldSuppressAlert(persistentState, persistenceGatedEvaluation.fingerprint, now)
  ) {
    emailSuppressed = true;
  } else if (
    persistenceGatedEvaluation.action !== "none" &&
    input.config.alertEmailEnabled &&
    input.sendAlertEmail
  ) {
    emailAttempted = true;

    try {
      await input.sendAlertEmail(
        createWatchdogAlertEmail({
          config: input.config,
          evaluation: persistenceGatedEvaluation,
          now,
        }),
      );
      emailSent = true;

      if (persistenceGatedEvaluation.fingerprint) {
        persistentState.recentAlertsByFingerprint[persistenceGatedEvaluation.fingerprint] = now.toISOString();
      }
      if (
        persistenceGatedEvaluation.reasonCode === "host_cpu_step_increase" &&
        persistentState.cpuStepCandidate
      ) {
        persistentState.cpuStepCandidate.alertSentAt = now.toISOString();
      }
    } catch (error) {
      emailError = error instanceof Error ? error.message : String(error);
    }
  }

  if (rawEvaluation.action === "email_and_restart" && persistenceGatedEvaluation.reasonCode === "restart_throttled") {
    restartSuppressed = true;
  } else if (persistenceGatedEvaluation.action === "email_and_restart") {
    restartAttempted = true;
    persistentState.recentRestartAts.push(now.toISOString());

    try {
      await input.restartService();
      restartPerformed = true;
    } catch (error) {
      restartError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    effectiveEvaluation: persistenceGatedEvaluation,
    emailAttempted,
    emailError,
    emailSent,
    emailSuppressed,
    persistentState,
    rawEvaluation,
    restartAttempted,
    restartError,
    restartPerformed,
    restartSuppressed,
  };
}
