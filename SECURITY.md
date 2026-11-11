# Security and release scope

## Threat boundary
The local operating-system user and MCP host are trusted. The encrypted token file protects against file-only disclosure; it does not protect against malware, a compromised host/client, or an attacker who obtains both the encryption key and file. Put the key in a user-controlled secure launcher/secret store. The app does not implement multi-user isolation.

Only official, fixed Google HTTPS API endpoints are accessed. The sole local listener is the ephemeral OAuth loopback callback, bound to 127.0.0.1 for five minutes. It validates unpredictable state and PKCE. Authorization codes and upstream bodies are not logged. Avoid running with HTTP debug logging enabled.

Every report uses channel==MINE. Every tool checks channels.list(mine=true); an optional channel ID pin detects an unintended account. Video tools verify the video's owner. OAuth scopes are exactly youtube.readonly and yt-analytics.readonly. Any expanded grant is rejected. No credential introspection tool exists.

## Known release limitations
- OAuth code exchange and live report validity remain unverified against a real channel.
- No automatic alerts, remote transport, public deployment, billing, multi-account routing or viewer-level data.
- No analytics cache. Client-side conversation retention is outside this server; users must review the client's privacy settings.
- Network quota errors are returned safely; no exponential backoff or background worker is needed in this on-demand first version.
- Windows folder ACLs rely on the operator's user-profile configuration. Encryption does not excuse permissive local access.
- No derived virality/earnings/sentiment scores. Use of official metrics in further analyses must still comply with applicable Google/YouTube policies.
- Google APIs may change supported report combinations/scopes and verification requirements. Re-test before broadening access or publishing.

## Before any public/remote release
Implement authenticated MCP authorization, protected-resource metadata and per-user token binding, HTTPS, origin/host controls, encrypted managed storage, token rotation, least-privilege admin access, deletion/revocation workflows, rate limiting, audit logs without secrets, dependency scanning, and live end-to-end tests. Verify current Google and YouTube policies rather than representing this prototype as legal certification.
