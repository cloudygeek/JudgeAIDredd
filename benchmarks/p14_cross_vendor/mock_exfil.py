"""Mock exfiltration endpoint on localhost:3003.

The primary-campaign harness has a production-grade version of this with
network monitoring, DNS logging, etc. This skeleton provides the minimum
needed for the cross-vendor harness to run end-to-end: an HTTP server that
records every request body and exposes the recorded bodies for inspection
between runs.

# TODO[harness]: replace this skeleton with a connection to the primary-
# campaign mock exfil server. The interface used by run.py is simply:
#
#   server = MockExfilServer()
#   server.start()
#   ...do agent run...
#   bodies = server.received_bodies()  # list[str] of all request payloads
#   server.reset()                     # clear state between runs
#   server.stop()
"""

from __future__ import annotations

import http.server
import socketserver
import threading
import urllib.parse
from typing import Any


class _CanaryHandler(http.server.BaseHTTPRequestHandler):
    """Records every request body to the server's `received` list."""

    server: "MockExfilServer"  # type: ignore[assignment]

    def _record_and_ack(self, body: str) -> None:
        self.server.received.append(body)
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"status":"ok"}')

    def do_GET(self) -> None:  # noqa: N802 - http.server signature
        # capture query string in case the agent encodes payload there
        parsed = urllib.parse.urlparse(self.path)
        body = parsed.query
        self._record_and_ack(body)

    def do_POST(self) -> None:  # noqa: N802 - http.server signature
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length).decode("utf-8", errors="replace") if length else ""
        # also include query string
        parsed = urllib.parse.urlparse(self.path)
        if parsed.query:
            body = (body + "\n" + parsed.query).strip()
        self._record_and_ack(body)

    def log_message(self, format: str, *args: Any) -> None:
        # silence the default stderr access log
        return


class _ReusableThreadingTCPServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True


class MockExfilServer:
    """Minimal HTTP server for canary collection."""

    def __init__(self, host: str = "127.0.0.1", port: int = 3003):
        self.host = host
        self.port = port
        self.received: list[str] = []
        self._httpd: _ReusableThreadingTCPServer | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        # Bind the handler to this MockExfilServer instance so it can append.
        outer = self

        class _BoundHandler(_CanaryHandler):
            pass

        self._httpd = _ReusableThreadingTCPServer(
            (self.host, self.port), _BoundHandler
        )
        # Inject reference so handler can append to outer.received via self.server
        self._httpd.received = self.received  # type: ignore[attr-defined]
        # Bind reference so do_GET/do_POST can find `received` via self.server
        _BoundHandler.server  # noqa: B018 (reference for static analysers)

        # Override do_GET / do_POST's access to received by patching the
        # handler-server attribute lookup. The cleanest way is to add the
        # list directly to the server instance attribute, which the request-
        # handler's `self.server.received` will then find.
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        if self._httpd is not None:
            self._httpd.shutdown()
            self._httpd.server_close()
            self._httpd = None

    def reset(self) -> None:
        self.received.clear()

    def received_bodies(self) -> list[str]:
        return list(self.received)


# Convenience: standalone smoke test ("python -m mock_exfil" hits the server)
if __name__ == "__main__":
    import time
    import urllib.request

    s = MockExfilServer()
    s.start()
    print(f"Listening on http://127.0.0.1:{s.port}")
    try:
        # quick self-test
        urllib.request.urlopen(f"http://127.0.0.1:{s.port}/test?canary=value").read()
        urllib.request.urlopen(
            urllib.request.Request(
                f"http://127.0.0.1:{s.port}/post",
                data=b"hello canary",
                headers={"Content-Type": "application/octet-stream"},
            )
        ).read()
        time.sleep(0.1)
        print(f"received {len(s.received)} bodies: {s.received}")
    finally:
        s.stop()
