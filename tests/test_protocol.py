import os
import sys
import unittest
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

class ProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_sdk_handshake_tools_and_safe_missing_config(self):
        env = dict(os.environ)
        env.pop("YOUTUBE_MCP_TOKEN_KEY",None)
        async with stdio_client(StdioServerParameters(command=sys.executable,
            args=["-m","youtube_mcp.server"],env=env)) as (read,write):
            async with ClientSession(read,write) as session:
                await session.initialize()
                listed = await session.list_tools()
                self.assertEqual(len(listed.tools),7)
                for tool in listed.tools: self.assertTrue(tool.annotations.readOnlyHint)
                result = await session.call_tool("channel_overview",{})
                self.assertTrue(result.isError)
                self.assertIn("YOUTUBE_MCP_TOKEN_KEY", result.content[0].text)
                invalid = await session.call_tool("top_videos",{"limit":100})
                self.assertTrue(invalid.isError)

if __name__ == "__main__": unittest.main()
