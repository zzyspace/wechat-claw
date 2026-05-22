import fs from "node:fs";

import type { Logger } from "../../core/logging/logger.js";
import { formatZonedDate } from "../../core/runtime/timezone.js";
import type { StoredAttachment } from "../../core/storage/types.js";
import type {
  ReimbursementEvidenceType,
  ReimbursementExpenseCategory,
  ReimbursementExtractionInput,
  ReimbursementExtractionResult,
  ReimbursementVoucherDateSource,
} from "./types.js";

export interface ReimbursementModelProviderConfig {
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}

interface ModelStructuredResponse {
  amount?: number | string | null;
  currency?: string | null;
  expense_category?: string | null;
  voucher_date?: string | null;
  merchant?: string | null;
  document_no?: string | null;
  voucher_type?: string | null;
  ocr_text?: string | null;
  confidence?: number | null;
}

const FOOD_KEYWORDS = [
  "食材",
  "原料",
  "采购",
  "蔬菜",
  "水果",
  "肉",
  "牛肉",
  "猪肉",
  "鸡",
  "鸭",
  "鱼",
  "虾",
  "米",
  "面",
  "油",
  "调料",
  "酱",
  "菜",
  "蛋",
  "奶",
  "豆腐",
  "火锅",
];

function detectEvidenceType(input: ReimbursementExtractionInput): ReimbursementEvidenceType {
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

function getMessageVoucherDate(input: ReimbursementExtractionInput): string {
  return formatZonedDate(new Date(input.sentAt), input.timeZone);
}

function normalizeText(text: string): string {
  return text === "(非文本消息)" ? "" : text.trim();
}

function normalizeCurrency(currency: string | null | undefined): string {
  const value = (currency ?? "").trim().toUpperCase();

  if (!value || value === "人民币" || value === "RMB" || value === "￥" || value === "¥") {
    return "CNY";
  }

  return value;
}

function normalizeAmount(value: number | string | null | undefined): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.replace(/[,，]/g, "").match(/\d+(?:\.\d+)?/)?.[0];
  const amount = normalized ? Number(normalized) : Number.NaN;

  return Number.isFinite(amount) ? amount : null;
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized ? normalized : null;
}

function normalizeExpenseCategory(value: string | null | undefined, fallbackText: string): ReimbursementExpenseCategory {
  const normalized = (value ?? "").trim().toLowerCase();

  if (normalized === "food" || normalized === "食材") {
    return "food";
  }

  if (normalized === "other" || normalized === "其他") {
    return "other";
  }

  return detectExpenseCategoryFromText(fallbackText);
}

function normalizeVoucherDate(
  value: string | null | undefined,
  messageVoucherDate: string,
): {
  voucherDate: string;
  voucherDateSource: ReimbursementVoucherDateSource;
} {
  const normalized = value?.trim();

  if (normalized && /^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return {
      voucherDate: normalized,
      voucherDateSource: "model",
    };
  }

  return {
    voucherDate: messageVoucherDate,
    voucherDateSource: "message",
  };
}

export function detectExpenseCategoryFromText(text: string): ReimbursementExpenseCategory {
  return FOOD_KEYWORDS.some((keyword) => text.includes(keyword)) ? "food" : "other";
}

export function extractAmountFromText(text: string): number | null {
  const normalized = text.replace(/[,，]/g, "");
  const patterns = [
    /(?:￥|¥|人民币|RMB|CNY)\s*(\d+(?:\.\d{1,2})?)/i,
    /(\d+(?:\.\d{1,2})?)\s*(?:元|块|RMB|CNY)/i,
    /(?:金额|合计|总计|实付|支付|付款|报账|报销)[:：]?\s*(\d+(?:\.\d{1,2})?)/,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    const amount = match?.[1] ? Number(match[1]) : Number.NaN;

    if (Number.isFinite(amount)) {
      return amount;
    }
  }

  return null;
}

function buildDataUrl(attachment: StoredAttachment): string | null {
  if (!attachment.localPath || !fs.existsSync(attachment.localPath)) {
    return null;
  }

  const mimeType = attachment.mimeType || "image/jpeg";
  const bytes = fs.readFileSync(attachment.localPath);
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

function buildPrompt(input: ReimbursementExtractionInput): string {
  return [
    "你是门店报账图片理解与金额提取助手。",
    "这条消息来自报账群，图片通常是订单截图、微信付款截图、账单照片、发票、小票或手写单据。",
    "你的首要任务是分析图中实际付款的总金额，也就是这笔交易最终真实支付出去的总金额。",
    "图片里可能同时出现商品单价、原价、优惠、折扣、退款、运费、服务费、应付、实付、已优惠、待支付等多个数字，必须优先识别最终实际付款总金额。",
    "如果图中存在“实付”“已支付”“支付成功金额”“总计”“合计”“微信支付金额”等候选值，优先选择最能表示最终付款完成金额的那个数字。",
    "外卖或商城订单页如果有多个商品、套餐或明细金额，但页面没有明确总金额，应把每个商品或明细的实际价格加总，得到最终付款总金额。",
    "微信聊天界面的转账截图如果包含多条转账记录，应把每条转账的金额加起来，得到最终付款总金额。",
    "支付宝聊天界面的转账或代付截图如果包含多条记录，应把每条转账或代付的金额加起来，得到最终付款总金额。",
    "不要把商品单价、数量、优惠前金额、退款金额、待支付金额、账户余额、积分抵扣、手续费等误当成最终付款总金额。",
    "请只根据图片和文字提取报账字段，不要猜测不可见信息。",
    "支出类别只能输出 food 或 other。明确是食品原料、门店食材采购才输出 food；非食材或不确定都输出 other。",
    "如果票据日期清晰可见，voucher_date 输出 YYYY-MM-DD；看不到日期则输出 null。",
    "如果无法可靠判断最终付款总金额，amount 输出 null，不要猜测。",
    "必须返回 JSON，不要输出额外解释。",
    "JSON 字段：amount, currency, expense_category, voucher_date, merchant, document_no, voucher_type, ocr_text, confidence。",
    "currency 默认 CNY；confidence 是 0 到 1 的数字。",
    `报账人：${input.reporter}`,
    `群聊：${input.channelName}`,
    `消息时间：${input.sentAt}`,
    `文字备注：${normalizeText(input.textContent) || "无"}`,
  ].join("\n");
}

async function callQwenReimbursementExtraction(
  input: ReimbursementExtractionInput,
  config: ReimbursementModelProviderConfig,
): Promise<ModelStructuredResponse | null> {
  const firstAttachment = input.attachments[0];
  const imageDataUrl = firstAttachment ? buildDataUrl(firstAttachment) : null;

  if (!imageDataUrl) {
    return null;
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
          content: [
            {
              type: "text",
              text: buildPrompt(input),
            },
            {
              type: "image_url",
              image_url: {
                url: imageDataUrl,
              },
            },
          ],
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
    throw new Error(`Qwen reimbursement request failed: ${response.status} ${errorText}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string;
      };
    }>;
  };
  const messageContent = payload.choices?.[0]?.message?.content;

  return messageContent ? (JSON.parse(messageContent) as ModelStructuredResponse) : null;
}

function buildFallbackExtraction(input: ReimbursementExtractionInput): ReimbursementExtractionResult {
  const note = normalizeText(input.textContent);
  const amount = extractAmountFromText(note);
  const evidenceType = detectEvidenceType(input);
  const voucherDate = getMessageVoucherDate(input);
  const expenseCategory = detectExpenseCategoryFromText(note);

  return {
    scenarioCode: "reimbursement",
    extractorCode: "heuristic-v1",
    status: "extracted",
    confidence: amount === null ? 0.45 : 0.72,
    needsReview: amount === null,
    resultJson: {
      eventType: "reimbursement_report",
      rawMessageId: input.rawMessageId,
      channelName: input.channelName,
      reporter: input.reporter,
      reportedAt: input.sentAt,
      amount,
      currency: "CNY",
      expenseCategory,
      voucherDate,
      voucherDateSource: "message",
      note,
      evidenceType,
      merchant: null,
      documentNo: null,
      voucherType: null,
      ocrText: null,
    },
  };
}

export async function extractReimbursementReport(
  input: ReimbursementExtractionInput,
  config: ReimbursementModelProviderConfig,
  logger?: Logger,
): Promise<ReimbursementExtractionResult> {
  if (!input.attachments.length || !config.provider || !config.model || !config.apiKey) {
    logger?.info("Reimbursement extraction fell back to heuristic", {
      attachmentCount: input.attachments.length,
      channelCode: input.channelCode ?? "(empty)",
      provider: config.provider ?? "(empty)",
      model: config.model ?? "(empty)",
      rawMessageId: input.rawMessageId,
      reason: !input.attachments.length
        ? "no_attachments"
        : !config.provider
          ? "provider_missing"
          : !config.model
            ? "model_missing"
            : "api_key_missing",
      reporter: input.reporter,
    });
    return buildFallbackExtraction(input);
  }

  const note = normalizeText(input.textContent);
  const messageVoucherDate = getMessageVoucherDate(input);

  try {
    logger?.info("Calling reimbursement model extraction", {
      attachmentCount: input.attachments.length,
      channelCode: input.channelCode ?? "(empty)",
      model: config.model,
      provider: config.provider,
      rawMessageId: input.rawMessageId,
      reporter: input.reporter,
    });
    const modelResult =
      config.provider === "qwen" ? await callQwenReimbursementExtraction(input, config) : null;

    if (!modelResult) {
      logger?.info("Reimbursement model returned no structured result, using heuristic fallback", {
        channelCode: input.channelCode ?? "(empty)",
        model: config.model,
        provider: config.provider,
        rawMessageId: input.rawMessageId,
        reporter: input.reporter,
      });
      return buildFallbackExtraction(input);
    }

    const amount = normalizeAmount(modelResult.amount);
    const { voucherDate, voucherDateSource } = normalizeVoucherDate(
      modelResult.voucher_date,
      messageVoucherDate,
    );
    const expenseCategory = normalizeExpenseCategory(
      modelResult.expense_category,
      `${note}\n${modelResult.ocr_text ?? ""}`,
    );
    const confidence =
      typeof modelResult.confidence === "number" && Number.isFinite(modelResult.confidence)
        ? Math.max(0, Math.min(1, modelResult.confidence))
        : amount === null
          ? 0.55
          : 0.82;

    const result: ReimbursementExtractionResult = {
      scenarioCode: "reimbursement",
      extractorCode: `model-${config.provider}-${config.model}`,
      status: "extracted",
      confidence,
      needsReview: amount === null,
      resultJson: {
        eventType: "reimbursement_report",
        rawMessageId: input.rawMessageId,
        channelName: input.channelName,
        reporter: input.reporter,
        reportedAt: input.sentAt,
        amount,
        currency: normalizeCurrency(modelResult.currency),
        expenseCategory,
        voucherDate,
        voucherDateSource,
        note,
        evidenceType: detectEvidenceType(input),
        merchant: normalizeOptionalText(modelResult.merchant),
        documentNo: normalizeOptionalText(modelResult.document_no),
        voucherType: normalizeOptionalText(modelResult.voucher_type),
        ocrText: normalizeOptionalText(modelResult.ocr_text),
      },
    };

    logger?.info("Reimbursement model extraction completed", {
      amount: result.resultJson.amount,
      attachmentCount: input.attachments.length,
      channelCode: input.channelCode ?? "(empty)",
      confidence: result.confidence,
      evidenceType: result.resultJson.evidenceType,
      expenseCategory: result.resultJson.expenseCategory,
      extractorCode: result.extractorCode,
      needsReview: result.needsReview,
      rawMessageId: input.rawMessageId,
      reporter: input.reporter,
      voucherDate: result.resultJson.voucherDate,
      voucherDateSource: result.resultJson.voucherDateSource,
    });

    return result;
  } catch {
    const fallback = buildFallbackExtraction(input);

    logger?.warn("Reimbursement model extraction failed, using heuristic fallback", {
      attachmentCount: input.attachments.length,
      channelCode: input.channelCode ?? "(empty)",
      model: config.model,
      provider: config.provider,
      rawMessageId: input.rawMessageId,
      reporter: input.reporter,
    });

    return {
      ...fallback,
      extractorCode: `model-${config.provider}-${config.model}-fallback`,
      confidence: Math.min(fallback.confidence, 0.55),
      needsReview: true,
    };
  }
}
