"""PromptArmor screening bridge for MT-AgentRisk benchmark.

Talks to Judge Dredd's `/screen` endpoint (which hosts the PromptArmor
detector). Used in the agent loop to sanitise tool-result text before
the LLM sees it on the next turn — same pattern as the InjecAgent /
AgentDojo PromptArmor adapters, ported to MT-AgentRisk's loop.

Fail-open semantics: any HTTP error returns the original text
unchanged so a transient hook outage doesn't poison the whole run.
The cell-summary still records the failure count so operators can
spot it.

Compose with `DreddBridge` for the T-5 composite arm: PromptArmor
sanitises the tool result, then Dredd's `/evaluate` decides whether
the next tool call is allowed. Composite cells pass both bridges to
`run_scenario`.
"""

from __future__ import annotations

import logging
import time
from typing import Any

import requests

logger = logging.getLogger(__name__)


class PromptArmorBridge:
    """HTTP client for Dredd's /screen endpoint.

    Stats shape mirrors DreddBridge so the per-scenario summary can
    serialise both bridges with the same code.
    """

    def __init__(
        self,
        dredd_url: str,
        backend: str,
        model: str,
        run_id: str | None = None,
        api_key: str | None = None,
        verify_tls: bool = True,
        timeout_s: float = 90.0,
    ) -> None:
        self.dredd_url = dredd_url.rstrip("/")
        self.backend = backend
        self.model = model
        self.run_id = run_id
        self.api_key = api_key
        self.verify_tls = verify_tls
        self.timeout_s = timeout_s
        self.stats: dict[str, Any] = {
            "screened": 0,
            "clean": 0,
            "injected": 0,
            "sanitised": 0,
            "sanitisation_failed": 0,
            "errors": 0,
            "total_latency_ms": 0.0,
        }

    def screen(self, text: str, task_context: str) -> tuple[str, dict[str, Any]]:
        """Send text to /screen, return (sanitised_text, telemetry).

        Sanitised text replaces the original in the conversation if
        the verdict was "injected" — otherwise the original passes
        through unchanged. Telemetry dict gets attached to the
        scenario result for later analysis.
        """
        body: dict[str, Any] = {
            "content": text[:32_000],  # /screen caps at 32 KB
            "task_context": task_context,
            "backend": self.backend,
            "model": self.model,
        }
        if self.run_id:
            body["run_id"] = self.run_id

        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        start = time.time()
        self.stats["screened"] += 1

        try:
            resp = requests.post(
                f"{self.dredd_url}/screen",
                json=body,
                headers=headers,
                timeout=self.timeout_s,
                verify=self.verify_tls,
            )
            resp.raise_for_status()
            result = resp.json()
            latency_ms = (time.time() - start) * 1000.0
            self.stats["total_latency_ms"] += latency_ms

            verdict = result.get("verdict", "clean")
            if verdict == "clean":
                self.stats["clean"] += 1
            elif verdict == "injected":
                self.stats["injected"] += 1
                if result.get("sanitisation_failed"):
                    self.stats["sanitisation_failed"] += 1
                else:
                    self.stats["sanitised"] += 1
            else:
                # Parse error / unknown verdict — count as an error
                # so the operator notices.
                self.stats["errors"] += 1

            return result.get("sanitised", text), {
                "verdict": verdict,
                "latency_ms": result.get("latency_ms", latency_ms),
                "tokens": result.get("tokens"),
                "sanitisation_failed": result.get("sanitisation_failed", False),
            }
        except Exception as e:
            self.stats["errors"] += 1
            logger.warning("PromptArmor /screen failed: %s", e)
            # Fail-open: return original text so the run continues.
            return text, {"verdict": "error", "error": str(e)}
