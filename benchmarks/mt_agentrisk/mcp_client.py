"""Stdio client for MCP servers (direct subprocess, no supergateway).

Spawns each MCP server as a child process and communicates via
JSON-RPC over stdin/stdout.  No HTTP, no SSE, no session management.
"""

from __future__ import annotations

import json
import logging
import subprocess
import threading
import queue
import shutil
import time
from dataclasses import dataclass, field

from .llm_client import ToolDef

logger = logging.getLogger(__name__)

# Each server config maps to a command that speaks MCP over stdio.
# The entrypoint sets env vars for paths; these are the fallback defaults.
DEFAULT_MCP_COMMANDS = {
    "filesystem": {
        "cmd": ["node", "node_modules/@modelcontextprotocol/server-filesystem/dist/index.js",
                "/tmp/mcp-workspace", "/tmp", "/app"],
    },
    "postgres": {
        "cmd": ["postgres-mcp", "postgresql://postgres:password@localhost:5432/postgres"],
    },
    "browser": {
        "cmd": ["node", "node_modules/@playwright/mcp/cli.js", "--isolated", "--no-sandbox"],
        "env_extra": {"PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH": "/usr/bin/chromium"},
    },
    "notion": {
        "cmd": ["npx", "-y", "@notionhq/notion-mcp-server"],
    },
}


@dataclass
class MCPServer:
    name: str
    cmd: list[str]
    env_extra: dict[str, str] = field(default_factory=dict)
    tools: list[ToolDef] = field(default_factory=list)
    _tool_names: set[str] = field(default_factory=set, repr=False)
    _process: subprocess.Popen | None = field(default=None, repr=False)
    _reader_thread: threading.Thread | None = field(default=None, repr=False)
    _response_queue: queue.Queue = field(default_factory=queue.Queue, repr=False)
    _next_id: int = field(default=1, repr=False)


class MCPToolRouter:
    """Routes tool calls to the correct MCP server based on tool name."""

    def __init__(self, server_configs: dict[str, dict] | None = None):
        configs = server_configs or DEFAULT_MCP_COMMANDS
        self._servers: dict[str, MCPServer] = {}
        for name, cfg in configs.items():
            self._servers[name] = MCPServer(
                name=name,
                cmd=cfg["cmd"],
                env_extra=cfg.get("env_extra", {}),
            )
        self._tool_to_server: dict[str, MCPServer] = {}

    def connect_all(self, retries: int = 3, delay: float = 2.0) -> None:
        for server in self._servers.values():
            if not shutil.which(server.cmd[0]) and server.cmd[0] != "node":
                logger.warning("Skipping %s: %s not found", server.name, server.cmd[0])
                continue
            for attempt in range(1, retries + 1):
                try:
                    self._start_server(server)
                    self._initialize(server)
                    self._discover_tools(server)
                    logger.info("Connected to %s: %d tools", server.name, len(server.tools))
                    break
                except Exception as e:
                    self._stop_server(server)
                    if attempt < retries:
                        logger.info("Retry %d/%d for %s: %s", attempt, retries, server.name, e)
                        time.sleep(delay)
                    else:
                        logger.warning("Failed to connect to %s: %s", server.name, e)

    def _start_server(self, server: MCPServer) -> None:
        import os
        env = os.environ.copy()
        env.update(server.env_extra)

        self._stop_server(server)

        server._process = subprocess.Popen(
            server.cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )

        t = threading.Thread(
            target=self._stdout_reader,
            args=(server,),
            daemon=True,
            name=f"mcp-reader-{server.name}",
        )
        t.start()
        server._reader_thread = t

        # Log stderr in background
        threading.Thread(
            target=self._stderr_reader,
            args=(server,),
            daemon=True,
            name=f"mcp-stderr-{server.name}",
        ).start()

    def _stdout_reader(self, server: MCPServer) -> None:
        """Read newline-delimited JSON-RPC messages from stdout."""
        try:
            for raw_line in server._process.stdout:
                line = raw_line.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                    if "id" in msg:
                        server._response_queue.put(msg)
                except json.JSONDecodeError:
                    logger.debug("Bad JSON from %s: %s", server.name, line[:200])
        except Exception as e:
            logger.debug("Reader for %s ended: %s", server.name, e)

    def _stderr_reader(self, server: MCPServer) -> None:
        try:
            for line in server._process.stderr:
                text = line.decode("utf-8", errors="replace").rstrip()
                if text:
                    logger.debug("[%s stderr] %s", server.name, text)
        except Exception:
            pass

    def _stop_server(self, server: MCPServer) -> None:
        if server._process is not None:
            try:
                server._process.terminate()
                server._process.wait(timeout=5)
            except Exception:
                try:
                    server._process.kill()
                except Exception:
                    pass
            server._process = None
        server._reader_thread = None
        while not server._response_queue.empty():
            try:
                server._response_queue.get_nowait()
            except queue.Empty:
                break

    def _send_jsonrpc(self, server: MCPServer, method: str, params: dict | None = None) -> dict:
        if server._process is None or server._process.poll() is not None:
            raise ConnectionError(f"Server {server.name} is not running")

        msg_id = server._next_id
        server._next_id += 1

        payload = {"jsonrpc": "2.0", "id": msg_id, "method": method}
        if params is not None:
            payload["params"] = params

        line = json.dumps(payload) + "\n"
        server._process.stdin.write(line.encode("utf-8"))
        server._process.stdin.flush()

        try:
            resp = server._response_queue.get(timeout=60)
            return resp
        except queue.Empty:
            raise TimeoutError(f"No response from {server.name} for {method} within 60s")

    def _initialize(self, server: MCPServer) -> None:
        resp = self._send_jsonrpc(server, "initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "mt-agentrisk-benchmark", "version": "1.0"},
        })
        if "error" in resp:
            raise ConnectionError(f"Initialize failed: {resp['error']}")

        # Send initialized notification (no response expected)
        notif = {"jsonrpc": "2.0", "method": "notifications/initialized"}
        line = json.dumps(notif) + "\n"
        server._process.stdin.write(line.encode("utf-8"))
        server._process.stdin.flush()

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

        except TimeoutError:
            logger.warning("Tool call timed out: %s", tool_name)
            return "Error: tool call timed out after 60s"
        except Exception as e:
            logger.warning("Tool call failed: %s(%s): %s", tool_name, arguments, e)
            return f"Error: {e}"

    def disconnect_all(self) -> None:
        self._tool_to_server.clear()
        for server in self._servers.values():
            self._stop_server(server)
            server.tools.clear()
            server._tool_names.clear()

    def server_status(self) -> dict[str, int]:
        return {s.name: len(s.tools) for s in self._servers.values()}
