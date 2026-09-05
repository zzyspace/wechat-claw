import type { RequestHandler } from "express";
import type { AdminSession } from "./auth.js";
import { validateExpenseAuthorization } from "./authorization.js";

export interface GatewayAuthConfig { mode: "legacy" | "unified"; url: string; token: string }
export function gatewayAuthConfig(env: NodeJS.ProcessEnv = process.env): GatewayAuthConfig {
  const mode = env.ADMIN_AUTH_MODE ?? "legacy";
  if (mode !== "legacy" && mode !== "unified") throw new Error("Invalid ADMIN_AUTH_MODE.");
  const url = env.ADMIN_AUTH_GATEWAY_URL ?? "http://127.0.0.1:8790";
  const token = env.ADMIN_AUTH_INTERNAL_TOKEN ?? "";
  if (mode === "unified") {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(parsed.hostname) ||
        parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash ||
        !/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error("Invalid internal gateway configuration.");
  }
  return { mode, url, token };
}
export function createGatewayAuth(config: GatewayAuthConfig): RequestHandler {
  return async (request, response, next) => {
    response.set("Cache-Control", "no-store");
    try {
      const reply = await fetch(`${config.url.replace(/\/$/, "")}/internal/authorization/expense`, {
        redirect: "error", signal: AbortSignal.timeout(2000),
        headers: {
          Authorization: `Bearer ${config.token}`, Cookie: request.get("Cookie") ?? "",
          "X-Original-Method": request.method, "X-Original-Host": request.get("Host") ?? "",
          "X-Original-Proto": request.protocol, "X-Original-Origin": request.get("Origin") ?? "",
        },
      });
      if (!reply.ok) {
        await reply.body?.cancel();
        const status = [401, 403].includes(reply.status) ? reply.status : 503;
        response.status(status).json({ success: false, error: { message: status === 503 ? "登录服务暂不可用。" : "登录已失效或无权访问。" } });
        return;
      }
      const session: AdminSession = validateExpenseAuthorization(await reply.json());
      response.locals.adminSession = session;
      next();
    } catch {
      response.status(503).json({ success: false, error: { message: "登录服务或权限配置暂不可用。" } });
    }
  };
}
