# AWS Support ticket — Gemma 4 on Bedrock-mantle: intermittent HTTP 500 on tool-calling requests

**Service:** Amazon Bedrock — `bedrock-mantle` (OpenAI-compatible endpoint)
**Model:** `google.gemma-4-31b`
**Region:** eu-central-1 (Frankfurt)
**Account:** 621978938576 (caller identity authenticated via SigV4, service `bedrock-mantle`)
**Date observed:** 2026-06-15
**Severity:** Medium — blocks programmatic agentic/tool-use workloads on Gemma 4.

---

## Summary

`POST https://bedrock-mantle.eu-central-1.api.aws/openai/v1/chat/completions` for
`google.gemma-4-31b` returns `HTTP 500 internal_server_error` when the request includes a
`tools` array (function-calling). The failure is **time-varying in waves, not per-call
random**: in one ~20-minute window the same payload succeeded **10/10**; in a later window
the identical payload (and a minimal single-tool payload) failed **5/5 and 5/5** — i.e. the
tool-calling path swings between ~0% and ~100% error rate over multi-minute windows. It is
a 500 (server error), not a 400 (request validation), so it is not a payload-shape problem.

A client agent run with 3-attempt retry + exponential backoff still failed **5/5 reps**
during a bad window (all 3 attempts per call hit 500) — so retries do not recover during
an outage window.

Text-only requests (no `tools`) are **100% reliable** (we have never observed a 500 without
a tools array). The instability is specific to the tool-calling path.

## Impact

Agentic workloads that pass tool definitions on every turn fail intermittently. Because a
single agent run makes many sequential tool-bearing calls, even a low per-call 500 rate
compounds into frequent run failures, making Gemma 4 unusable for tool-use applications via
this endpoint despite the model card advertising "native function calling."

## Reproduction

Endpoint: `https://bedrock-mantle.eu-central-1.api.aws/openai/v1/chat/completions`
Auth: SigV4, service name `bedrock-mantle`, region `eu-central-1`.

**Request that intermittently 500s** (a minimal single-tool call):

```json
{
  "model": "google.gemma-4-31b",
  "messages": [{"role": "user", "content": "List the files using get_files."}],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_files",
        "description": "List files matching a glob pattern.",
        "parameters": {
          "type": "object",
          "properties": {"pattern": {"type": "string", "description": "glob"}},
          "required": ["pattern"]
        }
      }
    }
  ],
  "tool_choice": "auto",
  "max_completion_tokens": 128
}
```

**Observed responses to this exact payload:**

- **Success (HTTP 200)** — correct `finish_reason: "tool_calls"`, valid tool call returned:
  ```json
  {"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,
   "tool_calls":[{"id":"call_0","type":"function",
   "function":{"name":"get_files","arguments":"{\"pattern\":\"*\"}"}}]}}],
   "model":"google.gemma-4-31b","object":"chat.completion"}
  ```
  example success request-id: `req_oipifurcexqr7anhbd2y75slr6kmu4zobhlo6tbvg3tvncewm2kq`

- **Failure (HTTP 500)** — same payload, a different attempt:
  ```json
  {"error":{"code":"internal_server_error",
   "message":"The server had an error while processing your request. Sorry about that!",
   "param":null,"type":"server_error"}}
  ```

**Control (always 200):** the same request with the `tools`/`tool_choice` fields removed and
`max_completion_tokens` only — returns text reliably (e.g. `{"choices":[{"finish_reason":
"stop","message":{"content":"PONG"}}]}`, request-id
`req_tltzahjniuie75ypsyzqsydhp732ij6vg3wddzavj4gdlpmkpfta`).

## What we have ruled out (client-side)

- **Auth/credentials:** reproduced with SigV4 (service `bedrock-mantle`) under valid IAM
  credentials in account 621978938576; text-only calls with the same signer succeed 100%.
- **Tool schema shape:** varied `tool_choice` (`auto`/`required`/none), `required` arrays,
  property descriptions, tool count (1 / 6 / 10) — 500s appear and disappear independent of
  these; the same schema returns both 200 and 500 across attempts.
- **API path:** both `/openai/v1/chat/completions` and `/openai/v1/responses` exhibit the
  500 on tool-bearing requests; both are 200 on text-only.
- **Client version:** AWS CLI 2.35.4 (latest); `bedrock-mantle` is not exposed as a CLI
  service, so requests are made directly to the OpenAI-compatible HTTPS endpoint with
  manual SigV4 — the signing is verified correct (text-only calls succeed with the same
  signature path).

## Questions for AWS

1. Is there a known issue / rollout-in-progress with Gemma 4 function-calling on
   `bedrock-mantle` in eu-central-1?
2. Is the 500 capacity/throttling-related (should it be a 429 instead), or a genuine
   server-side error in the tool-calling handler?
3. Is there a recommended retry/backoff guidance for tool-bearing requests until this is
   resolved?

## How to fetch our request IDs

Both success and failure responses carry `x-amzn-requestid` / `x-request-id` headers (the
two examples above). We can supply a larger batch of failing request-ids on request — the
500s recur within a few minutes of sustained tool-call traffic.
