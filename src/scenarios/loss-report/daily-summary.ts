import type { ScenarioExtractionRecord } from "../../core/scenarios/scenario-extraction-repository.js";
import type { LossDailySummary, LossReporterDailySummary, LossReporterDailySummaryItem } from "./types.js";

interface ExtractionRow {
  channelCode?: string;
  channelName: string;
  senderName: string;
  textContent: string;
  eventReceivedAt: string;
  extraction: ScenarioExtractionRecord;
}

interface DraftGroup {
  rawMessageIds: number[];
  channelCode?: string;
  channelName: string;
  reportedAt: string;
  eventReceivedAt: string;
  evidenceType: "text" | "image" | "image+text";
  reporterSummary?: string;
  sourceTexts: string[];
  notes: string;
  reasonCategory: string | null;
  items: LossReporterDailySummaryItem["items"];
  needsReview: boolean;
  hasRelevantContent: boolean;
}

function isRelevantLossExtraction(row: ExtractionRow) {
  const result = row.extraction.resultJson as { isRelevant?: boolean } | null;
  return row.extraction.scenarioCode === "loss-report" && result?.isRelevant === true;
}

export function buildLossDailySummary(date: string, rows: ExtractionRow[]): LossDailySummary {
  return buildLossDailySummaryWithMergeWindow(date, rows, 60);
}

export function buildLossDailySummaryWithMergeWindow(
  date: string,
  rows: ExtractionRow[],
  mergeWindowSeconds: number,
): LossDailySummary {
  const sortedRows = [...rows].sort((a, b) => {
    if ((a.channelCode ?? a.channelName) !== (b.channelCode ?? b.channelName)) {
      return (a.channelCode ?? a.channelName).localeCompare(b.channelCode ?? b.channelName);
    }

    if (a.senderName !== b.senderName) {
      return a.senderName.localeCompare(b.senderName);
    }

    return new Date(a.eventReceivedAt).getTime() - new Date(b.eventReceivedAt).getTime();
  });
  const reporterMap = new Map<string, LossReporterDailySummary & { currentDraft?: DraftGroup; lastGroupEventReceivedAt?: string }>();
  const mergeWindowMs = mergeWindowSeconds * 1000;

  for (const row of sortedRows) {
    const relevant = isRelevantLossExtraction(row);
    const result = row.extraction.resultJson as {
      rawMessageId: number;
      reportedAt: string;
      evidenceType: "text" | "image" | "image+text";
      reporterSummary?: string;
      notes: string;
      reasonCategory: string | null;
      items: LossReporterDailySummaryItem["items"];
    };

    const reporter = row.senderName;
    const reporterKey = `${row.channelCode ?? row.channelName}::${reporter}`;
    const existing =
      reporterMap.get(reporterKey) ??
      ({
        reporter,
        messageCount: 0,
        reportItems: [],
      } satisfies LossReporterDailySummary);

    const currentTime = new Date(row.eventReceivedAt).getTime();
    const lastTime =
      existing.lastGroupEventReceivedAt ? new Date(existing.lastGroupEventReceivedAt).getTime() : null;
    const shouldMerge =
      existing.currentDraft !== undefined &&
      lastTime !== null &&
      Math.abs(currentTime - lastTime) <= mergeWindowMs &&
      canMergeDraft(existing.currentDraft, row, result);

    if (shouldMerge && existing.currentDraft) {
      mergeRowIntoDraft(existing.currentDraft, row, result, relevant);
      existing.lastGroupEventReceivedAt = row.eventReceivedAt;
    } else {
      finalizeDraft(existing);
      existing.currentDraft = createDraftFromRow(row, result, relevant);
      existing.lastGroupEventReceivedAt = row.eventReceivedAt;
    }

    reporterMap.set(reporterKey, existing);
  }

  for (const reporter of reporterMap.values()) {
    finalizeDraft(reporter);
  }

  const reporters = Array.from(reporterMap.values())
    .map((reporter) => ({
      reporter: reporter.reporter,
      messageCount: reporter.reportItems.length,
      reportItems: reporter.reportItems,
    }))
    .filter((reporter) => reporter.reportItems.length > 0)
    .sort((a, b) => b.messageCount - a.messageCount);
  const totalNeedsReview = reporters.reduce(
    (count, reporter) => count + reporter.reportItems.filter((item) => item.needsReview).length,
    0,
  );

  return {
    date,
    channelCode: rows[0]?.channelCode,
    channelName: rows[0]?.channelName,
    totalRelevantMessages: reporters.reduce((count, reporter) => count + reporter.reportItems.length, 0),
    totalReporters: reporters.length,
    totalNeedsReview,
    reporters,
  };
}

function createDraftFromRow(
  row: ExtractionRow,
  result: {
    rawMessageId: number;
    reportedAt: string;
    evidenceType: "text" | "image" | "image+text";
    reporterSummary?: string;
    notes: string;
    reasonCategory: string | null;
    items: LossReporterDailySummaryItem["items"];
  },
  relevant: boolean,
): DraftGroup {
  return {
    rawMessageIds: [result.rawMessageId],
    channelCode: row.channelCode,
    channelName: row.channelName,
    reportedAt: result.reportedAt,
    eventReceivedAt: row.eventReceivedAt,
    evidenceType: result.evidenceType,
    reporterSummary: result.reporterSummary,
    sourceTexts: mergeSourceTexts([], row.textContent),
    notes: result.notes,
    reasonCategory: result.reasonCategory,
    items: result.items,
    needsReview: row.extraction.needsReview,
    hasRelevantContent: relevant,
  };
}

function mergeRowIntoDraft(
  draft: DraftGroup,
  row: ExtractionRow,
  result: {
    rawMessageId: number;
    reportedAt: string;
    evidenceType: "text" | "image" | "image+text";
    reporterSummary?: string;
    notes: string;
    reasonCategory: string | null;
    items: LossReporterDailySummaryItem["items"];
  },
  relevant: boolean,
) {
  draft.rawMessageIds.push(result.rawMessageId);
  draft.eventReceivedAt = row.eventReceivedAt;
  draft.sourceTexts = mergeSourceTexts(draft.sourceTexts, row.textContent);
  draft.needsReview = draft.needsReview || row.extraction.needsReview;

  if (!relevant) {
    return;
  }

  draft.hasRelevantContent = true;
  draft.evidenceType = mergeEvidenceType(draft.evidenceType, result.evidenceType);
  draft.notes = mergeNotes(draft.notes, result.notes);
  draft.reasonCategory = mergeReasonCategory(draft.reasonCategory, result.reasonCategory);
  draft.reporterSummary = mergeReporterSummary(draft.reporterSummary, result.reporterSummary);
  draft.items = mergeItems(draft.items, result.items);
}

function canMergeDraft(
  draft: DraftGroup,
  row: ExtractionRow,
  result: {
    evidenceType: "text" | "image" | "image+text";
  },
) {
  if ((draft.channelCode ?? draft.channelName) !== (row.channelCode ?? row.channelName)) {
    return false;
  }

  const draftAlreadyHasImage = draft.evidenceType === "image" || draft.evidenceType === "image+text";
  const currentIsImage = result.evidenceType === "image" || result.evidenceType === "image+text";

  if (draftAlreadyHasImage && currentIsImage) {
    return false;
  }

  return true;
}

function finalizeDraft(
  reporter: LossReporterDailySummary & { currentDraft?: DraftGroup },
) {
  const draft = reporter.currentDraft;

  if (!draft) {
    return;
  }

  if (draft.hasRelevantContent) {
    reporter.reportItems.push({
      rawMessageId: draft.rawMessageIds[0],
      rawMessageIds: draft.rawMessageIds,
      channelCode: draft.channelCode,
      channelName: draft.channelName,
      reportedAt: draft.reportedAt,
      eventReceivedAt: draft.eventReceivedAt,
      evidenceType: draft.evidenceType,
      reporterSummary: draft.reporterSummary,
      sourceTexts: draft.sourceTexts,
      notes: draft.notes,
      reasonCategory: draft.reasonCategory,
      items: draft.items,
      needsReview: draft.needsReview,
    });
  }

  reporter.currentDraft = undefined;
}

function canMergeEvidence(
  left: "text" | "image" | "image+text",
  right: "text" | "image" | "image+text",
) {
  if (left === "image+text" || right === "image+text") {
    return true;
  }

  return left !== right;
}

function mergeEvidenceType(
  left: "text" | "image" | "image+text",
  right: "text" | "image" | "image+text",
): "text" | "image" | "image+text" {
  if (left === right) {
    return left;
  }

  return "image+text";
}

function mergeNotes(left: string, right: string) {
  if (!left) {
    return right;
  }

  if (!right || left === right) {
    return left;
  }

  if (isSimpleHumanReason(left) && isModelAnalysis(right)) {
    return left;
  }

  if (isSimpleHumanReason(right) && isModelAnalysis(left)) {
    return right;
  }

  return `${left}；${right}`;
}

function mergeReasonCategory(left: string | null, right: string | null) {
  if (!left) {
    return right;
  }

  if (!right) {
    return left;
  }

  if (left === right) {
    return left;
  }

  const priorityOrder = ["变质", "过期", "包装破损", "操作失误", "品质异常"];

  for (const candidate of priorityOrder) {
    if (left === candidate || right === candidate) {
      return candidate;
    }
  }

  return left;
}

function isSimpleHumanReason(text: string) {
  const compact = text.trim();
  return compact.length > 0 && compact.length <= 8;
}

function isModelAnalysis(text: string) {
  return (
    text.includes("图片显示") ||
    text.includes("文字说明为") ||
    text.includes("无法提取") ||
    text.includes("无法确认") ||
    text.includes("结合上报场景")
  );
}

function mergeItems(
  left: LossReporterDailySummaryItem["items"],
  right: LossReporterDailySummaryItem["items"],
) {
  if (left.length === 0) {
    return right;
  }

  if (right.length === 0) {
    return left;
  }

  const merged = [...left];

  for (const item of right) {
    const duplicate = merged.find(
      (existing) =>
        existing.name === item.name &&
        existing.quantity === item.quantity &&
        existing.unit === item.unit,
    );

    if (!duplicate) {
      merged.push(item);
    }
  }

  return merged;
}

function mergeReporterSummary(left: string | undefined, right: string | undefined) {
  if (!left) {
    return right;
  }

  if (!right || left === right) {
    return left;
  }

  return left.length >= right.length ? left : right;
}

function mergeSourceTexts(existing: string[] | undefined, textContent: string) {
  const next = [...(existing ?? [])];
  const normalized = textContent.trim();

  if (!hasMeaningfulSourceText(normalized)) {
    return next;
  }

  if (!next.includes(normalized)) {
    next.push(normalized);
  }

  return next;
}

function hasMeaningfulSourceText(textContent: string) {
  const normalized = textContent.trim();
  return Boolean(normalized && normalized !== "(非文本消息)");
}

export function renderLossDailySummaryText(summary: LossDailySummary, promptTemplate: string): string {
  const header = [
    `报损日报（${summary.date}）`,
    summary.channelName ? `群聊：${summary.channelName}` : "",
    "",
    `总计 ${summary.totalReporters} 人上报，${summary.totalRelevantMessages} 条相关记录。`,
    "",
  ];

  const reporterLines = summary.reporters.flatMap((reporter) => {
    const lines = [`${reporter.reporter}：`];

    for (const item of reporter.reportItems) {
      const itemText =
        item.items.length > 0
          ? item.items
              .map((entry) => {
                const quantityText = entry.quantity !== null ? `${entry.quantity}${entry.unit ?? ""}` : "";
                return `${entry.name ?? "未识别物品"}${quantityText ? ` ${quantityText}` : ""}`;
              })
              .join("；")
          : simplifyReporterSummary(item.reporterSummary, item.reasonCategory);

      const displayReason = buildDisplayReason(item);
      const channelPrefix = !summary.channelName && item.channelName ? `[${item.channelName}] ` : "";
      const reasonSuffix = displayReason ? `；原因：${displayReason}` : "";
      lines.push(`- ${channelPrefix}${itemText}${reasonSuffix}`);
    }

    return lines;
  });

  return [promptTemplate, "", ...header, ...reporterLines].join("\n");
}

function preferReasonCategory(reasonCategory: string | null, notes: string) {
  if (reasonCategory && isSimpleHumanReason(reasonCategory)) {
    return reasonCategory;
  }

  return notes;
}

function buildDisplayReason(item: LossReporterDailySummaryItem) {
  const reasonLabel = item.reasonCategory || preferReasonCategory(item.reasonCategory, item.notes) || "未说明";
  const sourceText = chooseSourceText(item.sourceTexts, reasonLabel, item.reporterSummary);

  return sourceText || reasonLabel;
}

function chooseSourceText(sourceTexts: string[] | undefined, fallback: string, reporterSummary?: string) {
  const candidates = (sourceTexts ?? []).filter((text) => text !== "报损");

  if (candidates.length > 0) {
    return candidates.join("；");
  }

  const inferred = inferShortReasonFromSummary(reporterSummary);
  if (inferred) {
    return inferred;
  }

  return fallback || "";
}

function simplifyReporterSummary(reporterSummary: string | undefined, reasonCategory: string | null) {
  if (!reporterSummary) {
    return reasonCategory ? `${reasonCategory}（未识别具体物品）` : "未识别具体物品";
  }

  const directNounPatterns = [
    /破碎的([^，。；]+)/,
    /有泡沫残留的([^，。；]+)/,
    /手持一支([^，。；]+)/,
    /手持一个([^，。；]+)/,
    /手持一块([^，。；]+)/,
    /盘中有一块([^，。；]+)/,
    /盘中有一份([^，。；]+)/,
    /一把([^，。；]+)/,
  ];

  for (const pattern of directNounPatterns) {
    const match = reporterSummary.match(pattern);
    if (match?.[1]) {
      return normalizeThingName(match[1]);
    }
  }

  const patterns = [
    /一块([^，。；]+)/,
    /一份([^，。；]+)/,
    /一个([^，。；]+)/,
    /一只([^，。；]+)/,
    /一盘([^，。；]+)/,
  ];

  for (const pattern of patterns) {
    const match = reporterSummary.match(pattern);
    if (match?.[1]) {
      return normalizeThingName(match[1]);
    }
  }

  if (reporterSummary.includes("玻璃杯")) {
    return "玻璃杯";
  }

  if (reporterSummary.includes("蟹")) {
    return "蟹";
  }

  if (reporterSummary.includes("电子蜡烛")) {
    return "电子蜡烛";
  }

  if (reporterSummary.includes("玻璃状物体")) {
    return "玻璃状物体";
  }

  return reporterSummary;
}

function inferShortReasonFromSummary(reporterSummary: string | undefined) {
  if (!reporterSummary) {
    return "";
  }

  const reasonPatterns = ["严重烧焦", "烧焦", "空的", "破损", "变质", "过期"];

  for (const pattern of reasonPatterns) {
    if (reporterSummary.includes(pattern)) {
      return pattern;
    }
  }

  return "";
}

function normalizeThingName(text: string) {
  return text
    .replace(/，.*$/, "")
    .replace(/置于.*$/, "")
    .replace(/均无法.*$/, "")
    .replace(/疑似.*$/, "")
    .replace(/底部有.*$/, "")
    .replace(/杯口有.*$/, "")
    .replace(/杯底有.*$/, "")
    .replace(/有明显.*$/, "")
    .replace(/带盖的/, "")
    .replace(/透明的?/, "")
    .replace(/白色的?/, "")
    .trim();
}
