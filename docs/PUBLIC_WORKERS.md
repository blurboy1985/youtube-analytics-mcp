# Public multi-user Workers implementation (launch gated)

This is a separate TypeScript implementation under `worker/`; the original Python server remains private/single-owner. **No live Google connection or production validation is implied. Do not enable public connections until the checklist below is complete.**

## What is implemented

- Cloudflare Workers module with a SQLite-backed Durable Object, compatible with the Free architecture (no Containers subscription).
- Official MCP SDK Streamable HTTP, stateless request/response transport.
- Maintained `@cloudflare/workers-oauth-provider` 1.2.4: protected-resource and authorization-server metadata, authorization-code + S256 PKCE, issuer identification, CIMD and DCR, exact redirects, resource-bound opaque tokens, refresh rotation and revocation. This implementation adds strict one-use refresh tracking; the library's default previous-token retry grace is deliberately rejected and replay revokes that grant.
- Google web OAuth with browser-bound state and PKCE after explicit client/privacy/terms consent. Only `youtube.readonly` and `yt-analytics.readonly` are requested. Google tokens never reach the MCP client.
- Seven owner-bound read-only report tools plus the explicitly destructive `disconnect_account` authorization-management tool. No video writes, revenue, custom scores or report cache.
- Google refresh tokens are encrypted within the OAuth library's grant `props`; secret token hashes and encrypted records reside in SQLite. Google client credentials belong in Worker secrets, never this repository.
- The library's small KV-shaped adapter is backed by **SQLite, not Workers KV**. All authorization mutations and validations run in one Durable Object under `blockConcurrencyWhile`, avoiding eventual-consistency replay and refresh races. Analytics API requests run outside that serialized object.
- Every report refreshes Google access and checks the authorized channel again; video tools also check ownership. Inputs, response sizes, dates and quotas are bounded.
- Operator-configured launch gates default closed. Missing credentials, support details, policy approval or launch approval return 503 for connection endpoints.

## Build and validate

Node 24+ is required for dependency-free TypeScript unit tests. From `worker/`:

```sh
npm ci --ignore-scripts
npm run check
npm audit --omit=dev
```

The tests use synthetic credentials/channel data only. Workers runtime integration uses Miniflare with a mocked Google service. It does **not** certify live Google consent, real reports or ChatGPT installation.

Run the original Python tests separately from the repository root:

```sh
PYTHONPATH=src python -m unittest discover -s tests -v
python -m compileall -q src tests
```

## Google and public launch checklist

1. Confirm actual Cloudflare account Workers plan and absence of paid subscription/automatic paid upgrades. Do not assume a Worker marked `standard` proves Free. No billing changes are authorized by this implementation.
2. Select an operator-owned Google Cloud production project; enable YouTube Data API v3 and YouTube Analytics API.
3. Configure External audience, branding, operator/support contacts, homepage/privacy/terms, and authorized domains. Inspect actual scope classification in Google Auth Platform Data Access.
4. Verify domain ownership in Google's required flow. **workers.dev acceptance for public Google verification is not established.** An already-owned custom domain is safer; buying a domain needs a separate cost decision.
5. Create a Web application OAuth client with exact redirect `BASE_URL/google/callback`. Google OAuth Testing is limited to listed users and grants expire after seven days. Production publication does not by itself satisfy scope/brand verification.
6. Store `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` as Worker secret bindings through an approved secure route. Do not paste secrets into chat, code, issues, deployment JSON or logs.
7. Have the operator review the draft privacy/terms text in `src/web.ts`, support contact, deletion process and Google/YouTube policy commitments. Set `POLICY_APPROVED=true` only after review; do not treat generated policy text as legal certification.
8. Complete required Google verification with accurate scope justification and demonstration video. No revenue permission is included.
9. Test a staging installation in ChatGPT using the exact callback displayed there. Verify discovery, both OAuth layers, reconnect, denial/cancel, revocation/deletion, two distinct real creators/Brand channels, and account switching. Do not publish other people's analytics or tokens as evidence.
10. Benchmark cold starts/crypto/report parsing against Free CPU quotas. Exercise quota failure and deletion under load. Review the pinned storage adapter before any OAuth-library upgrade.
11. Enable `PUBLIC_LAUNCH_READY=true` only after all preceding gates and independent security review. A public staging homepage can be deployed while both approval flags remain false, but it is **not a usable public MCP**.

## Deployment shape

`worker/deployment.example.json` describes the Cloudflare multipart API upload metadata. Upload `worker/dist/worker.js` as the module and apply a **new SQLite** Durable Object migration; do not use legacy KV-backed Durable Objects. Configure the canonical HTTPS BASE_URL before enabling OAuth. Avoid overlapping names with existing services. Disable preview hosts or reject them with the canonical-host guard.

Use the connected Cloudflare API or the current Cloudflare CLI (`cf`) for a new deployment. This project does not introduce Wrangler config. The deployment does not create or switch any billing plan.

Observability is deliberately disabled in the example: automatic invocation logs/traces can capture authorization-code callback query strings or sensitive headers. Before enabling observability, establish tested redaction and exclusions. Safe counters/health checks can be added without storing credentials, requests or reports. Do not enable raw request/body logging.

## Limits and retention

- Access tokens last 5 minutes. MCP grants expire after a fixed 7 days, requiring explicit reconnection. This conservative MVP avoids indefinite dormant authorization; it is a deliberate UX limitation, not a claim that Google production grants must expire weekly.
- Expired authorization/transaction records are purged daily. SQLite recovery copies are subject to Cloudflare retention; include this in the final operator policy.
- `disconnect_account(confirm=true)` attempts immediate Google revocation, then deletes every local grant/token for the verified channel. It reports when Google revocation could not be confirmed and links manual Google revocation. Google revocation can affect other grants for the same Google app/account; the tool warns of this. It never deletes YouTube content or client chat history.
- There is no public operator-admin API. Support-assisted deletion requires a verified operator procedure before launch.
- Source-first rate controls, global login/registration budgets, separate token budgets and per-channel tool limits fail closed. These are conservative MVP quotas, not comprehensive DDoS protection. A distributed attack or exhausted account quota can make the service unavailable. Tune only after monitoring actual project quotas.
- One serialized authorization object is an intentional small-service constraint. High-volume public use needs further load tests and possibly sharded consistent storage; do not promise unlimited free usage.
- Free plan reference limits at review time: Workers 100,000 requests/day and 10 ms CPU per request; SQLite DO 100,000 requests/day, 13,000 GB-s duration/day, 5 million rows read/day, 100,000 rows written/day, 5 GB storage. Quotas are shared with other account applications. Confirm current values before deployment.

## Official references

- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/durable-objects/platform/pricing/
- https://github.com/cloudflare/workers-oauth-provider/blob/main/docs/authorization-server.md
- https://github.com/cloudflare/workers-oauth-provider/blob/main/docs/upstream-sign-in.md
- https://developers.openai.com/plugins/build/auth
- https://developers.google.com/youtube/analytics/reference/reports/query
- https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification
- https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification
- https://developers.google.com/youtube/terms/developer-policies
- https://support.google.com/cloud/answer/15549945?hl=en
