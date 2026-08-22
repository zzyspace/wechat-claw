import { timingSafeEqual } from "node:crypto";

import type { NextFunction, Request, Response } from "express";
import type {
  ReimbursementAccessPrincipal,
  ReimbursementAccountRole,
  ReimbursementManagerStore,
} from "../core/config/reimbursement-access.js";

export interface AdminSession extends ReimbursementAccessPrincipal {
  canWrite: boolean;
  canSubmit: boolean;
  canViewAllReports: boolean;
}

export interface ConfiguredAdminAccount {
  accountId: string;
  managerStores: ReimbursementManagerStore[];
  username: string;
  password: string;
  role: ReimbursementAccountRole;
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

function parseBearerAuthHeader(header: string | undefined) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    return null;
  }

  const token = header.slice("Bearer ".length).trim();
  return token || null;
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
  accountId: string;
  managerStores?: ReimbursementManagerStore[];
  username?: string;
  password?: string;
  role: ReimbursementAccountRole;
}): ConfiguredAdminAccount | null {
  const username = input.username?.trim();
  const password = input.password?.trim();

  if (!hasValue(username) || !hasValue(password) || !username || !password) {
    return null;
  }

  return {
    accountId: input.accountId,
    managerStores: input.managerStores ?? [],
    username,
    password,
    role: input.role,
  };
}

export function getAdminSession(response: Response): AdminSession | undefined {
  return response.locals.adminSession as AdminSession | undefined;
}

export function createAdminAuthMiddleware(input?: {
  accounts?: ConfiguredAdminAccount[];
  username?: string;
  password?: string;
  realm?: string;
}) {
  const realm = input?.realm ?? "Wechat Claw Reimbursement Admin";
  const adminAccount = createConfiguredAccount({
    accountId: "reimbursement-admin",
    username: input?.username,
    password: input?.password,
    role: "admin",
  });
  const accounts = [
    adminAccount,
    ...(input?.accounts ?? []),
  ].filter((account): account is ConfiguredAdminAccount => account !== null);
  if (new Set(accounts.map((account) => account.accountId)).size !== accounts.length) {
    throw new Error("Reimbursement accountId values must be unique.");
  }
  if (new Set(accounts.map((account) => account.username)).size !== accounts.length) {
    throw new Error("Reimbursement account usernames must be unique.");
  }

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
      accountId: account.accountId,
      managerStores: account.managerStores,
      username: account.username,
      role: account.role,
      canWrite: account.role === "admin",
      canSubmit: true,
      canViewAllReports: account.role === "admin" || account.role === "partner",
    } satisfies AdminSession;
    next();
  };
}

export function createShortcutApiAuthMiddleware(input?: { token?: string }) {
  const configuredToken = input?.token?.trim();

  return (request: Request, response: Response, next: NextFunction) => {
    setNoStore(response);

    if (!configuredToken) {
      response.status(503).json({
        success: false,
        error: {
          message: "快捷指令报账接口尚未配置。",
        },
      });
      return;
    }

    const suppliedToken = parseBearerAuthHeader(request.headers.authorization);

    if (!suppliedToken || !secureCompare(suppliedToken, configuredToken)) {
      response.status(401).json({
        success: false,
        error: {
          message: "快捷指令报账接口身份验证失败。",
        },
      });
      return;
    }

    next();
  };
}

export function enforceAdminRole(request: Request, response: Response, next: NextFunction) {
  if (getAdminSession(response)?.role === "admin") {
    next();
    return;
  }
  sendAdminError(request, response, 403, "当前账号无权使用管理员专属功能。");
}
