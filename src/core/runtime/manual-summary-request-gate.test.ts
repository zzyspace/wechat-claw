import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { AppConfig } from "../config/env.js";
import { getManualSummaryRequestGateResult } from "./manual-summary-request-gate.js";
import { getHealthArtifactPath } from "./state-paths.js";

function createConfig(stateDir: string): AppConfig {
  return {
    botName: "wechat-loss-bot",
    channels: [],
    channelsSource: "json",
    debugContactName: "Ryan。",
    lossExtractionApiKey: undefined,
    lossExtractionBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    lossExtractionModel: undefined,
    lossExtractionProvider: undefined,
    lossMergeWindowSeconds: 60,
    puppet: "wechaty-puppet-wechat",
    puppetServiceToken: undefined,
    stateDir,
    summaryPromptTemplate: "",
    timeZone: "Asia/Shanghai",
  };
}

function withTempStateDir(run: (config: AppConfig) => void) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claw-summary-gate-"));

  try {
    run(createConfig(stateDir));
  } finally {
    fs.rmSync(stateDir, { force: true, recursive: true });
  }
}

test("manual summary request gate rejects when health file is missing", () => {
  withTempStateDir((config) => {
    const result = getManualSummaryRequestGateResult(config);

    assert.equal(result.allowed, false);
    assert.equal(result.status, "missing");
    assert.match(result.reason ?? "", /not found/i);
  });
});

test("manual summary request gate rejects when bot is waiting for scan", () => {
  withTempStateDir((config) => {
    fs.writeFileSync(
      getHealthArtifactPath(config),
      JSON.stringify({
        status: "waiting_for_scan",
      }),
      "utf8",
    );

    const result = getManualSummaryRequestGateResult(config);

    assert.equal(result.allowed, false);
    assert.equal(result.status, "waiting_for_scan");
    assert.match(result.reason ?? "", /discarded and not queued/i);
  });
});

test("manual summary request gate allows when bot is logged in", () => {
  withTempStateDir((config) => {
    fs.writeFileSync(
      getHealthArtifactPath(config),
      JSON.stringify({
        status: "logged_in",
      }),
      "utf8",
    );

    const result = getManualSummaryRequestGateResult(config);

    assert.equal(result.allowed, true);
    assert.equal(result.status, "logged_in");
  });
});
