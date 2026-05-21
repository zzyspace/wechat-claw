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

function padMilliseconds(value: number): string {
  return String(value).padStart(3, "0");
}

function formatDateString(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

export function parseDateString(date: string) {
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
  return formatDateString(parts.year, parts.month, parts.day);
}

export function formatZonedMinuteKey(date: Date, timeZone: string): string {
  const parts = getZonedDateParts(date, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

export function formatZonedTimestamp(date: Date, timeZone: string): string {
  const parts = getZonedDateParts(date, timeZone);

  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}.${padMilliseconds(date.getMilliseconds())}`;
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

export function addDaysToDateString(date: string, days: number): string {
  const parts = parseDateString(date);
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12, 0, 0));

  return formatDateString(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
  );
}

function getUtcStartOfZonedDate(date: string, timeZone: string) {
  const parts = parseDateString(date);
  return zonedDateTimeToUtc(parts.year, parts.month, parts.day, 0, 0, 0, timeZone);
}

export function getUtcRangeForZonedDate(date: string, timeZone: string) {
  const startUtc = getUtcStartOfZonedDate(date, timeZone);
  const endUtc = getUtcStartOfZonedDate(addDaysToDateString(date, 1), timeZone);

  return {
    startInclusiveIso: startUtc.toISOString(),
    endExclusiveIso: endUtc.toISOString(),
  };
}

export function getWeekRangeForDate(date: string) {
  parseDateString(date);
  const anchor = new Date(`${date}T12:00:00.000Z`);
  const weekday = anchor.getUTCDay();
  const diffToMonday = (weekday + 6) % 7;
  const startDate = addDaysToDateString(date, -diffToMonday);
  const endDate = addDaysToDateString(startDate, 6);
  const endExclusiveDate = addDaysToDateString(startDate, 7);

  return {
    startDate,
    endDate,
    endExclusiveDate,
  };
}

export function getUtcRangeForZonedWeek(date: string, timeZone: string) {
  const { startDate, endDate, endExclusiveDate } = getWeekRangeForDate(date);

  return {
    startDate,
    endDate,
    startInclusiveIso: getUtcStartOfZonedDate(startDate, timeZone).toISOString(),
    endExclusiveIso: getUtcStartOfZonedDate(endExclusiveDate, timeZone).toISOString(),
  };
}
