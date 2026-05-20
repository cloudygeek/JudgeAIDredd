"""Vendor-abstracted chat-with-tools interface.

A run is: send a conversation (system prompt + user messages + tool results)
to the model, receive a response that either ends or requests tool calls,
execute any approved tool calls, append results to the conversation, repeat.

Each vendor adapter implements the same surface so the orchestration loop in
run.py is identical across vendors.

Adapters are deliberately thin: they do not implement security guardrails.
The harness applies the guardrail configuration (C1/C3/C4-equivalent) by
choosing which system prompt to load and which tool-approval policy to apply
in run.py, not inside the adapter.

# TODO[harness]: every _call_api and _extract_tool_calls method needs a
# vendor-specific implementation. The contracts are documented in each
# adapter's docstring.
"""

from __future__ import annotations

import abc
import json
import os
from dataclasses import dataclass, field
from typing import Any


# ---- shared types ----------------------------------------------------------


@dataclass
class ToolCall:
    """A model-issued tool invocation."""
    id: str
    name: str
    arguments: dict[str, Any]


@dataclass
class AssistantTurn:
    """One turn of the agent loop."""
    text: str  # natural-language portion of the response
    tool_calls: list[ToolCall] = field(default_factory=list)
    finish_reason: str = "stop"  # "stop" | "tool_calls" | "length" | ...


# The toolset offered to every vendor. Same JSON schema everywhere so the
# attack scripts produce comparable agent behaviour across vendors.
TOOL_SCHEMAS: list[dict[str, Any]] = [
    {
        "name": "read_file",
        "description": "Read the contents of a file in the working directory.",
        "parameters": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
    },
    {
        "name": "write_file",
        "description": "Write content to a file in the working directory.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "content": {"type": "string"},
            },
            "required": ["path", "content"],
        },
    },
    {
        "name": "run_command",
        "description": "Execute a shell command in the working directory.",
        "parameters": {
            "type": "object",
            "properties": {"command": {"type": "string"}},
            "required": ["command"],
        },
    },
    {
        "name": "http_request",
        "description": "Make an HTTP request.",
        "parameters": {
            "type": "object",
            "properties": {
                "method": {"type": "string", "enum": ["GET", "POST", "PUT", "DELETE", "HEAD"]},
                "url": {"type": "string"},
                "body": {"type": "string"},
                "headers": {"type": "object"},
            },
            "required": ["method", "url"],
        },
    },
]


# ---- adapter base ----------------------------------------------------------


class VendorAdapter(abc.ABC):
    """Abstract chat-with-tools surface.

    Subclasses implement:
      - _call_api(messages, system_prompt) -> raw vendor response
      - _extract_assistant_turn(raw_response) -> AssistantTurn
      - format_tool_result(call_id, output) -> message dict suitable to
        re-feed to the model

    The orchestration loop in run.py calls .chat() repeatedly until the
    model returns finish_reason == 'stop' or the turn budget is exhausted.
    """

    model_name: str

    def __init__(self, model_name: str):
        self.model_name = model_name

    @abc.abstractmethod
    def _call_api(
        self,
        messages: list[dict[str, Any]],
        system_prompt: str | None,
    ) -> Any:
        """Call the vendor API once and return the raw response object."""

    @abc.abstractmethod
    def _extract_assistant_turn(self, raw_response: Any) -> AssistantTurn:
        """Convert vendor-specific response into the harness's AssistantTurn."""

    @abc.abstractmethod
    def format_tool_result(self, call: ToolCall, output: str) -> dict[str, Any]:
        """Format a tool result so it can be appended to the messages list
        and re-sent to the model on the next turn."""

    def chat(
        self,
        messages: list[dict[str, Any]],
        system_prompt: str | None,
    ) -> AssistantTurn:
        """One round-trip to the vendor."""
        raw = self._call_api(messages=messages, system_prompt=system_prompt)
        return self._extract_assistant_turn(raw)


# ---- OpenAI ---------------------------------------------------------------


class OpenAIAdapter(VendorAdapter):
    """OpenAI Chat Completions with function calling.

    Expected usage in _call_api:
        from openai import OpenAI
        client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
        tools = [{"type": "function", "function": s} for s in TOOL_SCHEMAS]
        msgs = ([{"role": "system", "content": system_prompt}] if system_prompt else []) + messages
        return client.chat.completions.create(
            model=self.model_name,
            messages=msgs,
            tools=tools,
            tool_choice="auto",
        )
    """

    def _call_api(self, messages, system_prompt):
        # TODO[harness]: implement OpenAI client call. Pseudocode in docstring.
        raise NotImplementedError(
            "OpenAIAdapter._call_api is a stub. "
            "Implement by calling openai.OpenAI().chat.completions.create with "
            "the TOOL_SCHEMAS converted to OpenAI function-tool format. "
            "Set tool_choice='auto'. Return the raw ChatCompletion object."
        )

    def _extract_assistant_turn(self, raw_response) -> AssistantTurn:
        # TODO[harness]: implement.
        # raw.choices[0].message.content -> text
        # raw.choices[0].message.tool_calls -> list[ChatCompletionMessageToolCall]
        # each tool_call has .id, .function.name, .function.arguments (JSON string)
        # raw.choices[0].finish_reason -> "stop" | "tool_calls" | ...
        raise NotImplementedError(
            "OpenAIAdapter._extract_assistant_turn is a stub. "
            "Parse raw.choices[0].message.content, .tool_calls, and "
            ".finish_reason into AssistantTurn."
        )

    def format_tool_result(self, call: ToolCall, output: str) -> dict[str, Any]:
        # OpenAI expects: {"role": "tool", "tool_call_id": <id>, "content": <output>}
        return {"role": "tool", "tool_call_id": call.id, "content": output}


# ---- Together AI (open-weight inference) -----------------------------------


class TogetherAdapter(VendorAdapter):
    """Together AI inference API for Llama-3.1-70B-Instruct / Qwen-2.5-72B-Instruct.

    Together's API is OpenAI-compatible at the chat-completions level for the
    instruction-tuned models, so the implementation can closely mirror
    OpenAIAdapter. The base URL differs; the tool-calling schema differs in
    some models (e.g. Qwen uses Hermes-style function calls).

    Expected usage:
        from openai import OpenAI
        client = OpenAI(
            api_key=os.environ["TOGETHER_API_KEY"],
            base_url="https://api.together.xyz/v1",
        )

    The 70B-class instruct models support OpenAI-style function calling; smaller
    open-weights typically do not. If swapping to a non-tool-calling model,
    use a JSON-mode wrapper or text-output parsing instead.
    """

    def _call_api(self, messages, system_prompt):
        # TODO[harness]: implement Together client call. Mirror OpenAIAdapter,
        # change base_url to "https://api.together.xyz/v1" and pass model_name.
        raise NotImplementedError(
            "TogetherAdapter._call_api is a stub. "
            "Implement by calling the OpenAI-compatible Together endpoint."
        )

    def _extract_assistant_turn(self, raw_response) -> AssistantTurn:
        # TODO[harness]: most Together instruct models return OpenAI-style
        # message/tool_calls; copy OpenAIAdapter's parsing once that is done.
        raise NotImplementedError(
            "TogetherAdapter._extract_assistant_turn is a stub."
        )

    def format_tool_result(self, call: ToolCall, output: str) -> dict[str, Any]:
        return {"role": "tool", "tool_call_id": call.id, "content": output}


# ---- Anthropic (optional sanity check) ------------------------------------


class AnthropicAdapter(VendorAdapter):
    """Anthropic Messages API. Used optionally to confirm the harness
    reproduces the original primary-matrix GES values within variance.

    Expected usage:
        from anthropic import Anthropic
        client = Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
        tools = [{"name": s["name"], "description": s["description"],
                  "input_schema": s["parameters"]} for s in TOOL_SCHEMAS]
        return client.messages.create(
            model=self.model_name,
            system=system_prompt,
            messages=messages,
            tools=tools,
            max_tokens=4096,
        )
    """

    def _call_api(self, messages, system_prompt):
        # TODO[harness]: implement Anthropic Messages client call.
        raise NotImplementedError("AnthropicAdapter._call_api is a stub.")

    def _extract_assistant_turn(self, raw_response) -> AssistantTurn:
        # TODO[harness]: anthropic Messages content blocks are a list of
        # {"type": "text", "text": ...} | {"type": "tool_use", "id": ..., "name": ..., "input": ...}
        # stop_reason -> "end_turn" | "tool_use" | "max_tokens"
        raise NotImplementedError(
            "AnthropicAdapter._extract_assistant_turn is a stub."
        )

    def format_tool_result(self, call: ToolCall, output: str) -> dict[str, Any]:
        # Anthropic expects tool_result inside a user-role message:
        # {"role": "user", "content": [
        #     {"type": "tool_result", "tool_use_id": call.id, "content": output}
        # ]}
        return {
            "role": "user",
            "content": [
                {"type": "tool_result", "tool_use_id": call.id, "content": output}
            ],
        }


# ---- factory --------------------------------------------------------------


def make_adapter(vendor: str, model_name: str) -> VendorAdapter:
    """Construct the right adapter for a (vendor, model_name) pair."""
    vendor = vendor.lower()
    if vendor == "openai":
        return OpenAIAdapter(model_name)
    if vendor == "together":
        return TogetherAdapter(model_name)
    if vendor == "anthropic":
        return AnthropicAdapter(model_name)
    raise ValueError(f"unknown vendor: {vendor!r}")
