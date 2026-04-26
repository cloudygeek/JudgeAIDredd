"""Standalone Dredd HTTP client for MT-AgentRisk benchmark.

Talks to Judge Dredd's /intent, /evaluate, /end endpoints.
Fail-open on errors (returns "allow" if Dredd is unreachable).
"""

from __future__ import annotations

import logging
import time

import requests

logger = logging.getLogger(__name__)


class DreddBridge:

    def __init__(self, dredd_url: str = "http://localhost:3001"):
        self.dredd_url = dredd_url.rstrip("/")
        self.stats = {
            "evaluated": 0,
            "allowed": 0,
            "denied": 0,
            "errors": 0,
            "total_latency_ms": 0.0,
        }

    def register_intent(self, session_id: str, prompt: str) -> dict:
        try:
            resp = requests.post(
                f"{self.dredd_url}/intent",
                json={"session_id": session_id, "prompt": prompt},
                timeout=10,
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
                timeout=30,
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
                timeout=5,
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
