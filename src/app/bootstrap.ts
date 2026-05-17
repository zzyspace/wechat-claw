import { logger } from "../core/logging/logger.js";
import { startBot } from "../bot/wechaty-client.js";

async function main() {
  try {
    await startBot(logger);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Application failed to start", { message });
    process.exitCode = 1;
  }
}

void main();
