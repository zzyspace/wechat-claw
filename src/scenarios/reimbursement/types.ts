import type { StoredAttachment } from "../../core/storage/types.js";

export type ReimbursementEvidenceType = "text" | "image" | "image+text";
export type ReimbursementExpenseCategory = "food" | "other";
export type ReimbursementReceiptTargetType = "contact_name" | "room_topic";
export type ReimbursementVoucherDateSource = "model" | "message";
export type ReimbursementSourceRole = "primary" | "remark";

export interface ReimbursementExtractionInput {
  rawMessageId: number;
  channelCode?: string;
  channelName: string;
  reporter: string;
  textContent: string;
  sentAt: string;
  timeZone: string;
  attachments: StoredAttachment[];
}

export interface ReimbursementExtractionResultJson {
  eventType: "reimbursement_report";
  rawMessageId: number;
  channelName: string;
  reporter: string;
  reportedAt: string;
  amount: number | null;
  currency: string;
  expenseCategory: ReimbursementExpenseCategory;
  voucherDate: string;
  voucherDateSource: ReimbursementVoucherDateSource;
  note: string;
  evidenceType: ReimbursementEvidenceType;
  merchant: string | null;
  documentNo: string | null;
  voucherType: string | null;
  ocrText: string | null;
}

export interface ReimbursementExtractionResult {
  scenarioCode: "reimbursement";
  extractorCode: string;
  status: "extracted";
  confidence: number;
  needsReview: boolean;
  resultJson: ReimbursementExtractionResultJson;
}

export interface ReimbursementReportInput {
  channelCode?: string;
  channelName: string;
  reporter: string;
  amount: number | null;
  currency: string;
  expenseCategory: ReimbursementExpenseCategory;
  voucherDate: string;
  voucherDateSource: ReimbursementVoucherDateSource;
  note: string;
  evidenceType: ReimbursementEvidenceType;
  merchant: string | null;
  documentNo: string | null;
  voucherType: string | null;
  ocrText: string | null;
  confidence: number;
  needsReview: boolean;
  primaryRawMessageId: number;
  timeZone?: string;
  referenceDateTime?: string;
}

export interface ReimbursementReportRecord {
  id: number;
  channelCode?: string;
  channelName: string;
  reporter: string;
  amount: number | null;
  currency: string;
  expenseCategory: ReimbursementExpenseCategory;
  voucherDate: string;
  voucherDateSource: ReimbursementVoucherDateSource;
  note: string;
  evidenceType: ReimbursementEvidenceType;
  merchant: string | null;
  documentNo: string | null;
  voucherType: string | null;
  ocrText: string | null;
  confidence: number;
  needsReview: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ReimbursementReportSourceRecord {
  id: number;
  reimbursementReportId: number;
  rawMessageId: number;
  role: ReimbursementSourceRole;
  createdAt: string;
}

export interface ReimbursementReportSourceDetail extends ReimbursementReportSourceRecord {
  eventReceivedAt: string;
  messageExternalId: string;
  senderName: string;
  textContent: string;
}

export interface ReimbursementReportDetail extends ReimbursementReportRecord {
  sources: ReimbursementReportSourceDetail[];
}

export interface ReimbursementReceiptDeliveryRecord {
  id: number;
  reimbursementReportId: number;
  channelCode?: string;
  targetType: ReimbursementReceiptTargetType;
  targetValue: string;
  receiptText: string;
  sentAt: string;
  rawMessageId?: number;
  createdAt: string;
  updatedAt: string;
}
