"""Judge AI Dredd defense bridge for AgentDojo benchmark.

Implements BasePipelineElement that intercepts tool calls before execution
and evaluates them against Judge Dredd's three-stage pipeline (policy →
embedding drift → LLM judge). Blocked tool calls are replaced with error
messages so the agent can continue.
"""

import json
import logging
import time
from collections.abc import Sequence
from urllib.parse import urljoin

import requests

from agentdojo.agent_pipeline.base_pipeline_element import BasePipelineElement
from agentdojo.functions_runtime import EmptyEnv, Env, FunctionsRuntime
from agentdojo.types import (
    ChatMessage,
    ChatToolResultMessage,
    text_content_block_from_string,
)

logger = logging.getLogger(__name__)


class DreddUnavailableError(RuntimeError):
    """Raised after MAX_DREDD_FAILURES consecutive Dredd hook failures.

    Prevents a hung production hook from silently fail-opening every
    /evaluate or /screen call and returning bare-agent ASR with a
    defence label — the bug that bit Phase C C6 on 2026-05-11.

    AgentDojo doesn't have a per-cell entry point we can wrap, so the
    exception bubbles all the way up — caller (the entrypoint script)
    sees a non-zero exit and can triage.
    """


class _DreddFailureGate:
    """Per-process consecutive-failure tracker shared between
    JudgeDreddDefense and PromptArmorDefense. A success on either path
    resets the count, since both are signals the hook is alive."""

    import os
    _max = int(os.environ.get("MAX_DREDD_FAILURES", "5"))
    _consecutive = 0

    @classmethod
    def record_failure(cls, endpoint: str, err: str) -> None:
        cls._consecutive += 1
        if cls._consecutive >= cls._max:
            raise DreddUnavailableError(
                f"{cls._consecutive} consecutive Dredd {endpoint} "
                f"failures (last: {err}); aborting cell. Triage the "
                f"hook before re-running."
            )

    @classmethod
    def record_success(cls) -> None:
        cls._consecutive = 0


class JudgeDreddDefense(BasePipelineElement):
    """PreToolUse defense that calls Judge Dredd's HTTP API.

    Insert this BEFORE ToolsExecutor in the ToolsExecutionLoop so it can
    evaluate (and optionally block) tool calls before they execute.

    Args:
        dredd_url: Base URL of the running Judge Dredd server.
        session_id: Unique session identifier for this benchmark run.
        prompt_variant: Which judge prompt to use ("standard", "B7", "B7.1").
    """

    name = "judge_dredd"

    def __init__(
        self,
        dredd_url: str = "http://localhost:3001",
        session_id: str = "agentdojo-bench",
        prompt_variant: str = "B7.1",
        api_key: str | None = None,
        verify_tls: bool = True,
        mode: str = "autonomous",
    ) -> None:
        if mode not in ("interactive", "autonomous", "learn"):
            raise ValueError(f"mode must be interactive|autonomous|learn, got {mode!r}")
        self.dredd_url = dredd_url.rstrip("/")
        self.mode = mode
        # Keep the original base separately so reset_session() can mint
        # `${BASE}-${count}` each time rather than appending to whatever
        # the previous reset produced. Without this, session_id grew by
        # ~3-4 chars every scenario (agentdojo-bench-1 -> -1-2 -> -1-2-3
        # ...) and crossed the hook's {1,128} regex limit at ~40 scenarios,
        # silently turning B7/B7.1 into fail-open runs.
        self._session_id_base = session_id
        self.session_id = session_id
        self.prompt_variant = prompt_variant
        self.api_key = api_key
        self.verify_tls = verify_tls
        self._intent_registered = False
        self._last_query = None
        self._scenario_count = 0
        self.stats = {
            "evaluated": 0,
            "allowed": 0,
            "denied": 0,
            "errors": 0,
            "total_latency_ms": 0,
        }
        if not verify_tls:
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

    def register_intent(self, intent: str) -> None:
        """Register the user task as the session intent with Dredd."""
        try:
            resp = requests.post(
                f"{self.dredd_url}/intent",
                json={
                    "session_id": self.session_id,
                    "prompt": intent,
                    "mode": self.mode,
                },
                headers=self._headers(),
                timeout=10,
                verify=self.verify_tls,
            )
            resp.raise_for_status()
            self._intent_registered = True
            logger.info(f"Dredd intent registered: {intent[:80]}...")
        except Exception as e:
            logger.warning(f"Failed to register intent with Dredd: {e}")

    def reset_session(self, session_id: str, intent: str) -> None:
        """Reset for a new scenario — end old session, register new intent."""
        try:
            requests.post(
                f"{self.dredd_url}/end",
                json={"session_id": self.session_id},
                headers=self._headers(),
                timeout=5,
                verify=self.verify_tls,
            )
        except Exception:
            pass
        self.session_id = session_id
        self._intent_registered = False
        self.register_intent(intent)

    def _evaluate_tool_call(self, tool_name: str, tool_input: dict) -> dict:
        """Call Dredd's /evaluate endpoint for a single tool call.

        Returns dict with at least:
          permissionDecision: "allow" | "deny"
          reason: str
          stage: str (e.g. "policy-allow", "judge-deny")
        """
        start = time.time()
        try:
            payload = {
                "session_id": self.session_id,
                "tool_name": tool_name,
                "tool_input": tool_input,
                "mode": self.mode,
            }
            resp = requests.post(
                f"{self.dredd_url}/evaluate",
                json=payload,
                headers=self._headers(),
                timeout=30,
                verify=self.verify_tls,
            )
            resp.raise_for_status()
            result = resp.json()
            _DreddFailureGate.record_success()
            elapsed_ms = (time.time() - start) * 1000
            self.stats["total_latency_ms"] += elapsed_ms
            self.stats["evaluated"] += 1

            meta = result.get("_meta", {})
            hook_output = result.get("hookSpecificOutput", {})
            return {
                "permissionDecision": hook_output.get("permissionDecision", "allow"),
                "reason": meta.get("reason", hook_output.get("permissionDecisionReason", "")),
                "stage": meta.get("stage", ""),
                "similarity": meta.get("similarity"),
                "judgeVerdict": meta.get("judgeVerdict"),
                "evaluationMs": meta.get("evaluationMs"),
            }
        except DreddUnavailableError:
            raise
        except Exception as e:
            self.stats["errors"] += 1
            logger.warning(f"Dredd evaluation failed for {tool_name}: {e}")
            _DreddFailureGate.record_failure("/evaluate", str(e))
            return {"permissionDecision": "allow", "reason": str(e), "stage": "error"}

    def query(
        self,
        query: str,
        runtime: FunctionsRuntime,
        env: Env = EmptyEnv(),
        messages: Sequence[ChatMessage] = [],
        extra_args: dict = {},
    ) -> tuple[str, FunctionsRuntime, Env, Sequence[ChatMessage], dict]:
        # Auto-register intent when query changes (new scenario)
        if query != self._last_query:
            self._scenario_count += 1
            self._last_query = query
            # Always derive from the original base, never from the current
            # session_id. Otherwise we accumulate suffixes per scenario.
            new_session_id = f"{self._session_id_base}-{self._scenario_count}"
            self.reset_session(new_session_id, query)

        if len(messages) == 0:
            return query, runtime, env, messages, extra_args
        last_msg = messages[-1]
        if last_msg["role"] != "assistant":
            return query, runtime, env, messages, extra_args
        if last_msg["tool_calls"] is None or len(last_msg["tool_calls"]) == 0:
            return query, runtime, env, messages, extra_args

        denied_ids: set[str] = set()

        for tc in last_msg["tool_calls"]:
            result = self._evaluate_tool_call(tc.function, tc.args)
            decision = result.get("permissionDecision", "allow")

            if decision == "deny":
                self.stats["denied"] += 1
                denied_ids.add(tc.id)
                logger.info(f"BLOCKED: {tc.function}({json.dumps(tc.args)[:100]})")
            else:
                self.stats["allowed"] += 1

        if not denied_ids:
            return query, runtime, env, messages, extra_args

        # Keep all tool_calls in the assistant message so every tool_result
        # has a matching tool_use (Anthropic API requirement).  Add error
        # tool_results for denied calls.  When any call in a batch is
        # denied we block the entire batch — a mixed legitimate/malicious
        # batch indicates hijacking.
        error_results = []
        for tc in last_msg["tool_calls"]:
            if tc.id in denied_ids:
                reason = "Security policy denied this tool call"
            else:
                reason = "Blocked: batch contained a denied tool call"
            error_results.append(
                ChatToolResultMessage(
                    role="tool",
                    content=[text_content_block_from_string(
                        f"Tool call blocked by security policy: {reason}"
                    )],
                    tool_call_id=tc.id,
                    tool_call=tc,
                    error=reason,
                )
            )

        # ToolsExecutor will see messages[-1] is "tool" and pass through.
        # The LLM will see error results and can respond accordingly.
        messages = [*messages, *error_results]

        return query, runtime, env, messages, extra_args
