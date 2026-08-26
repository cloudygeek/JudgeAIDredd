# Self-hosting Dredd on a Mac Studio

Runs the judge, the intent classifier, and drift embeddings **locally on the
Mac's GPU**, keeps session state in **AWS DynamoDB**, and exposes the service to
the internet from a **Linux VM** on the same machine.

Design and rationale: [`docs/plan-selfhost-studio-2026-08-26.md`](../docs/plan-selfhost-studio-2026-08-26.md).

---

## The one thing to understand first

**The model does not run in the VM.**

Apple's Hypervisor.framework exposes no virtual GPU, so Ollama inside a Linux VM
falls back to CPU — roughly 3–5x slower. Measured on this hardware, a judge call
with `qwen3.6:35b` takes **1.3s** on Metal; the CPU penalty puts it at 4–7s, on a
call that **blocks the agent's tool call**, for roughly 56% of tool calls.

So the layout is the inverse of the instinct:

```
internet → :80,:443 → [ VM: Caddy + hook + dashboard ]
                              │ host-only network
                              ▼
              macOS host: Ollama + Metal GPU
                              │
                              ▼
                     AWS DynamoDB (eu-west-1)
```

The VM is the **blast radius** — it is what the internet touches. It reaches the
host on exactly one port. A compromise there yields a Linux guest and an LLM
endpoint, not the Studio.

---

## 1. Prepare the macOS host

Install Ollama and pull both models. `nomic-embed-text` is easy to forget — the
judge will start fine without it and drift detection will fail on every call.

```bash
brew install ollama          # or the .app
ollama pull qwen3.6          # judge
ollama pull nomic-embed-text # drift embeddings
```

**Model residency is handled for you.** Ollama evicts after 5 minutes by
default, and a cold 23GB model costs ~22s against 1.3s warm — on a call that
blocks the agent. Dredd sends `keep_alive` on every request
(`DREDD_OLLAMA_KEEP_ALIVE`, default `24h` in `docker-compose.yml`), so there is
**nothing to configure on the host**.

That is deliberate. The usual advice — `launchctl setenv OLLAMA_KEEP_ALIVE 24h`
— is a poor fix: it silently does nothing when set over SSH (that lands in
launchd's `Background` domain while Ollama.app runs in `Aqua`), it needs the app
restarted, and it reverts on reinstall. None of which is discoverable; you just
get an occasional slow call. Making residency a property of the caller removes
the whole class of problem.

Check what is resident and until when:

```bash
curl -s http://127.0.0.1:11434/api/ps | jq '.models[] | {name, expires_at}'
```

---

## 2. Start the VM

Lima is installed from its release tarball rather than Homebrew — a package
manager is a far larger footprint than this one binary needs, and the Studio had
no brew:

```bash
curl -fsSL https://github.com/lima-vm/lima/releases/download/v2.2.0/lima-2.2.0-Darwin-arm64.tar.gz \
  | tar -xz -C "$HOME/opt/lima"          # keeps bin/ share/ libexec/ siblings — Lima needs that layout
ln -sf "$HOME/opt/lima/bin/limactl" "$HOME/.local/bin/limactl"

limactl start --name=dredd ./lima-dredd.yaml
```

> On the Studio, `~/.local` turned out to be owned by **root** (pre-existing),
> so a prefix of `~/.local` fails to extract while `~/.local/bin` is still
> writable for the symlink. `~/opt/lima` avoids the problem entirely.

> **Group membership needs a VM restart.** The template adds the guest user to
> the `docker` group, but `limactl shell` holds a persistent SSH connection whose
> session keeps the *old* groups. If `docker` commands report
> `permission denied ... /var/run/docker.sock`, run `limactl stop dredd &&
> limactl start dredd` — the group is already in `/etc/group`, the session just
> has not picked it up.

---

## 3. Point the VM at the host's Ollama

**Measured on the Studio, and it is better than expected: you do not have to
reconfigure Ollama at all.**

Lima publishes the host to the guest as `host.lima.internal` (192.168.5.2, the
vz user-mode gateway), and that route **reaches services bound to the host's
loopback**. So Ollama stays on `127.0.0.1`, where it is exposed neither to your
LAN nor to the VM bridge, and the VM still reaches it.

An earlier draft of this document told you to find the vzNAT bridge address and
bind Ollama to it. That was unnecessary and strictly worse: it exposes the model
endpoint on an extra interface, and it makes Ollama's startup depend on
`bridge100` existing, which only happens once a VM has booted. Measured result:
`host.lima.internal:11434` **reachable**, `192.168.64.1:11434` **not**.

So the config is simply:

```bash
OLLAMA_HOST=http://host.lima.internal:11434
```

Verify from inside the VM before starting the stack:

```bash
limactl shell dredd -- curl -sS --max-time 5 http://host.lima.internal:11434/api/tags | head -c 120
```

And confirm the Mac has **not** become an open model server — from another
machine on the LAN:

```bash
curl -m 3 http://<studio-lan-ip>:11434/api/tags   # MUST fail/refuse
```

> **Never set `OLLAMA_HOST=0.0.0.0` on the Mac.** It publishes an
> unauthenticated model endpoint — free inference and your model list — to
> everything on the network. Nothing in this design requires it.

> **`launchctl setenv` over SSH does not work here.** An SSH session lives in
> launchd's `Background` domain while Ollama.app runs in `Aqua`, so variables
> set over SSH never reach it. If you ever do need to change Ollama's
> environment, do it from a terminal on the machine itself (or from the app's
> own settings) — not remotely.

## 4. AWS credentials

Create an IAM user (`dredd-selfhost`), no console access, access key only, with
[`iam-policy.json`](./iam-policy.json) inline.

The policy is **DynamoDB actions only** — no `bedrock:*`, no `kms:*`, no
`secretsmanager:*`. If a future change reintroduces a Bedrock call path, it
fails loudly on this credential rather than silently starting to bill.

> **Checked, and worth re-checking:** `jaid-sessions` currently reports
> `SSEDescription: null` — AWS-owned encryption keys, not a customer-managed
> CMK — which is why no `kms:Decrypt` grant is needed. The Terraform *can*
> create these tables with a CMK (`var.sse_kms_key_arn`). If the tables are ever
> re-created that way, this policy starts failing **every read** with an opaque
> `AccessDeniedException` that says nothing about KMS.
>
> ```bash
> aws dynamodb describe-table --table-name jaid-sessions \
>   --region eu-west-1 --query 'Table.SSEDescription'
> ```

---

## 5. DNS and the router

| Record | Type | Value |
|---|---|---|
| `hook.soteriacyber.com` | A | your static IP |
| `dredd.soteriacyber.com` | A | your static IP |

Forward **only** `:80` and `:443` from the router to the Studio. `:80` is
required for the ACME HTTP-01 challenge — not just for the HTTPS redirect.

Do **not** repoint `dredd-hook.acta.io` / `dredd.acta.io`. Those stay on the AWS
stack so both can run in parallel; cut over by moving clients, which keeps a way
back.

---

## 6. Configure and start

```bash
cp .env.example .env && chmod 600 .env
$EDITOR .env
GIT_COMMIT=$(git -C /Users/$USER/IdeaProjects/JudgeAIDredd rev-parse --short HEAD) \
  docker compose --env-file .env up -d --build
```

While testing the port forward, uncomment the `acme_ca` staging line in the
`Caddyfile`. Let's Encrypt rate-limits five failed issuances per hostname per
hour, which is a miserable way to debug a firewall rule.

---

## 7. Verify

```bash
# Certificate + liveness
curl -sS https://hook.soteriacyber.com/health | jq '{version, degraded, judge}'

# Judge health. On a freshly-started server this is "unknown" — no traffic means
# no evidence. It is NOT "ok" until real judge calls have succeeded.
curl -sS https://hook.soteriacyber.com/api/health | jq .judge

# Authenticated hot path
curl -sS -H "Authorization: Bearer $(cat ~/.claude/dredd/api-key)" \
  https://hook.soteriacyber.com/api/health | jq .status
```

Then point one client at it and run a real session:

```
DREDD_URL=https://hook.soteriacyber.com
```

### The drill worth actually running

Stop Ollama mid-session and confirm you get **asked**, not silently allowed:

```bash
# host
launchctl setenv OLLAMA_KEEP_ALIVE 0 && pkill ollama
# then make a tool call in a live Claude Code session
curl -sS https://hook.soteriacyber.com/api/health | jq '.judge.status, .degraded'
```

Expected: `judge.status` goes `degraded` then `down`, `degraded: true`, and the
session surfaces a permission prompt carrying the judge's reason. If instead
tool calls sail through, `DREDD_JUDGE_FAIL_CLOSED` is not set and **you are
running unprotected** — that is the whole failure mode this deployment exists to
avoid.

---

## Operational notes

**Client IPs are not captured; the access log records the gateway.** Two of the
three hops that destroyed the source address are fixed (`selfhost/pf-client-ip.sh`
removes Lima's userspace forwarder and Docker's rewrite). The third is the UniFi
gateway: classic Port Forwarding source-NATs, so every internet client arrives as
`172.16.0.1`. Verified twice with genuinely external requests — a LAN test
hairpins through the router and proves nothing.

UniFi's `Dest. NAT` rule type preserves the source and is the fix in principle,
but on this network a Dest. NAT rule for :443 never matched and the gateway
answered with its own admin UI instead, so the port forward was restored to keep
the service up. Working service was judged worth more than attributable logs.

This also affects the hook's `[REQ]` lines and the `clientIp` stamped onto
session META in DynamoDB — same constant, same caveat. Do not rate-limit, ban,
or geolocate on any of them. Everything else in the logs is accurate.

If you want real client IPs later, the options are: get a Dest. NAT rule
matching on the gateway, or put a reverse proxy in front that injects
`X-Forwarded-For` (which means a third party terminating TLS for a service whose
selling point is that data stays on your hardware — weigh that carefully).


**Judge health is observed, not probed.** It is derived from real judge traffic
rather than by pinging the model on a timer. A probe would burn GPU on a
schedule and — worse — could report a backend healthy on a trivial synthetic
prompt while real judge calls were timing out on their much larger ones. The
cost of that choice is that an idle server reports `unknown` rather than `ok`.

**`/health` returns 200 even when the judge is down.** It is the load-balancer
target-group check, and a judge outage is global: failing it would pull every
task and turn a degraded service into no service at all. Alert on
`.judge.status` and `.degraded`, not on the HTTP code.

**Timeout ordering is load-bearing.** `dredd-hook.sh` uses `curl --max-time 60`
on `/evaluate`, Claude Code allows 60s for the PreToolUse hook, and Caddy is set
to 120s so it never cuts first. If the proxy times out first, the hook sees a
truncated response instead of a decision and fails open to an ordinary
permission prompt — indistinguishable, from the user's side, from Dredd not
running.

**Changing `EMBEDDING_MODEL` later is not free.** Stored vectors in
`jaid-sessions` / `jaid-approvals` carry the dimensionality of whatever model
wrote them. Mismatched vectors are now handled as *unusable* rather than fatal
(drift reports maximum similarity-distance and escalates to the judge), but
expect a burst of escalations while live sessions re-embed.

**Backups.** DynamoDB PITR covers session state. Nothing backs up the VM — it is
meant to be reproducible from this directory. `caddy-data` holds your ACME
account key and certificates; don't prune that volume casually or you will
re-issue and can hit rate limits.

**Rotate the AWS keys.** They are static, they live in `.env` in the VM, and
they do not rotate themselves. If this grows past one box, IAM Roles Anywhere is
the upgrade path.

---

## Files

| File | Purpose |
|---|---|
| `lima-dredd.yaml` | VM definition — Apple Virtualization, shared network, `:80`/`:443` forwards, ufw |
| `docker-compose.yml` | hook + dashboard + Caddy, built from `fargate/Dockerfile.judge` |
| `Caddyfile` | TLS termination, HTTP-01, the 120s proxy timeouts |
| `iam-policy.json` | DynamoDB-only policy for the `dredd-selfhost` user |
| `.env.example` | configuration template |
