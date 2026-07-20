import { createHmac, timingSafeEqual } from "node:crypto";
import type { DemoConfig } from "./config.js";
import { assertAllowedInstallation } from "./config.js";
import type { DurableEventStore } from "./store.js";
import type { YarioEvent } from "./types.js";

export interface WebhookHeaders {
  eventId: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
}

export interface WebhookResult {
  status: "processed" | "duplicate" | "ignored";
  event: YarioEvent;
}

export class WebhookError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string) {
    super(code);
  }
}

export function signWebhook(secret: string, timestamp: number, rawBody: Buffer): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("hex")}`;
}

export async function verifyAndClaimWebhook(
  config: DemoConfig,
  store: DurableEventStore,
  rawBody: Buffer,
  headers: WebhookHeaders,
  nowSeconds = Math.floor(Date.now() / 1_000)
): Promise<WebhookResult> {
  if (!headers.eventId || !headers.timestamp || !headers.signature) {
    throw new WebhookError(400, "missing_webhook_headers");
  }
  const timestamp = Number(headers.timestamp);
  if (!Number.isInteger(timestamp) || Math.abs(nowSeconds - timestamp) > 300) {
    throw new WebhookError(401, "stale_webhook_timestamp");
  }
  const expected = Buffer.from(signWebhook(config.webhookSecret, timestamp, rawBody));
  const actual = Buffer.from(headers.signature.toLowerCase());
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new WebhookError(401, "invalid_webhook_signature");
  }
  let event: YarioEvent;
  try {
    event = JSON.parse(rawBody.toString("utf8")) as YarioEvent;
  } catch {
    throw new WebhookError(400, "invalid_json");
  }
  if (event.eventId !== headers.eventId) throw new WebhookError(400, "event_id_mismatch");
  assertAllowedInstallation(config, event.installationId);
  const claimed = await store.claim(event.eventId);
  if (!claimed) return { status: "duplicate", event };
  const supported = new Set([
    "ticket.updated",
    "ticket.message.created",
    "merchant_onboarding.application.created",
    "merchant_onboarding.application.updated"
  ]);
  return { status: supported.has(event.type) ? "processed" : "ignored", event };
}
