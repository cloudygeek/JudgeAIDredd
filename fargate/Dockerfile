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

# MCP servers for MT-AgentRisk (Test 24)
# Spawned as stdio subprocesses by the Python benchmark runner (mcp_client.py).
RUN npm install --save \
        @modelcontextprotocol/server-filesystem \
        @playwright/mcp \
        @notionhq/notion-mcp-server
RUN pip3 install --break-system-packages postgres-mcp 2>/dev/null || true

# MT-AgentRisk dataset (vendored — HF repo is gated)
COPY datasets/mt-agentrisk/ /app/datasets/mt-agentrisk/

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
# Wildcard COPY picks up all current and future entrypoints automatically.
COPY docker-entrypoint*.sh /
RUN chmod +x /docker-entrypoint*.sh

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
