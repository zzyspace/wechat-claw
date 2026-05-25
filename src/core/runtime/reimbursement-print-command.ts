import { getDatabasePath } from "../storage/database.js";
import { getReimbursementExpenseCategoryLabel } from "../../scenarios/reimbursement/categories.js";
import type { ReimbursementReportDetail } from "../../scenarios/reimbursement/types.js";
import { getZonedDateParts } from "./timezone.js";

const DEFAULT_LIMIT = 50;
const DEFAULT_TIME_ZONE = "Asia/Shanghai";

export interface PrintReimbursementCliOptions {
  channelCode?: string;
  limit?: number;
  timeZone?: string;
}

export function buildPrintReimbursementUsageText() {
  return [
    "Usage:",
    "  npm run inspect:reimbursements -- [--channel <code>] [--limit <N>]",
    "",
    "Options:",
    "  --channel <code>    Only print reimbursement reports for the given channel code",
    "  --limit <N>         Only print the latest N reimbursement reports",
    "  -h, --help          Show this help text",
    "",
    `Defaults: prints all reports; omit --limit to remove the cap, or use --limit ${DEFAULT_LIMIT} for a lighter view.`,
  ].join("\n");
}

export function parsePrintReimbursementCliArgs(argv: string[]): PrintReimbursementCliOptions {
  const options: PrintReimbursementCliOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--channel") {
      const value = argv[index + 1];

      if (!value) {
        throw new Error("Missing value for --channel");
      }

      options.channelCode = value.trim();
      index += 1;
      continue;
    }

    if (arg === "--limit") {
      const value = argv[index + 1];

      if (!value) {
        throw new Error("Missing value for --limit");
      }

      const limit = Number(value);

      if (!Number.isFinite(limit) || limit <= 0) {
        throw new Error(`Invalid --limit value: ${value}`);
      }

      options.limit = limit;
      index += 1;
      continue;
    }

    if (arg === "-h" || arg === "--help") {
      throw new Error(buildPrintReimbursementUsageText());
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function formatAmount(report: ReimbursementReportDetail) {
  if (report.amount === null) {
    return "待复核";
  }

  return `${report.amount.toFixed(2)} ${report.currency}`;
}

function formatOptional(value: string | null | undefined) {
  return value && value.trim().length > 0 ? value : "(空)";
}

function formatYesNo(value: boolean) {
  return value ? "是" : "否";
}

function compactText(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized || "(空)";
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function parseUtcDatabaseTimestamp(value: string) {
  const normalized = value.trim().replace(" ", "T");
  const withZone = /(?:Z|[+-]\d{2}:\d{2})$/.test(normalized) ? normalized : `${normalized}Z`;
  const date = new Date(withZone);

  if (!Number.isFinite(date.getTime())) {
    return null;
  }

  return date;
}

function formatRuntimeTimestamp(value: string, timeZone: string) {
  const date = parseUtcDatabaseTimestamp(value);

  if (!date) {
    return `${value} (${timeZone})`;
  }

  const parts = getZonedDateParts(date, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)} (${timeZone})`;
}

export function renderReimbursementReportList(
  reports: ReimbursementReportDetail[],
  options?: PrintReimbursementCliOptions,
) {
  const timeZone = options?.timeZone ?? DEFAULT_TIME_ZONE;
  const lines = [
    `database=${getDatabasePath()}`,
    `channel_code=${options?.channelCode ?? "(all)"}`,
    `limit=${options?.limit ?? "(all)"}`,
    `timezone=${timeZone}`,
    `reports=${reports.length}`,
  ];

  if (reports.length === 0) {
    lines.push("status=empty");
    return lines.join("\n");
  }

  for (const report of reports) {
    lines.push("----");
    lines.push(`报账ID: ${report.id}`);
    lines.push(`群聊: ${report.channelName}${report.channelCode ? ` (${report.channelCode})` : ""}`);
    lines.push(`报账人: ${report.reporter}`);
    lines.push(`金额: ${formatAmount(report)}`);
    lines.push(`类别: ${getReimbursementExpenseCategoryLabel(report.expenseCategory)}`);
    lines.push(`票据日期: ${report.voucherDate} (${report.voucherDateSource})`);
    lines.push(`凭证类型: ${formatOptional(report.voucherType)}`);
    lines.push(`商户: ${formatOptional(report.merchant)}`);
    lines.push(`单号: ${formatOptional(report.documentNo)}`);
    lines.push(`证据: ${report.evidenceType}`);
    lines.push(`备注: ${formatOptional(report.note)}`);
    lines.push(`OCR: ${formatOptional(report.ocrText)}`);
    lines.push(`置信度: ${report.confidence.toFixed(2)}`);
    lines.push(`需复核: ${formatYesNo(report.needsReview)}`);
    lines.push(`创建时间: ${formatRuntimeTimestamp(report.createdAt, timeZone)}`);
    lines.push(`更新时间: ${formatRuntimeTimestamp(report.updatedAt, timeZone)}`);
    lines.push(`来源消息数: ${report.sources.length}`);

    for (const source of report.sources) {
      lines.push(
        `  - [${source.role}] raw_message_id=${source.rawMessageId} sender=${source.senderName} received_at=${source.eventReceivedAt}`,
      );
      lines.push(`    external_id=${source.messageExternalId}`);
      lines.push(`    text=${compactText(source.textContent)}`);
    }
  }

  return lines.join("\n");
}

export { DEFAULT_LIMIT };
