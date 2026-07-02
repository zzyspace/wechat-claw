import { getDatabasePath } from "../storage/database.js";
import {
  getReimbursementExpenseCategoryLabel,
  normalizeReimbursementExpenseCategory,
} from "../../scenarios/reimbursement/categories.js";
import type { ManualReimbursementImportResult } from "../../scenarios/reimbursement/manual-import.js";
import type { ReimbursementExpenseCategory } from "../../scenarios/reimbursement/types.js";

const DEFAULT_TIME_ZONE = "Asia/Shanghai";

export interface ManualReimbursementImportCliOptions {
  amount: number;
  channelCode: string;
  expenseCategory: ReimbursementExpenseCategory;
  note: string;
  reporter: string;
  sentAt: string;
}

export function buildManualReimbursementImportUsageText() {
  return [
    "Usage:",
    "  npm run reimbursement:manual-import -- --channel-code <code> --reporter <name> --amount <number> --category <code-or-alias> [--note <text>] [--sent-at <iso-datetime>]",
    "",
    "Options:",
    "  --channel-code <code>   Reimbursement channel code, for example reimbursement_fuzzy",
    "  --reporter <name>       Reporter name stored in the reimbursement record",
    "  --amount <number>       Reimbursement amount; negative numbers are allowed",
    "  --category <value>      Expense category code or alias, for example food / 食材 / other",
    "  --note <text>           Optional note stored on the reimbursement record",
    "  --sent-at <datetime>    Optional source message time, recommended ISO 8601 with timezone",
    "  -h, --help              Show this help text",
    "",
    "Examples:",
    "  npm run reimbursement:manual-import -- --channel-code reimbursement_fuzzy --reporter 张三 --amount 36.5 --category 食材 --note 午餐报账",
    "  npm run reimbursement:manual-import -- --channel-code reimbursement_fuzzy --reporter 张三 --amount 36.5 --category food --sent-at 2026-07-02T14:32:00+08:00",
  ].join("\n");
}

function parseRequiredStringArg(argv: string[], index: number, arg: string) {
  const value = argv[index + 1]?.trim();

  if (!value) {
    throw new Error(`Missing value for ${arg}`);
  }

  return value;
}

function parseAmount(value: string) {
  const amount = Number(value);

  if (!Number.isFinite(amount)) {
    throw new Error(`Invalid --amount value: ${value}`);
  }

  return amount;
}

function parseSentAt(value: string) {
  const date = new Date(value);

  if (!Number.isFinite(date.getTime())) {
    throw new Error(`Invalid --sent-at value: ${value}`);
  }

  return date.toISOString();
}

function parseExpenseCategory(value: string) {
  const normalized = normalizeReimbursementExpenseCategory(value);

  if (!normalized) {
    throw new Error(`Invalid --category value: ${value}`);
  }

  return normalized;
}

export function parseManualReimbursementImportCliArgs(
  argv: string[],
  input?: { now?: Date },
): ManualReimbursementImportCliOptions {
  let amount: number | undefined;
  let channelCode: string | undefined;
  let expenseCategory: ReimbursementExpenseCategory | undefined;
  let note = "";
  let reporter: string | undefined;
  let sentAt = (input?.now ?? new Date()).toISOString();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--channel-code") {
      channelCode = parseRequiredStringArg(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--reporter") {
      reporter = parseRequiredStringArg(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--amount") {
      amount = parseAmount(parseRequiredStringArg(argv, index, arg));
      index += 1;
      continue;
    }

    if (arg === "--category") {
      expenseCategory = parseExpenseCategory(parseRequiredStringArg(argv, index, arg));
      index += 1;
      continue;
    }

    if (arg === "--note") {
      note = parseRequiredStringArg(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--sent-at") {
      sentAt = parseSentAt(parseRequiredStringArg(argv, index, arg));
      index += 1;
      continue;
    }

    if (arg === "-h" || arg === "--help") {
      throw new Error(buildManualReimbursementImportUsageText());
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!channelCode) {
    throw new Error("Missing required argument: --channel-code");
  }

  if (!reporter) {
    throw new Error("Missing required argument: --reporter");
  }

  if (amount === undefined) {
    throw new Error("Missing required argument: --amount");
  }

  if (!expenseCategory) {
    throw new Error("Missing required argument: --category");
  }

  return {
    amount,
    channelCode,
    expenseCategory,
    note,
    reporter,
    sentAt,
  };
}

function formatOptionalText(value: string) {
  return value.trim() || "(空)";
}

export function renderManualReimbursementImportResult(
  result: ManualReimbursementImportResult,
  input: {
    amount: number;
    channelCode: string;
    channelName: string;
    expenseCategory: ReimbursementExpenseCategory;
    reporter: string;
    sentAt: string;
    timeZone?: string;
  },
) {
  const lines = [
    `database=${getDatabasePath()}`,
    "action=manual_imported",
    `channel=${input.channelName} (${input.channelCode})`,
    `reporter=${input.reporter}`,
    `amount=${input.amount.toFixed(2)} CNY`,
    `category=${input.expenseCategory} (${getReimbursementExpenseCategoryLabel(input.expenseCategory)})`,
    `sent_at=${input.sentAt}`,
    `timezone=${input.timeZone ?? DEFAULT_TIME_ZONE}`,
    `report_id=${result.report.id}`,
    `raw_message_id=${result.rawMessageId}`,
    `voucher_date=${result.report.voucherDate}`,
    `note=${formatOptionalText(result.report.note)}`,
    `source_text=${result.textContent}`,
    `extractor=${result.extraction.extractorCode}`,
  ];

  return lines.join("\n");
}
