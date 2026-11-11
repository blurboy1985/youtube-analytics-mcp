# Security and release scope

## Threat boundary
The local operating-system user and MCP host are trusted. The encrypted token file protects against file-only disclosure; it does not protect against malware, a compromised host/client, or an attacker who obtains both the encryption key and file. Put the key in a user-controlled secure launcher/secret store. The app does not implement multi-user isolation.

Only official, fixed Google HTTPS API endpoints are accessed. In default stdio mode the sole local listener is the ephemeral OAuth loopback callback, bound to 127.0.0.1 for five minutes. It validates unpredictable state and PKCE. Authorization codes and upstream bodies are not logged. Avoid running with HTTP debug logging enabled.

Every report uses channel==MINE. Every tool checks channels.list(mine=true); a channel ID pin detects an unintended account (optional in stdio, mandatory for remote). Video tools verify the video's owner. OAuth scopes are exactly youtube.readonly and yt-analytics.readonly. Any expanded grant is rejected. No credential introspection tool exists.

## Known release limitations
- OAuth code exchange and live report validity remain unverified against a real channel.
- No automatic alerts, completed public deployment, billing, multi-account routing or viewer-level data. A single-owner bearer-authenticated Streamable HTTP transport is available; it is not an OAuth authorization server or directly a ChatGPT OAuth connector.
- No analytics cache. Client-side conversation retention is outside this server; users must review the client's privacy settings.
- Network quota errors are returned safely; no exponential backoff or background worker is needed in this on-demand first version.
- Windows folder ACLs rely on the operator's user-profile configuration. Encryption does not excuse permissive local access.
- No derived virality/earnings/sentiment scores. Use of official metrics in further analyses must still comply with applicable Google/YouTube policies.
- Google APIs may change supported report combinations/scopes and verification requirements. Re-test before broadening access or publishing.

## Before any public/remote release
For remote deployment, follow docs/REMOTE_HOSTING.md: the implemented gate checks bearer authentication, host/origin and owner pin. Configure TLS and private networking, encrypted managed storage, token rotation, least-privilege admin access, deletion/revocation workflows, infrastructure rate limiting and secret-free logs. Before ChatGPT OAuth or multi-user release, additionally implement/review MCP OAuth authorization, protected-resource metadata and per-user token binding. Dependency review and live end-to-end tests remain required. Verify current Google and YouTube policies rather than representing this prototype as legal certification.
