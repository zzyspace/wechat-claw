import type { RequestHandler } from "express";
import type { AdminSession } from "./auth.js";
import { getAllowedSubmissionChannelCodes, type ReimbursementAccountRole } from "../core/config/reimbursement-access.js";

const CHANNEL_STORES: Record<string, string> = {
  reimbursement_fuzzy: "fuzzy", reimbursement_peanut: "peanut", reimbursement_fuzzyqz: "fuzzyqz",
  reimbursement_fuzzy_manager: "fuzzy", reimbursement_peanut_manager: "peanut", reimbursement_fuzzy_qz_manager: "fuzzyqz",
};
const PERMISSIONS = ["report:view", "attachment:view", "report:submit", "report:edit", "report:delete", "report:import", "task:view:any"];
export interface ExpenseScope { ownership?: "self" | "any"; stores: "all" | string[]; channels: "all" | string[] }
export interface ExpensePolicy { permissions: string[]; viewScope: ExpenseScope; submitScope: ExpenseScope; importScope: ExpenseScope }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid authorization.");
  return value as Record<string, unknown>;
}
function scope(value: unknown, viewing: boolean): ExpenseScope {
  const item = record(value);
  const allowed = viewing ? ["ownership", "stores", "channels"] : ["stores", "channels"];
  if (Object.keys(item).some((key) => !allowed.includes(key)) ||
      (viewing && item.ownership !== "self" && item.ownership !== "any")) throw new Error("Invalid scope.");
  for (const [key, values] of [["stores", ["fuzzy", "peanut", "fuzzyqz"]], ["channels", Object.keys(CHANNEL_STORES)]] as const) {
    if (item[key] !== "all" && (!Array.isArray(item[key]) || !(item[key] as unknown[]).every((entry) => typeof entry === "string" && (values as readonly string[]).includes(entry)))) {
      throw new Error("Invalid scope.");
    }
  }
  return item as unknown as ExpenseScope;
}
export function validateExpenseAuthorization(value: unknown): AdminSession {
  const data = record(value), account = record(data.account), access = record(data.access), config = record(access.config);
  if (data.success !== true || account.enabled !== true || access.enabled !== true || access.app !== "expense" ||
      typeof account.accountId !== "string" || !account.accountId || access.accountId !== account.accountId ||
      typeof account.username !== "string" || !account.username || !Number.isSafeInteger(account.version) || Number(account.version) < 1 || !Number.isSafeInteger(access.version) || Number(access.version) < 1 ||
      !["admin", "partner", "manager"].includes(String(access.role)) ||
      !Array.isArray(access.permissions) || !access.permissions.every((entry) => PERMISSIONS.includes(entry)) ||
      Object.keys(config).some((key) => !["viewScope", "submitScope", "importScope"].includes(key))) throw new Error("Invalid expense authorization.");
  const permissions = access.permissions as string[];
  const policy: ExpensePolicy = {
    permissions,
    viewScope: scope(config.viewScope, true),
    submitScope: scope(config.submitScope, false),
    // Accounts created before separate import scopes keep their previous scope.
    importScope: scope(config.importScope ?? config.submitScope, false),
  };
  const dependentPermissions = ["attachment:view", "report:edit", "report:delete", "report:import", "task:view:any"];
  if ((!permissions.includes("report:view") && !permissions.includes("report:submit")) ||
      dependentPermissions.some((permission) => permissions.includes(permission)) && !permissions.includes("report:view") ||
      permissions.includes("report:view") && effectiveChannels(policy.viewScope).length === 0 ||
      permissions.includes("report:submit") && effectiveChannels(policy.submitScope).length === 0 ||
      permissions.includes("report:import") && effectiveChannels(policy.importScope).length === 0) {
    throw new Error("Invalid expense authorization dependencies or empty scope.");
  }
  return {
    accountId: account.accountId, username: account.username, role: access.role as ReimbursementAccountRole,
    managerStores: policy.submitScope.stores === "all" ? [] : policy.submitScope.stores as AdminSession["managerStores"],
    canWrite: ["report:edit", "report:delete", "report:import"].some((permission) => policy.permissions.includes(permission)),
    canSubmit: policy.permissions.includes("report:submit"),
    canViewAllReports: policy.permissions.includes("report:view") && policy.viewScope.ownership === "any" && policy.viewScope.stores === "all" && policy.viewScope.channels === "all",
    authorization: policy,
  };
}
export function hasPermission(session: AdminSession | undefined, permission: string): boolean {
  if (!session) return false;
  if (session.authorization) return session.authorization.permissions.includes(permission);
  return ["report:view", "attachment:view", "report:submit"].includes(permission) || session.role === "admin";
}
export function requirePermission(permission: string): RequestHandler {
  return (_request, response, next) => {
    if (hasPermission(response.locals.adminSession as AdminSession | undefined, permission)) return next();
    response.status(403).json({ success: false, error: { message: response.locals.adminSession?.authorization ? "当前账号无权执行此操作。" : "当前账号无权使用管理员专属功能。" } });
  };
}
export function scopeAllows(scope: ExpenseScope, channelCode: string | undefined): boolean {
  if (!channelCode) return scope.stores === "all" && scope.channels === "all";
  return (scope.channels === "all" || scope.channels.includes(channelCode)) &&
    (scope.stores === "all" || scope.stores.includes(CHANNEL_STORES[channelCode]));
}
function effectiveChannels(scope: ExpenseScope): string[] {
  return Object.keys(CHANNEL_STORES).filter((channel) => scopeAllows(scope, channel));
}
export function actionChannels(session: AdminSession, permission: "report:submit" | "report:import"): string[] {
  if (!session.authorization) return getAllowedSubmissionChannelCodes(session);
  if (!hasPermission(session, permission)) return [];
  return effectiveChannels(permission === "report:import" ? session.authorization.importScope : session.authorization.submitScope);
}
export function submissionChannels(session: AdminSession): string[] {
  return actionChannels(session, "report:submit");
}
export function canViewResource(session: AdminSession, resource: { channelCode?: string; submittedByAccountId?: string }): boolean {
  const scope = session.authorization?.viewScope;
  if (!scope) return session.role !== "manager" || (resource.submittedByAccountId === session.accountId && Boolean(resource.channelCode) && getAllowedSubmissionChannelCodes(session).includes(resource.channelCode!));
  return (scope.ownership === "any" || resource.submittedByAccountId === session.accountId) && scopeAllows(scope, resource.channelCode);
}
export function reportAccessScope(session: AdminSession): { submittedByAccountId?: string; allowedChannelCodes?: string[] } {
  const scope = session.authorization?.viewScope;
  if (!scope) return session.role === "manager" ? { submittedByAccountId: session.accountId, allowedChannelCodes: submissionChannels(session) } : {};
  return {
    ...(scope.ownership === "self" ? { submittedByAccountId: session.accountId } : {}),
    ...(scope.stores !== "all" || scope.channels !== "all" ? { allowedChannelCodes: Object.keys(CHANNEL_STORES).filter((channel) => scopeAllows(scope, channel)) } : {}),
  };
}
