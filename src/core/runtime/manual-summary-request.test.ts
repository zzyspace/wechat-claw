import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  createSummarySendRequest,
  getSummarySendRequestById,
} from "./manual-summary-request.js";

const originalStateDir = process.env.WECHATY_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) {
    delete process.env.WECHATY_STATE_DIR;
    return;
  }

  process.env.WECHATY_STATE_DIR = originalStateDir;
});

function withTempStateDir(run: (stateDir: string) => void) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claw-manual-summary-request-"));
  process.env.WECHATY_STATE_DIR = stateDir;
  run(stateDir);
}

test("createSummarySendRequest persists summary type", () => {
  withTempStateDir(() => {
    const request = createSummarySendRequest({
      channelCode: "loss_a",
      requestedBy: "cli:test",
      scenarioCode: "loss-report",
      summaryType: "weekly",
      targetDate: "2026-05-24",
    });

    const saved = getSummarySendRequestById(request.id);

    assert(saved);
    assert.equal(saved.summaryType, "weekly");
    assert.equal(saved.targetDate, "2026-05-24");
  });
});
