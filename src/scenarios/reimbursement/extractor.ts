import fs from "node:fs";

import { ProxyAgent, type Dispatcher } from "undici";

import type { Logger } from "../../core/logging/logger.js";
import { formatZonedDate } from "../../core/runtime/timezone.js";
import type { StoredAttachment } from "../../core/storage/types.js";
import {
  DEFAULT_REIMBURSEMENT_EXPENSE_CATEGORY,
  normalizeReimbursementExpenseCategory,
} from "./categories.js";
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
  retryModel?: string;
  apiKey?: string;
  baseUrl?: string;
  proxyUrl?: string;
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

interface ChatCompletionPayload {
  id?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: unknown;
    };
  }>;
}

interface ReimbursementModelAttemptResult {
  emptyStructuredResult: boolean;
  modelResult: ModelStructuredResponse | null;
  responseSummary?: Record<string, unknown>;
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

const FLOWER_KEYWORDS = ["鲜花", "花卉", "绿植", "花材", "花束", "菊花", "百合"];

const PLANNED_EXPENSE_OCR_NAME = "李晨晨";
const PLANNED_EXPENSE_OCR_MIN_OCCURRENCES = 3;
const MANAGER_REIMBURSEMENT_OCR_MARKERS = ["店长报账群"];
const EMPTY_STRUCTURED_RESULT_MAX_RETRIES = 1;
const DEFAULT_QWEN_EMPTY_STRUCTURED_RESULT_RETRY_MODEL = "qwen3.5-plus";
const MODEL_RESPONSE_PREVIEW_LIMIT = 240;
const openAiProxyDispatchers = new Map<string, Dispatcher>();

function resolveOpenAiProxyDispatcher(
  provider: string,
  proxyUrl: string | undefined,
): Dispatcher | undefined {
  const normalizedProxyUrl = proxyUrl?.trim();

  if (provider !== "openai" || !normalizedProxyUrl) {
    return undefined;
  }

  const cachedDispatcher = openAiProxyDispatchers.get(normalizedProxyUrl);

  if (cachedDispatcher) {
    return cachedDispatcher;
  }

  const dispatcher = new ProxyAgent(normalizedProxyUrl);
  openAiProxyDispatchers.set(normalizedProxyUrl, dispatcher);
  return dispatcher;
}

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
  const normalized = normalizeReimbursementExpenseCategory(value);

  if (normalized) {
    return normalized;
  }

  return detectExpenseCategoryFromText(fallbackText);
}

function shouldForceManagerReimbursementFromOcr(ocrText: string | null | undefined): boolean {
  return Boolean(
    ocrText && MANAGER_REIMBURSEMENT_OCR_MARKERS.some((marker) => ocrText.includes(marker)),
  );
}

function countOccurrences(text: string, needle: string): number {
  if (!text || !needle) {
    return 0;
  }

  return text.split(needle).length - 1;
}

function resolveForcedExpenseCategoryFromOcr(
  ocrText: string | null | undefined,
): ReimbursementExpenseCategory | null {
  if (!ocrText) {
    return null;
  }

  if (countOccurrences(ocrText, PLANNED_EXPENSE_OCR_NAME) >= PLANNED_EXPENSE_OCR_MIN_OCCURRENCES) {
    return "planned_expense";
  }

  if (shouldForceManagerReimbursementFromOcr(ocrText)) {
    return "manager_reimbursement";
  }

  return null;
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
  if (FLOWER_KEYWORDS.some((keyword) => text.includes(keyword))) {
    return "flower";
  }

  if (FOOD_KEYWORDS.some((keyword) => text.includes(keyword))) {
    return "food";
  }

  return DEFAULT_REIMBURSEMENT_EXPENSE_CATEGORY;
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
    "对于订单截图里的“总预算”金额，如果图中没有比它更明确的最终付款金额，也应把它作为最终付款总金额候选值。",
    "外卖或商城订单页如果有多个商品、套餐或明细金额，但页面没有明确总金额，应把每个商品或明细的实际价格加总，得到最终付款总金额。",
    "外卖或商城的订单列表截图如果同时展示多笔已完成订单，应把每笔完整可见订单的“实付”金额相加，得到最终付款总金额；被截图截断且看不到实付金额的订单不计入。",
    "微信聊天界面的转账截图如果包含多条转账记录，应把每条转账的金额加起来，得到最终付款总金额。",
    "支付宝聊天界面的转账或代付截图如果包含多条记录，应把每条转账或代付的金额加起来，得到最终付款总金额。",
    "只有当前交易状态明确显示“退款成功”“已退款”“退款到账”或“退回成功”时，amount 才返回负数；金额前的负号可能只是银行表示消费支出的记账符号，不能单独作为退款依据，如果同时显示“支付成功”“付款成功”“消费”或“扣款”，amount 应返回实际支出金额的绝对值；“可退款”“申请退款”“扫码退款”“支持退款”“退款入口”等按钮、操作入口或功能说明不表示本笔交易已经退款，必须忽略。",
    "不要把商品单价、数量、优惠前金额、退款金额、待支付金额、账户余额、积分抵扣、手续费等误当成最终付款总金额。",
    "请只根据图片和文字提取报账字段，不要猜测不可见信息。",
    "支出类别优先输出已知 code。当前常用 code 包括 food、flower、salary、rent、utilities、manager_reimbursement、planned_expense、other。",
    "无论是否满足其他类别条件，只要明确包含“店长报账”字样一律输出 manager_reimbursement；否则，如果报账图片中的商品是鲜花、花卉、绿植、花材、花束、菊花、百合等花卉类型，或报账图片中出现“宏程下单号”字样，一律输出 flower；如果报账图片中出现“金辉”或“刘以琼”字样，或商户名称包含“泉州市丰泽区喜相逢百货商行”，一律输出 food；明确是食品原料、门店食材采购也输出 food；明确是工资、薪资输出 salary；明确是房租、租金输出 rent；明确是水费、电费、水电费、水费账单、电费账单、电力缴费输出 utilities；非上述或不确定输出 other。",
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

function truncatePreview(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();

  if (!normalized) {
    return "";
  }

  if (normalized.length <= MODEL_RESPONSE_PREVIEW_LIMIT) {
    return normalized;
  }

  return `${normalized.slice(0, MODEL_RESPONSE_PREVIEW_LIMIT - 3)}...`;
}

function summarizeMessageContent(content: unknown): Record<string, unknown> {
  if (typeof content === "string") {
    const preview = truncatePreview(content);

    return {
      messageContentLength: content.length,
      messageContentPreview: preview || undefined,
      messageContentType: "string",
    };
  }

  if (Array.isArray(content)) {
    const preview = truncatePreview(JSON.stringify(content));

    return {
      messageContentItemCount: content.length,
      messageContentPreview: preview || undefined,
      messageContentType: "array",
    };
  }

  if (content === null) {
    return {
      messageContentType: "null",
    };
  }

  if (content === undefined) {
    return {
      messageContentType: "undefined",
    };
  }

  const preview = truncatePreview(JSON.stringify(content));

  return {
    messageContentPreview: preview || undefined,
    messageContentType: typeof content,
  };
}

function summarizeChatCompletionPayload(payload: ChatCompletionPayload): Record<string, unknown> {
  const firstChoice = payload.choices?.[0];

  return {
    choiceCount: payload.choices?.length ?? 0,
    finishReason: firstChoice?.finish_reason ?? null,
    responseId: payload.id,
    usageCompletionTokens: payload.usage?.completion_tokens,
    usagePromptTokens: payload.usage?.prompt_tokens,
    usageTotalTokens: payload.usage?.total_tokens,
    ...summarizeMessageContent(firstChoice?.message?.content),
  };
}

function resolveRetryModel(
  configuredRetryModel: string | undefined,
  provider: string,
  baseModel: string,
): string {
  const configured = configuredRetryModel?.trim();

  if (configured) {
    return configured;
  }

  return provider === "qwen"
    ? DEFAULT_QWEN_EMPTY_STRUCTURED_RESULT_RETRY_MODEL
    : baseModel;
}

function resolveAttemptModel(baseModel: string, retryModel: string, attempt: number): string {
  return attempt <= 1 ? baseModel : retryModel;
}

async function callChatCompletionReimbursementExtraction(
  input: ReimbursementExtractionInput,
  config: ReimbursementModelProviderConfig,
  provider: "openai" | "qwen",
): Promise<ReimbursementModelAttemptResult> {
  const firstAttachment = input.attachments[0];
  const imageDataUrl = firstAttachment ? buildDataUrl(firstAttachment) : null;

  if (!imageDataUrl) {
    return {
      emptyStructuredResult: false,
      modelResult: null,
      responseSummary: {
        attachmentLocalPath: firstAttachment?.localPath,
        reason: "image_data_unavailable",
      },
    };
  }

  const baseUrl = config.baseUrl?.replace(/\/+$/, "");

  if (!baseUrl) {
    throw new Error(`Reimbursement ${provider} base URL is missing`);
  }

  const requestBody = {
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
    ...(provider === "openai"
      ? {
          reasoning_effort: "none",
        }
      : {
          temperature: 0.1,
        }),
  };
  const dispatcher = resolveOpenAiProxyDispatcher(provider, config.proxyUrl);
  const requestInit: RequestInit & { dispatcher?: Dispatcher } = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(requestBody),
  };

  if (dispatcher) {
    requestInit.dispatcher = dispatcher;
  }

  const response = await fetch(`${baseUrl}/chat/completions`, requestInit);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Reimbursement ${provider} request failed: ${response.status} ${errorText}`);
  }

  const payload = (await response.json()) as ChatCompletionPayload;
  const messageContent = payload.choices?.[0]?.message?.content;
  const responseSummary = summarizeChatCompletionPayload(payload);

  if (typeof messageContent !== "string") {
    return {
      emptyStructuredResult: messageContent == null,
      modelResult: null,
      responseSummary,
    };
  }

  const trimmedContent = messageContent.trim();

  if (!trimmedContent) {
    return {
      emptyStructuredResult: true,
      modelResult: null,
      responseSummary,
    };
  }

  return {
    emptyStructuredResult: false,
    modelResult: JSON.parse(trimmedContent) as ModelStructuredResponse,
    responseSummary,
  };
}

function callReimbursementModel(
  input: ReimbursementExtractionInput,
  config: ReimbursementModelProviderConfig,
): Promise<ReimbursementModelAttemptResult> {
  const provider = config.provider?.trim().toLowerCase();

  if (provider === "openai" || provider === "qwen") {
    return callChatCompletionReimbursementExtraction(input, config, provider);
  }

  throw new Error(`Unsupported reimbursement extraction provider: ${config.provider}`);
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
  const provider = config.provider.trim().toLowerCase();
  const retryModel = resolveRetryModel(config.retryModel, provider, config.model);

  try {
    let attempt = 0;
    let effectiveModel = config.model;
    let modelResult: ModelStructuredResponse | null = null;

    while (attempt <= EMPTY_STRUCTURED_RESULT_MAX_RETRIES) {
      attempt += 1;
      effectiveModel = resolveAttemptModel(config.model, retryModel, attempt);
      logger?.info("Calling reimbursement model extraction", {
        attachmentCount: input.attachments.length,
        attempt,
        channelCode: input.channelCode ?? "(empty)",
        model: effectiveModel,
        provider,
        rawMessageId: input.rawMessageId,
        reporter: input.reporter,
      });
      let attemptResult: ReimbursementModelAttemptResult;

      try {
        attemptResult = await callReimbursementModel(input, {
          ...config,
          provider,
          model: effectiveModel,
        });
      } catch (error) {
        if (attempt <= EMPTY_STRUCTURED_RESULT_MAX_RETRIES) {
          logger?.warn("Reimbursement model extraction failed, retrying once", {
            attempt,
            attachmentCount: input.attachments.length,
            channelCode: input.channelCode ?? "(empty)",
            error,
            model: effectiveModel,
            provider,
            rawMessageId: input.rawMessageId,
            reporter: input.reporter,
            retryModel,
          });
          continue;
        }

        throw error;
      }
      modelResult = attemptResult.modelResult;

      if (modelResult) {
        break;
      }

      if (attemptResult.emptyStructuredResult && attempt <= EMPTY_STRUCTURED_RESULT_MAX_RETRIES) {
        logger?.warn("Reimbursement model returned empty structured result, retrying once", {
          attempt,
          channelCode: input.channelCode ?? "(empty)",
          model: effectiveModel,
          provider,
          rawMessageId: input.rawMessageId,
          reporter: input.reporter,
          retryModel,
          ...attemptResult.responseSummary,
        });
        continue;
      }

      logger?.warn("Reimbursement model returned no structured result, using heuristic fallback", {
        attempt,
        channelCode: input.channelCode ?? "(empty)",
        model: effectiveModel,
        provider,
        rawMessageId: input.rawMessageId,
        reporter: input.reporter,
        ...attemptResult.responseSummary,
      });
      return buildFallbackExtraction(input);
    }

    if (!modelResult) {
      return buildFallbackExtraction(input);
    }

    const amount = normalizeAmount(modelResult.amount);
    const { voucherDate, voucherDateSource } = normalizeVoucherDate(
      modelResult.voucher_date,
      messageVoucherDate,
    );
    const normalizedOcrText = normalizeOptionalText(modelResult.ocr_text);
    const forcedExpenseCategory = resolveForcedExpenseCategoryFromOcr(normalizedOcrText);
    const expenseCategory = forcedExpenseCategory
      ? forcedExpenseCategory
      : normalizeExpenseCategory(modelResult.expense_category, `${note}\n${normalizedOcrText ?? ""}`);
    const confidence =
      typeof modelResult.confidence === "number" && Number.isFinite(modelResult.confidence)
        ? Math.max(0, Math.min(1, modelResult.confidence))
        : amount === null
          ? 0.55
          : 0.82;

    const result: ReimbursementExtractionResult = {
      scenarioCode: "reimbursement",
      extractorCode: `model-${provider}-${effectiveModel}`,
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
        ocrText: normalizedOcrText,
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
      model: effectiveModel,
      needsReview: result.needsReview,
      rawMessageId: input.rawMessageId,
      reporter: input.reporter,
      voucherDate: result.resultJson.voucherDate,
      voucherDateSource: result.resultJson.voucherDateSource,
    });

    return result;
  } catch (error) {
    const fallback = buildFallbackExtraction(input);

    logger?.warn("Reimbursement model extraction failed, using heuristic fallback", {
      attachmentCount: input.attachments.length,
      channelCode: input.channelCode ?? "(empty)",
      error,
      model: config.model,
      provider,
      rawMessageId: input.rawMessageId,
      reporter: input.reporter,
    });

    return {
      ...fallback,
      extractorCode: `model-${provider}-${config.model}-fallback`,
      confidence: Math.min(fallback.confidence, 0.55),
      needsReview: true,
    };
  }
}
