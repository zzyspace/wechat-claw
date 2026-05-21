import { getAppConfig } from "../core/config/env.js";
import {
  buildShowLogsUsageText,
  parseShowLogsCliArgs,
  readRecentLogs,
} from "../core/logging/show-logs-command.js";

function main() {
  const config = getAppConfig();

  let options;

  try {
    options = parseShowLogsCliArgs(process.argv.slice(2), {
      timeZone: config.timeZone,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes("Usage:")) {
      console.log(message);
      process.exitCode = 0;
      return;
    }

    console.error(message);
    console.log("");
    console.log(buildShowLogsUsageText());
    process.exitCode = 1;
    return;
  }

  const result = readRecentLogs(config, options);
  console.log(`log_file=${result.filePath}`);
  console.log(`date=${options.date}`);
  console.log(`kind=${options.errorsOnly ? "error" : "app"}`);
  console.log(`grep=${options.grep ?? "(none)"}`);
  console.log(`lines=${result.lines.length}`);

  if (result.missing) {
    console.log("status=missing");
    return;
  }

  console.log("----");

  for (const line of result.lines) {
    console.log(line);
  }
}

main();
