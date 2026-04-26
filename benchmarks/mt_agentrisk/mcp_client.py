"""HTTP+SSE client for ToolShield's MCP servers.

Routes tool calls by name to the correct MCP server. Each server exposes
tools via the Model Context Protocol over HTTP+SSE transport (supergateway).

Falls back to raw HTTP if the mcp Python SDK is not available.
"""

from __future__ import annotations

import json
import logging
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

    def connect_all(self) -> None:
        for server in self._servers.values():
            try:
                self._discover_tools(server)
                logger.info("Connected to %s (%s): %d tools",
                            server.name, server.url, len(server.tools))
            except Exception as e:
                logger.warning("Failed to connect to %s (%s): %s",
                               server.name, server.url, e)

    def _discover_tools(self, server: MCPServer) -> None:
        """Discover tools from an MCP server via its HTTP endpoint.

        ToolShield's MCP servers (via supergateway) expose a JSON-RPC
        endpoint. We send a tools/list request to enumerate available tools.
        """
        resp = requests.post(
            f"{server.url}/mcp",
            json={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}},
            timeout=10,
            headers={"Content-Type": "application/json"},
        )
        resp.raise_for_status()
        data = resp.json()

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
            resp = requests.post(
                f"{server.url}/mcp",
                json={
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "tools/call",
                    "params": {"name": tool_name, "arguments": arguments},
                },
                timeout=60,
                headers={"Content-Type": "application/json"},
            )
            resp.raise_for_status()
            data = resp.json()

            if "error" in data:
                error = data["error"]
                return f"Error: {error.get('message', str(error))}"

            result = data.get("result", {})
            content = result.get("content", [])
            texts = [c.get("text", "") for c in content if c.get("type") == "text"]
            return "\n".join(texts) if texts else json.dumps(result)

        except requests.Timeout:
            logger.warning("Tool call timed out: %s", tool_name)
            return f"Error: tool call timed out after 60s"
        except Exception as e:
            logger.warning("Tool call failed: %s(%s): %s", tool_name, arguments, e)
            return f"Error: {e}"

    def disconnect_all(self) -> None:
        self._tool_to_server.clear()
        for server in self._servers.values():
            server.tools.clear()
            server._tool_names.clear()

    def server_status(self) -> dict[str, int]:
        return {s.name: len(s.tools) for s in self._servers.values()}
