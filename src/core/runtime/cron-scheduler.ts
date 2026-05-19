import type { Logger } from "../logging/logger.js";
import { formatZonedMinuteKey, getZonedDateParts } from "./timezone.js";

interface ParsedCronField {
  wildcard: boolean;
  values: Set<number>;
}

interface ParsedCronExpression {
  minute: ParsedCronField;
  hour: ParsedCronField;
  dayOfMonth: ParsedCronField;
  month: ParsedCronField;
  dayOfWeek: ParsedCronField;
}

export interface CronSchedulerOptions {
  expression: string;
  timeZone: string;
  taskName: string;
  logger: Logger;
  task: () => Promise<void>;
  onTaskError?: (error: unknown) => void;
}

function normalizeDayOfWeek(value: number): number {
  return value === 7 ? 0 : value;
}

function parseValue(token: string, min: number, max: number, normalize?: (value: number) => number): number {
  const value = Number(token);

  if (!Number.isInteger(value)) {
    throw new Error(`Invalid cron value: ${token}`);
  }

  const normalized = normalize ? normalize(value) : value;

  if (normalized < min || normalized > max) {
    throw new Error(`Cron value out of range: ${token}`);
  }

  return normalized;
}

function addRange(
  values: Set<number>,
  start: number,
  end: number,
  step: number,
  normalize?: (value: number) => number,
) {
  if (step <= 0) {
    throw new Error(`Invalid cron step: ${step}`);
  }

  if (start > end) {
    throw new Error(`Invalid cron range: ${start}-${end}`);
  }

  for (let value = start; value <= end; value += step) {
    values.add(normalize ? normalize(value) : value);
  }
}

function parseCronField(
  field: string,
  min: number,
  max: number,
  normalize?: (value: number) => number,
): ParsedCronField {
  const values = new Set<number>();
  const parts = field.split(",");
  const wildcard = field === "*";

  for (const part of parts) {
    const trimmed = part.trim();

    if (!trimmed) {
      throw new Error(`Invalid cron field: ${field}`);
    }

    if (trimmed === "*") {
      addRange(values, min, max, 1, normalize);
      continue;
    }

    const stepParts = trimmed.split("/");
    if (stepParts.length > 2) {
      throw new Error(`Invalid cron field: ${field}`);
    }

    const base = stepParts[0];
    const step = stepParts[1] ? Number(stepParts[1]) : 1;

    if (base === "*") {
      addRange(values, min, max, step, normalize);
      continue;
    }

    const rangeMatch = /^(\d+)-(\d+)$/.exec(base);

    if (rangeMatch) {
      const start = parseValue(rangeMatch[1], min, max, normalize);
      const end = parseValue(rangeMatch[2], min, max, normalize);
      addRange(values, start, end, step, normalize);
      continue;
    }

    if (stepParts[1]) {
      const start = parseValue(base, min, max, normalize);
      addRange(values, start, max, step, normalize);
      continue;
    }

    values.add(parseValue(base, min, max, normalize));
  }

  return {
    wildcard,
    values,
  };
}

export function parseCronExpression(expression: string): ParsedCronExpression {
  const fields = expression.trim().split(/\s+/);

  if (fields.length !== 5) {
    throw new Error(`Invalid cron expression: ${expression}`);
  }

  return {
    minute: parseCronField(fields[0], 0, 59),
    hour: parseCronField(fields[1], 0, 23),
    dayOfMonth: parseCronField(fields[2], 1, 31),
    month: parseCronField(fields[3], 1, 12),
    dayOfWeek: parseCronField(fields[4], 0, 6, normalizeDayOfWeek),
  };
}

function matchesCronField(field: ParsedCronField, value: number): boolean {
  return field.values.has(value);
}

function matchesCronExpression(expression: ParsedCronExpression, date: Date, timeZone: string): boolean {
  const parts = getZonedDateParts(date, timeZone);
  const dayOfMonthMatch = matchesCronField(expression.dayOfMonth, parts.day);
  const dayOfWeekMatch = matchesCronField(expression.dayOfWeek, parts.weekday);
  const eitherDayRestricted = !expression.dayOfMonth.wildcard && !expression.dayOfWeek.wildcard;
  const dayMatch = eitherDayRestricted
    ? dayOfMonthMatch || dayOfWeekMatch
    : dayOfMonthMatch && dayOfWeekMatch;

  return (
    matchesCronField(expression.minute, parts.minute) &&
    matchesCronField(expression.hour, parts.hour) &&
    matchesCronField(expression.month, parts.month) &&
    dayMatch
  );
}

export function startCronScheduler(options: CronSchedulerOptions): { stop(): void } {
  const parsed = parseCronExpression(options.expression);
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let lastTriggeredMinute = "";

  async function tick() {
    if (stopped) {
      return;
    }

    const now = new Date();
    const minuteKey = formatZonedMinuteKey(now, options.timeZone);

    if (minuteKey !== lastTriggeredMinute && matchesCronExpression(parsed, now, options.timeZone)) {
      lastTriggeredMinute = minuteKey;

      if (running) {
        options.logger.warn("Scheduled task skipped because a previous run is still active", {
          taskName: options.taskName,
          minuteKey,
        });
      } else {
        running = true;

        try {
          await options.task();
        } catch (error) {
          options.onTaskError?.(error);
        } finally {
          running = false;
        }
      }
    }

    scheduleNextTick();
  }

  function scheduleNextTick() {
    if (stopped) {
      return;
    }

    const now = new Date();
    const delayMs = 60_000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 50;
    timer = setTimeout(() => {
      void tick();
    }, delayMs);
  }

  void tick();

  return {
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
      }
    },
  };
}
