import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { DemoConfig } from "./config.js";
import { createDemoHandler } from "./demo-app.js";
import { DurableEventStore } from "./store.js";
import type { ConformanceReport } from "./types.js";

const installationId = "11111111-1111-4111-8111-111111111111";
const clientId = "22222222-2222-4222-8222-222222222222";

function config(root: string): DemoConfig {
  return {
    port: 8080,
    apiBaseUrl: "https://integration-api-dev.yario.ai",
    apiKey: "yario_test_public.secret",
    webhookSecret: "12345678901234567890123456789012",
    allowedInstallationIds: new Set([installationId]),
    allowedClientIds: new Set([clientId]),
    allowLive: false,
    resetTestData: false,
    dataDir: join(root, "data"),
    reportDir: join(root, "reports"),
    demoUsername: "demo",
    demoPassword: "public-password",
    sessionTtlSeconds: 3600,
    runCooldownSeconds: 60,
    secureCookies: false,
    requestTimeoutMs: 1000,
    requestAttempts: 2
  };
}

function report(): ConformanceReport {
  return {
    schema: "yario.partner-conformance.v1",
    startedAt: "2026-07-20T00:00:00.000Z",
    completedAt: "2026-07-20T00:00:01.000Z",
    environment: "test",
    appSlug: "internal-demo-slug",
    installationId,
    passed: true,
    checks: [{
      code: "profile",
      required: true,
      status: "passed",
      durationMs: 4,
      detail: `key yario_test_public.secret installation ${installationId}`
    }]
  };
}

test("protects the demo, runs once and returns only a redacted public report", async () => {
  const root = await mkdtemp(join(tmpdir(), "yario-demo-app-"));
  let currentTime = 1_000_000;
  let runs = 0;
  const demoConfig = config(root);
  const server = createServer(createDemoHandler({
    config: demoConfig,
    store: new DurableEventStore(join(root, "events")),
    runConformance: async () => {
      runs += 1;
      return report();
    },
    processMerchantApplication: async () => {},
    now: () => currentTime
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const anonymous = await fetch(`${base}/api/session`);
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.headers.get("x-frame-options"), "DENY");
    assert.equal(anonymous.headers.get("strict-transport-security"), "max-age=31536000; includeSubDomains");

    const invalid = await fetch(`${base}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "demo", password: "wrong" })
    });
    assert.equal(invalid.status, 401);

    const login = await fetch(`${base}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "demo", password: "public-password" })
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie?.startsWith("yario_demo_session="));
    assert.equal(login.headers.get("set-cookie")?.includes("HttpOnly"), true);
    assert.equal(login.headers.get("set-cookie")?.includes("SameSite=Lax"), true);

    const run = await fetch(`${base}/api/conformance`, {
      method: "POST",
      headers: { cookie: cookie! }
    });
    assert.equal(run.status, 200);
    const publicReport = await run.json() as Record<string, unknown>;
    const serialized = JSON.stringify(publicReport);
    assert.equal(publicReport.schema, "yario.partner-demo-report.v1");
    assert.equal("installationId" in publicReport, false);
    assert.equal("appSlug" in publicReport, false);
    assert.equal(serialized.includes("yario_test_"), false);
    assert.equal(serialized.includes(installationId), false);
    assert.equal(serialized.includes("[REDACTED_API_KEY]"), true);
    assert.equal(serialized.includes("[REDACTED_ID]"), true);

    const download = await fetch(`${base}/api/report`, { headers: { cookie: cookie! } });
    assert.equal(download.status, 200);
    assert.match(download.headers.get("content-disposition") ?? "", /yario-partner-demo-report\.json/);

    const limited = await fetch(`${base}/api/conformance`, {
      method: "POST",
      headers: { cookie: cookie! }
    });
    assert.equal(limited.status, 429);
    assert.equal(runs, 1);

    currentTime += 61_000;
    const rerun = await fetch(`${base}/api/conformance`, {
      method: "POST",
      headers: { cookie: cookie! }
    });
    assert.equal(rerun.status, 200);
    assert.equal(runs, 2);

    const logout = await fetch(`${base}/api/session`, {
      method: "DELETE",
      headers: { cookie: cookie! }
    });
    assert.equal(logout.status, 200);
    const afterLogout = await fetch(`${base}/api/session`, { headers: { cookie: cookie! } });
    assert.equal(afterLogout.status, 401);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("serializes access to the shared synthetic fixture", async () => {
  const root = await mkdtemp(join(tmpdir(), "yario-demo-busy-"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const demoConfig = { ...config(root), runCooldownSeconds: 1 };
  const server = createServer(createDemoHandler({
    config: demoConfig,
    store: new DurableEventStore(join(root, "events")),
    runConformance: async () => {
      await gate;
      return report();
    },
    processMerchantApplication: async () => {}
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;

  async function login(): Promise<string> {
    const response = await fetch(`${base}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "demo", password: "public-password" })
    });
    return response.headers.get("set-cookie")!.split(";")[0]!;
  }

  try {
    const firstCookie = await login();
    const secondCookie = await login();
    const first = fetch(`${base}/api/conformance`, { method: "POST", headers: { cookie: firstCookie } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const busy = await fetch(`${base}/api/conformance`, { method: "POST", headers: { cookie: secondCookie } });
    assert.equal(busy.status, 409);
    release();
    assert.equal((await first).status, 200);
  } finally {
    release();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
