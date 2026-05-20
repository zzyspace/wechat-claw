import type { StoredAttachment } from "../../core/storage/types.js";

export interface LossReportHeuristicInput {
  rawMessageId: number;
  channelName: string;
  senderName: string;
  messageType: string;
  textContent: string;
  sentAt: string;
  attachments: StoredAttachment[];
}

export interface LossReportItem {
  name: string | null;
  quantity: number | null;
  unit: string | null;
  confidence: number;
}

export interface LossReportHeuristicResult {
  scenarioCode: "loss-report";
  extractorCode: string;
  status: "extracted" | "ignored";
  confidence: number;
  needsReview: boolean;
  resultJson: {
    eventType: "loss_report";
    rawMessageId: number;
    channelName: string;
    reporter: string;
    reportedAt: string;
    isRelevant: boolean;
    evidenceType: "text" | "image" | "image+text";
    reporterSummary: string;
    reasonCategory: string | null;
    notes: string;
    items: LossReportItem[];
  };
}

export interface LossReporterDailySummaryItem {
  rawMessageId: number;
  rawMessageIds?: number[];
  channelCode?: string;
  channelName?: string;
  reportedAt: string;
  eventReceivedAt?: string;
  evidenceType: "text" | "image" | "image+text";
  reporterSummary?: string;
  sourceTexts?: string[];
  notes: string;
  reasonCategory: string | null;
  items: LossReportItem[];
  needsReview: boolean;
}

export interface LossReporterDailySummary {
  reporter: string;
  messageCount: number;
  reportItems: LossReporterDailySummaryItem[];
}

export interface LossDailySummary {
  date: string;
  channelCode?: string;
  channelName?: string;
  totalRelevantMessages: number;
  totalReporters: number;
  totalNeedsReview: number;
  reporters: LossReporterDailySummary[];
}
