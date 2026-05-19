import fs from "node:fs";

import type { StoredAttachment } from "../../core/storage/types.js";
import type { LossReportHeuristicResult, LossReportItem } from "./types.js";

export interface LossReportModelExtractionInput {
  rawMessageId: number;
  channelName: string;
  senderName: string;
  textContent: string;
  sentAt: string;
  attachments: StoredAttachment[];
}

export interface LossReportModelProviderConfig {
  enabled: boolean;
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}

function detectEvidenceType(input: LossReportModelExtractionInput): "text" | "image" | "image+text" {
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

function buildFallbackItemsFromText(text: string): LossReportItem[] {
  const match =
    text.match(
      /(?:(?<itemBefore>[\u4e00-\u9fa5A-Za-z0-9]{1,12})\s*)?(?<quantity>\d+(?:\.\d+)?)\s*(?<unit>盒|袋|个|斤|kg|KG|千克|克|包|箱|瓶|份|桶|板|根|只|件|条|盘)\s*(?<itemAfter>[\u4e00-\u9fa5A-Za-z0-9]{1,12})?/,
    ) ?? null;

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
      confidence: 0.72,
    },
  ];
}

function buildDataUrl(attachment: StoredAttachment): string | null {
  if (!attachment.localPath || !fs.existsSync(attachment.localPath)) {
    return null;
  }

  const mimeType = attachment.mimeType || "image/jpeg";
  const bytes = fs.readFileSync(attachment.localPath);
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

function normalizeEvidenceType(input: LossReportModelExtractionInput): "text" | "image" | "image+text" {
  return detectEvidenceType(input);
}

function buildPrompt(input: LossReportModelExtractionInput) {
  return [
    "你是门店报损提取助手。",
    "请根据图片和文字，判断这是否是一条报损上报。",
    "如果是，尽量提取报损物品、数量、单位、原因；如果图片里无法确定数量，不要猜。",
    "如果图片内容与文字说明冲突，优先参考文字说明，不要自行脑补商品名称、生产日期、价格、重量、配方等细节。",
    "上报时间就是本条消息的真实时间，只能使用我提供的上报时间，不要假设当前年份或当前日期。",
    "除非图片里清晰可见且能够确认，否则不要输出生产日期、净含量、电子秤读数、价格等额外信息。",
    "如果文字只写了“变质”“过期”等原因，而图片无法确认具体物品，请保留 is_relevant=true，reason_category 使用文字，items 可以为空数组。",
    "必须返回 JSON，不要输出额外解释。",
    "JSON 字段：is_relevant, reporter_summary, reason_category, notes, items。",
    "items 内字段：name, quantity, unit, confidence。",
    "如果只有图片，也要尽量给出一个简短的物品名称，例如：玻璃杯、电子蜡烛、饼状食物、玻璃状物体。",
    "只有在完全无法识别物品时，才把 items 设为空数组。",
    "reporter_summary 必须是简短名词性描述，不要写完整视觉分析句子。",
    "notes 只保留简短、直接的提取结论，不要写长段分析。",
    `发送人：${input.senderName}`,
    `群聊：${input.channelName}`,
    `上报时间：${input.sentAt}`,
    `文字说明：${input.textContent === "(非文本消息)" ? "无" : input.textContent}`,
  ].join("\n");
}

interface QwenStructuredResponse {
  is_relevant?: boolean;
  reporter_summary?: string;
  reason_category?: string | null;
  notes?: string;
  items?: Array<{
    name?: string | null;
    quantity?: number | null;
    unit?: string | null;
    confidence?: number | null;
  }>;
}

async function callQwenLossExtraction(
  input: LossReportModelExtractionInput,
  config: LossReportModelProviderConfig,
): Promise<QwenStructuredResponse | null> {
  const firstAttachment = input.attachments[0];
  const imageDataUrl = firstAttachment ? buildDataUrl(firstAttachment) : null;

  const content: Array<Record<string, unknown>> = [
    {
      type: "text",
      text: buildPrompt(input),
    },
  ];

  if (imageDataUrl) {
    content.push({
      type: "image_url",
      image_url: {
        url: imageDataUrl,
      },
    });
  }

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        {
          role: "user",
          content,
        },
      ],
      response_format: {
        type: "json_object",
      },
      temperature: 0.1,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Qwen request failed: ${response.status} ${errorText}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string;
      };
    }>;
  };

  const messageContent = payload.choices?.[0]?.message?.content;

  if (!messageContent) {
    return null;
  }

  return JSON.parse(messageContent) as QwenStructuredResponse;
}

export async function extractLossReportByModel(
  input: LossReportModelExtractionInput,
  config: LossReportModelProviderConfig,
): Promise<LossReportHeuristicResult | null> {
  if (!config.enabled || !config.provider || !config.model || !config.apiKey) {
    return null;
  }

  if (input.attachments.length === 0) {
    return null;
  }

  const firstImagePath = input.attachments[0]?.localPath;
  const imageExists = firstImagePath ? fs.existsSync(firstImagePath) : false;
  const evidenceType = detectEvidenceType(input);
  const notes = input.textContent === "(非文本消息)" ? "" : input.textContent;
  const fallbackItems = buildFallbackItemsFromText(notes);

  if (config.provider !== "qwen") {
    return {
      scenarioCode: "loss-report",
      extractorCode: `model-${config.provider}-${config.model}`,
      status: "extracted",
      confidence: imageExists ? 0.7 : 0.55,
      needsReview: true,
      resultJson: {
        eventType: "loss_report",
        rawMessageId: input.rawMessageId,
        channelName: input.channelName,
        reporter: input.senderName,
        reportedAt: input.sentAt,
        isRelevant: true,
        evidenceType,
        reporterSummary: imageExists ? "图片报损待模型识别确认" : "文本报损待模型识别确认",
        reasonCategory: null,
        notes,
        items: fallbackItems,
      },
    };
  }

  const result = await callQwenLossExtraction(input, config);
  const normalizedItems =
    result?.items?.map((item) => ({
      name: item.name ?? null,
      quantity: typeof item.quantity === "number" ? item.quantity : null,
      unit: item.unit ?? null,
      confidence: typeof item.confidence === "number" ? item.confidence : 0.7,
    })) ?? fallbackItems;
  const reporterSummary =
    result?.reporter_summary ??
    (normalizedItems.length > 0
      ? normalizedItems.map((item) => `${item.name ?? "未识别物品"}${item.quantity !== null ? ` ${item.quantity}${item.unit ?? ""}` : ""}`).join("；")
      : "未识别具体物品");
  const completedItems =
    normalizedItems.length > 0 ? normalizedItems : inferFallbackItemFromSummary(reporterSummary);

  const relevant = result?.is_relevant ?? (imageExists || normalizedItems.length > 0);
  const hasHumanText = input.textContent !== "(非文本消息)" && input.textContent.trim().length > 0;

  return {
    scenarioCode: "loss-report",
    extractorCode: `model-${config.provider}-${config.model}`,
    status: relevant ? "extracted" : "ignored",
    confidence: completedItems.length > 0 ? 0.84 : imageExists ? 0.68 : 0.55,
    needsReview: completedItems.length === 0 || imageExists,
    resultJson: {
      eventType: "loss_report",
      rawMessageId: input.rawMessageId,
      channelName: input.channelName,
      reporter: input.senderName,
      reportedAt: input.sentAt,
      isRelevant: relevant,
      evidenceType: normalizeEvidenceType(input),
      reporterSummary,
      reasonCategory: result?.reason_category ?? null,
      notes: normalizeModelNotes(result?.notes, hasHumanText ? notes : ""),
      items: completedItems,
    },
  };
}

function normalizeModelNotes(modelNotes: string | undefined, fallbackNotes: string) {
  if (!fallbackNotes) {
    return "";
  }

  if (!modelNotes) {
    return fallbackNotes;
  }

  const compact = modelNotes.replace(/\s+/g, " ").trim();

  if (isModelAnalysisNote(compact)) {
    return fallbackNotes;
  }

  return compact.length > 120 ? compact.slice(0, 120) : compact;
}

function isModelAnalysisNote(text: string) {
  return (
    text.includes("图片显示") ||
    text.includes("文字说明为") ||
    text.includes("未见明确") ||
    text.includes("结合上报场景") ||
    text.includes("无法提取") ||
    text.includes("无法确认")
  );
}

function inferFallbackItemFromSummary(summary: string): LossReportItem[] {
  const simplifiedName = extractSimpleThingName(summary);

  if (!simplifiedName) {
    return [];
  }

  return [
    {
      name: simplifiedName,
      quantity: null,
      unit: null,
      confidence: 0.6,
    },
  ];
}

function extractSimpleThingName(summary: string) {
  const directMatches = [
    /玻璃杯/,
    /电子蜡烛/,
    /玻璃状物体/,
    /饼状食物/,
    /红色刷子/,
    /扫帚/,
    /蟹/,
  ];

  for (const pattern of directMatches) {
    const match = summary.match(pattern);
    if (match?.[0]) {
      return match[0];
    }
  }

  const nounPatterns = [
    /一块([^，。；]+)/,
    /一份([^，。；]+)/,
    /一个([^，。；]+)/,
    /一支([^，。；]+)/,
    /一把([^，。；]+)/,
  ];

  for (const pattern of nounPatterns) {
    const match = summary.match(pattern);
    if (match?.[1]) {
      return match[1]
        .replace(/严重烧焦的?/, "")
        .replace(/有明显裂纹的?/, "")
        .replace(/有泡沫残留的?/, "")
        .replace(/白色的?/, "")
        .replace(/透明的?/, "")
        .trim();
    }
  }

  return "";
}
