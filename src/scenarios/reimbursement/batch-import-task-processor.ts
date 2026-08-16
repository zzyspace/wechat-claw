import type { ReimbursementModelProviderConfig } from "./extractor.js";
import {
  importBatchReimbursementReport,
  type ReimbursementExtractor,
} from "./batch-import.js";
import {
  claimNextBatchImportWorkItem,
  finalizeBatchImportTask,
  markBatchImportItemFailed,
  markBatchImportItemSucceeded,
} from "./batch-import-task-repository.js";

export async function processBatchImportTask(input: {
  extractor?: ReimbursementExtractor;
  jobId: string;
  modelConfig: ReimbursementModelProviderConfig;
}) {
  while (true) {
    const item = claimNextBatchImportWorkItem(input.jobId);

    if (!item) {
      break;
    }

    try {
      const result = await importBatchReimbursementReport(
        {
          attachment: item.attachment,
          channelCode: item.channelCode,
          channelName: item.channelName,
          messageExternalId: `batch-import-task:${item.jobId}:${item.index}`,
          modelConfig: input.modelConfig,
          note: item.note,
          reporter: item.reporter,
          sentAt: item.sentAt,
          timeZone: item.timeZone,
        },
        input.extractor,
      );
      markBatchImportItemSucceeded(item.jobId, item.index, result.report.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      markBatchImportItemFailed(item.jobId, item.index, message || "识别失败");
    }
  }

  return finalizeBatchImportTask(input.jobId);
}
