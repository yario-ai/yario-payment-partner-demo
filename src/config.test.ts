import assert from "node:assert/strict";
import test from "node:test";
import { DemoBoundaryError, assertAllowedClient, loadConfig } from "./config.js";

const id = "11111111-1111-4111-8111-111111111111";
const base = {
  YARIO_API_BASE_URL: "https://integration-api.yario.ai",
  YARIO_API_KEY: "yario_test_public.secret",
  YARIO_WEBHOOK_SECRET: "12345678901234567890123456789012",
  YARIO_DEMO_INSTALLATION_IDS: id,
  YARIO_DEMO_CLIENT_IDS: id,
  DEMO_USERNAME: "demo",
  DEMO_PASSWORD: "public-demo-password"
};

test("loads a test-only allowlisted configuration", () => {
  const config = loadConfig(base);
  assert.equal(config.allowLive, false);
  assert.equal(config.resetTestData, false);
  assert.equal(config.allowedInstallationIds.has(id), true);
  assert.equal(config.secureCookies, true);
  assert.equal(config.sessionTtlSeconds, 14_400);
});

test("requires an explicit opt-in before resetting test fixtures", () => {
  assert.equal(loadConfig({ ...base, YARIO_RESET_TEST_DATA: "true" }).resetTestData, true);
});

test("refuses a live key unless explicitly enabled", () => {
  assert.throws(() => loadConfig({ ...base, YARIO_API_KEY: "yario_live_public.secret" }), /Live credentials are disabled/);
});

test("fails closed outside the demo client allowlist", () => {
  const config = loadConfig(base);
  assert.throws(() => assertAllowedClient(config, "22222222-2222-4222-8222-222222222222"), DemoBoundaryError);
});

test("rejects invalid session and cooldown configuration", () => {
  assert.throws(() => loadConfig({ ...base, DEMO_SESSION_TTL_SECONDS: "0" }), /positive integer/);
  assert.throws(() => loadConfig({ ...base, DEMO_RUN_COOLDOWN_SECONDS: "later" }), /positive integer/);
});
