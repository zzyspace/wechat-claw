import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { listScenarioExtractionsByRawMessageId } from "../../core/scenarios/scenario-extraction-repository.js";
import { getAdminReimbursementReportDetail } from "./repository.js";
import { importBatchReimbursementReports } from "./batch-import.js";
import type { ReimbursementExtractionInput } from "./types.js";

process.env.WECHATY_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claw-batch-reimbursement-import-"));

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
      return {
        scenarioCode: "reimbursement",
        extractorCode: "model-test-v1",
        status: "extracted",
        confidence: 0.9,
        needsReview: false,
        resultJson: {
          eventType: "reimbursement_report",
          rawMessageId: input.rawMessageId,
          channelName: input.channelName,
          reporter: input.reporter,
          reportedAt: input.sentAt,
          amount: index * 10,
          currency: "CNY",
          expenseCategory: "food",
          voucherDate: "2026-08-17",
          voucherDateSource: "model",
          note: "模型备注",
          evidenceType: "image+text",
          merchant: `商户${index}`,
          documentNo: null,
          voucherType: "小票",
          ocrText: `OCR ${index}`,
        },
      };
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
