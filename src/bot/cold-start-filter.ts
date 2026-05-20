export interface ColdStartFilterInput {
  botStartedAt: string;
  coldStartIgnoreWindowSeconds: number;
  now?: Date;
}

export interface ColdStartFilterDecision {
  ignored: boolean;
  messageAgeSeconds?: number;
  messageSentAt?: string;
  cutoffAt?: string;
}

export function shouldIgnoreColdStartMessage(
  message: any,
  input: ColdStartFilterInput,
): ColdStartFilterDecision {
  if (input.coldStartIgnoreWindowSeconds <= 0) {
    return { ignored: false };
  }

  const botStartedAt = new Date(input.botStartedAt);
  if (!Number.isFinite(botStartedAt.getTime())) {
    return { ignored: false };
  }

  const now = input.now ?? new Date();
  const sentAt = resolveMessageSentAt(message, now);
  if (!sentAt) {
    return { ignored: false };
  }

  const cutoffAt = new Date(botStartedAt.getTime() - input.coldStartIgnoreWindowSeconds * 1000);
  const messageAgeSeconds = Math.max(0, Math.floor((now.getTime() - sentAt.getTime()) / 1000));

  if (sentAt.getTime() >= cutoffAt.getTime()) {
    return {
      ignored: false,
      cutoffAt: cutoffAt.toISOString(),
      messageAgeSeconds,
      messageSentAt: sentAt.toISOString(),
    };
  }

  return {
    ignored: true,
    cutoffAt: cutoffAt.toISOString(),
    messageAgeSeconds,
    messageSentAt: sentAt.toISOString(),
  };
}

function resolveMessageSentAt(message: any, now: Date): Date | undefined {
  if (message && typeof message.date === "function") {
    try {
      const value = message.date();
      if (value instanceof Date && Number.isFinite(value.getTime())) {
        return value;
      }
    } catch {
      // ignore and fall back to age()
    }
  }

  if (message && typeof message.age === "function") {
    try {
      const ageSeconds = Number(message.age());
      if (Number.isFinite(ageSeconds) && ageSeconds >= 0) {
        return new Date(now.getTime() - ageSeconds * 1000);
      }
    } catch {
      // ignore and give up
    }
  }

  return undefined;
}
