import { normalizeReimbursementExpenseCategory } from "../../scenarios/reimbursement/categories.js";
import type { ReimbursementExpenseCategory } from "../../scenarios/reimbursement/types.js";

export interface ManualReimbursementImportMessageCommand {
  amount: number;
  channelCode: string;
  expenseCategory: ReimbursementExpenseCategory;
  note: string;
  reporter: string;
  sentAt?: string;
}

export interface ManualReimbursementImportMessageCommandOptions {
  defaultChannelCode?: string;
}

const COMMAND_HEADER = "补录报账";
const SUPPORTED_KEYS = new Map<string, keyof ManualReimbursementImportMessageCommand>([
  ["amount", "amount"],
  ["category", "expenseCategory"],
  ["channel", "channelCode"],
  ["channel_code", "channelCode"],
  ["channelcode", "channelCode"],
  ["note", "note"],
  ["reporter", "reporter"],
  ["sent_at", "sentAt"],
  ["sentat", "sentAt"],
  ["分类", "expenseCategory"],
  ["报账人", "reporter"],
  ["时间", "sentAt"],
  ["群聊代码", "channelCode"],
  ["金额", "amount"],
  ["备注", "note"],
]);

export function buildManualReimbursementImportMessageFormatText() {
  return [
    "补录报账",
    "channel_code: reimbursement_fuzzy",
    "reporter: 张三",
    "amount: 36.5",
    "category: 食材",
    "note: 午餐报账",
    "sent_at: 2026-07-02T14:32:00+08:00",
  ].join("\n");
}

function normalizeMessageLineBreaks(text: string) {
  return text.replace(/<br\s*\/?>/gi, "\n");
}

function normalizeKey(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, "").replace(/-/g, "_");
}

function parseAmount(value: string) {
  const amount = Number(value);

  if (!Number.isFinite(amount)) {
    throw new Error(`Invalid amount: ${value}`);
  }

  return amount;
}

function parseSentAt(value: string) {
  const date = new Date(value);

  if (!Number.isFinite(date.getTime())) {
    throw new Error(`Invalid sent_at: ${value}`);
  }

  return date.toISOString();
}

function parseCategory(value: string) {
  const normalized = normalizeReimbursementExpenseCategory(value);

  if (!normalized) {
    throw new Error(`Invalid category: ${value}`);
  }

  return normalized;
}

export function parseManualReimbursementImportMessageCommand(
  text: string,
  options?: ManualReimbursementImportMessageCommandOptions,
): ManualReimbursementImportMessageCommand | null {
  const lines = normalizeMessageLineBreaks(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0 || lines[0] !== COMMAND_HEADER) {
    return null;
  }

  const parsed: Partial<ManualReimbursementImportMessageCommand> = {
    note: "",
  };

  for (const line of lines.slice(1)) {
    const match = line.match(/^([^:：]+)\s*[:：]\s*([\s\S]+)$/);

    if (!match) {
      throw new Error(`Invalid line: ${line}`);
    }

    const key = SUPPORTED_KEYS.get(normalizeKey(match[1]));

    if (!key) {
      throw new Error(`Unsupported field: ${match[1].trim()}`);
    }

    const value = match[2].trim();

    if (!value) {
      throw new Error(`Empty value for field: ${match[1].trim()}`);
    }

    if (key === "amount") {
      parsed.amount = parseAmount(value);
      continue;
    }

    if (key === "expenseCategory") {
      parsed.expenseCategory = parseCategory(value);
      continue;
    }

    if (key === "sentAt") {
      parsed.sentAt = parseSentAt(value);
      continue;
    }

    parsed[key] = value;
  }

  const channelCode = parsed.channelCode ?? options?.defaultChannelCode?.trim();

  if (!channelCode) {
    throw new Error("Missing field: channel_code");
  }

  if (!parsed.reporter) {
    throw new Error("Missing field: reporter");
  }

  if (parsed.amount === undefined) {
    throw new Error("Missing field: amount");
  }

  if (!parsed.expenseCategory) {
    throw new Error("Missing field: category");
  }

  return {
    amount: parsed.amount,
    channelCode,
    expenseCategory: parsed.expenseCategory,
    note: parsed.note ?? "",
    reporter: parsed.reporter,
    sentAt: parsed.sentAt,
  };
}
