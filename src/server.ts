import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir } from "node:fs/promises";
import { loadConfig, DemoBoundaryError } from "./config.js";
import { DurableEventStore } from "./store.js";
import { verifyAndClaimWebhook, WebhookError } from "./webhook.js";
import { YarioClient } from "./yario-client.js";

const config = loadConfig();
await mkdir(config.dataDir, { recursive: true });
const store = new DurableEventStore(config.dataDir);
const client = new YarioClient(config);

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") {
      return json(response, 200, { status: "ok", demoOnly: true });
    }
    if (request.method === "POST" && request.url === "/webhooks/yario") {
      const rawBody = await readBody(request);
      const result = await verifyAndClaimWebhook(config, store, rawBody, {
        eventId: header(request, "x-yario-event-id"),
        timestamp: header(request, "x-yario-timestamp"),
        signature: header(request, "x-yario-signature")
      });
      if (result.status === "processed" && result.event.type.startsWith("merchant_onboarding.")) {
        await processMerchantApplication(result.event);
      }
      return json(response, 202, { status: result.status });
    }
    return json(response, 404, { error: "not_found" });
  } catch (error) {
    if (error instanceof WebhookError) return json(response, error.statusCode, { error: error.code });
    if (error instanceof DemoBoundaryError) return json(response, 403, { error: error.code });
    console.error(JSON.stringify({ level: "error", event: "request_failed", error: error instanceof Error ? error.name : "UnknownError" }));
    return json(response, 500, { error: "internal_error" });
  }
});

server.listen(config.port, "0.0.0.0", () => {
  console.log(JSON.stringify({ level: "info", event: "server_started", port: config.port, demoOnly: true }));
});

async function processMerchantApplication(event: { installationId: string; data: Record<string, unknown> }): Promise<void> {
  const applicationId = typeof event.data.applicationId === "string"
    ? event.data.applicationId
    : typeof event.data.resource === "object" && event.data.resource && "id" in event.data.resource
      ? String((event.data.resource as { id: unknown }).id)
      : undefined;
  if (!applicationId) return;
  const application = await client.getMerchantApplication(event.installationId, applicationId);
  if (application.status !== "Submitted") return;
  await client.updateMerchantApplication(event.installationId, application.id, "UnderReview", {
    provider: "yario-payment-partner-demo",
    demoOnly: true,
    reasonCode: "synthetic_review_started",
    reviewedAt: new Date().toISOString()
  }, `demo-webhook-${event.installationId}-${application.id}`);
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_048_576) throw new WebhookError(413, "payload_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function json(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store"
  });
  response.end(payload);
}
