# Yario Payment Partner Demo

Public, demo-only reference implementation for a payment or regulated partner
integrating with the [Yario Integration API](https://docs.yario.ai/docs/developers/integrations).

It demonstrates:

- API-key authentication and environment discovery;
- explicit installation and client allowlists;
- stable idempotency keys and bounded retry with jitter;
- tickets and messages;
- synthetic merchant KYC review;
- webhook HMAC verification over the exact raw body;
- timestamp validation and durable `eventId` deduplication;
- terminal, JSON and JUnit conformance reports.

It does **not** process payments, cards, balances, refunds, payouts or real
customer data.

## Safety boundary

The process fails at startup unless both `YARIO_DEMO_INSTALLATION_IDS` and
`YARIO_DEMO_CLIENT_IDS` are non-empty. Every resource-creating operation checks
those allowlists.

`yario_live_...` credentials are rejected unless `YARIO_ALLOW_LIVE=true` is
also set. Enabling that switch does not bypass the allowlists and does not turn
this demo into a payment processor.

## Quickstart

Requirements: Node.js 22+ or Docker.

```bash
cp .env.example .env
# Fill only a Yario test key, its synthetic installationId/testClientId,
# and a new webhook secret. Never commit .env.
npm ci
npm run check
npm run conformance
npm start
```

Reports are written to:

- `reports/conformance.json`;
- `reports/conformance.junit.xml`.

Run with Docker:

```bash
docker compose up --build
curl --fail http://localhost:8080/health
```

## Partner flow

1. Register at `https://partners.yario.ai/partner/register`.
2. Complete the partner profile and obtain a `yario_test_...` credential.
3. Call `/v1/installations` and copy only the synthetic installation and client
   IDs into `.env`.
4. Run `npm run conformance`.
5. Start the receiver and expose `POST /webhooks/yario` only over HTTPS.
6. Use the same runner in CI before requesting live access.

## Architecture

```text
Yario Integration API
  | HTTPS + Api-Key + Idempotency-Key
  v
YarioClient --------> tickets/messages/KYC

Yario webhook
  | exact raw body + HMAC headers
  v
/webhooks/yario ---> allowlist ---> durable eventId store ---> demo KYC handler
```

The file-based event store is intentionally small and inspectable. A real
partner should preserve the same unique-event constraint in its transactional
database.

## Conformance checks

The runner exercises a real Yario test environment:

- profile and capability discovery;
- test reset;
- ticket create/read/update;
- identical replay and changed-body conflict;
- message roundtrip;
- random-resource isolation;
- optional synthetic merchant onboarding;
- valid, duplicate, invalid-signature, stale and unknown webhook fixtures.

No API key, webhook secret, message body or KYC snapshot is written to the
reports.

## Production adaptation

Before adapting this repository:

- replace the file event store with a database unique constraint;
- use a managed secret store;
- add your own KYC schemas and retention policy;
- keep the allowlist until your tenant mapping is independently verified;
- add operational metrics and alerts;
- complete Yario legal and live-access review.

See the [interactive API reference](https://docs.yario.ai/api-reference/developers/integrations/api-reference)
for the current HTTP contract.
