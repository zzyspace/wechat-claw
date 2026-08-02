import { timingSafeEqual } from "node:crypto";

import type { NextFunction, Request, Response } from "express";

export type AdminRole = "admin" | "readonly";

export interface AdminSession {
  username: string;
  role: AdminRole;
  canWrite: boolean;
}

interface ConfiguredAdminAccount {
  username: string;
  password: string;
  role: AdminRole;
}

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

  if (request.originalUrl.includes("/api/")) {
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

function createConfiguredAccount(input: {
  username?: string;
  password?: string;
  role: AdminRole;
}): ConfiguredAdminAccount | null {
  const username = input.username?.trim();
  const password = input.password?.trim();

  if (!hasValue(username) || !hasValue(password) || !username || !password) {
    return null;
  }

  return {
    username,
    password,
    role: input.role,
  };
}

export function getAdminSession(response: Response): AdminSession | undefined {
  return response.locals.adminSession as AdminSession | undefined;
}

export function createAdminAuthMiddleware(input?: {
  username?: string;
  password?: string;
  guestUsername?: string;
  guestPassword?: string;
  realm?: string;
}) {
  const realm = input?.realm ?? "Wechat Claw Reimbursement Admin";
  const adminAccount = createConfiguredAccount({
    username: input?.username,
    password: input?.password,
    role: "admin",
  });
  const guestAccount = createConfiguredAccount({
    username: input?.guestUsername,
    password: input?.guestPassword,
    role: "readonly",
  });
  const accounts = [
    adminAccount,
    guestAccount && guestAccount.username !== adminAccount?.username ? guestAccount : null,
  ].filter((account): account is ConfiguredAdminAccount => account !== null);

  return (request: Request, response: Response, next: NextFunction) => {
    if (!adminAccount) {
      sendAdminError(request, response, 503, "管理员后台尚未配置账号密码。");
      return;
    }

    const credentials = parseBasicAuthHeader(request.headers.authorization);
    const account = credentials
      ? accounts.find(
          (candidate) =>
            secureCompare(credentials.username, candidate.username) &&
            secureCompare(credentials.password, candidate.password),
        )
      : undefined;

    if (!account) {
      sendAdminError(request, response, 401, "需要管理员身份验证。", {
        "WWW-Authenticate": `Basic realm="${realm}", charset="UTF-8"`,
      });
      return;
    }

    setNoStore(response);
    response.locals.adminSession = {
      username: account.username,
      role: account.role,
      canWrite: account.role === "admin",
    } satisfies AdminSession;
    next();
  };
}

const READ_ONLY_HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function enforceAdminWriteAccess(request: Request, response: Response, next: NextFunction) {
  const session = getAdminSession(response);

  if (READ_ONLY_HTTP_METHODS.has(request.method) || session?.canWrite) {
    next();
    return;
  }

  sendAdminError(request, response, 403, "只读账号无权执行删除或其他编辑操作。");
}
