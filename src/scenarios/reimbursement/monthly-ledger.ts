import { getZonedDateParts, zonedDateTimeToUtc } from "../../core/runtime/timezone.js";

interface MonthlyLedgerNote {
  text: string;
  month: number;
  year?: number;
}

export function parseMonthlyLedgerNote(note: string): MonthlyLedgerNote | null {
  let ledger: MonthlyLedgerNote | null = null;

  // Do not interpret the tail of an invalid month or year as a bare month.
  for (const match of note.matchAll(/(?<![\d年])(?:(\d{4})年)?(\d{1,2})月[账帐]/g)) {
    const year = match[1] === undefined ? undefined : Number(match[1]);
    const month = Number(match[2]);

    if (month < 1 || month > 12 || (year !== undefined && year < 1000)) {
      continue;
    }

    ledger = { text: match[0], month, year };
  }

  return ledger;
}

export function resolveMonthlyLedgerCreatedAtOverride(input: {
  note: string;
  timeZone?: string;
  referenceDateTime?: string;
}) {
  const ledger = parseMonthlyLedgerNote(input.note);
  if (!ledger) {
    return null;
  }

  const timeZone = input.timeZone ?? "Asia/Shanghai";
  let year = ledger.year;

  if (year === undefined) {
    const referenceDate = input.referenceDateTime ? new Date(input.referenceDateTime) : new Date();
    if (!Number.isFinite(referenceDate.getTime())) {
      return null;
    }

    const reference = getZonedDateParts(referenceDate, timeZone);
    year = reference.year - (ledger.month > reference.month ? 1 : 0);
  }

  const lastDay = new Date(Date.UTC(year, ledger.month, 0)).getUTCDate();
  const utcDate = zonedDateTimeToUtc(year, ledger.month, lastDay, 23, 59, 59, timeZone);
  return utcDate.toISOString().slice(0, 19).replace("T", " ");
}
