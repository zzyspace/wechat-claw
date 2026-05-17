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
  extractorCode: "heuristic-v1";
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
    reasonCategory: string | null;
    notes: string;
    items: LossReportItem[];
  };
}
