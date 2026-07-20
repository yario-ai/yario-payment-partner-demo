import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { DemoConfig } from "./config.js";
import { DurableEventStore } from "./store.js";
import type { ConformanceCheck, ConformanceReport, IntegrationInstallation } from "./types.js";
import { signWebhook, verifyAndClaimWebhook, WebhookError } from "./webhook.js";
import { YarioApiError, YarioClient } from "./yario-client.js";

export async function runConformance(config: DemoConfig, client = new YarioClient(config)): Promise<ConformanceReport> {
  const startedAt = new Date();
  const checks: ConformanceCheck[] = [];
  let environment: string | undefined;
  let appSlug: string | undefined;
  let selected: IntegrationInstallation | undefined;

  await check(checks, "profile", true, async () => {
    const profile = await client.profile();
    environment = profile.environment;
    appSlug = profile.appSlug;
    if (profile.environment === "live" && !config.allowLive) throw new Error("Live profile is forbidden by demo policy");
  }, "Verify YARIO_API_KEY and its environment.");

  await check(checks, "installation.discovery", true, async () => {
    const installations = await client.installations();
    selected = installations.find((item) => config.allowedInstallationIds.has(item.id.toLowerCase()));
    if (!selected) throw new Error("No API installation matches YARIO_DEMO_INSTALLATION_IDS");
  }, "Add an installation returned by /v1/installations to YARIO_DEMO_INSTALLATION_IDS.");

  if (environment === "test") {
    await check(checks, "test.reset", true, async () => {
      const reset = await client.resetTestData();
      if (!config.allowedInstallationIds.has(reset.installationId.toLowerCase())) {
        throw new Error("Reset returned an installation outside the demo allowlist");
      }
      if (!config.allowedClientIds.has(reset.testClientId.toLowerCase())) {
        throw new Error("Reset returned a client outside the demo allowlist");
      }
    }, "Use the installationId and testClientId returned by the current test environment.");
    const installations = await client.installations();
    selected = installations.find((item) => config.allowedInstallationIds.has(item.id.toLowerCase()));
  }

  let ticketId: string | undefined;
  const clientId = selected?.testClientId && config.allowedClientIds.has(selected.testClientId.toLowerCase())
    ? selected.testClientId
    : [...config.allowedClientIds][0];
  const idempotencyKey = `demo-ticket-${randomUUID()}`;
  const ticketBody = {
    summary: "Demo payment partner conformance",
    description: "Synthetic data only",
    externalReference: `demo-${randomUUID()}`,
    priority: "Regular",
    attachments: []
  };

  await check(checks, "ticket.create", true, async () => {
    if (!selected || !clientId) throw new Error("No demo installation/client is available");
    const ticket = await client.createTicket(selected.id, clientId, ticketBody, idempotencyKey);
    ticketId = ticket.id;
  }, "Confirm tickets:write and that the client belongs to the selected installation.");

  await check(checks, "idempotency.replay", true, async () => {
    if (!selected || !clientId || !ticketId) throw new Error("Ticket prerequisite failed");
    const replay = await client.createTicket(selected.id, clientId, ticketBody, idempotencyKey);
    if (replay.id !== ticketId) throw new Error("Replay returned a different ticket");
  }, "Retry the identical request with the identical Idempotency-Key.");

  await check(checks, "idempotency.conflict", true, async () => {
    if (!selected || !clientId) throw new Error("Ticket prerequisite failed");
    try {
      await client.createTicket(selected.id, clientId, { ...ticketBody, summary: "Changed body" }, idempotencyKey);
      throw new Error("Changed body unexpectedly succeeded");
    } catch (error) {
      if (!(error instanceof YarioApiError) || error.status !== 409) throw error;
    }
  }, "Do not reuse an Idempotency-Key with a different request body.");

  await check(checks, "ticket.read-update", true, async () => {
    if (!ticketId) throw new Error("Ticket prerequisite failed");
    await client.getTicket(ticketId);
    await client.updateTicket(ticketId, { status: "WaitingForManager" }, `demo-ticket-update-${randomUUID()}`);
  }, "Confirm tickets:read and tickets:write scopes.");

  await check(checks, "message.roundtrip", true, async () => {
    if (!ticketId) throw new Error("Ticket prerequisite failed");
    await client.addMessage(ticketId, "Synthetic conformance message", `demo-message-${randomUUID()}`);
    const messages = await client.messages(ticketId);
    if (messages.length === 0) throw new Error("No messages were returned");
  }, "Confirm messages:read and messages:write scopes.");

  await check(checks, "isolation.random-resource", true, async () => {
    const response = await client.raw(`/v1/tickets/${randomUUID()}`);
    if (response.status !== 404) throw new Error(`Expected 404, received ${response.status}`);
  }, "Mask resources outside the credential environment with 404.");

  const merchantRequired = selected?.capabilities.includes("merchant_onboarding") ?? false;
  await check(checks, "merchant-onboarding.roundtrip", merchantRequired, async () => {
    if (!selected) throw new Error("Installation prerequisite failed");
    const applications = await client.merchantApplications(selected.id);
    const application = applications[0];
    if (!application) throw new Error("No synthetic merchant application is available");
    await client.updateMerchantApplication(selected.id, application.id, "UnderReview", {
      provider: "yario-payment-partner-demo",
      demoOnly: true,
      reasonCode: "synthetic_review_started"
    }, `demo-kyc-${randomUUID()}`);
  }, "Enable merchant_onboarding and process the synthetic fixture.");

  await runWebhookChecks(config, checks, selected?.id);

  const report: ConformanceReport = {
    schema: "yario.partner-conformance.v1",
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    ...(environment ? { environment } : {}),
    ...(appSlug ? { appSlug } : {}),
    ...(selected ? { installationId: selected.id } : {}),
    passed: checks.every((item) => !item.required || item.status === "passed"),
    checks
  };
  await writeReports(config, report);
  return report;
}

async function runWebhookChecks(config: DemoConfig, checks: ConformanceCheck[], installationId?: string): Promise<void> {
  if (!installationId) {
    checks.push({
      code: "webhook.fixtures",
      required: true,
      status: "failed",
      durationMs: 0,
      remediation: "Complete installation discovery before webhook checks."
    });
    return;
  }
  const store = new DurableEventStore(join(config.dataDir, `conformance-${randomUUID()}`));
  const event = {
    eventId: randomUUID(),
    type: "ticket.updated",
    createdAt: new Date().toISOString(),
    installationId,
    data: { ticketId: randomUUID(), testData: true }
  };
  const body = Buffer.from(JSON.stringify(event));
  const timestamp = Math.floor(Date.now() / 1_000);
  const headers = { eventId: event.eventId, timestamp: String(timestamp), signature: signWebhook(config.webhookSecret, timestamp, body) };

  await check(checks, "webhook.valid-signature", true, async () => {
    const result = await verifyAndClaimWebhook(config, store, body, headers, timestamp);
    if (result.status !== "processed") throw new Error("Valid webhook was not processed");
  }, "Verify the HMAC over timestamp and exact raw body.");
  await check(checks, "webhook.duplicate", true, async () => {
    const result = await verifyAndClaimWebhook(config, store, body, headers, timestamp);
    if (result.status !== "duplicate") throw new Error("Duplicate event was not deduplicated");
  }, "Persist eventId before starting a business side effect.");
  await expectWebhookFailure(checks, "webhook.invalid-signature", config, store, body, { ...headers, signature: "v1=".padEnd(67, "0") }, timestamp, "invalid_webhook_signature");
  await expectWebhookFailure(checks, "webhook.stale-timestamp", config, store, body, { ...headers, timestamp: String(timestamp - 301), signature: signWebhook(config.webhookSecret, timestamp - 301, body) }, timestamp, "stale_webhook_timestamp");

  const unknown = { ...event, eventId: randomUUID(), type: "future.event" };
  const unknownBody = Buffer.from(JSON.stringify(unknown));
  await check(checks, "webhook.unknown-event", true, async () => {
    const result = await verifyAndClaimWebhook(config, store, unknownBody, {
      eventId: unknown.eventId,
      timestamp: String(timestamp),
      signature: signWebhook(config.webhookSecret, timestamp, unknownBody)
    }, timestamp);
    if (result.status !== "ignored") throw new Error("Unknown event was not safely acknowledged");
  }, "Persist and acknowledge unknown event types without a business side effect.");
}

async function expectWebhookFailure(
  checks: ConformanceCheck[],
  code: string,
  config: DemoConfig,
  store: DurableEventStore,
  body: Buffer,
  headers: { eventId: string; timestamp: string; signature: string },
  now: number,
  expectedCode: string
): Promise<void> {
  await check(checks, code, true, async () => {
    try {
      await verifyAndClaimWebhook(config, store, body, headers, now);
      throw new Error("Invalid webhook unexpectedly succeeded");
    } catch (error) {
      if (!(error instanceof WebhookError) || error.code !== expectedCode) throw error;
    }
  }, `Reject webhook with ${expectedCode}.`);
}

async function check(
  checks: ConformanceCheck[],
  code: string,
  required: boolean,
  operation: () => Promise<void>,
  remediation: string
): Promise<void> {
  if (!required) {
    checks.push({ code, required: false, status: "skipped", durationMs: 0, remediation });
    return;
  }
  const started = performance.now();
  try {
    await operation();
    checks.push({ code, required, status: "passed", durationMs: Math.round(performance.now() - started) });
  } catch (error) {
    checks.push({
      code,
      required,
      status: "failed",
      durationMs: Math.round(performance.now() - started),
      remediation,
      detail: safeError(error)
    });
  }
}

function safeError(error: unknown): string {
  if (error instanceof YarioApiError) return `HTTP ${error.status}${error.traceId ? ` traceId=${error.traceId}` : ""}`;
  if (error instanceof Error) return error.message.replace(/yario_(test|live)_[A-Za-z0-9._-]+/g, "[REDACTED_API_KEY]");
  return "Unknown error";
}

async function writeReports(config: DemoConfig, report: ConformanceReport): Promise<void> {
  await mkdir(config.reportDir, { recursive: true });
  await writeFile(join(config.reportDir, "conformance.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  const cases = report.checks.map((item) => {
    const failure = item.status === "failed"
      ? `<failure message="${xml(item.remediation ?? "Check failed")}">${xml(item.detail ?? "")}</failure>`
      : item.status === "skipped" ? "<skipped/>" : "";
    return `<testcase name="${xml(item.code)}" time="${(item.durationMs / 1_000).toFixed(3)}">${failure}</testcase>`;
  }).join("");
  const failed = report.checks.filter((item) => item.status === "failed").length;
  await writeFile(join(config.reportDir, "conformance.junit.xml"),
    `<?xml version="1.0" encoding="UTF-8"?><testsuite name="Yario partner conformance" tests="${report.checks.length}" failures="${failed}">${cases}</testsuite>\n`,
    { mode: 0o600 });
}

function xml(value: string): string {
  return value.replace(/[<>&"']/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "\"": "&quot;", "'": "&apos;" })[character]!);
}
