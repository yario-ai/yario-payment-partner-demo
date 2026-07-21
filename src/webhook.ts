import {
  signWebhook as sdkSignWebhook,
  verifyWebhook,
  YarioWebhookError,
} from "@yario-ai/integration-sdk";
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
  return sdkSignWebhook(secret, String(timestamp), rawBody);
}

export async function verifyAndClaimWebhook(
  config: DemoConfig,
  store: DurableEventStore,
  rawBody: Buffer,
  headers: WebhookHeaders,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<WebhookResult> {
  let event: YarioEvent;
  try {
    const sdkHeaders: Record<string, string> = {};
    if (headers.eventId) sdkHeaders["x-yario-event-id"] = headers.eventId;
    if (headers.timestamp) sdkHeaders["x-yario-timestamp"] = headers.timestamp;
    if (headers.signature) sdkHeaders["x-yario-signature"] = headers.signature;
    event = await verifyWebhook({
      secret: config.webhookSecret,
      rawBody,
      headers: sdkHeaders,
      nowSeconds,
    }) as YarioEvent;
  } catch (error) {
    if (!(error instanceof YarioWebhookError)) throw error;
    const mapped = {
      missing_headers: [400, "missing_webhook_headers"],
      stale_timestamp: [401, "stale_webhook_timestamp"],
      invalid_signature: [401, "invalid_webhook_signature"],
      invalid_payload: [400, "invalid_json"],
      event_id_mismatch: [400, "event_id_mismatch"],
      duplicate_event: [409, "duplicate_event"],
    } as const;
    const [status, code] = mapped[error.code];
    throw new WebhookError(status, code);
  }
  assertAllowedInstallation(config, event.installationId);
  const claimed = await store.claim(event.eventId);
  if (!claimed) return { status: "duplicate", event };
  const supported = new Set([
    "ticket.updated",
    "ticket.message.created",
    "merchant_onboarding.application.created",
    "merchant_onboarding.application.updated",
  ]);
  return { status: supported.has(event.type) ? "processed" : "ignored", event };
}
