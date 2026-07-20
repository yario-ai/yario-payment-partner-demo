# Yario Payment Partner Demo

Public, demo-only reference implementation for a payment or regulated partner
integrating with the [Yario Integration API](https://docs.yario.ai/docs/developers/integrations).

## Try the hosted demo

Open [demo-partner.yario.ai](https://demo-partner.yario.ai) and use the
demo-only access published in the
[Integration API Guide](https://docs.yario.ai/docs/developers/integrations).
The browser never receives an Integration API key: the hosted server calls a
dedicated synthetic test environment and returns only a redacted report.

The hosted demo serializes access to its shared fixture, rate-limits login and
test runs, uses an HttpOnly session cookie, and rejects live credentials.

## Start here

Use the documentation in this order:

1. [Integration API Guide](https://docs.yario.ai/docs/developers/integrations) —
   the single entry point and complete partner journey.
2. [Registration and legal/test access](https://docs.yario.ai/docs/developers/integrations/onboarding) —
   organization profile, agreements and the boundary between test and live.
3. [Interactive API Reference](https://docs.yario.ai/api-reference/developers/integrations/api-reference) —
   the normative HTTP, security and webhook contract.
4. [Testing and certification](https://docs.yario.ai/docs/developers/integrations/testing) —
   expected checks, reports and remediation.

Technical certification proves the test integration. It does not replace
Yario legal and operator approval for live access.

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

1. Open the [Yario Partner Portal](https://partners.yario.ai/partner/register)
   and register the demo organization.
2. Complete the profile and upload synthetic documents only. On explicitly
   configured demo stands, allowlisted partners can self-approve
   `integration.test_access`; this never approves live access.
3. Accept the published test agreement and store the one-time
   `yario_test_...` credential in a secret manager.
4. Call `/v1/installations` and copy only the synthetic installation and client
   IDs into `.env`.
5. Run `npm run conformance`.
6. Start the receiver and expose `POST /webhooks/yario` only over HTTPS.
7. Use the same runner in CI before requesting live access.
8. Revoke the demo credential after the evaluation. Live access always
   requires separate Yario legal and operator review.

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
- ticket create/read/update;
- identical replay and changed-body conflict;
- message roundtrip;
- random-resource isolation;
- optional synthetic merchant onboarding;
- valid, duplicate, invalid-signature, stale and unknown webhook fixtures.

No API key, webhook secret, message body or KYC snapshot is written to the
reports.

The runner does not reset fixtures by default because `/v1/test/reset` rotates
their IDs and a demo must never expand its allowlist automatically. If the
reset result IDs have been explicitly pre-approved, set
`YARIO_RESET_TEST_DATA=true`; otherwise reset separately, then copy the new
installation/client IDs into the allowlist before running conformance.

## Production adaptation

Before adapting this repository:

- replace the file event store with a database unique constraint;
- use a managed secret store;
- add your own KYC schemas and retention policy;
- keep the allowlist until your tenant mapping is independently verified;
- add operational metrics and alerts;
- complete Yario legal and live-access review.

If you want Yario to adapt this implementation to your platform, we can deliver
a separately scoped integration project **from USD 2,000**. The final price
depends on capabilities and provider complexity; provider fees, legal review
and non-standard product work are excluded unless the statement of work says
otherwise. Contact [info@yario.ai](mailto:info@yario.ai?subject=Yario%20partner%20integration%20from%20USD%202000).

See the [interactive API reference](https://docs.yario.ai/api-reference/developers/integrations/api-reference)
for the current HTTP contract, or return to the
[Integration API Guide](https://docs.yario.ai/docs/developers/integrations)
for the complete legal, technical and testing flow.
