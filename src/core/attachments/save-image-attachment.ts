import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { StoredAttachment } from "../storage/types.js";

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function detectMimeType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();

  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

export async function saveImageAttachment(message: any): Promise<StoredAttachment | null> {
  if (typeof message.toFileBox !== "function") {
    return null;
  }

  const fileBox = await message.toFileBox();
  const fileName = fileBox?.name || "attachment.bin";
  const fileBuffer = await fileBox.toBuffer();
  const sha256 = crypto.createHash("sha256").update(fileBuffer).digest("hex");
  const ext = path.extname(fileName) || ".bin";
  const now = new Date();
  const targetDir = path.join(
    process.cwd(),
    "storage",
    "raw",
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  );

  ensureDir(targetDir);

  const storedFileName = `${sha256}${ext}`;
  const absolutePath = path.join(targetDir, storedFileName);

  if (!fs.existsSync(absolutePath)) {
    fs.writeFileSync(absolutePath, fileBuffer);
  }

  return {
    type: "image",
    localPath: absolutePath,
    sha256,
    mimeType: detectMimeType(fileName),
  };
}
