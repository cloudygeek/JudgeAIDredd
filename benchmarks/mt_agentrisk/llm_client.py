"""LLM chat abstraction for MT-AgentRisk benchmark.

Provides a common interface over three backends:
  - Bedrock Anthropic (Claude via AsyncAnthropicBedrock)
  - OpenAI (GPT-4o-mini via openai SDK)
  - Bedrock Converse (Qwen3 via boto3 bedrock-runtime)
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any, Literal

import boto3
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_random_exponential

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Common types
# ---------------------------------------------------------------------------

@dataclass
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any]


@dataclass
class ChatMessage:
    role: Literal["system", "user", "assistant", "tool"]
    content: str | None = None
    tool_calls: list[ToolCall] | None = None
    tool_call_id: str | None = None


@dataclass
class ToolDef:
    """JSON-schema tool definition in a backend-neutral format."""
    name: str
    description: str
    parameters: dict[str, Any]


# ---------------------------------------------------------------------------
# Model registry
# ---------------------------------------------------------------------------

AGENT_MODELS: dict[str, tuple[str, str, str | None]] = {
    # key → (backend, model_id, region)
    "haiku-4.5":    ("bedrock-anthropic", "eu.anthropic.claude-haiku-4-5-20251001-v1:0", "eu-west-1"),
    "sonnet-4.5":   ("bedrock-anthropic", "eu.anthropic.claude-sonnet-4-5-20250929-v1:0", "eu-west-1"),
    "sonnet-4.6":   ("bedrock-anthropic", "eu.anthropic.claude-sonnet-4-6", "eu-west-1"),
    "opus-4.7":     ("bedrock-anthropic", "eu.anthropic.claude-opus-4-7", "eu-west-1"),
    "gpt-4o-mini":  ("openai", "gpt-4o-mini-2024-07-18", None),
    "qwen3-coder":  ("bedrock-converse", "qwen.qwen3-coder-480b-a35b-v1:0", "eu-west-2"),
}


def create_client(
    model_key: str,
    *,
    region_override: str | None = None,
    temperature: float = 0.0,
    max_tokens: int = 4096,
) -> "LLMClient":
    """Factory: return the right client for a model key."""
    backend, model_id, default_region = AGENT_MODELS[model_key]
    region = region_override or default_region

    if backend == "bedrock-anthropic":
        return BedrockAnthropicClient(model_id, region=region or "eu-west-1",
                                      temperature=temperature, max_tokens=max_tokens)
    if backend == "openai":
        return OpenAIClient(model_id, temperature=temperature, max_tokens=max_tokens)
    if backend == "bedrock-converse":
        return BedrockConverseClient(model_id, region=region or "eu-west-2",
                                     temperature=temperature, max_tokens=max_tokens)
    raise ValueError(f"Unknown backend: {backend}")


# ---------------------------------------------------------------------------
# Bedrock Converse helpers (shared with BedrockConverseClient and judge)
# ---------------------------------------------------------------------------

def _is_retryable(exc: BaseException) -> bool:
    from botocore.exceptions import ClientError
    if isinstance(exc, ClientError):
        code = exc.response.get("Error", {}).get("Code", "")
        return code in ("ThrottlingException", "ServiceUnavailableException",
                        "ModelTimeoutException", "InternalServerException")
    return False


def _tool_def_to_bedrock(t: ToolDef) -> dict:
    return {
        "toolSpec": {
            "name": t.name,
            "description": t.description,
            "inputSchema": {"json": t.parameters},
        }
    }


def _messages_to_bedrock(messages: list[ChatMessage]) -> tuple[list[dict] | None, list[dict]]:
    """Convert ChatMessages to Bedrock Converse format."""
    system_prompt: list[dict] | None = None
    bedrock_msgs: list[dict] = []

    for msg in messages:
        if msg.role == "system":
            if msg.content:
                system_prompt = [{"text": msg.content}]

        elif msg.role == "user":
            block = {"role": "user", "content": [{"text": msg.content or ""}]}
            if bedrock_msgs and bedrock_msgs[-1]["role"] == "user":
                bedrock_msgs[-1]["content"].extend(block["content"])
            else:
                bedrock_msgs.append(block)

        elif msg.role == "assistant":
            content: list[dict] = []
            if msg.content:
                content.append({"text": msg.content})
            if msg.tool_calls:
                for tc in msg.tool_calls:
                    content.append({
                        "toolUse": {
                            "toolUseId": tc.id,
                            "name": tc.name,
                            "input": tc.arguments,
                        }
                    })
            if content:
                bedrock_msgs.append({"role": "assistant", "content": content})

        elif msg.role == "tool":
            tool_result: dict = {
                "toolResult": {
                    "toolUseId": msg.tool_call_id or "unknown",
                    "content": [{"text": msg.content or "OK"}],
                }
            }
            if msg.content and msg.content.startswith("BLOCKED:"):
                tool_result["toolResult"]["status"] = "error"
            if bedrock_msgs and bedrock_msgs[-1]["role"] == "user":
                bedrock_msgs[-1]["content"].append(tool_result)
            else:
                bedrock_msgs.append({"role": "user", "content": [tool_result]})

    return system_prompt, bedrock_msgs


def _parse_bedrock_response(response: dict) -> ChatMessage:
    output = response["output"]["message"]
    content_blocks = output.get("content", [])

    text_parts = []
    tool_calls = []

    for block in content_blocks:
        if "text" in block:
            text_parts.append(block["text"])
        elif "toolUse" in block:
            tu = block["toolUse"]
            tool_calls.append(ToolCall(
                id=tu["toolUseId"],
                name=tu["name"],
                arguments=tu.get("input", {}),
            ))

    return ChatMessage(
        role="assistant",
        content="\n".join(text_parts) if text_parts else None,
        tool_calls=tool_calls if tool_calls else None,
    )


# ---------------------------------------------------------------------------
# Bedrock Anthropic client (Claude models via Bedrock Converse API)
# ---------------------------------------------------------------------------

class BedrockAnthropicClient:
    """Claude models via Bedrock Converse API (same wire format as BedrockConverseClient)."""

    def __init__(self, model_id: str, region: str = "eu-west-1",
                 temperature: float = 0.0, max_tokens: int = 4096):
        self.model_id = model_id
        self.region = region
        self.temperature = temperature
        self.max_tokens = max_tokens
        self._client = boto3.client("bedrock-runtime", region_name=region)

    @retry(wait=wait_random_exponential(multiplier=2, max=90),
           stop=stop_after_attempt(8), reraise=True,
           retry=retry_if_exception(_is_retryable))
    def _converse(self, **kwargs) -> dict:
        return self._client.converse(**kwargs)

    def chat(self, messages: list[ChatMessage], tools: list[ToolDef]) -> ChatMessage:
        system_prompt, bedrock_messages = _messages_to_bedrock(messages)
        kwargs: dict[str, Any] = {
            "modelId": self.model_id,
            "messages": bedrock_messages,
            "inferenceConfig": {"maxTokens": self.max_tokens, "temperature": self.temperature},
        }
        if system_prompt:
            kwargs["system"] = system_prompt
        if tools:
            kwargs["toolConfig"] = {"tools": [_tool_def_to_bedrock(t) for t in tools]}
        response = self._converse(**kwargs)
        return _parse_bedrock_response(response)


# ---------------------------------------------------------------------------
# Bedrock Converse client (Qwen / non-Anthropic models)
# ---------------------------------------------------------------------------

class BedrockConverseClient:
    """Non-Anthropic models via Bedrock Converse API (Qwen, Llama, etc.)."""

    def __init__(self, model_id: str, region: str = "eu-west-2",
                 temperature: float = 0.0, max_tokens: int = 4096):
        self.model_id = model_id
        self.region = region
        self.temperature = temperature
        self.max_tokens = max_tokens
        self._client = boto3.client("bedrock-runtime", region_name=region)

    @retry(wait=wait_random_exponential(multiplier=2, max=90),
           stop=stop_after_attempt(8), reraise=True,
           retry=retry_if_exception(_is_retryable))
    def _converse(self, **kwargs) -> dict:
        return self._client.converse(**kwargs)

    def chat(self, messages: list[ChatMessage], tools: list[ToolDef]) -> ChatMessage:
        system_prompt, bedrock_messages = _messages_to_bedrock(messages)
        kwargs: dict[str, Any] = {
            "modelId": self.model_id,
            "messages": bedrock_messages,
            "inferenceConfig": {"maxTokens": self.max_tokens, "temperature": self.temperature},
        }
        if system_prompt:
            kwargs["system"] = system_prompt
        if tools:
            kwargs["toolConfig"] = {"tools": [_tool_def_to_bedrock(t) for t in tools]}
        response = self._converse(**kwargs)
        return _parse_bedrock_response(response)


# ---------------------------------------------------------------------------
# OpenAI client
# ---------------------------------------------------------------------------

class OpenAIClient:
    """GPT models via OpenAI API."""

    def __init__(self, model_id: str, temperature: float = 0.0, max_tokens: int = 4096):
        import openai
        self.model_id = model_id
        self.temperature = temperature
        self.max_tokens = max_tokens
        self._client = openai.OpenAI()

    def _tools_to_openai(self, tools: list[ToolDef]) -> list[dict]:
        return [
            {
                "type": "function",
                "function": {
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.parameters,
                },
            }
            for t in tools
        ]

    def chat(self, messages: list[ChatMessage], tools: list[ToolDef]) -> ChatMessage:
        oai_messages = []
        for msg in messages:
            if msg.role == "system":
                oai_messages.append({"role": "system", "content": msg.content or ""})
            elif msg.role == "user":
                oai_messages.append({"role": "user", "content": msg.content or ""})
            elif msg.role == "assistant":
                m: dict[str, Any] = {"role": "assistant"}
                if msg.content:
                    m["content"] = msg.content
                if msg.tool_calls:
                    m["tool_calls"] = [
                        {
                            "id": tc.id,
                            "type": "function",
                            "function": {
                                "name": tc.name,
                                "arguments": json.dumps(tc.arguments),
                            },
                        }
                        for tc in msg.tool_calls
                    ]
                oai_messages.append(m)
            elif msg.role == "tool":
                oai_messages.append({
                    "role": "tool",
                    "tool_call_id": msg.tool_call_id or "unknown",
                    "content": msg.content or "",
                })

        kwargs: dict[str, Any] = {
            "model": self.model_id,
            "messages": oai_messages,
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
        }
        if tools:
            kwargs["tools"] = self._tools_to_openai(tools)
            kwargs["tool_choice"] = "auto"

        response = self._client.chat.completions.create(**kwargs)
        choice = response.choices[0]
        msg_out = choice.message

        tool_calls = None
        if msg_out.tool_calls:
            tool_calls = []
            for tc in msg_out.tool_calls:
                try:
                    args = json.loads(tc.function.arguments)
                except (json.JSONDecodeError, TypeError):
                    args = {}
                tool_calls.append(ToolCall(
                    id=tc.id,
                    name=tc.function.name,
                    arguments=args,
                ))

        return ChatMessage(
            role="assistant",
            content=msg_out.content,
            tool_calls=tool_calls if tool_calls else None,
        )


# Re-export types used by other modules
LLMClient = BedrockAnthropicClient | OpenAIClient | BedrockConverseClient
