# Judge AI Dredd — Log APIs

The judge server exposes HTTP endpoints for every log and event stream the
dashboard uses. You can query them directly with `curl`, `jq`, or any HTTP
client. All endpoints live on the same origin as the dashboard (default
`http://localhost:3001`).

Two log stores exist:

| Store | On-disk location | Endpoint family |
|---|---|---|
| **Session logs** — one JSON per finished session | `CONFIG.logDir` (default `results/`, `/data/sessions` in the container) | `/api/sessions`, `/api/session-log/:id` |
| **Console logs** — daily rolling `dredd-YYYY-MM-DD.log` | `CONFIG.consoleLogDir` (default `logs/`, `/data/logs` in the container) | `/api/logs`, `/api/logs/:filename` |

There is also a live in-memory **event feed** (last 200 events) at `/api/feed`.

---

## Live feed

`GET /api/feed`

Returns the in-memory ring buffer of hook events — intents, tool evaluations,
policy decisions. Each entry:

```json
{
  "timestamp": "2026-05-04T16:38:31.123Z",
  "type": "tool",
  "tool": "Bash",
  "stage": "judge-allow",
  "allowed": true,
  "reason": "Judge: consistent — ...",
  "sessionId": "abc123..."
}
```

Buffer caps at 200 entries and resets when the server restarts. Filter by
`sessionId` client-side for a per-session view.

```bash
# All events
curl -s http://localhost:3001/api/feed | jq

# Just events for one session
curl -s http://localhost:3001/api/feed \
  | jq '[.[] | select(.sessionId == "abc123...")]'

# Denies only
curl -s http://localhost:3001/api/feed | jq '[.[] | select(.allowed == false)]'
```

---

## Session logs

### List recent sessions

`GET /api/sessions`

Returns the most recent 50 session logs as an array of full session objects
(summary stats, tool history, intent history, turn metrics, etc.).

```bash
curl -s http://localhost:3001/api/sessions | jq '.[].sessionId'
curl -s http://localhost:3001/api/sessions | jq '.[] | {sessionId, originalTask, summary: .summary.toolCalls}'
```

### Fetch one session by ID

`GET /api/session-log/:id`

Matches the first 12 characters of the session id against the filename prefix
(`session-<id12>-<iso>.json`). Returns the newest match if several exist.

```bash
curl -s http://localhost:3001/api/session-log/abc123... | jq
```

Response shape (trimmed):

```json
{
  "sessionId": "...",
  "timestamp": "2026-05-04T16:38:24.000Z",
  "originalTask": "fix the dashboard bug",
  "summary": {
    "turns": 6,
    "toolCalls": 42,
    "denied": 1,
    "filesWritten": 3,
    "envVarsSet": 0
  },
  "toolHistory": [ { "turn": 1, "tool": "Read", "decision": "allow", ... } ],
  "intentHistory": [ { "turn": 1, "intent": "..." } ],
  "turnMetrics":  [ { "turnNumber": 1, "classification": "on-task", ... } ],
  "filesWritten": [ { "path": "...", "writeCount": 3, "containsCanary": false } ]
}
```

---

## Console logs

### List daily log files

`GET /api/logs`

Returns filenames of `dredd-YYYY-MM-DD.log` files in `consoleLogDir`, newest
first.

```bash
curl -s http://localhost:3001/api/logs | jq
```

### Fetch one day

`GET /api/logs/:filename?tail=N`

Returns the raw file as `text/plain`. Filename must be bare (no `/` or `..`).
Use `?tail=N` for only the last N lines.

```bash
# Whole file
curl -s "http://localhost:3001/api/logs/dredd-2026-05-04.log" -o today.log

# Last 200 lines
curl -s "http://localhost:3001/api/logs/dredd-2026-05-04.log?tail=200"
```

---

## Bulk download (zip)

`GET /api/logs/download`

Returns a zip archive of logs grouped by day (`YYYY-MM-DD/sessions/...`,
`YYYY-MM-DD/console/...`). Uses stdlib zlib — no dependency on an external
tool. Returns `404` if nothing matches.

| Query param | Values | Effect |
|---|---|---|
| `kind` | `all` (default), `sessions`, `console` | Which store(s) to include |
| `date` | `YYYY-MM-DD` | Limit to a single day |

```bash
# Everything, all days
curl -OJ http://localhost:3001/api/logs/download

# Session JSON only
curl -OJ "http://localhost:3001/api/logs/download?kind=sessions"

# One day, both stores
curl -OJ "http://localhost:3001/api/logs/download?date=2026-05-04"

# One day, console only
curl -OJ "http://localhost:3001/api/logs/download?kind=console&date=2026-05-04"
```

Archive layout:

```
2026-05-04/
  sessions/
    session-abc123abc123-2026-05-04T16-38-24-000Z.json
    ...
  console/
    dredd-2026-05-04.log
2026-05-03/
  ...
```

---

## Policies

`GET /api/policies`

Returns the current allow / deny / review policy state plus domain policies.
Useful for auditing what the policy engine will do without triggering a tool
call.

```bash
curl -s http://localhost:3001/api/policies | jq
```

---

## Health

`GET /api/health` (alias `/health`)

Returns server version, mode, active session count, backend config.

```bash
curl -s http://localhost:3001/api/health | jq
```

---

## Notes

- **Session logs are only written on `Stop`** — an in-flight session won't
  appear under `/api/sessions` or the zip. Use `/api/feed` for live state.
- **Console logs roll by UTC date**. If you care about a specific run, capture
  the log file immediately after the run finishes; rotation happens at
  midnight UTC.
- **The live feed resets on restart.** Nothing is persisted there; the source
  of truth for historical events is the session log JSON.
- **Container deployments** (AI Sandbox / Fargate) put both stores under
  `/data` (`$DATA_DIR`), which should be an EFS-backed volume so logs survive
  task restarts.
