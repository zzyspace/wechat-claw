import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import test from "node:test";
import { requestPerformance, recordRequestStage, setTimingHeader } from "./request-performance.js";

test("performance events include stages and completion without leaking query or credentials", () => {
  const events: Record<string, unknown>[] = [];
  const logger = { info: (_message: string, data?: Record<string, unknown>) => events.push(data!), debug() {}, warn() {}, error() {} };
  for (const completed of [true, false]) {
    const headers = new Map<string, unknown>();
    const response = Object.assign(new EventEmitter(), {
      locals: {}, statusCode: 200, writableFinished: completed, headersSent: false,
      set: (name: string, value: string) => headers.set(name, value),
      getHeader: (name: string) => headers.get(name),
    }) as unknown as Response;
    requestPerformance(logger)({ method: "GET", path: "/api/reports", originalUrl: "/expense/api/reports?reporter=secret-name",
      headers: { cookie: "private-cookie", authorization: "private-token" } } as unknown as Request, response, () => {});
    recordRequestStage(response, "auth", 2.345);
    recordRequestStage(response, "query", 1.1);
    setTimingHeader(response);
    assert.equal(headers.get("Server-Timing"), "auth;dur=2.35, query;dur=1.1");
    if (completed) response.emit("finish");
    response.emit("close");
  }
  assert.equal(events.length, 2);
  assert.equal(events[0].completed, true);
  assert.equal(events[1].completed, false);
  assert.equal(events[0].route, "reports.list");
  assert.doesNotMatch(JSON.stringify(events), /secret-name|private-cookie|private-token|reporter/);
});
