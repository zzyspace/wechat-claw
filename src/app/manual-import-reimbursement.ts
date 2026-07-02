import { getAppConfig } from "../core/config/env.js";
import {
  buildManualReimbursementImportUsageText,
  parseManualReimbursementImportCliArgs,
  renderManualReimbursementImportResult,
} from "../core/runtime/reimbursement-manual-import-command.js";
import { importManualReimbursementReport } from "../scenarios/reimbursement/manual-import.js";

function main() {
  const config = getAppConfig();

  let options;

  try {
    options = parseManualReimbursementImportCliArgs(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes("Usage:")) {
      console.log(message);
      process.exitCode = 0;
      return;
    }

    console.error(message);
    console.log("");
    console.log(buildManualReimbursementImportUsageText());
    process.exitCode = 1;
    return;
  }

  const channel = config.channels.find((item) => item.code === options.channelCode);

  if (!channel) {
    console.error(`Unknown channel code: ${options.channelCode}`);
    process.exitCode = 1;
    return;
  }

  if (channel.scenario !== "reimbursement") {
    console.error(`Channel ${options.channelCode} is not a reimbursement channel.`);
    process.exitCode = 1;
    return;
  }

  const result = importManualReimbursementReport({
    amount: options.amount,
    channelCode: channel.code,
    channelName: channel.match.value,
    expenseCategory: options.expenseCategory,
    note: options.note,
    reporter: options.reporter,
    sentAt: options.sentAt,
    timeZone: config.timeZone,
  });

  console.log(
    renderManualReimbursementImportResult(result, {
      amount: options.amount,
      channelCode: channel.code,
      channelName: channel.match.value,
      expenseCategory: options.expenseCategory,
      reporter: options.reporter,
      sentAt: options.sentAt,
      timeZone: config.timeZone,
    }),
  );
}

main();
