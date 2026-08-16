import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import multer from "multer";

import { getAppConfig, type AppConfig } from "../core/config/env.js";
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
} from "../scenarios/reimbursement/categories.js";
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
  listAdminReimbursementReports,
  updateAdminReimbursementReport,
} from "../scenarios/reimbursement/repository.js";
import {
  createAdminAuthMiddleware,
  enforceAdminWriteAccess,
  getAdminSession,
} from "./auth.js";

const ADMIN_BASE_PATH = "/reimbursement";
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;
const MAX_MANUAL_IMPORT_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_BATCH_IMPORT_IMAGES = 20;
const MAX_BATCH_IMPORT_NOTE_LENGTH = 300;
const MAX_ADMIN_EDIT_NOTE_LENGTH = 1000;
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

  if (createdDateFrom && createdDateTo && createdDateFrom > createdDateTo) {
    throw new AdminValidationError("createdDateFrom 不能晚于 createdDateTo。", "createdDateFrom");
  }

  return {
    search: trimString(query.search) || undefined,
    channelCode: trimString(query.channelCode) || undefined,
    reporter: trimString(query.reporter) || undefined,
    note: trimString(query.note) || undefined,
    expenseCategory: parseExpenseCategory(query.expenseCategory),
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
  staticDir?: string;
}) {
  const config = input?.config ?? getAppConfig();
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
  const adminAuth = createAdminAuthMiddleware({
    username: config.adminUsername,
    password: config.adminPassword,
    guestUsername: config.adminGuestUsername,
    guestPassword: config.adminGuestPassword,
  });
  const app = express();
  const activeBatchImportTaskIds = new Set<string>();
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

  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));

  app.get(`${ADMIN_BASE_PATH}/healthz`, (_request, response) => {
    response.status(200).json({ ok: true });
  });

  app.get([`${ADMIN_BASE_PATH}`, `${ADMIN_BASE_PATH}/`], adminAuth, (_request, response) => {
    response.sendFile(path.join(staticDir, "admin.html"));
  });

  app.use(`${ADMIN_BASE_PATH}/api`, adminAuth, enforceAdminWriteAccess);

  app.get(`${ADMIN_BASE_PATH}/api/session`, (_request, response) => {
    const session = getAdminSession(response);

    response.status(200).json({
      success: true,
      account: {
        username: session?.username,
        role: session?.role,
      },
      permissions: {
        canWrite: session?.canWrite === true,
      },
    });
  });

  app.get(`${ADMIN_BASE_PATH}/api/manual-import-options`, (_request, response) => {
    response.status(200).json({
      success: true,
      channels: config.channels
        .filter((channel) => channel.enabled && channel.scenario === "reimbursement")
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

  app.post(`${ADMIN_BASE_PATH}/api/reports`, manualImportImageUpload.single("image"), (request, response, next) => {
    try {
      const channelCode = parseRequiredString(request.body?.channelCode, "channelCode", "门店");
      const channel = config.channels.find(
        (item) => item.enabled && item.scenario === "reimbursement" && item.code === channelCode,
      );

      if (!channel) {
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
      });

      response.status(201).json({
        success: true,
        report: result.report,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post(
    `${ADMIN_BASE_PATH}/api/batch-reports`,
    batchImportImageUpload.array("images", MAX_BATCH_IMPORT_IMAGES),
    async (request, response, next) => {
      const uploadedFiles = Array.isArray(request.files) ? request.files : [];

      try {
        const channelCode = parseRequiredString(request.body?.channelCode, "channelCode", "门店");
        const channel = config.channels.find(
          (item) => item.enabled && item.scenario === "reimbursement" && item.code === channelCode,
        );

        if (!channel) {
          throw new AdminValidationError("请选择有效的报账门店。", "channelCode");
        }

        const reporter = parseRequiredString(request.body?.reporter, "reporter", "报账人");
        const sentAt = parseManualImportSentAt(request.body?.sentAt, config.timeZone);
        const files = uploadedFiles;

        if (files.length === 0) {
          throw new AdminValidationError("请至少添加一张报账图。", "images");
        }

        const notes = parseBatchImportNotes(request.body?.notesJson, files.length);

        const attachments = files.map((file) =>
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
          originalNames: files.map((file) => file.originalname),
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
    },
  );

  app.get(`${ADMIN_BASE_PATH}/api/batch-reports/:taskId`, (request, response, next) => {
    try {
      const taskId = parseRequiredString(request.params.taskId, "taskId", "批量补录任务");
      const task = getBatchImportTask(taskId);

      if (!task) {
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

  app.get(`${ADMIN_BASE_PATH}/api/reports`, (request, response, next) => {
    try {
      const result = listAdminReimbursementReports(
        {
          ...parseReportListQuery(request.query as Record<string, unknown>),
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

  app.get(`${ADMIN_BASE_PATH}/api/reports/:id`, (request, response, next) => {
    try {
      const reportId = parsePositiveInteger(request.params.id, "id");
      const report = getAdminReimbursementReportDetail(reportId);

      if (!report) {
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

  app.patch(`${ADMIN_BASE_PATH}/api/reports/:id`, (request, response, next) => {
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

  app.delete(`${ADMIN_BASE_PATH}/api/reports/:id`, (request, response, next) => {
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

  app.get(`${ADMIN_BASE_PATH}/api/attachments/:attachmentId/content`, (request, response, next) => {
    try {
      const attachmentId = parsePositiveInteger(request.params.attachmentId, "attachmentId");
      const attachment = findAdminReimbursementAttachment(attachmentId);

      if (!attachment || !attachment.exists) {
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

export { ADMIN_BASE_PATH, DEFAULT_LIMIT, MAX_BATCH_IMPORT_IMAGES, MAX_LIMIT };
