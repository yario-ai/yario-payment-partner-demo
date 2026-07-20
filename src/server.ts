import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { createDemoHandler } from "./demo-app.js";
import { DurableEventStore } from "./store.js";
import { YarioClient } from "./yario-client.js";
import { runConformance } from "./conformance.js";

const config = loadConfig();
await mkdir(config.dataDir, { recursive: true });
const store = new DurableEventStore(config.dataDir);
const client = new YarioClient(config);

const server = createServer(createDemoHandler({
  config,
  store,
  runConformance: () => runConformance(config, client),
  processMerchantApplication
}));

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
