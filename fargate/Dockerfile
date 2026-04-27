# Judge AI Dredd — Test Runner (Tests 3, 7)
# Build context: project root
#   docker build -f fargate/Dockerfile -t judge-ai-dredd .

FROM 891377407345.dkr.ecr.eu-west-1.amazonaws.com/cko-pull-through/docker-hub/library/node:22-bookworm-slim

WORKDIR /app

# ── AWS CLI v2 ──────────────────────────────────────────────────────────────
# Needed because bedrock-client.ts shells out to `aws bedrock-runtime converse`
# and `aws bedrock-runtime invoke-model` for embeddings.
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl unzip ca-certificates \
    && ARCH=$(uname -m) \
    && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${ARCH}.zip" \
         -o /tmp/awscliv2.zip \
    && unzip -q /tmp/awscliv2.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/aws /tmp/awscliv2.zip \
    && rm -rf /var/lib/apt/lists/*

# ── Python 3 + pip (for AgentDojo benchmark) ───────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3-full python3-pip \
    && rm -rf /var/lib/apt/lists/*

# ── Node dependencies ───────────────────────────────────────────────────────
# tsx (devDep) is required at runtime: tsconfig rootDir=src means scenarios/
# cannot be compiled alongside src/ without restructuring; tsx handles it fine.
COPY package.json ./
RUN npm install --registry https://registry.npmjs.org

# ── Application source ──────────────────────────────────────────────────────
COPY tsconfig.json ./
COPY src/ ./src/
COPY scenarios/ ./scenarios/
COPY workspace-template/ ./workspace-template/

# ── AgentDojo benchmark (Python) ────────────────────────────────────────────
# All wheels are vendored in the zip (no network access to PyPI needed).
COPY python-wheels/ /tmp/python-wheels/
# Full dependency closure vendored — install everything with --no-deps to avoid
# pip resolver conflicts (e.g. cohere wants pydantic-core<2.44 but we have 2.46).
RUN pip3 install --break-system-packages --no-index --find-links /tmp/python-wheels/ \
        --no-deps /tmp/python-wheels/*.whl \
    && python3 -c "from agentdojo.agent_pipeline.agent_pipeline import AgentPipeline; print('agentdojo import OK')" \
    && rm -rf /tmp/python-wheels/
COPY benchmarks/ ./benchmarks/

# ── MT-AgentRisk infrastructure (Test 24) ──────────────────────────────────
# PostgreSQL for database-surface scenarios
RUN apt-get update && apt-get install -y --no-install-recommends \
        postgresql postgresql-client sudo \
    && rm -rf /var/lib/apt/lists/*

# Chromium for Playwright MCP browser-surface scenarios
RUN apt-get update && apt-get install -y --no-install-recommends \
        chromium \
    && rm -rf /var/lib/apt/lists/*
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# ToolShield MCP servers (cloned from source — not published on npm)
ARG TOOLSHIELD_COMMIT=main
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && git clone --depth 1 https://github.com/CHATS-lab/ToolShield.git /app/toolshield \
    && rm -rf /app/toolshield/.git \
    && rm -rf /var/lib/apt/lists/*


# ── Build provenance ────────────────────────────────────────────────────────
ARG GIT_COMMIT=unknown
ARG GIT_DIRTY=false
ENV GIT_COMMIT=${GIT_COMMIT}
ENV GIT_DIRTY=${GIT_DIRTY}
ENV BEDROCK_REGION=eu-west-2

# Results written here, then synced to S3
RUN mkdir -p results

# ── Entrypoints + AI Sandbox HTTP wrapper ───────────────────────────────────
# In the zip, these files are at the root (flat layout for CodeBuild).
# Test 7: Cross-Model Agent Testing (sequential)
COPY docker-entrypoint.sh /docker-entrypoint.sh
# Test 3: Statistical Robustness (parallel jobs)
COPY docker-entrypoint-test3.sh /docker-entrypoint-test3.sh
# Test 4: Goal Anchoring Effectiveness (parallel jobs)
COPY docker-entrypoint-test4.sh /docker-entrypoint-test4.sh
# Test 1: Combined Pipeline E2E (effort sweep)
COPY docker-entrypoint-test1.sh /docker-entrypoint-test1.sh
# Test 3a: Statistical Robustness — Opus 4.7 + effort
COPY docker-entrypoint-test3a.sh /docker-entrypoint-test3a.sh
# Test 8: Adversarial Judge Robustness (effort sweep)
COPY docker-entrypoint-test8.sh /docker-entrypoint-test8.sh
# Test 9a: Latency Impact — effort dimension
COPY docker-entrypoint-test9a.sh /docker-entrypoint-test9a.sh
# Test 9: Latency Impact (parallel jobs)
COPY docker-entrypoint-test9.sh /docker-entrypoint-test9.sh
# Test 8 B6: Format Leakage
COPY docker-entrypoint-test8b6.sh /docker-entrypoint-test8b6.sh
# Test 10/11: Pipeline Exfiltration Scoring
COPY docker-entrypoint-test10.sh /docker-entrypoint-test10.sh
# Test 12: AgentDojo External Benchmark
COPY docker-entrypoint-test12.sh /docker-entrypoint-test12.sh
# Test 12a: AgentDojo B7.1-office rerun (token-expiry tainted scenarios)
COPY docker-entrypoint-test12a.sh /docker-entrypoint-test12a.sh
# Test 12b: AgentDojo compromised-scenario repeat-runs
COPY docker-entrypoint-test12b.sh /docker-entrypoint-test12b.sh
# Test 12c: AgentDojo full clean rerun (B7.1-office, OpenAI models)
COPY docker-entrypoint-test12c.sh /docker-entrypoint-test12c.sh
# Test 13: Prompt-Reduction Benchmark (single trace)
COPY docker-entrypoint-test13.sh /docker-entrypoint-test13.sh
# Test 14: Prompt-Reduction Corpus Benchmark
COPY docker-entrypoint-test14.sh /docker-entrypoint-test14.sh
# Test 15: FPR under Prompt v2
COPY docker-entrypoint-test15.sh /docker-entrypoint-test15.sh
# Test 16: Cross-Model Recommended Pipeline
COPY docker-entrypoint-test16.sh /docker-entrypoint-test16.sh
# Test 17: AgentDojo GPT-4o Tier-Match
COPY docker-entrypoint-test17.sh /docker-entrypoint-test17.sh
# Test 18: T3e Exfiltration Under Recommended Pipeline
COPY docker-entrypoint-test18.sh /docker-entrypoint-test18.sh
# Test 20: AgentDojo Cross-Vendor with Qwen3 (Bedrock)
COPY docker-entrypoint-test20.sh /docker-entrypoint-test20.sh
# Test 21: AgentDojo with Anthropic Claude as Defended Agent
COPY docker-entrypoint-test21.sh /docker-entrypoint-test21.sh
# Test 23: T3e Cross-Vendor with Qwen3 (Bedrock Converse)
COPY docker-entrypoint-test23.sh /docker-entrypoint-test23.sh
# Test 24: MT-AgentRisk Multi-Turn Tool-Grounded Safety Benchmark
COPY docker-entrypoint-test24.sh /docker-entrypoint-test24.sh
# Test 25: AgentLAB Long-Horizon Cross-Vendor Smoke
COPY docker-entrypoint-test25.sh /docker-entrypoint-test25.sh
RUN chmod +x /docker-entrypoint.sh /docker-entrypoint-test1.sh /docker-entrypoint-test3.sh /docker-entrypoint-test3a.sh /docker-entrypoint-test4.sh /docker-entrypoint-test8.sh /docker-entrypoint-test8b6.sh /docker-entrypoint-test9.sh /docker-entrypoint-test9a.sh /docker-entrypoint-test10.sh /docker-entrypoint-test12.sh /docker-entrypoint-test12a.sh /docker-entrypoint-test12b.sh /docker-entrypoint-test12c.sh /docker-entrypoint-test13.sh /docker-entrypoint-test14.sh /docker-entrypoint-test15.sh /docker-entrypoint-test16.sh /docker-entrypoint-test17.sh /docker-entrypoint-test18.sh /docker-entrypoint-test20.sh /docker-entrypoint-test21.sh /docker-entrypoint-test23.sh /docker-entrypoint-test24.sh /docker-entrypoint-test25.sh

COPY server.js /app/server.js

# ── Non-root user ───────────────────────────────────────────────────────
# Claude Code refuses bypassPermissions when running as root.
# Create a dedicated user and hand over ownership of writable directories.
RUN useradd -m -s /bin/bash dredd \
    && chown -R dredd:dredd /app results
USER dredd

# Port 3000 is required by the AI Sandbox ALB target group
EXPOSE 3000

# exec form — process receives signals directly (SIGTERM for graceful shutdown)
CMD ["node", "/app/server.js"]
