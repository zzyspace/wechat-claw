import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { listScenarioExtractionsByRawMessageId } from "../../core/scenarios/scenario-extraction-repository.js";
import { getAdminReimbursementReportDetail } from "./repository.js";
import { importBatchReimbursementReports } from "./batch-import.js";
import { processBatchImportTask } from "./batch-import-task-processor.js";
import {
  claimNextBatchImportWorkItem,
  createBatchImportTask,
  getBatchImportTask,
  recoverInterruptedBatchImportTasks,
} from "./batch-import-task-repository.js";
import type { ReimbursementExtractionInput } from "./types.js";

process.env.WECHATY_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claw-batch-reimbursement-import-"));

function createModelExtraction(input: ReimbursementExtractionInput, amount: number) {
  return {
    scenarioCode: "reimbursement" as const,
    extractorCode: "model-test-v1",
    status: "extracted" as const,
    confidence: 0.9,
    needsReview: false,
    resultJson: {
      eventType: "reimbursement_report" as const,
      rawMessageId: input.rawMessageId,
      channelName: input.channelName,
      reporter: input.reporter,
      reportedAt: input.sentAt,
      amount,
      currency: "CNY",
      expenseCategory: "food",
      voucherDate: "2026-08-17",
      voucherDateSource: "model" as const,
      note: "模型备注",
      evidenceType: "image+text" as const,
      merchant: "测试商户",
      documentNo: null,
      voucherType: "小票",
      ocrText: "OCR",
    },
  };
}

test("importBatchReimbursementReports runs extraction once per image and creates one report per image", async () => {
  const extractorInputs: ReimbursementExtractionInput[] = [];
  const attachments = ["first.png", "second.png"].map((fileName, index) => ({
    type: "image",
    localPath: path.join(process.env.WECHATY_STATE_DIR ?? os.tmpdir(), fileName),
    sha256: `batch-image-${index}`,
    mimeType: "image/png",
  }));

  for (const attachment of attachments) {
    fs.writeFileSync(attachment.localPath, attachment.sha256, "utf8");
  }

  const results = await importBatchReimbursementReports(
    {
      attachments,
      channelCode: "reimbursement_fuzzy",
      channelName: "模糊报账群",
      modelConfig: {
        provider: "qwen",
        model: "test-model",
        apiKey: "test-key",
      },
      notes: ["第一张花材", "第二张花材"],
      reporter: "小陈",
      sentAt: "2026-08-17T02:30:00.000Z",
      timeZone: "Asia/Shanghai",
    },
    async (input) => {
      extractorInputs.push(input);
      const index = extractorInputs.length;
      return createModelExtraction(input, index * 10);
    },
  );

  assert.equal(extractorInputs.length, 2);
  assert.deepEqual(extractorInputs.map((input) => input.attachments), [[attachments[0]], [attachments[1]]]);
  assert.equal(results.length, 2);
  assert.deepEqual(results.map((item) => item.report.amount), [10, 20]);
  assert.deepEqual(results.map((item) => item.report.expenseCategory), ["food", "food"]);
  assert.deepEqual(results.map((item) => item.report.note), ["第一张花材", "第二张花材"]);

  for (const result of results) {
    const detail = getAdminReimbursementReportDetail(result.report.id);
    assert.equal(detail?.sources.length, 1);
    assert.equal(detail?.sources[0]?.attachments.length, 1);
    assert.equal(detail?.sources[0]?.textContent, result.report.note);
    const extractions = listScenarioExtractionsByRawMessageId(result.rawMessageId);
    assert.equal(extractions.length, 1);
    assert.equal(extractions[0]?.extractorCode, "model-test-v1");
    assert.equal((extractions[0]?.resultJson as { source?: string }).source, "batch_import");
  }
});

test("processBatchImportTask isolates failed images and completes the remaining items", async () => {
  const attachments = ["task-one.png", "task-two.png", "task-three.png"].map((fileName, index) => ({
    type: "image",
    localPath: path.join(process.env.WECHATY_STATE_DIR ?? os.tmpdir(), fileName),
    sha256: `task-image-${index}`,
    mimeType: "image/png",
  }));
  attachments.forEach((attachment) => fs.writeFileSync(attachment.localPath, attachment.sha256, "utf8"));
  const task = createBatchImportTask({
    attachments,
    channelCode: "reimbursement_fuzzy",
    channelName: "模糊报账群",
    originalNames: attachments.map((attachment) => path.basename(attachment.localPath)),
    notes: ["一", "二", "三"],
    reporter: "任务测试人",
    sentAt: "2026-08-17T03:00:00.000Z",
    timeZone: "Asia/Shanghai",
  });

  const completed = await processBatchImportTask({
    jobId: task.id,
    modelConfig: {},
    extractor: async (input) => {
      if (input.attachments[0]?.localPath.endsWith("task-two.png")) {
        throw new Error("第二张模拟失败");
      }
      return createModelExtraction(input, 20);
    },
  });

  assert(completed);
  assert.equal(completed.status, "completed");
  assert.equal(completed.completedCount, 3);
  assert.equal(completed.successCount, 2);
  assert.equal(completed.failedCount, 1);
  assert.deepEqual(completed.items.map((item) => item.status), ["succeeded", "failed", "succeeded"]);
  assert.match(completed.items[1]?.errorMessage ?? "", /第二张模拟失败/);
});

test("recoverInterruptedBatchImportTasks requeues processing work without duplicate reports", async () => {
  const attachment = {
    type: "image",
    localPath: path.join(process.env.WECHATY_STATE_DIR ?? os.tmpdir(), "recover-task.png"),
    sha256: "recover-task-image",
    mimeType: "image/png",
  };
  fs.writeFileSync(attachment.localPath, attachment.sha256, "utf8");
  const task = createBatchImportTask({
    attachments: [attachment],
    channelCode: "reimbursement_fuzzy",
    channelName: "模糊报账群",
    originalNames: ["recover-task.png"],
    notes: ["恢复任务"],
    reporter: "恢复测试人",
    sentAt: "2026-08-17T04:00:00.000Z",
    timeZone: "Asia/Shanghai",
  });

  assert(claimNextBatchImportWorkItem(task.id));
  assert.equal(getBatchImportTask(task.id)?.items[0]?.status, "processing");
  assert.equal(recoverInterruptedBatchImportTasks().includes(task.id), true);
  assert.equal(getBatchImportTask(task.id)?.items[0]?.status, "queued");

  const completed = await processBatchImportTask({
    jobId: task.id,
    modelConfig: {},
    extractor: async (input) => createModelExtraction(input, 30),
  });
  assert.equal(completed?.status, "completed");
  assert.equal(completed?.successCount, 1);
  assert.equal(completed?.items[0]?.reportId !== undefined, true);
});
