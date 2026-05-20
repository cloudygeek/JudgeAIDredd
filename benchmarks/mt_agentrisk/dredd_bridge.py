"""Standalone Dredd HTTP client for MT-AgentRisk benchmark.

Talks to Judge Dredd's /intent, /evaluate, /end endpoints.
Fail-open on errors (returns "allow" if Dredd is unreachable).

Auth + TLS:
  - api_key defaults to env DREDD_API_KEY when constructor arg is None.
    The hook ALB requires Bearer auth when DREDD_AUTH_MODE=required
    (the prod default). Without a key /intent and /evaluate return 401
    and every call is fail-open — defeating the benchmark.
  - verify_tls defaults to env DREDD_VERIFY_TLS != "false". The
    AI-Sandbox internal ALBs sign with CKO's self-signed CA chain
    which isn't in the container trust store, so set the env var to
    "false" when hitting *.aisandbox.dev.ckotech.internal.
"""

from __future__ import annotations

import logging
import os
import time

import requests

logger = logging.getLogger(__name__)


class DreddBridge:

    def __init__(
        self,
        dredd_url: str = "http://localhost:3001",
        api_key: str | None = None,
        verify_tls: bool | None = None,
    ):
        self.dredd_url = dredd_url.rstrip("/")
        self.api_key = api_key if api_key is not None else os.environ.get("DREDD_API_KEY")
        if verify_tls is None:
            verify_tls = os.environ.get("DREDD_VERIFY_TLS", "true").lower() != "false"
        self.verify_tls = verify_tls
        self.stats = {
            "evaluated": 0,
            "allowed": 0,
            "denied": 0,
            "errors": 0,
            "total_latency_ms": 0.0,
        }
        if not self.verify_tls:
            try:
                import urllib3
                urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
            except Exception:
                pass

    def _headers(self) -> dict:
        h = {"Content-Type": "application/json"}
        if self.api_key:
            h["Authorization"] = f"Bearer {self.api_key}"
        return h

    def register_intent(self, session_id: str, prompt: str) -> dict:
        try:
            resp = requests.post(
                f"{self.dredd_url}/intent",
                json={"session_id": session_id, "prompt": prompt},
                headers=self._headers(),
                timeout=10,
                verify=self.verify_tls,
            )
            resp.raise_for_status()
            logger.info("Dredd intent registered: %s", prompt[:80])
            return resp.json()
        except Exception as e:
            logger.warning("Failed to register intent: %s", e)
            return {"error": str(e)}

    def evaluate(self, session_id: str, tool_name: str, tool_input: dict) -> dict:
        start = time.time()
        try:
            resp = requests.post(
                f"{self.dredd_url}/evaluate",
                json={
                    "session_id": session_id,
                    "tool_name": tool_name,
                    "tool_input": tool_input,
                },
                headers=self._headers(),
                timeout=30,
                verify=self.verify_tls,
            )
            resp.raise_for_status()
            result = resp.json()
            elapsed_ms = (time.time() - start) * 1000
            self.stats["total_latency_ms"] += elapsed_ms
            self.stats["evaluated"] += 1

            meta = result.get("_meta", {})
            hook_output = result.get("hookSpecificOutput", {})
            decision = hook_output.get("permissionDecision", "allow")

            if decision == "deny":
                self.stats["denied"] += 1
            else:
                self.stats["allowed"] += 1

            return {
                "permissionDecision": decision,
                "reason": meta.get("reason", hook_output.get("permissionDecisionReason", "")),
                "stage": meta.get("stage", ""),
                "similarity": meta.get("similarity"),
                "judgeVerdict": meta.get("judgeVerdict"),
                "evaluationMs": meta.get("evaluationMs"),
            }
        except Exception as e:
            self.stats["errors"] += 1
            logger.warning("Dredd evaluation failed for %s: %s", tool_name, e)
            return {"permissionDecision": "allow", "reason": str(e), "stage": "error"}

    def end_session(self, session_id: str) -> dict:
        try:
            resp = requests.post(
                f"{self.dredd_url}/end",
                json={"session_id": session_id},
                headers=self._headers(),
                timeout=5,
                verify=self.verify_tls,
            )
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            logger.warning("Failed to end session: %s", e)
            return {"error": str(e)}

    def summary(self) -> str:
        s = self.stats
        avg = s["total_latency_ms"] / s["evaluated"] if s["evaluated"] else 0
        return (f"{s['evaluated']} evaluated, {s['allowed']} allowed, "
                f"{s['denied']} denied, {s['errors']} errors, avg {avg:.0f}ms")
