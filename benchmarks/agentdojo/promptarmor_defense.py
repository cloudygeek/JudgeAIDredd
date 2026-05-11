"""PromptArmor content-preprocessing defense for AgentDojo.

PromptArmor (Shi et al., arXiv:2507.15219; ICLR 2026) is a content-side
defense: it scans every untrusted-content blob (here, every tool result)
through an off-the-shelf detector LLM and either passes it through clean
or strips an injected span out before the agent sees it.

Architecturally distinct from JudgeDreddDefense:
  - JudgeDredd fires BEFORE ToolsExecutor (pre-tool-call gate).
  - PromptArmor fires AFTER ToolsExecutor (post-tool-result preprocess).

So in the AgentDojo pipeline this element goes between ToolsExecutor and
the next LLM step inside the ToolsExecutionLoop.

Talks to the deployed Judge Dredd `/screen` endpoint over HTTP — the
canonical PromptArmor implementation lives in src/promptarmor-baseline.ts;
this module is a thin Python adapter so the Python AgentDojo runner can
hit it without re-implementing the detector pass.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Sequence
from typing import Any

import requests

from agentdojo.agent_pipeline.base_pipeline_element import BasePipelineElement
from agentdojo.functions_runtime import EmptyEnv, Env, FunctionsRuntime

from dredd_defense import DreddUnavailableError, _DreddFailureGate
from agentdojo.types import (
    ChatMessage,
    text_content_block_from_string,
)

logger = logging.getLogger(__name__)


class PromptArmorDefense(BasePipelineElement):
    """Content-side defense that screens each tool result before it reaches the agent.

    Insert AFTER ToolsExecutor in the ToolsExecutionLoop so it sees the
    tool results that ToolsExecutor produced. The next pipeline step
    (the LLM) will then receive the (possibly sanitised) results.

    Args:
        screen_url: Base URL of the running Judge Dredd hook server
            (the same container that serves /evaluate; /screen lives there).
        backend: Detector backend — "openai" or "bedrock".
        model: Detector model id. Must match the /screen allow-list on
            the server (gpt-4o, gpt-4.1, o4-mini, claude-sonnet-4-6,
            claude-opus-4-7 — substring match).
        run_id: Optional run id; when set, the server appends every
            screen() call to results/promptarmor/<run_id>/calls.jsonl.
        api_key: Bearer token for the hook server's auth gate.
            If unset, requests are sent without an Authorization header
            (works when DREDD_AUTH_MODE=off or =optional).
        timeout: Per-call HTTP timeout in seconds; default 90. Sized to
            cover Bedrock Sonnet latency tails when multiple AgentDojo
            runners hit the same hook container concurrently — 30s
            fail-opened on Phase B PromptArmor cells. The /screen
            endpoint internally caps content size at 32 KB.
    """

    name = "promptarmor"

    def __init__(
        self,
        screen_url: str = "http://localhost:3001",
        backend: str = "bedrock",
        model: str = "eu.anthropic.claude-sonnet-4-6",
        run_id: str | None = None,
        api_key: str | None = None,
        timeout: float = 90.0,
        verify_tls: bool = True,
    ) -> None:
        if backend not in ("openai", "bedrock"):
            raise ValueError(f"backend must be openai or bedrock, got {backend!r}")
        self.screen_url = screen_url.rstrip("/")
        self.backend = backend
        self.model = model
        self.run_id = run_id
        self.api_key = api_key
        self.timeout = timeout
        self.verify_tls = verify_tls
        if not verify_tls:
            # Don't drown the logs in InsecureRequestWarning lines —
            # the operator opted in via --promptarmor-no-verify-tls.
            try:
                import urllib3
                urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
            except Exception:
                pass
        self._last_query: str | None = None
        self.stats = {
            "screened": 0,
            "clean": 0,
            "injected": 0,
            "parse_error": 0,
            "errors": 0,
            "total_latency_ms": 0.0,
            "sanitisation_failed": 0,
        }

    def _screen(self, content: str, task_context: str) -> dict[str, Any]:
        """Call /screen for one blob. Returns a dict with verdict + sanitised."""
        # The endpoint enforces a 32 KB content cap. Truncate proactively
        # so we don't blow our request budget on enormous tool outputs;
        # AgentDojo's tool returns are typically <2 KB anyway.
        truncated = content[:32_000] if len(content) > 32_000 else content
        body: dict[str, Any] = {
            "content": truncated,
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
        try:
            resp = requests.post(
                f"{self.screen_url}/screen",
                json=body,
                headers=headers,
                timeout=self.timeout,
                verify=self.verify_tls,
            )
            resp.raise_for_status()
            result = resp.json()
            _DreddFailureGate.record_success()
            elapsed_ms = (time.time() - start) * 1000
            self.stats["total_latency_ms"] += elapsed_ms
            self.stats["screened"] += 1
            verdict = result.get("verdict", "clean")
            if verdict == "clean":
                self.stats["clean"] += 1
            elif verdict == "injected":
                self.stats["injected"] += 1
                if result.get("sanitisation_failed"):
                    self.stats["sanitisation_failed"] += 1
            elif verdict == "parse_error":
                self.stats["parse_error"] += 1
            return result
        except DreddUnavailableError:
            raise
        except Exception as e:
            self.stats["errors"] += 1
            logger.warning(f"PromptArmor /screen failed: {e}")
            _DreddFailureGate.record_failure("/screen", str(e))
            # Fail-open: pass the original content through. This matches
            # the PromptArmorBaseline class's behaviour on a backend
            # network error and keeps the run unblocked. Dropped from
            # FPR/FNR by only-counting screened vs. error counts.
            return {"verdict": "error", "sanitised": content}

    def query(
        self,
        query: str,
        runtime: FunctionsRuntime,
        env: Env = EmptyEnv(),
        messages: Sequence[ChatMessage] = [],
        extra_args: dict = {},
    ) -> tuple[str, FunctionsRuntime, Env, Sequence[ChatMessage], dict]:
        # Track scenario boundary for telemetry. We don't reset session
        # state because PromptArmor is stateless per-blob.
        if query != self._last_query:
            self._last_query = query

        if len(messages) == 0:
            return query, runtime, env, messages, extra_args

        # We only act on tool-result messages produced by the immediately
        # preceding ToolsExecutor step. Walk back from the end, screen
        # any tool messages we find, and rewrite the message list with
        # sanitised content where verdict=injected.
        new_messages = list(messages)
        for i in range(len(new_messages) - 1, -1, -1):
            msg = new_messages[i]
            if msg["role"] != "tool":
                # Stop at the first non-tool message (an assistant turn)
                # — earlier tool results were screened in earlier loop
                # iterations.
                break

            content_blocks = msg.get("content") or []
            # Tool messages may carry one or more text content blocks.
            # AgentDojo's typical shape is a single block whose `content`
            # is the stringified tool result.
            full_text = ""
            for cb in content_blocks:
                # cb is a dict like {"type": "text", "content": "..."}
                if isinstance(cb, dict) and cb.get("type") == "text":
                    full_text += cb.get("content") or ""
            # Skip empty / non-textual results — nothing to screen.
            if not full_text:
                continue

            screen = self._screen(full_text, query)
            if screen.get("verdict") == "injected":
                sanitised = screen.get("sanitised", full_text)
                logger.info(
                    f"PromptArmor stripped injection from tool result "
                    f"({len(full_text)}->{len(sanitised)} chars)"
                )
                # Replace the message's content with a single sanitised
                # text block. We deliberately preserve tool_call_id and
                # tool_call so the agent loop's bookkeeping stays intact.
                new_msg: dict[str, Any] = dict(msg)
                new_msg["content"] = [text_content_block_from_string(sanitised)]
                new_messages[i] = new_msg  # type: ignore[assignment]

        return query, runtime, env, new_messages, extra_args
