# Private remote hosting

## Current status

The code supports a single-owner Streamable HTTP endpoint at `/mcp`. It is
**not deployed by this repository**. No credentials, account data, or working
public endpoint are included. Remote hosting still needs an approved host,
Google authorization, a channel ID, and separately generated service credentials.

This release supports clients that can send a bearer header. It does **not**
implement an OAuth authorization server for ChatGPT. Do not select "No
Authentication" to work around this. A ChatGPT client requiring OAuth needs a
reviewed OAuth proxy/provider and MCP resource metadata before installation.

## Security model

- A distinct random `YOUTUBE_MCP_ACCESS_TOKEN` protects every request, including
  initialization and tool discovery. This is not the Google access token.
- Missing/short credentials, missing channel pin, or non-HTTPS public URL cause
  startup failure. No anonymous fallback exists.
- The exact host and optional browser origin are checked; query parameters are
  rejected. All responses use `Cache-Control: no-store`.
- Google tokens remain encrypted, mounted privately. No token or key belongs in
  the image, repository, command-line arguments, URL, or client-visible results.
- The service has one owner. Everyone with the bearer secret can read that
  owner's permitted reports. Do not use it as a multi-user SaaS.
- Request payloads are limited to 16 KiB. Infrastructure must impose rate limits,
  request timeouts, and concurrency/resource limits. Application access logging
  is disabled. Ensure proxy/provider logs redact auth and private payloads.

## Deployment prerequisites

1. Complete the local Google consent setup from README and verify the intended
   channel. Approve moving the encrypted credential file and its separate key
   to the selected remote host's secret store. Keep it out of backups unless
   those backups are approved and encrypted. Do not paste secrets into chat.
2. Generate a separate 32-byte random URL-safe access token using a trusted
   secret manager. Store it only in the host secret store and authorised client.
3. Provision a TLS reverse proxy in front of the container. The container port
   must be reachable **only from the proxy**, never the public Internet. Forward
   the original `Host` unchanged and reject incorrect hosts at the proxy too.
4. Pin the verified YouTube channel with `YOUTUBE_MCP_CHANNEL_ID`.

Required runtime configuration (values are examples, not credentials):

```
YOUTUBE_MCP_PUBLIC_URL=https://your-service.example.com
YOUTUBE_MCP_CHANNEL_ID=UC_verified_channel_id
YOUTUBE_MCP_ACCESS_TOKEN=<secret-store value>
YOUTUBE_MCP_TOKEN_KEY=<separate encryption secret-store value>
YOUTUBE_MCP_TOKEN_FILE=/run/youtube/authorization.enc
```

`YOUTUBE_MCP_PUBLIC_URL` is the origin only, without `/mcp`. Pass the Google
credential file as a private writable volume readable only by container UID
10001, because Google may rotate refresh tokens. Keep key and data permissions
separate. Mount the container root filesystem read-only with a writable tmpfs
for `/tmp`; use an unprivileged user, dropped capabilities and resource limits.

Build with `docker build -t youtube-analytics-mcp .`. This command builds locally
and does not publish an image or deploy a service. Container build has not been
verified unless explicitly stated in a release report.

The entry point is `youtube-analytics-remote` (or the Dockerfile command).
Standalone mode defaults to loopback only. The Dockerfile listens on all
container interfaces, so only publish it to the private proxy network.

A compatible client sends `Authorization: Bearer <service access token>` on
HTTPS requests to `https://your-service.example.com/mcp`. Rotate this token if
exposed. Revoke Google authorization and remove stored credentials to disconnect.

## Release validation

Before sharing a URL:
- Verify TLS, incorrect Host/Origin rejection, missing/wrong bearer rejection.
- Run a real MCP client initialization, list tools, and an owner-authorized report.
- Confirm no private data appears in unauthenticated responses or provider logs.
- Verify deletion/revocation and channel pinning, and establish rate limits.
- Record exact deployed version. Fixture tests are not live Google validation.

The original filesystem-backed Python service is not a drop-in Cloudflare
Worker. Use a compatible container host or deliberately adapt and test storage,
networking and authentication for Workers. Do not deploy a placeholder Worker
and describe it as a functioning analytics service.
