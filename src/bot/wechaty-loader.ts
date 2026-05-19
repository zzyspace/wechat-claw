import type { WechatyModule } from "./types.js";

export async function loadWechatyModule(): Promise<WechatyModule> {
  try {
    const mod = (await import("wechaty")) as unknown as WechatyModule;
    return mod;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to load wechaty. Install dependencies first. Original error: ${message}`,
    );
  }
}

export async function loadPuppetModule(puppet?: string): Promise<void> {
  if (!puppet) {
    return;
  }

  try {
    await import(puppet);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to load puppet runtime ${puppet}. Verify production dependencies and Chromium runtime libraries. Original error: ${message}`,
    );
  }
}
