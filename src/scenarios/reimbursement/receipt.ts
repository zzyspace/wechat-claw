import { getReimbursementExpenseCategoryLabel } from "./categories.js";

export const REIMBURSEMENT_RECEIPT_PENDING_TEXT = "此次报账待核验";

export function formatReimbursementReceiptAmount(amount: number) {
  return amount.toFixed(2).replace(/\.?0+$/, "");
}

export function buildReimbursementReceiptText(report: {
  amount: number | null;
  expenseCategory?: string | null;
  merchant?: string | null;
  ocrText?: string | null;
}) {
  if (report.amount === null) {
    return `${REIMBURSEMENT_RECEIPT_PENDING_TEXT}${buildPendingReceiptSuffix(report)}`;
  }

  return `报账${formatReimbursementReceiptAmount(report.amount)}元已录入${buildRecordedReceiptSuffix(report)}`;
}

function buildPendingReceiptSuffix(report: {
  merchant?: string | null;
  ocrText?: string | null;
}) {
  const merchant = normalizeReceiptSummaryText(report.merchant);

  if (merchant) {
    return `(商户: ${merchant})`;
  }

  const ocrText = normalizeReceiptSummaryText(report.ocrText);

  if (ocrText) {
    return `(OCR: ${ocrText})`;
  }

  return "";
}

function buildRecordedReceiptSuffix(report: {
  expenseCategory?: string | null;
}) {
  const expenseCategory = normalizeReceiptSummaryText(
    report.expenseCategory ? getReimbursementExpenseCategoryLabel(report.expenseCategory) : null,
  );

  return expenseCategory ? `(分类: ${expenseCategory})` : "";
}

function normalizeReceiptSummaryText(value: string | null | undefined) {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized ? normalized : null;
}
