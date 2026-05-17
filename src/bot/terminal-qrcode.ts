import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export async function renderTerminalQrcode(qrcode: string): Promise<boolean> {
  try {
    const qrcodeTerminal = require("qrcode-terminal") as {
      generate(input: string, options?: { small?: boolean }): void;
    };

    qrcodeTerminal.generate(qrcode, { small: true });
    return true;
  } catch {
    return false;
  }
}
