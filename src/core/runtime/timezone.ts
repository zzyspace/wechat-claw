const weekdayMap: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export interface ZonedDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function parseDateString(date: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);

  if (!match) {
    throw new Error(`Invalid date string: ${date}. Expected YYYY-MM-DD.`);
  }

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

export function getZonedDateParts(date: Date, timeZone: string): ZonedDateParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });

  const parts = formatter.formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
    weekday: weekdayMap[values.weekday] ?? 0,
  };
}

export function formatZonedDate(date: Date, timeZone: string): string {
  const parts = getZonedDateParts(date, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

export function formatZonedMinuteKey(date: Date, timeZone: string): string {
  const parts = getZonedDateParts(date, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

export function getTimeZoneOffsetMinutes(date: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
    hour: "2-digit",
  });
  const timeZoneName = formatter.formatToParts(date).find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const normalized = timeZoneName.replace("UTC", "GMT");

  if (normalized === "GMT") {
    return 0;
  }

  const match = /^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(normalized);

  if (!match) {
    throw new Error(`Unable to parse time zone offset: ${timeZoneName}`);
  }

  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? "0");

  return sign * (hours * 60 + minutes);
}

export function zonedDateTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): Date {
  let candidate = new Date(Date.UTC(year, month - 1, day, hour, minute, second));

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const offsetMinutes = getTimeZoneOffsetMinutes(candidate, timeZone);
    const adjusted = new Date(
      Date.UTC(year, month - 1, day, hour, minute, second) - offsetMinutes * 60 * 1000,
    );

    if (adjusted.getTime() === candidate.getTime()) {
      return adjusted;
    }

    candidate = adjusted;
  }

  return candidate;
}

export function getUtcRangeForZonedDate(date: string, timeZone: string) {
  const start = parseDateString(date);
  const nextDayUtc = new Date(Date.UTC(start.year, start.month - 1, start.day + 1, 0, 0, 0));

  const startUtc = zonedDateTimeToUtc(start.year, start.month, start.day, 0, 0, 0, timeZone);
  const endParts = {
    year: nextDayUtc.getUTCFullYear(),
    month: nextDayUtc.getUTCMonth() + 1,
    day: nextDayUtc.getUTCDate(),
  };
  const endUtc = zonedDateTimeToUtc(endParts.year, endParts.month, endParts.day, 0, 0, 0, timeZone);

  return {
    startInclusiveIso: startUtc.toISOString(),
    endExclusiveIso: endUtc.toISOString(),
  };
}
