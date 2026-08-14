import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import multer from "multer";

import { getAppConfig, type AppConfig } from "../core/config/env.js";
import {
  ADMIN_MANUAL_IMPORT_IMAGE_MIME_TYPES,
  saveUploadedReimbursementImage,
} from "../core/attachments/save-uploaded-image.js";
import { getZonedDateParts, zonedDateTimeToUtc } from "../core/runtime/timezone.js";
import {
  normalizeReimbursementExpenseCategory,
  REIMBURSEMENT_EXPENSE_CATEGORY_DEFINITIONS,
} from "../scenarios/reimbursement/categories.js";
import { importManualReimbursementReport } from "../scenarios/reimbursement/manual-import.js";
import {
  deleteReimbursementReport,
  findAdminReimbursementAttachment,
  getAdminReimbursementReportDetail,
  listAdminReimbursementReports,
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
  const adminAuth = createAdminAuthMiddleware({
    username: config.adminUsername,
    password: config.adminPassword,
    guestUsername: config.adminGuestUsername,
    guestPassword: config.adminGuestPassword,
  });
  const app = express();

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
      response.status(400).json({
        success: false,
        error: {
          field: "image",
          message: error.code === "LIMIT_FILE_SIZE" ? "报账图不能超过 20MB。" : "报账图上传失败。",
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

export { ADMIN_BASE_PATH, DEFAULT_LIMIT, MAX_LIMIT };
