"""SSE client for ToolShield's MCP servers (via supergateway).

Supergateway wraps stdio MCP servers and exposes them over HTTP+SSE:
  - GET  /sse      → subscribe to server-sent events (includes endpoint URI)
  - POST /message  → send JSON-RPC requests

This client connects to each server's /sse endpoint to get the message
URI, then sends JSON-RPC tool/list and tool/call requests via POST.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field

import requests

from .llm_client import ToolDef

logger = logging.getLogger(__name__)

DEFAULT_MCP_SERVERS = {
    "filesystem": "http://localhost:9090",
    "postgres":   "http://localhost:9091",
    "browser":    "http://localhost:9092",
    "terminal":   "http://localhost:9093",
    "notion":     "http://localhost:9097",
}


@dataclass
class MCPServer:
    name: str
    url: str
    message_url: str | None = None
    tools: list[ToolDef] = field(default_factory=list)
    _tool_names: set[str] = field(default_factory=set, repr=False)


class MCPToolRouter:
    """Routes tool calls to the correct MCP server based on tool name."""

    def __init__(self, server_configs: dict[str, str] | None = None):
        configs = server_configs or DEFAULT_MCP_SERVERS
        self._servers: dict[str, MCPServer] = {
            name: MCPServer(name=name, url=url.rstrip("/"))
            for name, url in configs.items()
        }
        self._tool_to_server: dict[str, MCPServer] = {}

    def connect_all(self, retries: int = 5, delay: float = 3.0) -> None:
        for server in self._servers.values():
            for attempt in range(1, retries + 1):
                try:
                    self._connect_sse(server)
                    self._discover_tools(server)
                    logger.info("Connected to %s (%s): %d tools",
                                server.name, server.url, len(server.tools))
                    break
                except Exception as e:
                    if attempt < retries:
                        logger.info("Retry %d/%d for %s: %s",
                                    attempt, retries, server.name, e)
                        time.sleep(delay)
                    else:
                        logger.warning("Failed to connect to %s (%s): %s",
                                       server.name, server.url, e)

    def _connect_sse(self, server: MCPServer) -> None:
        """Connect to the SSE endpoint to discover the message URI.

        Supergateway sends an initial SSE event with the endpoint URI:
          event: endpoint
          data: /message?sessionId=...
        """
        resp = requests.get(
            f"{server.url}/sse",
            stream=True,
            timeout=10,
            headers={"Accept": "text/event-stream"},
        )
        resp.raise_for_status()

        message_url = None
        for line in resp.iter_lines(decode_unicode=True):
            if line and line.startswith("data:"):
                data = line[len("data:"):].strip()
                if "/message" in data:
                    if data.startswith("http"):
                        message_url = data
                    else:
                        message_url = f"{server.url}{data}"
                    break
            if line and line.startswith("event:") and "endpoint" in line:
                continue

        resp.close()

        if message_url:
            server.message_url = message_url
            logger.debug("SSE endpoint for %s: %s", server.name, message_url)
        else:
            server.message_url = f"{server.url}/message"
            logger.debug("No SSE endpoint discovered for %s, defaulting to /message", server.name)

    def _send_jsonrpc(self, server: MCPServer, method: str, params: dict | None = None) -> dict:
        url = server.message_url or f"{server.url}/message"
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
        }
        if params:
            payload["params"] = params

        resp = requests.post(
            url,
            json=payload,
            timeout=60,
            headers={"Content-Type": "application/json"},
        )
        resp.raise_for_status()

        content_type = resp.headers.get("Content-Type", "")
        if "text/event-stream" in content_type:
            return self._parse_sse_response(resp.text)

        return resp.json()

    def _parse_sse_response(self, text: str) -> dict:
        """Parse a JSON-RPC response from SSE-formatted text."""
        for line in text.splitlines():
            if line.startswith("data:"):
                data = line[len("data:"):].strip()
                if data:
                    try:
                        return json.loads(data)
                    except json.JSONDecodeError:
                        continue
        return {}

    def _discover_tools(self, server: MCPServer) -> None:
        data = self._send_jsonrpc(server, "tools/list")

        tools_list = data.get("result", {}).get("tools", [])
        server.tools = []
        server._tool_names = set()
        for t in tools_list:
            schema = t.get("inputSchema", {})
            schema.pop("title", None)
            tool_def = ToolDef(
                name=t["name"],
                description=t.get("description", ""),
                parameters=schema,
            )
            server.tools.append(tool_def)
            server._tool_names.add(t["name"])
            self._tool_to_server[t["name"]] = server

    def get_all_tools(self) -> list[ToolDef]:
        tools = []
        for server in self._servers.values():
            tools.extend(server.tools)
        return tools

    def get_tools_for_surface(self, surface: str) -> list[ToolDef]:
        server = self._servers.get(surface)
        if server is None:
            return []
        return server.tools

    def call_tool(self, tool_name: str, arguments: dict) -> str:
        server = self._tool_to_server.get(tool_name)
        if server is None:
            return f"Error: unknown tool '{tool_name}'"

        try:
            data = self._send_jsonrpc(server, "tools/call", {
                "name": tool_name,
                "arguments": arguments,
            })

            if "error" in data:
                error = data["error"]
                return f"Error: {error.get('message', str(error))}"

            result = data.get("result", {})
            content = result.get("content", [])
            texts = [c.get("text", "") for c in content if c.get("type") == "text"]
            return "\n".join(texts) if texts else json.dumps(result)

        except requests.Timeout:
            logger.warning("Tool call timed out: %s", tool_name)
            return "Error: tool call timed out after 60s"
        except Exception as e:
            logger.warning("Tool call failed: %s(%s): %s", tool_name, arguments, e)
            return f"Error: {e}"

    def disconnect_all(self) -> None:
        self._tool_to_server.clear()
        for server in self._servers.values():
            server.tools.clear()
            server._tool_names.clear()
            server.message_url = None

    def server_status(self) -> dict[str, int]:
        return {s.name: len(s.tools) for s in self._servers.values()}
