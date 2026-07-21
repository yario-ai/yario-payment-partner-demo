import { YarioApiError, YarioClient as SdkClient } from "@yario-ai/integration-sdk";
import type { CreateTicketRequest, UpdateMerchantOnboardingRequest, UpdateTicketRequest } from "@yario-ai/integration-sdk";
import type { DemoConfig } from "./config.js";
import { assertAllowedClient, assertAllowedInstallation } from "./config.js";
import type { IntegrationInstallation, IntegrationProfile, IntegrationTicket, MerchantApplication } from "./types.js";

export { YarioApiError } from "@yario-ai/integration-sdk";

/**
 * Demo-policy adapter around the official SDK.
 *
 * The SDK owns HTTP authentication, idempotency, retries and API errors. This
 * adapter adds the demo-only installation/client allowlist and preserves the
 * small interface used by the runnable conformance flow.
 */
export class YarioClient {
  private readonly sdk: SdkClient;

  constructor(private readonly config: DemoConfig, private readonly fetchImpl: typeof fetch = fetch) {
    this.sdk = new SdkClient({
      apiKey: config.apiKey,
      baseUrl: config.apiBaseUrl,
      attempts: config.requestAttempts,
      timeoutMs: config.requestTimeoutMs,
      fetch: fetchImpl,
    });
  }

  profile(): Promise<IntegrationProfile> {
    return this.sdk.getProfile() as Promise<IntegrationProfile>;
  }

  installations(): Promise<IntegrationInstallation[]> {
    return this.sdk.listInstallations() as Promise<IntegrationInstallation[]>;
  }

  resetTestData(): Promise<{ installationId: string; testClientId: string }> {
    return this.sdk.resetTestData() as Promise<{ installationId: string; testClientId: string }>;
  }

  createTicket(installationId: string, clientId: string, body: Record<string, unknown>, idempotencyKey?: string): Promise<IntegrationTicket> {
    assertAllowedInstallation(this.config, installationId);
    assertAllowedClient(this.config, clientId);
    return this.sdk.createTicket(installationId, { clientId, ...body } as CreateTicketRequest, mutationOptions(idempotencyKey)) as Promise<IntegrationTicket>;
  }

  getTicket(ticketId: string): Promise<IntegrationTicket> {
    return this.sdk.getTicket(ticketId) as Promise<IntegrationTicket>;
  }

  updateTicket(ticketId: string, body: Record<string, unknown>, idempotencyKey?: string): Promise<IntegrationTicket> {
    return this.sdk.updateTicket(ticketId, body as UpdateTicketRequest, mutationOptions(idempotencyKey)) as Promise<IntegrationTicket>;
  }

  addMessage(ticketId: string, content: string, idempotencyKey?: string): Promise<Record<string, unknown>> {
    return this.sdk.createMessage(ticketId, { content, attachments: [] }, mutationOptions(idempotencyKey)) as unknown as Promise<Record<string, unknown>>;
  }

  messages(ticketId: string): Promise<Record<string, unknown>[]> {
    return this.sdk.listMessages(ticketId) as unknown as Promise<Record<string, unknown>[]>;
  }

  merchantApplications(installationId: string): Promise<MerchantApplication[]> {
    assertAllowedInstallation(this.config, installationId);
    return this.sdk.listMerchantOnboardingApplications(installationId) as Promise<MerchantApplication[]>;
  }

  getMerchantApplication(installationId: string, applicationId: string): Promise<MerchantApplication> {
    assertAllowedInstallation(this.config, installationId);
    return this.sdk.getMerchantOnboardingApplication(installationId, applicationId) as Promise<MerchantApplication>;
  }

  updateMerchantApplication(installationId: string, applicationId: string, status: string, review: Record<string, unknown>, idempotencyKey?: string): Promise<MerchantApplication> {
    assertAllowedInstallation(this.config, installationId);
    return this.sdk.updateMerchantOnboardingApplication(
      installationId,
      applicationId,
      { status, review } as UpdateMerchantOnboardingRequest,
      mutationOptions(idempotencyKey),
    ) as Promise<MerchantApplication>;
  }

  async raw(path: string, init: { method?: string; idempotencyKey?: string; body?: unknown } = {}): Promise<Response> {
    const request: RequestInit = {
      method: init.method ?? "GET",
      headers: {
        "Api-Key": this.config.apiKey,
        Accept: "application/json",
        ...(init.idempotencyKey ? { "Idempotency-Key": init.idempotencyKey } : {}),
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
    };
    if (init.body !== undefined) request.body = JSON.stringify(init.body);
    return this.fetchImpl(`${this.config.apiBaseUrl}${path}`, request);
  }
}

function mutationOptions(idempotencyKey?: string): { idempotencyKey?: string } {
  return idempotencyKey ? { idempotencyKey } : {};
}
