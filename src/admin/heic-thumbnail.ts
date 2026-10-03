import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import sharp, { type Metadata } from "sharp";

const execFileAsync = promisify(execFile);
const MAX_INPUT_PIXELS = 40_000_000;
const HEVC_DECODER_UNAVAILABLE = "Support for this compression format has not been built in: HEVC";

export function isHeicDecoderUnavailable(error: unknown): boolean {
  return error instanceof Error && error.message.includes(HEVC_DECODER_UNAVAILABLE);
}

interface HeicThumbnailDependencies {
  readMetadata?: (sourcePath: string) => Promise<Metadata>;
  runThumbnailer?: (
    file: string,
    args: string[],
    options: { timeout: number; maxBuffer: number; windowsHide: boolean },
  ) => Promise<unknown>;
}

/** Decode only HEVC sources using the system codec, leaving originals untouched. */
export async function generateHeicThumbnail(
  sourcePath: string,
  dependencies: HeicThumbnailDependencies = {},
): Promise<Buffer> {
  const source = path.resolve(sourcePath);
  const readMetadata = dependencies.readMetadata ?? ((file: string) =>
    sharp(file, { limitInputPixels: MAX_INPUT_PIXELS, animated: false }).metadata());
  const metadata = await readMetadata(source);
  if (metadata.format !== "heif" || metadata.compression !== "hevc") {
    throw new Error("Native HEIC thumbnail requires an HEVC-compressed HEIF image");
  }
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 ||
      width * height > MAX_INPUT_PIXELS) {
    throw new Error("HEIC thumbnail input exceeds the pixel limit or has invalid dimensions");
  }

  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "expense-heic-thumbnail-"));
  try {
    await fs.chmod(temporaryDirectory, 0o700);
    const temporaryPng = path.join(temporaryDirectory, "thumbnail.png");
    const runThumbnailer = dependencies.runThumbnailer ?? execFileAsync;
    await runThumbnailer("/usr/bin/heif-thumbnailer", ["-s", "240", "-p", source, temporaryPng], {
      timeout: 15_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
    return await sharp(temporaryPng, { limitInputPixels: MAX_INPUT_PIXELS, animated: false })
      .rotate().resize({ width: 240, height: 240, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 60 }).toBuffer();
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}
