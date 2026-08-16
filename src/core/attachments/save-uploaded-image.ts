import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { AppConfig } from "../config/env.js";
import { getReimbursementRawStorageDir } from "../runtime/state-paths.js";
import { getZonedDateParts } from "../runtime/timezone.js";
import type { StoredAttachment } from "../storage/types.js";

const IMAGE_EXTENSIONS_BY_MIME_TYPE: Record<string, string> = {
  "image/gif": ".gif",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

export const ADMIN_MANUAL_IMPORT_IMAGE_MIME_TYPES = new Set(
  Object.keys(IMAGE_EXTENSIONS_BY_MIME_TYPE),
);

export function saveUploadedReimbursementImage(input: {
  buffer: Buffer;
  config: AppConfig;
  mimeType: string;
  now?: Date;
}): StoredAttachment {
  const extension = IMAGE_EXTENSIONS_BY_MIME_TYPE[input.mimeType];

  if (!extension) {
    throw new Error(`Unsupported reimbursement image type: ${input.mimeType}`);
  }

  const sha256 = crypto.createHash("sha256").update(input.buffer).digest("hex");
  const zonedNow = getZonedDateParts(input.now ?? new Date(), input.config.timeZone);
  const targetDir = path.join(
    getReimbursementRawStorageDir(input.config),
    String(zonedNow.year),
    String(zonedNow.month).padStart(2, "0"),
    String(zonedNow.day).padStart(2, "0"),
  );
  const localPath = path.join(targetDir, `${sha256}${extension}`);

  fs.mkdirSync(targetDir, { recursive: true });

  if (!fs.existsSync(localPath)) {
    fs.writeFileSync(localPath, input.buffer);
  }

  return {
    type: "image",
    localPath,
    sha256,
    mimeType: input.mimeType,
  };
}

export function saveUploadedReimbursementImageFile(input: {
  config: AppConfig;
  mimeType: string;
  sourcePath: string;
  now?: Date;
}): StoredAttachment {
  const extension = IMAGE_EXTENSIONS_BY_MIME_TYPE[input.mimeType];

  if (!extension) {
    throw new Error(`Unsupported reimbursement image type: ${input.mimeType}`);
  }

  const buffer = fs.readFileSync(input.sourcePath);
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  const zonedNow = getZonedDateParts(input.now ?? new Date(), input.config.timeZone);
  const targetDir = path.join(
    getReimbursementRawStorageDir(input.config),
    String(zonedNow.year),
    String(zonedNow.month).padStart(2, "0"),
    String(zonedNow.day).padStart(2, "0"),
  );
  const localPath = path.join(targetDir, `${sha256}${extension}`);

  fs.mkdirSync(targetDir, { recursive: true });

  if (fs.existsSync(localPath)) {
    fs.unlinkSync(input.sourcePath);
  } else {
    fs.renameSync(input.sourcePath, localPath);
  }

  return {
    type: "image",
    localPath,
    sha256,
    mimeType: input.mimeType,
  };
}
