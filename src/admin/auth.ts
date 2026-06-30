import { timingSafeEqual } from "node:crypto";

import type { NextFunction, Request, Response } from "express";

function hasValue(value: string | undefined) {
  return typeof value === "string" && value.length > 0;
}

function secureCompare(left: string, right: string) {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

function parseBasicAuthHeader(header: string | undefined) {
  if (typeof header !== "string" || !header.startsWith("Basic ")) {
    return null;
  }

  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const separatorIndex = decoded.indexOf(":");

    if (separatorIndex === -1) {
      return null;
    }

    return {
      username: decoded.slice(0, separatorIndex),
      password: decoded.slice(separatorIndex + 1),
    };
  } catch {
    return null;
  }
}

function setNoStore(response: Response) {
  response.set("Cache-Control", "no-store");
}

function sendAdminError(
  request: Request,
  response: Response,
  statusCode: number,
  message: string,
  extraHeaders: Record<string, string> = {},
) {
  setNoStore(response);
  response.set(extraHeaders);

  if (request.path.includes("/api/")) {
    response.status(statusCode).json({
      success: false,
      error: {
        message,
      },
    });
    return;
  }

  response.status(statusCode).type("text/plain; charset=utf-8").send(message);
}

export function createAdminAuthMiddleware(input?: {
  username?: string;
  password?: string;
  realm?: string;
}) {
  const username = input?.username?.trim();
  const password = input?.password?.trim();
  const realm = input?.realm ?? "Wechat Claw Reimbursement Admin";
  const isConfigured = hasValue(username) && hasValue(password);

  return (request: Request, response: Response, next: NextFunction) => {
    if (!isConfigured || !username || !password) {
      sendAdminError(request, response, 503, "管理员后台尚未配置账号密码。");
      return;
    }

    const credentials = parseBasicAuthHeader(request.headers.authorization);

    if (
      !credentials ||
      !secureCompare(credentials.username, username) ||
      !secureCompare(credentials.password, password)
    ) {
      sendAdminError(request, response, 401, "需要管理员身份验证。", {
        "WWW-Authenticate": `Basic realm="${realm}", charset="UTF-8"`,
      });
      return;
    }

    setNoStore(response);
    next();
  };
}
