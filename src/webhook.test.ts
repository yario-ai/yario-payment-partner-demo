import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { loadConfig } from "./config.js";
import { DurableEventStore } from "./store.js";
import { signWebhook, verifyAndClaimWebhook, WebhookError } from "./webhook.js";

const installationId = "11111111-1111-4111-8111-111111111111";
const config = loadConfig({
  YARIO_API_BASE_URL: "https://integration-api.yario.ai",
  YARIO_API_KEY: "yario_test_public.secret",
  YARIO_WEBHOOK_SECRET: "12345678901234567890123456789012",
  YARIO_DEMO_INSTALLATION_IDS: installationId,
  YARIO_DEMO_CLIENT_IDS: "22222222-2222-4222-8222-222222222222",
  DEMO_USERNAME: "demo",
  DEMO_PASSWORD: "public-password"
});

test("verifies exact bytes and durably deduplicates eventId", async () => {
  const store = new DurableEventStore(await mkdtemp(join(tmpdir(), "yario-event-test-")));
  const event = { eventId: randomUUID(), type: "ticket.updated", createdAt: new Date().toISOString(), installationId, data: {} };
  const body = Buffer.from(JSON.stringify(event));
  const timestamp = 1_800_000_000;
  const headers = { eventId: event.eventId, timestamp: String(timestamp), signature: signWebhook(config.webhookSecret, timestamp, body) };
  assert.equal((await verifyAndClaimWebhook(config, store, body, headers, timestamp)).status, "processed");
  assert.equal((await verifyAndClaimWebhook(config, store, body, headers, timestamp)).status, "duplicate");
});

test("rejects an invalid signature before parsing a business event", async () => {
  const store = new DurableEventStore(await mkdtemp(join(tmpdir(), "yario-event-test-")));
  const body = Buffer.from("{}");
  await assert.rejects(
    verifyAndClaimWebhook(config, store, body, {
      eventId: randomUUID(),
      timestamp: "1800000000",
      signature: "v1=".padEnd(67, "0")
    }, 1_800_000_000),
    (error: unknown) => error instanceof WebhookError && error.code === "invalid_webhook_signature"
  );
});
