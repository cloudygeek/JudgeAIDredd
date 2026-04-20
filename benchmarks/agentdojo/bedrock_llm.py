"""Bedrock-compatible AnthropicLLM for AgentDojo.

Wraps AsyncAnthropicBedrock into the AgentDojo AnthropicLLM by bypassing
the isinstance check in __init__.
"""

from anthropic import AsyncAnthropicBedrock

from agentdojo.agent_pipeline.llms.anthropic_llm import AnthropicLLM


# Bedrock model ID mapping
BEDROCK_MODELS = {
    "haiku": "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
    "sonnet": "eu.anthropic.claude-sonnet-4-6",
    "opus": "eu.anthropic.claude-opus-4-20250514-v1:0",
}


class BedrockAnthropicLLM(AnthropicLLM):
    """AnthropicLLM that uses AWS Bedrock instead of the direct Anthropic API."""

    def __init__(
        self,
        model: str,
        aws_region: str = "eu-west-2",
        temperature: float | None = 0.0,
        thinking_budget_tokens: int | None = None,
        max_tokens: int = 1024,
    ) -> None:
        client = AsyncAnthropicBedrock(aws_region=aws_region)
        # Bypass the isinstance check by directly setting attributes
        self.client = client
        self.model = model
        self.thinking_budget_tokens = thinking_budget_tokens
        if self.thinking_budget_tokens is not None:
            self.temperature = 1
        else:
            self.temperature = temperature
        if thinking_budget_tokens is not None:
            self._MAX_TOKENS = max_tokens + thinking_budget_tokens
        else:
            self._MAX_TOKENS = max_tokens
