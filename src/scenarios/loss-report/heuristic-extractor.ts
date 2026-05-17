import type { LossReportHeuristicInput, LossReportHeuristicResult, LossReportItem } from "./types.js";

const LOSS_KEYWORDS = [
  "报损",
  "损耗",
  "变质",
  "过期",
  "坏了",
  "坏掉",
  "发霉",
  "打翻",
  "破损",
  "丢弃",
  "处理掉",
];

const REASON_RULES: Array<{ category: string; keywords: string[] }> = [
  { category: "变质", keywords: ["变质", "发霉", "坏了", "坏掉", "发黑"] },
  { category: "过期", keywords: ["过期", "临期"] },
  { category: "包装破损", keywords: ["破损", "漏", "包装坏", "胀包"] },
  { category: "操作失误", keywords: ["打翻", "掉地上", "做错", "操作失误"] },
  { category: "品质异常", keywords: ["品质", "异物", "异味", "不新鲜"] },
];

const QUANTITY_UNIT_PATTERN =
  /(?:(?<itemBefore>[\u4e00-\u9fa5A-Za-z0-9]{1,12})\s*)?(?<quantity>\d+(?:\.\d+)?)\s*(?<unit>盒|袋|个|斤|kg|KG|千克|克|包|箱|瓶|份|桶|板|根|只|件|条|盘)\s*(?<itemAfter>[\u4e00-\u9fa5A-Za-z0-9]{1,12})?/;

function detectEvidenceType(input: LossReportHeuristicInput): "text" | "image" | "image+text" {
  const hasImage = input.attachments.length > 0;
  const hasText = input.textContent !== "(非文本消息)" && input.textContent.trim().length > 0;

  if (hasImage && hasText) {
    return "image+text";
  }

  if (hasImage) {
    return "image";
  }

  return "text";
}

function detectReasonCategory(text: string): string | null {
  for (const rule of REASON_RULES) {
    if (rule.keywords.some((keyword) => text.includes(keyword))) {
      return rule.category;
    }
  }

  return null;
}

function extractItems(text: string): LossReportItem[] {
  const match = text.match(QUANTITY_UNIT_PATTERN);

  if (!match?.groups) {
    return [];
  }

  const quantity = Number(match.groups.quantity);
  const unit = match.groups.unit ?? null;
  const item = (match.groups.itemBefore || match.groups.itemAfter || "").trim() || null;

  return [
    {
      name: item,
      quantity: Number.isFinite(quantity) ? quantity : null,
      unit,
      confidence: item && unit ? 0.82 : 0.65,
    },
  ];
}

function isLikelyRelevant(input: LossReportHeuristicInput, notes: string) {
  if (input.attachments.length > 0) {
    return true;
  }

  if (LOSS_KEYWORDS.some((keyword) => notes.includes(keyword))) {
    return true;
  }

  return extractItems(notes).length > 0;
}

export function extractLossReportHeuristically(
  input: LossReportHeuristicInput,
): LossReportHeuristicResult {
  const notes = input.textContent === "(非文本消息)" ? "" : input.textContent;
  const evidenceType = detectEvidenceType(input);
  const reasonCategory = detectReasonCategory(notes);
  const items = extractItems(notes);
  const relevant = isLikelyRelevant(input, notes);

  if (!relevant) {
    return {
      scenarioCode: "loss-report",
      extractorCode: "heuristic-v1",
      status: "ignored",
      confidence: 0.2,
      needsReview: false,
      resultJson: {
        eventType: "loss_report",
        rawMessageId: input.rawMessageId,
        channelName: input.channelName,
        reporter: input.senderName,
        reportedAt: input.sentAt,
        isRelevant: false,
        evidenceType,
        reasonCategory: null,
        notes,
        items: [],
      },
    };
  }

  const needsReview = input.attachments.length > 0 || !reasonCategory || items.length === 0;
  const confidence = items.length > 0 && reasonCategory ? 0.85 : input.attachments.length > 0 ? 0.62 : 0.68;

  return {
    scenarioCode: "loss-report",
    extractorCode: "heuristic-v1",
    status: "extracted",
    confidence,
    needsReview,
    resultJson: {
      eventType: "loss_report",
      rawMessageId: input.rawMessageId,
      channelName: input.channelName,
      reporter: input.senderName,
      reportedAt: input.sentAt,
      isRelevant: true,
      evidenceType,
      reasonCategory,
      notes,
      items,
    },
  };
}
