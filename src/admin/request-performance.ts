import crypto from "node:crypto";
import type { RequestHandler, Response } from "express";
import type { Logger } from "../core/logging/logger.js";

interface Timing { id: string; started: number; stages: Record<string, number> }

export function recordRequestStage(response: Response, name: string, milliseconds: number) {
  const timing = response.locals.requestTiming as Timing | undefined;
  if (timing) timing.stages[name] = Math.round(milliseconds * 100) / 100;
}

export function setTimingHeader(response: Response) {
  const timing = response.locals.requestTiming as Timing | undefined;
  if (!timing || response.headersSent) return;
  response.set("Server-Timing", Object.entries(timing.stages).map(([name, ms]) => `${name};dur=${ms}`).join(", "));
}

export function requestPerformance(logger: Logger): RequestHandler {
  return (request, response, next) => {
    const route = request.path === "/api/reports" ? "reports.list"
      : /^\/api\/attachments\/\d+\/(content|thumbnail)$/.test(request.path) ? `attachments.${request.path.split("/").pop()}` : undefined;
    if (request.method !== "GET" || !route) return next();
    const timing: Timing = { id: crypto.randomUUID(), started: performance.now(), stages: {} };
    response.locals.requestTiming = timing;
    response.set("X-Request-Id", timing.id);
    let recorded = false;
    const finish = () => {
      if (recorded) return;
      recorded = true;
      logger.info("reimbursement admin request", {
        requestId: timing.id, route, status: response.statusCode,
        completed: response.writableFinished,
        durationMs: Math.round((performance.now() - timing.started) * 100) / 100,
        ...timing.stages,
        responseBytes: response.getHeader("content-length"),
      });
    };
    response.once("finish", finish);
    response.once("close", finish);
    next();
  };
}
