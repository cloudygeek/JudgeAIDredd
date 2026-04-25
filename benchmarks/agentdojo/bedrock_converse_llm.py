"""Bedrock Converse API LLM adapter for AgentDojo.

Uses boto3 bedrock-runtime converse() to talk to any model available on
Bedrock (Qwen, Llama, Mistral, etc.) via the unified Converse API. This is
separate from bedrock_llm.py which wraps AsyncAnthropicBedrock for Claude.
"""

import json
import logging
from collections.abc import Sequence

import boto3
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_random_exponential

from agentdojo.agent_pipeline.base_pipeline_element import BasePipelineElement
from agentdojo.functions_runtime import EmptyEnv, Env, Function, FunctionCall, FunctionsRuntime
from agentdojo.types import (
    ChatAssistantMessage,
    ChatMessage,
    ChatToolResultMessage,
    text_content_block_from_string,
)

logger = logging.getLogger(__name__)

BEDROCK_CONVERSE_MODELS = {
    "qwen3-32b": "qwen.qwen3-32b-v1:0",
    "qwen3-235b": "qwen.qwen3-235b-a22b-2507-v1:0",
}


def _is_retryable(exc: BaseException) -> bool:
    from botocore.exceptions import ClientError
    if isinstance(exc, ClientError):
        code = exc.response.get("Error", {}).get("Code", "")
        return code in ("ThrottlingException", "ServiceUnavailableException",
                        "ModelTimeoutException", "InternalServerException")
    return False


def _function_to_bedrock_tool(f: Function) -> dict:
    schema = f.parameters.model_json_schema()
    schema.pop("title", None)
    return {
        "toolSpec": {
            "name": f.name,
            "description": f.description,
            "inputSchema": {"json": schema},
        }
    }


def _messages_to_bedrock(messages: Sequence[ChatMessage]) -> tuple[list[dict] | None, list[dict]]:
    """Convert AgentDojo messages to Bedrock Converse format.

    Returns (system_prompt_list, bedrock_messages).
    Bedrock requires alternating user/assistant roles. Tool results are
    delivered inside user-role messages (as toolResult content blocks).
    """
    system_prompt: list[dict] | None = None
    bedrock_msgs: list[dict] = []

    for msg in messages:
        role = msg["role"]

        if role == "system":
            texts = [b["content"] for b in msg["content"] if b.get("type") == "text" and b["content"]]
            if texts:
                system_prompt = [{"text": t} for t in texts]

        elif role == "user":
            content = [{"text": b["content"]} for b in msg["content"] if b.get("type") == "text" and b["content"]]
            if content:
                if bedrock_msgs and bedrock_msgs[-1]["role"] == "user":
                    bedrock_msgs[-1]["content"].extend(content)
                else:
                    bedrock_msgs.append({"role": "user", "content": content})

        elif role == "assistant":
            content: list[dict] = []
            if msg["content"]:
                for b in msg["content"]:
                    if b.get("type") == "text" and b["content"]:
                        content.append({"text": b["content"]})
            if msg.get("tool_calls"):
                for tc in msg["tool_calls"]:
                    content.append({
                        "toolUse": {
                            "toolUseId": tc.id or f"tc_{tc.function}",
                            "name": tc.function,
                            "input": dict(tc.args),
                        }
                    })
            if content:
                bedrock_msgs.append({"role": "assistant", "content": content})

        elif role == "tool":
            tool_msg: ChatToolResultMessage = msg  # type: ignore
            tool_result = {
                "toolResult": {
                    "toolUseId": tool_msg["tool_call_id"] or f"tc_{tool_msg['tool_call'].function}",
                    "content": [],
                }
            }
            if tool_msg.get("error"):
                tool_result["toolResult"]["status"] = "error"
                tool_result["toolResult"]["content"].append({"text": tool_msg["error"]})
            else:
                texts = [b["content"] for b in tool_msg["content"] if b.get("type") == "text" and b["content"]]
                for t in texts:
                    tool_result["toolResult"]["content"].append({"text": t})
                if not texts:
                    tool_result["toolResult"]["content"].append({"text": "OK"})

            if bedrock_msgs and bedrock_msgs[-1]["role"] == "user":
                bedrock_msgs[-1]["content"].append(tool_result)
            else:
                bedrock_msgs.append({"role": "user", "content": [tool_result]})

    return system_prompt, bedrock_msgs


def _parse_bedrock_response(response: dict) -> ChatAssistantMessage:
    output = response["output"]["message"]
    content_blocks = output.get("content", [])

    text_parts = []
    tool_calls = []

    for block in content_blocks:
        if "text" in block:
            text_parts.append(block["text"])
        elif "toolUse" in block:
            tu = block["toolUse"]
            tool_calls.append(FunctionCall(
                function=tu["name"],
                args=tu.get("input", {}),
                id=tu["toolUseId"],
            ))

    content = [text_content_block_from_string(t) for t in text_parts] if text_parts else None
    return ChatAssistantMessage(
        role="assistant",
        content=content,
        tool_calls=tool_calls if tool_calls else None,
    )


class BedrockConverseLLM(BasePipelineElement):
    """AgentDojo LLM element using the Bedrock Converse API."""

    def __init__(
        self,
        model_id: str,
        aws_region: str = "eu-west-2",
        temperature: float | None = 0.0,
        max_tokens: int = 2048,
    ) -> None:
        self.model_id = model_id
        self.aws_region = aws_region
        self.temperature = temperature
        self.max_tokens = max_tokens
        self._client = boto3.client("bedrock-runtime", region_name=aws_region)

    @retry(
        wait=wait_random_exponential(multiplier=2, max=90),
        stop=stop_after_attempt(8),
        reraise=True,
        retry=retry_if_exception(_is_retryable),
    )
    def _converse(self, **kwargs) -> dict:
        return self._client.converse(**kwargs)

    def query(
        self,
        query: str,
        runtime: FunctionsRuntime,
        env: Env = EmptyEnv(),
        messages: Sequence[ChatMessage] = [],
        extra_args: dict = {},
    ) -> tuple[str, FunctionsRuntime, Env, Sequence[ChatMessage], dict]:
        system_prompt, bedrock_messages = _messages_to_bedrock(messages)
        bedrock_tools = [_function_to_bedrock_tool(f) for f in runtime.functions.values()]

        kwargs: dict = {
            "modelId": self.model_id,
            "messages": bedrock_messages,
            "inferenceConfig": {"maxTokens": self.max_tokens},
        }
        if self.temperature is not None:
            kwargs["inferenceConfig"]["temperature"] = self.temperature
        if system_prompt:
            kwargs["system"] = system_prompt
        if bedrock_tools:
            kwargs["toolConfig"] = {"tools": bedrock_tools}

        response = self._converse(**kwargs)
        assistant_msg = _parse_bedrock_response(response)
        messages = [*messages, assistant_msg]
        return query, runtime, env, messages, extra_args
