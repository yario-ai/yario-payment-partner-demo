import { resolve } from "node:path";

export interface DemoConfig {
  port: number;
  apiBaseUrl: string;
  apiKey: string;
  webhookSecret: string;
  allowedInstallationIds: ReadonlySet<string>;
  allowedClientIds: ReadonlySet<string>;
  allowLive: boolean;
  dataDir: string;
  reportDir: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function uuidSet(env: NodeJS.ProcessEnv, name: string): ReadonlySet<string> {
  const values = required(env, name)
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (values.length === 0) throw new Error(`${name} must contain at least one UUID`);
  for (const value of values) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
      throw new Error(`${name} contains an invalid UUID`);
    }
  }
  return new Set(values);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DemoConfig {
  const apiKey = required(env, "YARIO_API_KEY");
  const mode = apiKey.startsWith("yario_test_") ? "test" : apiKey.startsWith("yario_live_") ? "live" : "invalid";
  const allowLive = env.YARIO_ALLOW_LIVE?.toLowerCase() === "true";
  if (mode === "invalid") throw new Error("YARIO_API_KEY must use yario_test_ or yario_live_ format");
  if (mode === "live" && !allowLive) {
    throw new Error("Live credentials are disabled. This demo is test-only unless YARIO_ALLOW_LIVE=true is explicitly set.");
  }
  const webhookSecret = required(env, "YARIO_WEBHOOK_SECRET");
  if (Buffer.byteLength(webhookSecret, "utf8") < 32) {
    throw new Error("YARIO_WEBHOOK_SECRET must contain at least 32 bytes");
  }
  const port = Number(env.PORT ?? "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port");
  const apiBaseUrl = new URL(required(env, "YARIO_API_BASE_URL"));
  if (apiBaseUrl.protocol !== "https:" && apiBaseUrl.hostname !== "localhost" && apiBaseUrl.hostname !== "127.0.0.1") {
    throw new Error("YARIO_API_BASE_URL must use HTTPS outside localhost");
  }
  return {
    port,
    apiBaseUrl: apiBaseUrl.toString().replace(/\/$/, ""),
    apiKey,
    webhookSecret,
    allowedInstallationIds: uuidSet(env, "YARIO_DEMO_INSTALLATION_IDS"),
    allowedClientIds: uuidSet(env, "YARIO_DEMO_CLIENT_IDS"),
    allowLive,
    dataDir: resolve(env.YARIO_DATA_DIR ?? "./data"),
    reportDir: resolve(env.YARIO_REPORT_DIR ?? "./reports")
  };
}

export function assertAllowedInstallation(config: DemoConfig, id: string): void {
  if (!config.allowedInstallationIds.has(id.toLowerCase())) {
    throw new DemoBoundaryError("installation_not_allowlisted");
  }
}

export function assertAllowedClient(config: DemoConfig, id: string): void {
  if (!config.allowedClientIds.has(id.toLowerCase())) {
    throw new DemoBoundaryError("client_not_allowlisted");
  }
}

export class DemoBoundaryError extends Error {
  constructor(public readonly code: string) {
    super("The requested resource is outside the configured demo boundary.");
  }
}
