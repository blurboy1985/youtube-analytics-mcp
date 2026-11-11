"""Explicit, interactive local Google OAuth setup. Never run by an MCP tool."""
from __future__ import annotations
import argparse
import base64
import hashlib
import json
import secrets
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse

import httpx
from .core import SCOPES, SafeError, store_from_env


def login(client_file: str):
    store = store_from_env()
    try:
        config = json.loads(Path(client_file).read_text())["installed"]
        client_id, client_secret = config["client_id"], config["client_secret"]
    except (OSError, ValueError, KeyError):
        raise SafeError("Supply a Google Desktop app OAuth client JSON file.") from None
    state, verifier = secrets.token_urlsafe(32), secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    result = {}

    class Callback(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(5)

        def do_GET(self):
            parsed = urlparse(self.path)
            args = parse_qs(parsed.query)
            valid = parsed.path == "/callback" and args.get("state") == [state]
            if not valid:
                self.send_response(400); self.end_headers(); self.wfile.write(b"Invalid OAuth callback."); return
            if "error" in args:
                result["error"] = True
            elif len(args.get("code", [])) == 1:
                result["code"] = args["code"][0]
            else:
                self.send_response(400); self.end_headers(); return
            self.send_response(200); self.end_headers()
            self.wfile.write(b"Authorization response received. Return to the terminal; you may close this tab.")
        def log_message(self, *args):
            pass  # OAuth authorization codes must never enter logs.

    with ThreadingHTTPServer(("127.0.0.1", 0), Callback) as server:
        server.timeout = 1
        redirect = f"http://127.0.0.1:{server.server_port}/callback"
        url = "https://accounts.google.com/o/oauth2/v2/auth?" + urlencode({
            "client_id": client_id, "redirect_uri": redirect, "response_type": "code",
            "scope": " ".join(sorted(SCOPES)), "state": state, "access_type": "offline",
            "prompt": "consent", "code_challenge": challenge, "code_challenge_method": "S256",
            "include_granted_scopes": "false",
        })
        print("Open this URL in a browser on THIS computer. Choose your channel and approve read-only access:\n" + url, file=sys.stderr)
        until = time.monotonic() + 300
        while not result and time.monotonic() < until:
            server.handle_request()
    if not result.get("code"):
        raise SafeError("Authorization cancelled or timed out; nothing was saved.")
    try:
        response = httpx.post("https://oauth2.googleapis.com/token", data={
            "grant_type": "authorization_code", "client_id": client_id, "client_secret": client_secret,
            "code": result["code"], "redirect_uri": redirect, "code_verifier": verifier,
        }, timeout=30, follow_redirects=False)
        body = response.json()
        if response.status_code != 200 or not body.get("refresh_token"):
            raise SafeError("Google did not issue an offline authorization. Reconnect and grant consent.")
        if set(body.get("scope", "").split()) != SCOPES:
            raise SafeError("Google did not grant exactly the two required read-only scopes. Nothing saved locally. Remove this app at https://myaccount.google.com/permissions before retrying.")
        store.save({"client_id": client_id, "client_secret": client_secret,
                    "refresh_token": body["refresh_token"], "scopes": sorted(SCOPES)})
        print("Encrypted authorization saved. Run the MCP server or 'youtube-analytics-auth check'.", file=sys.stderr)
    except (httpx.HTTPError, ValueError):
        raise SafeError("Google authorization exchange failed; no response details logged.") from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("login").add_argument("--client-file", required=True)
    sub.add_parser("check")
    sub.add_parser("disconnect")
    args = parser.parse_args()
    try:
        if args.command == "login":
            login(args.client_file)
        elif args.command == "check":
            from .core import YouTube
            with YouTube(store_from_env()) as service:
                print(json.dumps(service.owner(), indent=2))
        else:
            store = store_from_env()
            saved = store.load()
            try:
                r = httpx.post("https://oauth2.googleapis.com/revoke", data={"token": saved["refresh_token"]}, timeout=30)
                if r.status_code != 200 and not (r.status_code == 400 and r.json().get("error") == "invalid_token"):
                    raise SafeError("Revocation was not confirmed. Revoke in Google account permissions, then retry.")
            except (httpx.HTTPError, ValueError):
                raise SafeError("Revocation unavailable. Use Google account permissions, then retry.") from None
            store.path.unlink(missing_ok=True)
            print("Local authorization deleted. Review Google account permissions to confirm access removal.")
    except SafeError as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)

if __name__ == "__main__":
    main()
