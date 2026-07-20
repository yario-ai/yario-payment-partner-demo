import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { DemoConfig } from "./config.js";
import { DemoBoundaryError } from "./config.js";
import type { ConformanceCheck, ConformanceReport } from "./types.js";
import { WebhookError, verifyAndClaimWebhook } from "./webhook.js";
import type { DurableEventStore } from "./store.js";

const MAX_BODY_BYTES = 16_384;
const LOGIN_WINDOW_MS = 10 * 60_000;
const LOGIN_ATTEMPTS = 12;

export interface DemoAppDependencies {
  config: DemoConfig;
  store: DurableEventStore;
  runConformance: () => Promise<ConformanceReport>;
  processMerchantApplication: (event: { installationId: string; data: Record<string, unknown> }) => Promise<void>;
  publicDir?: string;
  now?: () => number;
}

interface Session {
  expiresAt: number;
  lastRunAt: number;
  report?: PublicConformanceReport;
}

interface PublicConformanceReport {
  schema: "yario.partner-demo-report.v1";
  startedAt: string;
  completedAt: string;
  environment: "test";
  passed: boolean;
  checks: ConformanceCheck[];
}

export function createDemoHandler(deps: DemoAppDependencies) {
  const sessions = new Map<string, Session>();
  const loginAttempts = new Map<string, number[]>();
  const now = deps.now ?? Date.now;
  const publicDir = deps.publicDir ?? join(process.cwd(), "public");
  let activeRun = false;

  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      securityHeaders(response);
      const url = new URL(request.url ?? "/", "http://localhost");

      if (request.method === "GET" && url.pathname === "/health") {
        return json(response, 200, { status: "ok", demoOnly: true });
      }
      if (request.method === "GET" && url.pathname === "/") {
        return asset(response, join(publicDir, "index.html"), "text/html; charset=utf-8");
      }
      if (request.method === "GET" && url.pathname === "/assets/app.css") {
        return asset(response, join(publicDir, "app.css"), "text/css; charset=utf-8");
      }
      if (request.method === "GET" && url.pathname === "/assets/app.js") {
        return asset(response, join(publicDir, "app.js"), "text/javascript; charset=utf-8");
      }
      if (request.method === "POST" && url.pathname === "/api/session") {
        const key = request.socket.remoteAddress ?? "unknown";
        const recent = (loginAttempts.get(key) ?? []).filter((item) => item > now() - LOGIN_WINDOW_MS);
        if (recent.length >= LOGIN_ATTEMPTS) {
          response.setHeader("retry-after", "600");
          return json(response, 429, { error: "login_rate_limited" });
        }
        const body = await readJson(request);
        if (!sameSecret(body.username, deps.config.demoUsername) || !sameSecret(body.password, deps.config.demoPassword)) {
          recent.push(now());
          loginAttempts.set(key, recent);
          return json(response, 401, { error: "invalid_credentials" });
        }
        loginAttempts.delete(key);
        const token = randomBytes(32).toString("base64url");
        sessions.set(hashToken(token), { expiresAt: now() + deps.config.sessionTtlSeconds * 1_000, lastRunAt: 0 });
        response.setHeader("set-cookie", sessionCookie(token, deps.config));
        return json(response, 200, { authenticated: true });
      }
      if (request.method === "DELETE" && url.pathname === "/api/session") {
        const token = cookie(request, "yario_demo_session");
        if (token) sessions.delete(hashToken(token));
        response.setHeader("set-cookie", expiredSessionCookie(deps.config));
        return json(response, 200, { authenticated: false });
      }
      if (request.method === "POST" && url.pathname === "/webhooks/yario") {
        const rawBody = await readBody(request, 1_048_576);
        const result = await verifyAndClaimWebhook(deps.config, deps.store, rawBody, {
          eventId: header(request, "x-yario-event-id"),
          timestamp: header(request, "x-yario-timestamp"),
          signature: header(request, "x-yario-signature")
        });
        if (result.status === "processed" && result.event.type.startsWith("merchant_onboarding.")) {
          await deps.processMerchantApplication(result.event);
        }
        return json(response, 202, { status: result.status });
      }

      const session = authenticate(request, sessions, now());
      if (!session) return json(response, 401, { error: "authentication_required" });

      if (request.method === "GET" && url.pathname === "/api/session") {
        return json(response, 200, { authenticated: true, demoOnly: true, environment: "test" });
      }
      if (request.method === "GET" && url.pathname === "/api/report") {
        if (!session.report) return json(response, 404, { error: "report_not_available" });
        response.setHeader("content-disposition", 'attachment; filename="yario-partner-demo-report.json"');
        return json(response, 200, session.report);
      }
      if (request.method === "POST" && url.pathname === "/api/conformance") {
        const elapsed = now() - session.lastRunAt;
        const cooldownMs = deps.config.runCooldownSeconds * 1_000;
        if (session.lastRunAt > 0 && elapsed < cooldownMs) {
          response.setHeader("retry-after", String(Math.ceil((cooldownMs - elapsed) / 1_000)));
          return json(response, 429, { error: "run_rate_limited" });
        }
        if (activeRun) return json(response, 409, { error: "demo_busy" });
        session.lastRunAt = now();
        activeRun = true;
        try {
          const report = toPublicReport(await deps.runConformance());
          session.report = report;
          return json(response, 200, report);
        } finally {
          activeRun = false;
        }
      }
      return json(response, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof SyntaxError) return json(response, 400, { error: "invalid_json" });
      if (error instanceof WebhookError) return json(response, error.statusCode, { error: error.code });
      if (error instanceof DemoBoundaryError) return json(response, 403, { error: error.code });
      console.error(JSON.stringify({
        level: "error",
        event: "request_failed",
        error: error instanceof Error ? error.name : "UnknownError"
      }));
      return json(response, 500, { error: "internal_error" });
    }
  };
}

function toPublicReport(report: ConformanceReport): PublicConformanceReport {
  return {
    schema: "yario.partner-demo-report.v1",
    startedAt: report.startedAt,
    completedAt: report.completedAt,
    environment: "test",
    passed: report.passed,
    checks: report.checks.map((check) => ({
      code: check.code,
      required: check.required,
      status: check.status,
      durationMs: check.durationMs,
      ...(check.remediation ? { remediation: redact(check.remediation) } : {}),
      ...(check.detail ? { detail: redact(check.detail) } : {})
    }))
  };
}

function redact(value: string): string {
  return value
    .replace(/yario_(test|live)_[A-Za-z0-9._-]+/gi, "[REDACTED_API_KEY]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "[REDACTED_ID]");
}

function authenticate(request: IncomingMessage, sessions: Map<string, Session>, currentTime: number): Session | undefined {
  const token = cookie(request, "yario_demo_session");
  if (!token) return undefined;
  const key = hashToken(token);
  const session = sessions.get(key);
  if (!session) return undefined;
  if (session.expiresAt <= currentTime) {
    sessions.delete(key);
    return undefined;
  }
  return session;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function sameSecret(value: unknown, expected: string): boolean {
  const actual = Buffer.from(typeof value === "string" ? value : "");
  const reference = Buffer.from(expected);
  return actual.length === reference.length && timingSafeEqual(actual, reference);
}

function sessionCookie(token: string, config: DemoConfig): string {
  return `yario_demo_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${config.sessionTtlSeconds}${config.secureCookies ? "; Secure" : ""}`;
}

function expiredSessionCookie(config: DemoConfig): string {
  return `yario_demo_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${config.secureCookies ? "; Secure" : ""}`;
}

function cookie(request: IncomingMessage, name: string): string | undefined {
  const values = request.headers.cookie?.split(";") ?? [];
  for (const value of values) {
    const [key, ...rest] = value.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(request, MAX_BODY_BYTES);
  return JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new WebhookError(413, "payload_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function asset(response: ServerResponse, path: string, contentType: string): Promise<void> {
  try {
    const payload = await readFile(path);
    response.writeHead(200, {
      "content-type": contentType,
      "content-length": payload.byteLength,
      "cache-control": contentType.startsWith("text/html") ? "no-store" : "public, max-age=3600"
    });
    response.end(payload);
  } catch {
    json(response, 404, { error: "asset_not_found" });
  }
}

function securityHeaders(response: ServerResponse): void {
  response.setHeader("content-security-policy", "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
}

function json(response: ServerResponse, status: number, body: object): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store"
  });
  response.end(payload);
}
