import { randomUUID } from "node:crypto";
import type { DemoConfig } from "./config.js";
import { assertAllowedClient, assertAllowedInstallation } from "./config.js";
import type { IntegrationInstallation, IntegrationProfile, IntegrationTicket, MerchantApplication } from "./types.js";

export class YarioApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly traceId?: string,
    message = `Yario API returned HTTP ${status}`
  ) {
    super(message);
  }
}

export class YarioClient {
  constructor(private readonly config: DemoConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  profile(): Promise<IntegrationProfile> {
    return this.request("/v1/me");
  }

  installations(): Promise<IntegrationInstallation[]> {
    return this.request("/v1/installations");
  }

  resetTestData(): Promise<{ installationId: string; testClientId: string }> {
    return this.request("/v1/test/reset", { method: "POST" });
  }

  createTicket(installationId: string, clientId: string, body: Record<string, unknown>, idempotencyKey: string = randomUUID()): Promise<IntegrationTicket> {
    assertAllowedInstallation(this.config, installationId);
    assertAllowedClient(this.config, clientId);
    return this.request(`/v1/installations/${installationId}/tickets`, {
      method: "POST",
      idempotencyKey,
      body: { clientId, ...body }
    });
  }

  getTicket(ticketId: string): Promise<IntegrationTicket> {
    return this.request(`/v1/tickets/${ticketId}`);
  }

  updateTicket(ticketId: string, body: Record<string, unknown>, idempotencyKey: string = randomUUID()): Promise<IntegrationTicket> {
    return this.request(`/v1/tickets/${ticketId}`, { method: "PATCH", idempotencyKey, body });
  }

  addMessage(ticketId: string, content: string, idempotencyKey: string = randomUUID()): Promise<Record<string, unknown>> {
    return this.request(`/v1/tickets/${ticketId}/messages`, {
      method: "POST",
      idempotencyKey,
      body: { content, attachments: [] }
    });
  }

  messages(ticketId: string): Promise<Record<string, unknown>[]> {
    return this.request(`/v1/tickets/${ticketId}/messages`);
  }

  merchantApplications(installationId: string): Promise<MerchantApplication[]> {
    assertAllowedInstallation(this.config, installationId);
    return this.request(`/v1/installations/${installationId}/merchant-onboarding/applications`);
  }

  getMerchantApplication(installationId: string, applicationId: string): Promise<MerchantApplication> {
    assertAllowedInstallation(this.config, installationId);
    return this.request(`/v1/installations/${installationId}/merchant-onboarding/applications/${applicationId}`);
  }

  updateMerchantApplication(
    installationId: string,
    applicationId: string,
    status: string,
    review: Record<string, unknown>,
    idempotencyKey: string = randomUUID()
  ): Promise<MerchantApplication> {
    assertAllowedInstallation(this.config, installationId);
    return this.request(`/v1/installations/${installationId}/merchant-onboarding/applications/${applicationId}`, {
      method: "PATCH",
      idempotencyKey,
      body: { status, review }
    });
  }

  async raw(path: string, init: { method?: string; idempotencyKey?: string; body?: unknown } = {}): Promise<Response> {
    const request: RequestInit = {
      method: init.method ?? "GET",
      headers: {
        "Api-Key": this.config.apiKey,
        Accept: "application/json",
        ...(init.idempotencyKey ? { "Idempotency-Key": init.idempotencyKey } : {}),
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" })
      }
    };
    if (init.body !== undefined) request.body = JSON.stringify(init.body);
    return this.fetchWithRetry(`${this.config.apiBaseUrl}${path}`, request);
  }

  private async request<T>(path: string, init: { method?: string; idempotencyKey?: string; body?: unknown } = {}): Promise<T> {
    const response = await this.raw(path, init);
    if (!response.ok) {
      const problem = await response.json().catch(() => ({})) as { detail?: string; traceId?: string };
      throw new YarioApiError(response.status, problem.traceId, problem.detail);
    }
    return response.json() as Promise<T>;
  }

  private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const response = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(15_000) });
        if (![408, 429, 500, 502, 503, 504].includes(response.status) || attempt === 5) return response;
        const retryAfter = Number(response.headers.get("retry-after"));
        await delay(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : backoff(attempt));
      } catch (error) {
        lastError = error;
        if (attempt === 5) throw error;
        await delay(backoff(attempt));
      }
    }
    throw lastError;
  }
}

function backoff(attempt: number): number {
  return Math.min(30_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
