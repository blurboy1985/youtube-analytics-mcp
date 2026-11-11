import json
import os
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import patch

import httpx
from cryptography.fernet import Fernet
from youtube_mcp.core import SCOPES, SafeError, TokenStore, YouTube, validate_dates

class CoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.key = Fernet.generate_key().decode()
        self.store = TokenStore(Path(self.tmp.name)/"token.enc", self.key)
        self.store.save({"client_id": "client", "client_secret": "secret", "refresh_token": "SECRET_REFRESH", "scopes": sorted(SCOPES)})
        self.calls = []

    def client(self, report=None, status=200, owner="mine"):
        def handle(req):
            self.calls.append(req)
            if req.url.path == "/token":
                return httpx.Response(200, json={"access_token": "SECRET_ACCESS", "scope": " ".join(SCOPES)})
            self.assertEqual(req.headers["Authorization"], "Bearer SECRET_ACCESS")
            if req.url.path.endswith("channels"):
                self.assertEqual(req.url.params["mine"], "true")
                return httpx.Response(200, json={"items": [{"id": "mine", "snippet": {"title": "Channel"}, "statistics": {"viewCount": "0"}}]})
            if req.url.path.endswith("videos"):
                return httpx.Response(200, json={"items": [{"snippet": {"channelId": owner}}]})
            return httpx.Response(status, json=report or {"rows": [], "columnHeaders": []})
        return YouTube(self.store, httpx.Client(transport=httpx.MockTransport(handle)))

    def test_encrypted_store(self):
        self.assertNotIn(b"SECRET_REFRESH", self.store.path.read_bytes())
        self.assertEqual(self.store.load()["refresh_token"], "SECRET_REFRESH")
        self.assertEqual(self.store.path.stat().st_mode & 0o777, 0o600)

    def test_malformed_saved_authorization(self):
        for payload in ([], {}, {"scopes": [{}]}):
            self.store.save(payload)
            with self.assertRaises(SafeError): self.store.load()

    def test_client_closed(self):
        with self.client() as service:
            service.owner()
        self.assertTrue(service.client.is_closed)

    def test_wrong_key(self):
        with self.assertRaises(SafeError):
            TokenStore(self.store.path, Fernet.generate_key().decode()).load()

    def test_missing_store(self):
        with self.assertRaises(SafeError): TokenStore(Path(self.tmp.name)/"absent", self.key).load()

    def test_default_dates(self):
        start, end = validate_dates(None, None)
        self.assertEqual(end, (date.today()-timedelta(days=3)).isoformat())
        self.assertEqual((date.fromisoformat(end)-date.fromisoformat(start)).days, 27)

    def test_invalid_dates(self):
        for a,b in [("bad",None),("2026-01-02","2026-01-01"),(None,"2999-01-01"),("2000-01-01","2000-01-02"),("2024-01-01","2026-01-01")]:
            with self.subTest(a=a,b=b), self.assertRaises(SafeError): validate_dates(a,b)

    def test_report_owner_bound(self):
        result = self.client({"rows": [[0]], "columnHeaders": [{"name": "views"}]}).report("2025-01-01","2025-01-31")
        self.assertEqual(self.calls[-1].url.params["ids"], "channel==MINE")
        self.assertEqual(result["rows"], [[0]])
        self.assertNotIn("SECRET", json.dumps(result))
        self.assertTrue(result["data_notes"])

    def test_empty_is_empty(self):
        self.assertEqual(self.client().report("2025-01-01","2025-01-31")["rows"], [])

    def test_pin(self):
        with patch.dict(os.environ, {"YOUTUBE_MCP_CHANNEL_ID": "other"}), self.assertRaises(SafeError): self.client().owner()

    def test_cross_channel_video_rejected(self):
        with self.assertRaises(SafeError): self.client(owner="other").verify_video("abcdefghijk")

    def test_video_injection_rejected(self):
        service = self.client()
        with self.assertRaises(SafeError): service.verify_video("abc;video==foo")
        self.assertEqual(len(self.calls), 0)

    def test_valid_video(self): self.client().verify_video("abcdefghijk")

    def test_quota_safe_error(self):
        with self.assertRaisesRegex(SafeError, "quota") as ctx:
            self.client({"secret": "DO_NOT_LEAK"},403).report("2025-01-01","2025-01-31")
        self.assertNotIn("DO_NOT_LEAK",str(ctx.exception))

    def test_no_arbitrary_endpoint(self):
        with self.assertRaises(SafeError): self.client().get("https://evil.example",{})

    def test_broad_scopes_refused(self):
        data = self.store.load(); data["scopes"].append("https://www.googleapis.com/auth/youtube"); self.store.save(data)
        with self.assertRaises(SafeError): self.client().owner()

    def test_401_retries_once(self):
        count = 0
        def handler(req):
            nonlocal count
            if req.url.path == "/token": return httpx.Response(200,json={"access_token":"ok"})
            count += 1
            return httpx.Response(401,json={"error":"secret"})
        service = YouTube(self.store,httpx.Client(transport=httpx.MockTransport(handler)))
        with self.assertRaises(SafeError): service.owner()
        self.assertEqual(count,2)

if __name__ == "__main__": unittest.main()
