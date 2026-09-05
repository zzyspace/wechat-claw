import { createGatewayAuth, gatewayAuthConfig, type GatewayAuthConfig } from "./gateway-auth.js";
import { hasPermission, requirePermission, submissionChannels, canViewResource, reportAccessScope } from "./authorization.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import multer from "multer";

import { getAppConfig, type AppConfig } from "../core/config/env.js";
import {
  getAllowedSubmissionChannelCodes,
  REIMBURSEMENT_SUBMISSION_CHANNEL_LABELS,
  type ReimbursementAccessPrincipal,
} from "../core/config/reimbursement-access.js";
import {
  ADMIN_MANUAL_IMPORT_IMAGE_MIME_TYPES,
  saveUploadedReimbursementImage,
  saveUploadedReimbursementImageFile,
} from "../core/attachments/save-uploaded-image.js";
import { getStateDirPath } from "../core/runtime/state-paths.js";
import { getZonedDateParts, zonedDateTimeToUtc } from "../core/runtime/timezone.js";
import {
  normalizeReimbursementExpenseCategory,
  REIMBURSEMENT_EXPENSE_CATEGORY_DEFINITIONS,
  getReimbursementExpenseCategoryLabel,
} from "../scenarios/reimbursement/categories.js";
import {
  importBatchReimbursementReport,
  REIMBURSEMENT_IMAGE_IMPORT_FALLBACK_TEXT,
  type ReimbursementExtractor,
} from "../scenarios/reimbursement/batch-import.js";
import { processBatchImportTask } from "../scenarios/reimbursement/batch-import-task-processor.js";
import {
  createBatchImportTask,
  getBatchImportTask,
  recoverInterruptedBatchImportTasks,
} from "../scenarios/reimbursement/batch-import-task-repository.js";
import { importManualReimbursementReport } from "../scenarios/reimbursement/manual-import.js";
import {
  deleteReimbursementReport,
  findAdminReimbursementAttachment,
  getAdminReimbursementReportDetail,
  getReimbursementReportByRawMessageId,
  listAdminReimbursementReports,
  ReimbursementFilterValidationError,
  updateAdminReimbursementReport,
  validateReimbursementExpenseCategoryFilter,
  validateReimbursementNoteFilter,
  validateReimbursementReporterFilter,
} from "../scenarios/reimbursement/repository.js";
import { buildReimbursementReceiptText } from "../scenarios/reimbursement/receipt.js";
import { getRawMessageByMessageExternalId } from "../core/storage/raw-message-repository.js";
import {
  createAdminAuthMiddleware,
  createShortcutApiAuthMiddleware,
  getAdminSession,
} from "./auth.js";

const ADMIN_BASE_PATH = "/expense";
const LEGACY_ADMIN_BASE_PATH = "/reimbursement";
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;
const MAX_MANUAL_IMPORT_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_BATCH_IMPORT_IMAGES = 20;
const MAX_BATCH_IMPORT_NOTE_LENGTH = 300;
const MAX_ADMIN_EDIT_NOTE_LENGTH = 1000;
const MAX_SHORTCUT_REPORTER_LENGTH = 100;
const SHORTCUT_API_PATH = `${ADMIN_BASE_PATH}/api/shortcut/reports`;
const SHORTCUT_MESSAGE_TYPE = "shortcut_api";
const IDEMPOTENCY_KEY_PATTERN = /^[\x20-\x7e]{8,256}$/;
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const defaultStaticDir = path.join(currentDir, "public");

class AdminValidationError extends Error {
  field?: string;

  constructor(message: string, field?: string) {
    super(message);
    this.name = "AdminValidationError";
    this.field = field;
  }
}

class AdminConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminConflictError";
  }
}

const manualImportImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_MANUAL_IMPORT_IMAGE_BYTES,
    files: 1,
  },
  fileFilter: (_request, file, callback) => {
    if (!ADMIN_MANUAL_IMPORT_IMAGE_MIME_TYPES.has(file.mimetype)) {
      callback(new AdminValidationError("报账图仅支持 JPG、PNG、WEBP、GIF、HEIC 或 HEIF。", "image"));
      return;
    }

    callback(null, true);
  },
});

function trimString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function isUnifiedSubmissionPage(value: unknown) {
  return trimString(value) === "submit";
}

function parsePositiveInteger(value: unknown, field: string) {
  const normalized = trimString(value);

  if (!/^\d+$/.test(normalized)) {
    throw new AdminValidationError(`${field} 参数无效。`, field);
  }

  const parsed = Number.parseInt(normalized, 10);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new AdminValidationError(`${field} 参数无效。`, field);
  }

  return parsed;
}

function parseDateFilter(value: unknown, field: string) {
  const normalized = trimString(value);

  if (!normalized) {
    return "";
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new AdminValidationError(`${field} 参数无效。`, field);
  }

  return normalized;
}

function parseLimit(value: unknown) {
  const normalized = trimString(value);

  if (!normalized) {
    return DEFAULT_LIMIT;
  }

  const parsed = Number.parseInt(normalized, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new AdminValidationError("limit 参数无效。", "limit");
  }

  return Math.min(parsed, MAX_LIMIT);
}

function parseOffset(value: unknown) {
  const normalized = trimString(value);

  if (!normalized) {
    return 0;
  }

  const parsed = Number.parseInt(normalized, 10);

  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new AdminValidationError("offset 参数无效。", "offset");
  }

  return parsed;
}

function parseExpenseCategory(value: unknown) {
  const normalized = trimString(value);

  if (!normalized || normalized.toLowerCase() === "all") {
    return undefined;
  }

  const category = normalizeReimbursementExpenseCategory(normalized);

  if (!category) {
    throw new AdminValidationError("expenseCategory 参数无效。", "expenseCategory");
  }

  return category;
}

function parseRequiredString(value: unknown, field: string, label: string) {
  const normalized = trimString(value);

  if (!normalized) {
    throw new AdminValidationError(`${label}不能为空。`, field);
  }

  return normalized;
}

function parseShortcutText(value: unknown, input: {
  field: string;
  label: string;
  maxLength: number;
  required?: boolean;
}) {
  const normalized = trimString(value);

  if (input.required && !normalized) {
    throw new AdminValidationError(`${input.label}不能为空。`, input.field);
  }

  if (normalized.length > input.maxLength) {
    throw new AdminValidationError(
      `${input.label}不能超过 ${input.maxLength} 个字符。`,
      input.field,
    );
  }

  return normalized;
}

function parseShortcutIdempotencyKey(value: string | undefined) {
  const normalized = value?.trim() ?? "";

  if (!IDEMPOTENCY_KEY_PATTERN.test(normalized)) {
    throw new AdminValidationError(
      "Idempotency-Key 必须是 8 至 256 个可打印 ASCII 字符。",
      "Idempotency-Key",
    );
  }

  return normalized;
}

function buildShortcutMessageExternalId(idempotencyKey: string) {
  const digest = crypto.createHash("sha256").update(idempotencyKey).digest("hex");
  return `shortcut-reimbursement:${digest}`;
}

function isSameShortcutRequest(
  rawMessage: NonNullable<ReturnType<typeof getRawMessageByMessageExternalId>>,
  input: {
    channelCode: string;
    imageSha256: string;
    note: string;
    reporter: string;
  },
) {
  const expectedText = input.note || REIMBURSEMENT_IMAGE_IMPORT_FALLBACK_TEXT;
  return (
    rawMessage.channelCode === input.channelCode &&
    rawMessage.senderName === input.reporter &&
    rawMessage.textContent === expectedText &&
    rawMessage.attachments.length === 1 &&
    rawMessage.attachments[0]?.type === "image" &&
    rawMessage.attachments[0]?.sha256 === input.imageSha256
  );
}

function buildShortcutReportResponse(input: {
  duplicate: boolean;
  idempotencyKey: string;
  report: NonNullable<ReturnType<typeof getReimbursementReportByRawMessageId>>;
}) {
  return {
    success: true,
    duplicate: input.duplicate,
    requestId: input.idempotencyKey,
    receipt: buildReimbursementReceiptText(input.report),
    report: {
      id: input.report.id,
      amount: input.report.amount,
      currency: input.report.currency,
      expenseCategory: input.report.expenseCategory,
      expenseCategoryLabel: getReimbursementExpenseCategoryLabel(input.report.expenseCategory),
      voucherDate: input.report.voucherDate,
      note: input.report.note,
      needsReview: input.report.needsReview,
    },
  };
}

function parseManualImportAmount(value: unknown) {
  const normalized = trimString(value);
  const amount = Number(normalized);

  if (!normalized || !Number.isFinite(amount) || amount <= 0) {
    throw new AdminValidationError("金额必须是大于 0 的数字。", "amount");
  }

  return amount;
}

function parseAdminEditAmount(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AdminValidationError("金额必须是有效数字。", "amount");
  }

  return value;
}

function hasOwnField(value: unknown, field: string) {
  return Boolean(value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, field));
}

function parseManualImportSentAt(value: unknown, timeZone: string) {
  const normalized = parseRequiredString(value, "sentAt", "报账时间");
  const localMatch = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(normalized);

  if (localMatch) {
    const expected = [
      Number(localMatch[1]),
      Number(localMatch[2]),
      Number(localMatch[3]),
      Number(localMatch[4]),
      Number(localMatch[5]),
      Number(localMatch[6] ?? "0"),
    ];
    const sentAt = zonedDateTimeToUtc(
      expected[0],
      expected[1],
      expected[2],
      expected[3],
      expected[4],
      expected[5],
      timeZone,
    );
    const actual = getZonedDateParts(sentAt, timeZone);

    if (
      actual.year !== expected[0] ||
      actual.month !== expected[1] ||
      actual.day !== expected[2] ||
      actual.hour !== expected[3] ||
      actual.minute !== expected[4] ||
      actual.second !== expected[5]
    ) {
      throw new AdminValidationError("报账时间无效。", "sentAt");
    }

    return sentAt.toISOString();
  }

  const sentAt = new Date(normalized);

  if (!Number.isFinite(sentAt.getTime())) {
    throw new AdminValidationError("报账时间无效。", "sentAt");
  }

  return sentAt.toISOString();
}

function parseBatchImportNotes(value: unknown, imageCount: number) {
  const normalized = trimString(value);

  if (!normalized) {
    return Array.from({ length: imageCount }, () => "");
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(normalized);
  } catch {
    throw new AdminValidationError("图片备注格式无效。", "notesJson");
  }

  if (!Array.isArray(parsed) || parsed.length !== imageCount || parsed.some((note) => typeof note !== "string")) {
    throw new AdminValidationError("图片备注与报账图数量不一致。", "notesJson");
  }

  return parsed.map((note) => {
    const trimmed = note.trim();

    if (trimmed.length > MAX_BATCH_IMPORT_NOTE_LENGTH) {
      throw new AdminValidationError(`每张报账图的备注不能超过 ${MAX_BATCH_IMPORT_NOTE_LENGTH} 个字符。`, "notesJson");
    }

    return trimmed;
  });
}

function buildAttachmentDownloadName(localPath: string) {
  const fileName = path.basename(localPath);
  return fileName || "attachment.bin";
}

function resolveStaticDir(staticDir?: string) {
  return staticDir ?? defaultStaticDir;
}

function parseReportListQuery(query: Record<string, unknown>) {
  const createdDateFrom = parseDateFilter(query.createdDateFrom, "createdDateFrom");
  const createdDateTo = parseDateFilter(query.createdDateTo, "createdDateTo");
  const reporter = trimString(query.reporter);
  const note = trimString(query.note);
  const expenseCategory = trimString(query.expenseCategory);

  if (createdDateFrom && createdDateTo && createdDateFrom > createdDateTo) {
    throw new AdminValidationError("createdDateFrom 不能晚于 createdDateTo。", "createdDateFrom");
  }

  for (const filter of [
    { field: "reporter", value: reporter, validate: validateReimbursementReporterFilter },
    { field: "note", value: note, validate: validateReimbursementNoteFilter },
    {
      field: "expenseCategory",
      value: expenseCategory.toLowerCase() === "all" ? "" : expenseCategory,
      validate: validateReimbursementExpenseCategoryFilter,
    },
  ]) {
    try {
      filter.validate(filter.value);
    } catch (error) {
      if (error instanceof ReimbursementFilterValidationError) {
        throw new AdminValidationError(error.message, filter.field);
      }

      throw error;
    }
  }

  return {
    search: trimString(query.search) || undefined,
    channelCode: trimString(query.channelCode) || undefined,
    reporter: reporter || undefined,
    note: note || undefined,
    expenseCategory:
      expenseCategory && expenseCategory.toLowerCase() !== "all" ? expenseCategory : undefined,
    createdDateFrom: createdDateFrom || undefined,
    createdDateTo: createdDateTo || undefined,
    limit: parseLimit(query.limit),
    offset: parseOffset(query.offset),
  };
}

function sendNotFound(_request: express.Request, response: express.Response) {
  response.status(404).type("text/plain; charset=utf-8").send("Not found");
}

export function createApp(input?: {
  config?: AppConfig;
  reimbursementExtractor?: ReimbursementExtractor;
  staticDir?: string;
  gatewayAuth?: GatewayAuthConfig;
}) {
  const config = input?.config ?? getAppConfig();
  const gateway = input?.gatewayAuth ? gatewayAuthConfig({ ADMIN_AUTH_MODE: input.gatewayAuth.mode,
    ADMIN_AUTH_GATEWAY_URL: input.gatewayAuth.url, ADMIN_AUTH_INTERNAL_TOKEN: input.gatewayAuth.token }) : gatewayAuthConfig();
  if (gateway.mode === "legacy" && config.reimbursementAccountsParseError) {
    throw new Error(config.reimbursementAccountsParseError);
  }
  const staticDir = resolveStaticDir(input?.staticDir);
  const batchUploadTempDir = path.join(getStateDirPath(config), "reimbursement", "batch-upload-temp");
  fs.mkdirSync(batchUploadTempDir, { recursive: true });
  const batchImportImageUpload = multer({
    storage: multer.diskStorage({
      destination: (_request, _file, callback) => callback(null, batchUploadTempDir),
      filename: (_request, _file, callback) => callback(null, crypto.randomUUID()),
    }),
    limits: {
      fileSize: MAX_MANUAL_IMPORT_IMAGE_BYTES,
      files: MAX_BATCH_IMPORT_IMAGES,
    },
    fileFilter: (_request, file, callback) => {
      if (!ADMIN_MANUAL_IMPORT_IMAGE_MIME_TYPES.has(file.mimetype)) {
        callback(new AdminValidationError("报账图仅支持 JPG、PNG、WEBP、GIF、HEIC 或 HEIF。", "images"));
        return;
      }

      callback(null, true);
    },
  });
  const adminAuth = gateway.mode === "unified" ? createGatewayAuth(gateway) : createAdminAuthMiddleware({
    username: config.adminUsername,
    password: config.adminPassword,
    accounts: config.reimbursementAccounts ?? [],
  });
  const shortcutApiAuth = createShortcutApiAuthMiddleware({
    token: config.reimbursementShortcutApiToken,
  });
  const app = express();
  const activeBatchImportTaskIds = new Set<string>();
  const activeShortcutRequestKeys = new Set<string>();
  const batchImportModelConfig = {
    provider: config.reimbursementExtractionProvider,
    model: config.reimbursementExtractionModel,
    retryModel: config.reimbursementExtractionRetryModel,
    apiKey: config.reimbursementExtractionApiKey,
    baseUrl: config.reimbursementExtractionBaseUrl,
    proxyUrl: config.reimbursementOpenAiProxyUrl,
  };

  function scheduleBatchImportTask(jobId: string) {
    if (activeBatchImportTaskIds.has(jobId)) {
      return;
    }

    activeBatchImportTaskIds.add(jobId);
    setImmediate(() => {
      void processBatchImportTask({
        jobId,
        modelConfig: batchImportModelConfig,
      })
        .catch((error) => {
          console.error(`Unexpected batch reimbursement task error (${jobId}):`, error);
        })
        .finally(() => {
          activeBatchImportTaskIds.delete(jobId);
        });
    });
  }

  for (const jobId of recoverInterruptedBatchImportTasks()) {
    scheduleBatchImportTask(jobId);
  }

  async function createBatchReportTask(
    request: express.Request,
    response: express.Response,
    next: express.NextFunction,
    input?: {
      allowedChannelCodes?: ReadonlySet<string>;
      reporter?: string;
      submittedBy?: ReimbursementAccessPrincipal;
    },
  ) {
    const uploadedFiles = Array.isArray(request.files) ? request.files : [];

    try {
      const channelCode = parseRequiredString(request.body?.channelCode, "channelCode", "门店");
      const channel = config.channels.find(
        (item) =>
          item.enabled &&
          item.scenario === "reimbursement" &&
          item.code === channelCode &&
          (!input?.allowedChannelCodes || input.allowedChannelCodes.has(item.code)),
      );

      if (!channel) {
        throw new AdminValidationError("请选择有效的报账门店。", "channelCode");
      }

      const reporter = input?.reporter ??
        parseRequiredString(request.body?.reporter, "reporter", "报账人");
      const sentAt = parseManualImportSentAt(request.body?.sentAt, config.timeZone);

      if (uploadedFiles.length === 0) {
        throw new AdminValidationError("请至少添加一张报账图。", "images");
      }

      const notes = parseBatchImportNotes(request.body?.notesJson, uploadedFiles.length);
      const attachments = uploadedFiles.map((file) =>
        saveUploadedReimbursementImageFile({
          config,
          mimeType: file.mimetype,
          sourcePath: file.path,
        }),
      );
      const task = createBatchImportTask({
        channelCode: channel.code,
        channelName: channel.match.value,
        reporter,
        notes,
        sentAt,
        timeZone: config.timeZone,
        attachments,
        originalNames: uploadedFiles.map((file) => file.originalname),
        submittedBy: input?.submittedBy,
      });

      response.status(202).json({
        success: true,
        task,
      });
      scheduleBatchImportTask(task.id);
    } catch (error) {
      for (const file of uploadedFiles) {
        if (file.path && fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
      }
      next(error);
    }
  }

  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");
  app.use((request, _response, next) => {
    if (
      request.url === LEGACY_ADMIN_BASE_PATH ||
      request.url.startsWith(`${LEGACY_ADMIN_BASE_PATH}/`)
    ) {
      request.url = `${ADMIN_BASE_PATH}${request.url.slice(LEGACY_ADMIN_BASE_PATH.length)}`;
    }
    next();
  });
  app.use(express.json({ limit: "32kb" }));

  app.get(["/health/expense", `${ADMIN_BASE_PATH}/healthz`], (_request, response) => {
    response.status(200).json({ ok: true });
  });

  app.get([`${ADMIN_BASE_PATH}`, `${ADMIN_BASE_PATH}/`], adminAuth, requirePermission("report:view"), (_request, response) => {
    response.sendFile(path.join(staticDir, "admin.html"));
  });

  app.get([`${ADMIN_BASE_PATH}/submit`, `${ADMIN_BASE_PATH}/submit/`], adminAuth, requirePermission("report:submit"), (_request, response) => {
    response.sendFile(path.join(staticDir, "submit.html"));
  });
  app.post(
    SHORTCUT_API_PATH,
    shortcutApiAuth,
    manualImportImageUpload.single("image"),
    async (request, response, next) => {
      let idempotencyKey: string | undefined;
      let ownsActiveShortcutKey = false;

      try {
        idempotencyKey = parseShortcutIdempotencyKey(request.get("Idempotency-Key"));
        const channelCode = parseRequiredString(request.body?.channelCode, "channelCode", "门店");
        const channel = config.channels.find(
          (item) => item.enabled && item.scenario === "reimbursement" && item.code === channelCode,
        );

        if (!channel) {
          throw new AdminValidationError("请选择有效的报账门店。", "channelCode");
        }

        const reporter = parseShortcutText(request.body?.reporter, {
          field: "reporter",
          label: "报账人",
          maxLength: MAX_SHORTCUT_REPORTER_LENGTH,
          required: true,
        });
        const submittedBy = (config.reimbursementAccounts ?? []).find(
          (account) =>
            account.role === "manager" &&
            account.username === reporter &&
            getAllowedSubmissionChannelCodes(account).includes(channel.code),
        );
        const note = parseShortcutText(request.body?.note, {
          field: "note",
          label: "备注",
          maxLength: MAX_BATCH_IMPORT_NOTE_LENGTH,
        });

        if (!request.file) {
          throw new AdminValidationError("请添加一张报账图。", "image");
        }

        const imageSha256 = crypto.createHash("sha256").update(request.file.buffer).digest("hex");
        const messageExternalId = buildShortcutMessageExternalId(idempotencyKey);
        const existingRawMessage = getRawMessageByMessageExternalId(messageExternalId);

        if (
          existingRawMessage &&
          !isSameShortcutRequest(existingRawMessage, {
            channelCode: channel.code,
            imageSha256,
            note,
            reporter,
          })
        ) {
          throw new AdminConflictError("Idempotency-Key 已被另一份报账内容使用。");
        }

        const existingReport = existingRawMessage
          ? getReimbursementReportByRawMessageId(existingRawMessage.id)
          : null;

        if (existingReport) {
          response.status(200).json(
            buildShortcutReportResponse({
              duplicate: true,
              idempotencyKey,
              report: existingReport,
            }),
          );
          return;
        }

        if (activeShortcutRequestKeys.has(idempotencyKey)) {
          throw new AdminConflictError("这份报账正在处理中，请稍后重试。");
        }

        activeShortcutRequestKeys.add(idempotencyKey);
        ownsActiveShortcutKey = true;

        const attachment = existingRawMessage?.attachments[0] ??
          saveUploadedReimbursementImage({
            buffer: request.file.buffer,
            config,
            mimeType: request.file.mimetype,
          });
        const sentAt = existingRawMessage?.eventReceivedAt ?? new Date().toISOString();
        const result = await importBatchReimbursementReport(
          {
            attachment,
            channelCode: channel.code,
            channelName: channel.match.value,
            messageExternalId,
            messageType: SHORTCUT_MESSAGE_TYPE,
            modelConfig: batchImportModelConfig,
            note,
            reporter,
            sentAt,
            source: "shortcut_api",
            submittedByAccountId: submittedBy?.accountId,
            submittedByUsername: submittedBy?.username,
            submittedByRole: submittedBy?.role,
            timeZone: config.timeZone,
          },
          input?.reimbursementExtractor,
        );

        response.status(existingRawMessage ? 200 : 201).json(
          buildShortcutReportResponse({
            duplicate: Boolean(existingRawMessage),
            idempotencyKey,
            report: result.report,
          }),
        );
      } catch (error) {
        next(error);
      } finally {
        if (idempotencyKey && ownsActiveShortcutKey) {
          activeShortcutRequestKeys.delete(idempotencyKey);
        }
      }
    },
  );

  app.use(`${ADMIN_BASE_PATH}/api`, adminAuth);
  const checkReport: express.RequestHandler = (request, response, next) => {
    const session = getAdminSession(response);
    const report = getAdminReimbursementReportDetail(Number(request.params.id));
    if (!session || !report || !canViewResource(session, report)) {
      response.status(404).json({ success: false, error: { message: "报账记录不存在。" } });
      return;
    }
    next();
  };

  app.get(`${ADMIN_BASE_PATH}/api/session`, (_request, response) => {
    const session = getAdminSession(response);

    response.status(200).json({
      success: true,
      ...(session?.authorization ? { authorization: reportAccessScope(session) } : {}),
      account: {
        accountId: session?.accountId,
        managerStores: session?.managerStores,
        username: session?.username,
        role: session?.role,
      },
      permissions: {
        ...(session?.authorization ? {
          canAttachment: hasPermission(session, "attachment:view"),
          canEdit: hasPermission(session, "report:edit"),
          canDelete: hasPermission(session, "report:delete"),
          canImport: hasPermission(session, "report:import"),
        } : {}),
        canWrite: session?.canWrite === true,
        canSubmit: session?.canSubmit === true,
        canViewAllReports: session?.canViewAllReports === true,
      },
    });
  });

  app.get(`${ADMIN_BASE_PATH}/api/submissions/:submissionPage/options`, requirePermission("report:submit"), (request, response) => {
    if (!isUnifiedSubmissionPage(request.params.submissionPage)) {
      response.status(404).json({
        success: false,
        error: { message: "批量报账页面不存在。" },
      });
      return;
    }

    const session = getAdminSession(response);
    if (!session) {
      response.status(401).json({ success: false, error: { message: "需要登录。" } });
      return;
    }
    const configuredChannelCodes = new Set(
      config.channels
        .filter((channel) => channel.enabled && channel.scenario === "reimbursement" &&
          (!getAdminSession(response)?.authorization || submissionChannels(getAdminSession(response)!).includes(channel.code)))
        .map((channel) => channel.code),
    );

    response.status(200).json({
      success: true,
      ...(session?.authorization ? { authorization: reportAccessScope(session) } : {}),
      account: {
        accountId: session.accountId,
        managerStores: session.managerStores,
        username: session?.username,
        role: session.role,
      },
      permissions: {
        ...(session?.authorization ? {
          canAttachment: hasPermission(session, "attachment:view"),
          canEdit: hasPermission(session, "report:edit"),
          canDelete: hasPermission(session, "report:delete"),
          canImport: hasPermission(session, "report:import"),
        } : {}),
        canWrite: session?.canWrite === true,
        canSubmit: session.canSubmit,
      },
      channels: submissionChannels(session)
        .filter((code) => configuredChannelCodes.has(code))
        .map((code) => ({ code, name: REIMBURSEMENT_SUBMISSION_CHANNEL_LABELS.get(code) ?? code })),
      timeZone: config.timeZone,
    });
  });

  app.get(`${ADMIN_BASE_PATH}/api/manual-import-options`, requirePermission("report:import"), (_request, response) => {
    response.status(200).json({
      success: true,
      channels: config.channels
        .filter((channel) => channel.enabled && channel.scenario === "reimbursement" &&
          (!getAdminSession(response)?.authorization || submissionChannels(getAdminSession(response)!).includes(channel.code)))
        .map((channel) => ({
          code: channel.code,
          name: channel.match.value,
        })),
      categories: REIMBURSEMENT_EXPENSE_CATEGORY_DEFINITIONS.map((category) => ({
        code: category.code,
        label: category.label,
      })),
      timeZone: config.timeZone,
    });
  });

  app.post(
    `${ADMIN_BASE_PATH}/api/reports`,
    requirePermission("report:import"),
    manualImportImageUpload.single("image"),
    (request, response, next) => {
      try {
        const channelCode = parseRequiredString(request.body?.channelCode, "channelCode", "门店");
        const channel = config.channels.find(
          (item) => item.enabled && item.scenario === "reimbursement" && item.code === channelCode,
        );

        if (!channel || (getAdminSession(response)?.authorization && !submissionChannels(getAdminSession(response)!).includes(channel.code))) {
          throw new AdminValidationError("请选择有效的报账门店。", "channelCode");
        }

        const expenseCategory = parseExpenseCategory(request.body?.expenseCategory);

        if (!expenseCategory) {
          throw new AdminValidationError("请选择报账类别。", "expenseCategory");
        }

        const reporter = parseRequiredString(request.body?.reporter, "reporter", "报账人");
        const amount = parseManualImportAmount(request.body?.amount);
        const sentAt = parseManualImportSentAt(request.body?.sentAt, config.timeZone);
        const attachments = request.file
          ? [
              saveUploadedReimbursementImage({
                buffer: request.file.buffer,
                config,
                mimeType: request.file.mimetype,
              }),
            ]
          : [];

        const result = importManualReimbursementReport({
          channelCode: channel.code,
          channelName: channel.match.value,
          reporter,
          amount,
          expenseCategory,
          note: trimString(request.body?.note),
          sentAt,
          timeZone: config.timeZone,
          attachments,
          submittedBy: getAdminSession(response)?.authorization ? getAdminSession(response) : undefined,
        });

        response.status(201).json({
          success: true,
          report: result.report,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    `${ADMIN_BASE_PATH}/api/batch-reports`,
    requirePermission("report:import"),
    batchImportImageUpload.array("images", MAX_BATCH_IMPORT_IMAGES),
    (request, response, next) => createBatchReportTask(request, response, next, {
      submittedBy: getAdminSession(response),
      ...(getAdminSession(response)?.authorization ? { allowedChannelCodes: new Set(submissionChannels(getAdminSession(response)!)) } : {}),
    }),
  );

  app.post(
    `${ADMIN_BASE_PATH}/api/submissions/:submissionPage/batch-reports`,
    requirePermission("report:submit"),
    batchImportImageUpload.array("images", MAX_BATCH_IMPORT_IMAGES),
    (request, response, next) => {
      if (!isUnifiedSubmissionPage(request.params.submissionPage)) {
        for (const file of Array.isArray(request.files) ? request.files : []) {
          if (file.path && fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
          }
        }
        response.status(404).json({
          success: false,
          error: { message: "批量报账页面不存在。" },
        });
        return;
      }

      const session = getAdminSession(response);
      if (!session) {
        response.status(401).json({ success: false, error: { message: "需要登录。" } });
        return;
      }
      const allowedChannelCodes = new Set(submissionChannels(session));
      void createBatchReportTask(request, response, next, {
        allowedChannelCodes,
        reporter: session.username,
        submittedBy: session,
      });
    },
  );

  app.get(`${ADMIN_BASE_PATH}/api/batch-reports/:taskId`, (request, response, next) => {
    try {
      const taskId = parseRequiredString(request.params.taskId, "taskId", "批量补录任务");
      const task = getBatchImportTask(taskId);
      const session = getAdminSession(response);

      if (
        !task ||
        !session ||
        (session.authorization ? (
          (!hasPermission(session, "task:view:any") && task.submittedByAccountId !== session.accountId) ||
          !(hasPermission(session, "report:view") && canViewResource(session, task) ||
            (task.submittedByAccountId === session.accountId &&
              (hasPermission(session, "report:submit") || hasPermission(session, "report:import")) && submissionChannels(session).includes(task.channelCode)))
        ) : ((session.role !== "admin" && task.submittedByAccountId !== session.accountId) ||
          (session.role === "manager" && !canViewResource(session, task))))
      ) {
        response.status(404).json({
          success: false,
          error: {
            message: "批量补录任务不存在。",
          },
        });
        return;
      }

      response.status(200).json({
        success: true,
        task,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get(`${ADMIN_BASE_PATH}/api/reports`, requirePermission("report:view"), (request, response, next) => {
    try {
      const session = getAdminSession(response);
      if (!session) {
        response.status(401).json({ success: false, error: { message: "需要登录。" } });
        return;
      }
      const result = listAdminReimbursementReports(
        {
          ...parseReportListQuery(request.query as Record<string, unknown>),
          ...reportAccessScope(session),
          timeZone: config.timeZone,
        },
      );
      response.status(200).json({
        success: true,
        ...result,
        timeZone: config.timeZone,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get(`${ADMIN_BASE_PATH}/api/reports/:id`, requirePermission("report:view"), (request, response, next) => {
    try {
      const reportId = parsePositiveInteger(request.params.id, "id");
      const report = getAdminReimbursementReportDetail(reportId);
      const session = getAdminSession(response);

      if (!report || !session || !canViewResource(session, {
        channelCode: report.channelCode,
        submittedByAccountId: report.submittedByAccountId,
      })) {
        response.status(404).json({
          success: false,
          error: {
            message: "报账记录不存在。",
          },
        });
        return;
      }

      response.status(200).json({
        success: true,
        report,
        timeZone: config.timeZone,
      });
    } catch (error) {
      next(error);
    }
  });

  app.patch(`${ADMIN_BASE_PATH}/api/reports/:id`, requirePermission("report:edit"), checkReport, (request, response, next) => {
    try {
      const reportId = parsePositiveInteger(request.params.id, "id");
      const expectedUpdatedAt = parseRequiredString(request.body?.updatedAt, "updatedAt", "更新时间");
      const hasAmount = hasOwnField(request.body, "amount");
      const hasExpenseCategory = hasOwnField(request.body, "expenseCategory");
      const hasNoteToAppend = hasOwnField(request.body, "noteToAppend");
      const amount = hasAmount ? parseAdminEditAmount(request.body.amount) : undefined;
      const expenseCategory = hasExpenseCategory
        ? parseExpenseCategory(request.body.expenseCategory)
        : undefined;
      const noteToAppend = hasNoteToAppend ? trimString(request.body.noteToAppend) : "";

      if (hasExpenseCategory && !expenseCategory) {
        throw new AdminValidationError("请选择报账类别。", "expenseCategory");
      }

      if (noteToAppend.length > MAX_ADMIN_EDIT_NOTE_LENGTH) {
        throw new AdminValidationError(
          `追加备注不能超过 ${MAX_ADMIN_EDIT_NOTE_LENGTH} 个字符。`,
          "noteToAppend",
        );
      }

      if (!hasAmount && !hasExpenseCategory && !noteToAppend) {
        throw new AdminValidationError("请至少修改金额、类别或追加一条备注。", "report");
      }

      const result = updateAdminReimbursementReport({
        reimbursementReportId: reportId,
        expectedUpdatedAt,
        amount,
        expenseCategory,
        noteToAppend: noteToAppend || undefined,
        timeZone: config.timeZone,
        referenceDateTime: new Date().toISOString(),
      });

      if (result.status === "not_found") {
        response.status(404).json({
          success: false,
          error: { message: "报账记录不存在。" },
        });
        return;
      }

      if (result.status === "conflict") {
        throw new AdminConflictError("这条报账已被其他操作更新，请重新加载后再编辑。");
      }

      response.status(200).json({
        success: true,
        report: result.report,
      });
    } catch (error) {
      next(error);
    }
  });

  app.delete(`${ADMIN_BASE_PATH}/api/reports/:id`, requirePermission("report:delete"), checkReport, (request, response, next) => {
    try {
      const reportId = parsePositiveInteger(request.params.id, "id");
      const deleted = deleteReimbursementReport(reportId);

      if (!deleted) {
        response.status(404).json({
          success: false,
          error: {
            message: "报账记录不存在。",
          },
        });
        return;
      }

      response.status(200).json({
        success: true,
        id: reportId,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get(`${ADMIN_BASE_PATH}/api/attachments/:attachmentId/content`, requirePermission("attachment:view"), (request, response, next) => {
    try {
      const attachmentId = parsePositiveInteger(request.params.attachmentId, "attachmentId");
      const attachment = findAdminReimbursementAttachment(attachmentId);
      const session = getAdminSession(response);

      if (
        !attachment ||
        !attachment.exists ||
        !session ||
        !canViewResource(session, {
          channelCode: attachment.reportChannelCode,
          submittedByAccountId: attachment.reportSubmittedByAccountId,
        })
      ) {
        response.status(404).json({
          success: false,
          error: {
            message: "附件不存在或已被清理。",
          },
        });
        return;
      }

      if (attachment.mimeType) {
        response.type(attachment.mimeType);
      }

      response.set(
        "Content-Disposition",
        `inline; filename*=UTF-8''${encodeURIComponent(buildAttachmentDownloadName(attachment.localPath))}`,
      );
      response.sendFile(attachment.localPath);
    } catch (error) {
      next(error);
    }
  });

  app.use(sendNotFound);

  app.use((error: unknown, request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof multer.MulterError) {
      const isBatchImport = request.path.endsWith("/batch-reports");
      const message =
        error.code === "LIMIT_FILE_SIZE"
          ? isBatchImport
            ? "每张报账图不能超过 20MB。"
            : "报账图不能超过 20MB。"
          : isBatchImport &&
              (error.code === "LIMIT_FILE_COUNT" || error.code === "LIMIT_UNEXPECTED_FILE")
            ? `批量补录每次最多添加 ${MAX_BATCH_IMPORT_IMAGES} 张报账图。`
            : "报账图上传失败。";
      response.status(400).json({
        success: false,
        error: {
          field: isBatchImport ? "images" : "image",
          message,
        },
      });
      return;
    }

    if (error instanceof AdminValidationError) {
      response.status(400).json({
        success: false,
        error: {
          field: error.field,
          message: error.message,
        },
      });
      return;
    }

    if (error instanceof AdminConflictError) {
      response.status(409).json({
        success: false,
        error: {
          message: error.message,
        },
      });
      return;
    }

    console.error("Unexpected reimbursement admin error:", error);

    if (request.path.includes("/api/")) {
      response.status(500).json({
        success: false,
        error: {
          message: "请求失败，请稍后重试。",
        },
      });
      return;
    }

    response.status(500).type("text/plain; charset=utf-8").send("请求失败，请稍后重试。");
  });

  return app;
}

export {
  ADMIN_BASE_PATH,
  DEFAULT_LIMIT,
  LEGACY_ADMIN_BASE_PATH,
  MAX_BATCH_IMPORT_IMAGES,
  MAX_LIMIT,
  SHORTCUT_API_PATH,
};
