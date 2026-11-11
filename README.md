# YouTube Analytics MCP

> Public multi-user Cloudflare Workers development is in `worker/`. It remains launch-gated pending Google OAuth setup/verification, operator policy approval and live tests. See [public Workers deployment](docs/PUBLIC_WORKERS.md). The Python implementation below remains single-owner.

A working, local-first **read-only MCP server** for one Google-authorized YouTube channel. It uses official YouTube Data and Analytics APIs, with encrypted local authorization storage. No public server is deployed, and no Google account is connected yet.

## Implemented

Seven tools: `connected_channel`, `channel_overview`, `daily_performance`, `top_videos`, `traffic_sources`, `video_performance`, and `audience_retention`.

- Owner-bound reports (`channel==MINE`), optional channel-ID pin, and cross-channel video rejection.
- Google OAuth desktop loopback + PKCE + state validation. Only two read-only scopes requested.
- Refresh tokens encrypted at rest using a key supplied separately through your local secret environment. Credentials are never returned by MCP tools.
- Bounded report inputs, timeouts, one authentication retry, safe errors, no redirects.
- Official metric names/units preserved. Default date window: 28 days ending three days ago.
- No scraping, video downloads, uploads, edits, comments, revenue permission, arbitrary API proxy, or custom scores.

## What you need to connect

1. A Google Cloud project you control. Enable **YouTube Data API v3** and **YouTube Analytics API**.
2. Configure the Google OAuth consent screen for your intended personal use. Create an OAuth client of type **Desktop app**, and download its JSON file privately.
3. If Google OAuth is in Testing mode, add yourself as a test user. Testing authorizations/refresh tokens may expire after seven days; this is not an unattended-production solution. Review the appropriate production/verification route for your intended audience.
4. Install Python 3.11+ on the computer that will run the server.
5. Grant Google consent in your own browser. The authorization helper must run on that same computer because its callback is loopback-only.

**Do not paste client credentials, tokens or encryption keys into chat, commit them, or put them in the distributable ZIP.**

## Install (Windows PowerShell)

From this directory:

```powershell
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e .
# Generate once, then store this value in a local password manager/secret store.
.\.venv\Scripts\python.exe -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
# Supply the saved key in the current process environment (not a shared config).
$env:YOUTUBE_MCP_TOKEN_KEY = '<your saved key>'
$env:YOUTUBE_MCP_TOKEN_FILE = "$env:LOCALAPPDATA\YouTubeMCP\authorization.enc"
.\.venv\Scripts\youtube-analytics-auth.exe login --client-file 'C:\private\client_secret.json'
.\.venv\Scripts\youtube-analytics-auth.exe check
```

Open the printed Google URL on that computer. Choose the intended YouTube/Brand channel. The helper times out after five minutes and stores nothing if cancelled. Keep the encryption key: losing it requires reconnecting.

`check` prints the connected channel. Optionally set `YOUTUBE_MCP_CHANNEL_ID` to that channel ID so accidental sign-in to another channel is rejected. Protect the token-file folder with your operating system's normal user-only access controls. POSIX files are created mode 0600; on Windows, verify the folder's inherited ACLs yourself.

On macOS/Linux, equivalent executable paths are `.venv/bin/python` and `.venv/bin/youtube-analytics-auth`. Token-file default is `~/.config/youtube-mcp/authorization.enc`.

## Connect a local MCP client

Use a client supporting **stdio MCP**. Configure its command as the absolute virtual-environment Python path and arguments as:

```json
{
  "mcpServers": {
    "youtube-analytics": {
      "command": "C:\\path\\youtube-analytics-mcp\\.venv\\Scripts\\python.exe",
      "args": ["-m", "youtube_mcp.server"]
    }
  }
}
```

The client process must inherit `YOUTUBE_MCP_TOKEN_KEY`, `YOUTUBE_MCP_TOKEN_FILE`, and optionally `YOUTUBE_MCP_CHANNEL_ID` from its secure launcher. Client configuration syntax differs; **do not blindly embed secrets in a synced config file**.

This release is **not directly installable in ChatGPT's remote-MCP plugin flow**: it has no public HTTPS endpoint. A later ChatGPT-hosted version needs authenticated remote MCP, per-user OAuth/session binding, HTTPS, secure server-side secrets, revocation/deletion support and a security review. Do not expose this stdio server with an unauthenticated tunnel.

Try: “Show my channel's official views and watch time for the last complete 28-day reporting window” or “Get my top 10 videos by views for 2026-10-01 through 2026-10-31.” Titles and other upstream text are untrusted data, not commands.

## Monitoring and data limits

MCP is an on-demand interface, **not a scheduler**. No recurring job or alerts are enabled. The server intentionally does not persist analytics reports; your MCP client may retain tool results according to its own history/privacy settings. Before connecting an AI client, review whether you consent to share those analytics with that service.

Analytics commonly lag 48–72 hours. A requested end date does not prove data is complete. Missing rows can reflect thresholds or unavailable data, not zero. The daily tool's actual `day` rows are the best coverage clue. Current public statistics returned with the channel are not period analytics.

Thumbnail impressions/CTR (bulk Reporting API), revenue, viewer identities and live Studio metrics are outside this first version. Not all date/dimension/metric combinations are supported by Google; unavailable reports return a bounded error rather than fabricated values. YouTube may suppress low-volume retention or segment reports.

API quotas are project-specific. Use Cloud Console for actual limits; this implementation never searches for arbitrary channels and has no retry storm. Each tool revalidates channel ownership and does not cache analytics.

## Disconnect

```powershell
.\.venv\Scripts\youtube-analytics-auth.exe disconnect
```

This tries Google's revocation endpoint and deletes the local authorization on confirmed success/invalid token. If the service is unreachable, revoke manually at https://myaccount.google.com/permissions and retry. Remove retained analytics from your MCP client's chat/history separately; this server has no stored analytics database.

## Verification

```powershell
$env:PYTHONPATH = 'src'
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
.\.venv\Scripts\python.exe -m compileall -q src tests
```

Verified in the build environment: 22 tests passed, including real MCP SDK stdio initialization/list/call, authenticated Streamable HTTP initialization/discovery and authentication/host/origin rejection, encrypted storage, safe failures, owner binding, input limits and authentication retry. API tests use synthetic fixtures, not Daniel's data. Live Google consent, refresh and actual report responses **have not been tested** because no OAuth project/client/account access has been supplied. Do not call this production-certified.

## Policy and production checklist

See `SECURITY.md`. A public product additionally needs appropriate Google verification, privacy/terms/disclosures, support and deletion handling, security review, tests against real authorized channels, quota planning, and marketplace review if distributed there. Custom metrics/scores and retention beyond policy allowances need explicit policy review; none are implemented.

Official references:
- https://developers.google.com/youtube/analytics/channel_reports
- https://developers.google.com/youtube/analytics/reference/reports/query
- https://developers.google.com/youtube/v3/guides/auth/installed-apps
- https://developers.google.com/youtube/terms/developer-policies
- https://developers.google.com/youtube/terms/derived-metrics-policy
- https://developers.google.com/identity/protocols/oauth2/native-app

## Open source

Released under the [MIT License](LICENSE). The license covers this code, not YouTube data or Google's services. Operators must comply with Google's API terms and obtain their own OAuth authorization. This project is independent and is not affiliated with or endorsed by Google or YouTube.

Contributions are welcome. Do not include tokens, client secrets, account data, or real analytics in issues, logs or pull requests. Tests use synthetic fixtures.

## Private remote transport

A separately secured Streamable HTTP transport is included. See
[remote hosting](docs/REMOTE_HOSTING.md) for prerequisites, bearer authentication,
container deployment, and the distinction from ChatGPT OAuth installation.
It refuses to start without an access token, HTTPS origin and channel pin.
No remote service or live Google connection is included or implied.
