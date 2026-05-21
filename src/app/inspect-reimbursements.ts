import { getAppConfig } from "../core/config/env.js";
import {
  buildPrintReimbursementUsageText,
  parsePrintReimbursementCliArgs,
  renderReimbursementReportList,
} from "../core/runtime/reimbursement-print-command.js";
import { listReimbursementReportDetails } from "../scenarios/reimbursement/repository.js";

function main() {
  const config = getAppConfig();

  let options;

  try {
    options = parsePrintReimbursementCliArgs(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes("Usage:")) {
      console.log(message);
      process.exitCode = 0;
      return;
    }

    console.error(message);
    console.log("");
    console.log(buildPrintReimbursementUsageText());
    process.exitCode = 1;
    return;
  }

  const reports = listReimbursementReportDetails({
    channelCode: options.channelCode,
    limit: options.limit,
  });

  console.log(renderReimbursementReportList(reports, options));
  console.log(`timezone=${config.timeZone}`);
}

main();
