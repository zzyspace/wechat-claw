import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { getQrcodeArtifactPath } from "../core/runtime/state-paths.js";

const require = createRequire(import.meta.url);

function ensureDirectoryForFile(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function renderAsciiQrcode(qrcode: string): string {
  try {
    const qrcodeTerminal = require("qrcode-terminal") as {
      generate(input: string, options: { small?: boolean }, cb?: (result: string) => void): void;
    };

    let output = "";
    qrcodeTerminal.generate(qrcode, { small: true }, (result: string) => {
      output = result;
    });

    return output.trim();
  } catch {
    return "";
  }
}

export function writeLatestQrcodeArtifact(qrcodeUrl: string, qrcode: string) {
  const artifactPath = getQrcodeArtifactPath();
  const asciiQrcode = renderAsciiQrcode(qrcode);
  const content = [
    `updated_at=${new Date().toISOString()}`,
    `qrcode_url=${qrcodeUrl}`,
    "",
    asciiQrcode || "(ascii qrcode unavailable)",
    "",
  ].join("\n");

  ensureDirectoryForFile(artifactPath);
  fs.writeFileSync(artifactPath, content, "utf8");

  return artifactPath;
}
