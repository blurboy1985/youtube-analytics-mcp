from __future__ import annotations
import json
import os
import tempfile
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import httpx
from cryptography.fernet import Fernet, InvalidToken

SCOPES = frozenset({
    "https://www.googleapis.com/auth/youtube.readonly",
    "https://www.googleapis.com/auth/yt-analytics.readonly",
})

class SafeError(Exception):
    """Safe to display; never include upstream bodies or credentials."""

class TokenStore:
    def __init__(self, path: Path, key: str):
        self.path = path
        try:
            self.cipher = Fernet(key.encode())
        except (ValueError, TypeError):
            raise SafeError("YOUTUBE_MCP_TOKEN_KEY must be a Fernet key.") from None

    def load(self) -> dict:
        try:
            data = json.loads(self.cipher.decrypt(self.path.read_bytes()))
            if (not isinstance(data, dict)
                or any(not isinstance(data.get(k), str) or not data[k] for k in ("client_id", "client_secret", "refresh_token"))
                or not isinstance(data.get("scopes"), list)
                or any(not isinstance(scope, str) for scope in data["scopes"])):
                raise ValueError("Invalid authorization shape")
            return data
        except FileNotFoundError:
            raise SafeError("No Google authorization saved. Run youtube-analytics-auth login.") from None
        except (InvalidToken, ValueError, OSError):
            raise SafeError("Cannot decrypt/read authorization. Check the key or reconnect.") from None

    def save(self, data: dict):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(dir=self.path.parent)
        try:
            with os.fdopen(fd, "wb") as out:
                out.write(self.cipher.encrypt(json.dumps(data).encode()))
            os.replace(name, self.path)
        finally:
            if os.path.exists(name):
                os.unlink(name)


def store_from_env() -> TokenStore:
    key = os.getenv("YOUTUBE_MCP_TOKEN_KEY")
    if not key:
        raise SafeError("Set YOUTUBE_MCP_TOKEN_KEY in your local secret environment.")
    path = Path(os.getenv("YOUTUBE_MCP_TOKEN_FILE", str(Path.home() / ".config/youtube-mcp/authorization.enc")))
    return TokenStore(path, key)


def validate_dates(start: str | None, end: str | None, days: int = 28) -> tuple[str, str]:
    try:
        stop = date.fromisoformat(end) if end else date.today() - timedelta(days=3)
        begin = date.fromisoformat(start) if start else stop - timedelta(days=days - 1)
    except (TypeError, ValueError):
        raise SafeError("Dates must be ISO YYYY-MM-DD.") from None
    if begin > stop or stop > date.today() or begin < date(2005, 1, 1):
        raise SafeError("Invalid date range: start must precede end, and end cannot be in the future.")
    if (stop - begin).days > 366:
        raise SafeError("Use date ranges of at most 367 days.")
    return begin.isoformat(), stop.isoformat()


class YouTube:
    def __init__(self, store: TokenStore, client: httpx.Client | None = None):
        self.store = store
        self.client = client or httpx.Client(timeout=30, follow_redirects=False)
        self.access_token: str | None = None
        self.channel: dict | None = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.client.close()

    def refresh(self):
        saved = self.store.load()
        if set(saved.get("scopes", [])) != SCOPES:
            raise SafeError("Authorization does not match the required read-only scopes. Reconnect.")
        try:
            response = self.client.post("https://oauth2.googleapis.com/token", data={
                "grant_type": "refresh_token", "client_id": saved["client_id"],
                "client_secret": saved["client_secret"], "refresh_token": saved["refresh_token"],
            })
            if response.status_code != 200:
                raise SafeError("Google authorization expired, revoked, or unavailable. Reconnect if it persists.")
            body = response.json()
            if "scope" in body and set(body["scope"].split()) != SCOPES:
                raise SafeError("Unexpected Google permissions. Reconnect with only the read-only scopes.")
            self.access_token = body["access_token"]
            if body.get("refresh_token"):
                saved["refresh_token"] = body["refresh_token"]
                self.store.save(saved)
        except (httpx.HTTPError, KeyError, ValueError):
            raise SafeError("Could not refresh Google authorization.") from None

    def get(self, endpoint: str, params: dict) -> dict:
        allowed = {
            "channels": "https://www.googleapis.com/youtube/v3/channels",
            "videos": "https://www.googleapis.com/youtube/v3/videos",
            "reports": "https://youtubeanalytics.googleapis.com/v2/reports",
        }
        if endpoint not in allowed:
            raise SafeError("Unsupported API endpoint.")
        if not self.access_token:
            self.refresh()
        try:
            for attempt in range(2):
                response = self.client.get(allowed[endpoint], params=params,
                    headers={"Authorization": f"Bearer {self.access_token}"})
                if response.status_code == 401 and attempt == 0:
                    self.refresh()
                    continue
                if response.status_code in (403, 429):
                    raise SafeError("Google denied this report or quota was reached. Check permissions and Cloud Console quotas.")
                if response.status_code >= 400:
                    raise SafeError(f"Google API request failed (HTTP {response.status_code}). Check report availability and inputs.")
                return response.json()
        except (httpx.HTTPError, ValueError):
            raise SafeError("YouTube API unavailable or returned an invalid response.") from None
        raise SafeError("Google authorization failed. Reconnect.")

    def owner(self) -> dict:
        # Verify ownership on every tool invocation, not just once at startup.
        data = self.get("channels", {"part": "id,snippet,statistics", "mine": "true"})
        items = data.get("items", [])
        if len(items) != 1:
            raise SafeError("Select exactly one YouTube channel during Google authorization, then reconnect.")
        item = items[0]
        pinned = os.getenv("YOUTUBE_MCP_CHANNEL_ID")
        if pinned and item["id"] != pinned:
            raise SafeError("Authorized channel does not match YOUTUBE_MCP_CHANNEL_ID.")
        self.channel = {"id": item["id"], "title": item.get("snippet", {}).get("title"),
                        "current_public_statistics": item.get("statistics", {})}
        return self.channel

    def report(self, start: str | None, end: str | None, *, dimensions: str | None = None,
               metrics: str = "views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost",
               extra: dict | None = None) -> dict:
        start, end = validate_dates(start, end)
        channel = self.owner()
        params: dict[str, Any] = {"ids": "channel==MINE", "startDate": start, "endDate": end, "metrics": metrics}
        if dimensions:
            params["dimensions"] = dimensions
        params.update(extra or {})
        result = self.get("reports", params)
        return {"channel": channel, "requested_range": {"start": start, "end": end},
            "data_notes": ["Official YouTube metrics only; requested end date is not a freshness guarantee.",
                           "Analytics commonly lags 48–72 hours; some segments can be suppressed.",
                           "Missing rows are not necessarily zero. Current public statistics are not period totals."],
            "column_headers": result.get("columnHeaders", []), "rows": result.get("rows", [])}

    def verify_video(self, video_id: str):
        import re
        if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
            raise SafeError("video_id must be an 11-character YouTube video ID.")
        channel = self.owner()
        items = self.get("videos", {"part": "snippet", "id": video_id}).get("items", [])
        if not items or items[0].get("snippet", {}).get("channelId") != channel["id"]:
            raise SafeError("Video is unavailable or does not belong to the authorized channel.")
