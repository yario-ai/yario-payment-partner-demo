export interface IntegrationProfile {
  appId: string;
  appSlug: string;
  appName: string;
  environment: "test" | "live";
  scopes: string[];
}

export interface IntegrationInstallation {
  id: string;
  name: string;
  externalReference?: string | null;
  capabilities: string[];
  testClientId?: string | null;
}

export interface IntegrationTicket {
  id: string;
  installationId: string;
  clientId: string;
  summary: string;
  description: string;
  externalReference?: string | null;
  status: string;
  priority: string;
  createdAt: string;
  updatedAt: string;
}

export interface MerchantApplication {
  id: string;
  installationId: string;
  externalReference: string;
  status: string;
  snapshot: Record<string, unknown>;
  review?: Record<string, unknown> | null;
}

export interface YarioEvent {
  eventId: string;
  type: string;
  createdAt: string;
  installationId: string;
  data: Record<string, unknown>;
}

export interface ConformanceCheck {
  code: string;
  required: boolean;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  remediation?: string;
  detail?: string;
}

export interface ConformanceReport {
  schema: "yario.partner-conformance.v1";
  startedAt: string;
  completedAt: string;
  environment?: string;
  appSlug?: string;
  installationId?: string;
  passed: boolean;
  checks: ConformanceCheck[];
}
