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
