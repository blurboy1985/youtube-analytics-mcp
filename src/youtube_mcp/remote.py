"""Private single-owner Streamable HTTP transport behind an HTTPS reverse proxy.

This is API-key authentication, not a public OAuth authorization server. Never
configure a ChatGPT connector as 'No authentication' against this endpoint.
"""
import hashlib
import hmac
import os
from urllib.parse import urlparse

from mcp.server.transport_security import TransportSecuritySettings
from starlette.responses import JSONResponse
from .server import mcp


class PrivateGate:
    def __init__(self, app, secret: str, authority: str, origin: str):
        if len(secret) < 43 or not secret.isascii() or any(c.isspace() for c in secret):
            raise ValueError("Use a random access token of at least 32 bytes, URL-safe encoded.")
        self.app, self.authority, self.origin = app, authority, origin
        self.digest = hashlib.sha256(secret.encode()).digest()

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)
        headers = scope.get('headers', [])
        values = lambda name: [v.decode('latin1') for k,v in headers if k.lower()==name]
        error, code = None, 403
        if values(b'host') != [self.authority]:
            error = 'Invalid host'
        elif values(b'origin') and values(b'origin') != [self.origin]:
            error = 'Invalid origin'
        elif scope.get('query_string'):
            error = 'Query parameters are not supported'
        elif scope['path'] != '/mcp':
            error, code = 'Not found', 404
        else:
            auth = values(b'authorization')
            if len(auth)!=1 or not auth[0].startswith('Bearer ') or not hmac.compare_digest(
                hashlib.sha256(auth[0][7:].encode()).digest(), self.digest):
                error, code = 'Authentication required', 401
        if error:
            return await JSONResponse({'error':error}, status_code=code,
                headers={'Cache-Control':'no-store', 'WWW-Authenticate':'Bearer realm="youtube-mcp"'})(scope,receive,send)
        async def private_send(message):
            if message['type']=='http.response.start':
                message['headers'] = list(message.get('headers', [])) + [(b'cache-control',b'no-store')]
            await send(message)
        await self.app(scope,receive,private_send)


def build_app():
    url = os.environ.get('YOUTUBE_MCP_PUBLIC_URL','')
    parsed = urlparse(url)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.path not in ('','/') or parsed.query or parsed.fragment or parsed.username or parsed.password:
        raise ValueError('YOUTUBE_MCP_PUBLIC_URL must be the exact HTTPS origin, without a path.')
    secret = os.environ.get('YOUTUBE_MCP_ACCESS_TOKEN','')
    # Bind every request to one explicitly configured owner even after reconnection.
    if not os.environ.get('YOUTUBE_MCP_CHANNEL_ID'):
        raise ValueError('Pin YOUTUBE_MCP_CHANNEL_ID before enabling remote access.')
    mcp.settings.stateless_http = True
    mcp.settings.json_response = True
    mcp.settings.max_request_body_size = 16384
    mcp.settings.transport_security = TransportSecuritySettings(enable_dns_rebinding_protection=True,
        allowed_hosts=[parsed.netloc], allowed_origins=[url.rstrip('/')])
    return PrivateGate(mcp.streamable_http_app(),secret,parsed.netloc,url.rstrip('/'))


def main():
    import uvicorn
    # No proxy-header trust: forwarded host/scheme must never bypass the gate.
    uvicorn.run(build_app(),host=os.environ.get('YOUTUBE_MCP_BIND','127.0.0.1'),
        port=int(os.environ.get('PORT','8000')),proxy_headers=False,access_log=False)
