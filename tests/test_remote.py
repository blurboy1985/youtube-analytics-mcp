import os
import unittest
from unittest.mock import patch
from starlette.testclient import TestClient
from youtube_mcp.remote import build_app

SECRET='a'*43
ENV={'YOUTUBE_MCP_PUBLIC_URL':'https://mcp.example.com', 'YOUTUBE_MCP_ACCESS_TOKEN':SECRET,'YOUTUBE_MCP_CHANNEL_ID':'UC_test'}
class RemoteTests(unittest.TestCase):
    def test_missing_settings_fail_closed(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(ValueError): build_app()
    def test_invalid_url_rejected(self):
        for url in ['http://mcp.example.com','https://mcp.example.com/mcp','https://user@mcp.example.com']:
            with patch.dict(os.environ,ENV|{'YOUTUBE_MCP_PUBLIC_URL':url}):
                with self.assertRaises(ValueError): build_app()
    def test_missing_channel_rejected(self):
        with patch.dict(os.environ,ENV|{'YOUTUBE_MCP_CHANNEL_ID':''}):
            with self.assertRaises(ValueError): build_app()
    def test_auth_and_protocol(self):
        with patch.dict(os.environ,ENV):
            with TestClient(build_app(),base_url=ENV['YOUTUBE_MCP_PUBLIC_URL']) as client:
                self.assertEqual(client.post('/mcp').status_code,401)
                self.assertEqual(client.post('/mcp',headers={'Authorization':'Bearer wrong'}).status_code,401)
                headers={'Authorization':'Bearer '+SECRET,'Accept':'application/json, text/event-stream'}
                self.assertEqual(client.post('/mcp?token=x',headers=headers).status_code,403)
                self.assertEqual(client.post('/mcp',headers=headers|{'Origin':'https://evil.example'}).status_code,403)
                self.assertEqual(client.post('/mcp',headers=headers|{'Host':'evil.example'}).status_code,403)
                result=client.post('/mcp',headers=headers,json={'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2025-11-25','capabilities':{},'clientInfo':{'name':'test','version':'1'}}})
                self.assertEqual(result.status_code,200,result.text)
                self.assertIn('no-store',result.headers['cache-control'])
                listed=client.post('/mcp',headers=headers,json={'jsonrpc':'2.0','id':2,'method':'tools/list','params':{}})
                self.assertEqual(len(listed.json()['result']['tools']),7)
