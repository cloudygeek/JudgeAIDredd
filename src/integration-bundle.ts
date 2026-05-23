/**
 * Integration-bundle builder.
 *
 * Produces a ZIP archive that teaches Claude Code how to talk to this judge
 * server: the hook script with DREDD_URL baked in, a settings.json.example
 * for .claude/, and a README explaining the install steps.
 *
 * Pure stdlib — no dependencies. Uses Node zlib.deflateRawSync + hand-rolled
 * ZIP headers (STORE method would also work; DEFLATE keeps the archive small).
 */
import { deflateRawSync, crc32 } from "node:zlib";
import { readFileSync } from "node:fs";

interface ZipEntry {
  name: string;
  data: Buffer;
  mode: number;
}

function dosDateTime(d: Date): { date: number; time: number } {
  const time =
    (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date =
    ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { date, time };
}

export type { ZipEntry };
export function buildZipArchive(entries: ZipEntry[]): Buffer {
  return buildZip(entries);
}

function buildZip(entries: ZipEntry[]): Buffer {
  const now = new Date();
  const { date, time } = dosDateTime(now);
  const chunks: Buffer[] = [];
  const centralDir: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const compressed = deflateRawSync(entry.data);
    const crc = crc32(entry.data);

    // Local file header
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);        // signature
    localHeader.writeUInt16LE(20, 4);                 // version needed
    localHeader.writeUInt16LE(0, 6);                  // flags
    localHeader.writeUInt16LE(8, 8);                  // method = deflate
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);                 // extra length

    chunks.push(localHeader, nameBuf, compressed);

    // Central directory record for this entry
    const cdRecord = Buffer.alloc(46);
    cdRecord.writeUInt32LE(0x02014b50, 0);           // signature
    cdRecord.writeUInt16LE(20, 4);                    // version made by
    cdRecord.writeUInt16LE(20, 6);                    // version needed
    cdRecord.writeUInt16LE(0, 8);                     // flags
    cdRecord.writeUInt16LE(8, 10);                    // method = deflate
    cdRecord.writeUInt16LE(time, 12);
    cdRecord.writeUInt16LE(date, 14);
    cdRecord.writeUInt32LE(crc, 16);
    cdRecord.writeUInt32LE(compressed.length, 20);
    cdRecord.writeUInt32LE(entry.data.length, 24);
    cdRecord.writeUInt16LE(nameBuf.length, 28);
    cdRecord.writeUInt16LE(0, 30);                    // extra
    cdRecord.writeUInt16LE(0, 32);                    // comment
    cdRecord.writeUInt16LE(0, 34);                    // disk
    cdRecord.writeUInt16LE(0, 36);                    // internal attrs
    // External attrs = unix mode << 16 | DOS attrs
    cdRecord.writeUInt32LE((entry.mode << 16) >>> 0, 38);
    cdRecord.writeUInt32LE(offset, 42);

    centralDir.push(cdRecord, nameBuf);
    offset += localHeader.length + nameBuf.length + compressed.length;
  }

  const cdBuf = Buffer.concat(centralDir);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);                           // disk
  eocd.writeUInt16LE(0, 6);                           // disk with CD
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, cdBuf, eocd]);
}

/**
 * Patch the hook script so it defaults to the caller's judge URL instead of
 * localhost:3001. Users can still override with $DREDD_URL at runtime.
 */
function bakeHookScript(script: string, dreddUrl: string): string {
  return script.replace(
    /DREDD_URL="\$\{DREDD_URL:-[^}]*\}"/,
    `DREDD_URL="\${DREDD_URL:-${dreddUrl}}"`,
  );
}

function renderSettings(dreddUrl: string): string {
  const install = "${HOME}/.claude/dredd/dredd-hook.sh";
  const settings = {
    hooks: {
      UserPromptSubmit: [
        { hooks: [{ type: "command", command: install, timeout: 30 }] },
      ],
      PreToolUse: [
        { matcher: "*", hooks: [{ type: "command", command: install, timeout: 60 }] },
      ],
      PostToolUse: [
        { matcher: "*", hooks: [{ type: "command", command: install, timeout: 10 }] },
      ],
      Stop: [{ hooks: [{ type: "command", command: install, timeout: 10 }] }],
      SessionEnd: [{ hooks: [{ type: "command", command: install, timeout: 10 }] }],
      PreCompact: [{ hooks: [{ type: "command", command: install, timeout: 5 }] }],
    },
    env: {
      DREDD_URL: dreddUrl,
    },
  };
  return JSON.stringify(settings, null, 2) + "\n";
}

function renderReadme(dreddUrl: string): string {
  return `# Judge AI Dredd — Integration

This bundle points your Claude Code CLI at the judge server at:

    ${dreddUrl}

Every tool call your agent attempts will be evaluated by the judge; prompt-
injection / goal-hijacking attempts are blocked before the tool runs.

## 1. Generate & install your API key

The hook server requires a Bearer key on every request. Without one,
\`/intent\` and \`/evaluate\` return 401 and Dredd silently falls back
to allowing everything.

Open the dashboard's **API Keys** tab → **Generate key**. The plaintext
key is shown ONCE — run the snippet shown in the banner, which does:

\`\`\`bash
mkdir -p ~/.claude/dredd
printf '%s\\n' 'jaid_live_PASTE_KEY_HERE' > ~/.claude/dredd/api-key
chmod 600 ~/.claude/dredd/api-key
\`\`\`

The hook script reads from \`~/.claude/dredd/api-key\` by default; override
with \`$DREDD_API_KEY_FILE\` if you keep it elsewhere.

## 2. Install the hook script

\`\`\`bash
mkdir -p ~/.claude/dredd
cp dredd-hook.sh ~/.claude/dredd/
chmod +x ~/.claude/dredd/dredd-hook.sh
\`\`\`

## 3. Wire up the hooks

Pick one scope:

### Global — every Claude Code session on this machine

\`\`\`bash
mkdir -p ~/.claude
if [ -e ~/.claude/settings.json ]; then
  echo "~/.claude/settings.json already exists — merge the hooks and env sections from settings.json manually"
else
  cp settings.json ~/.claude/settings.json
fi
\`\`\`

### Per-project — only inside one codebase

\`\`\`bash
cd /path/to/your/project
mkdir -p .claude
if [ -e .claude/settings.json ]; then
  echo ".claude/settings.json already exists — merge the hooks and env sections from /tmp/dredd/settings.json manually"
else
  cp /tmp/dredd/settings.json .claude/settings.json
fi
\`\`\`

Commit \`.claude/settings.json\` to share the integration with your team,
or rename to \`.claude/settings.local.json\` (git-ignored by default) to
keep it to yourself.

The script defaults to the URL above but respects \`$DREDD_URL\` if set.

## 4. Prerequisites

- \`curl\` and \`jq\` on your PATH (preinstalled on macOS / most Linux).

## 5. Verify

Confirm the API key is wired up by hitting an auth-required endpoint:

\`\`\`bash
curl -H "Authorization: Bearer $(cat ~/.claude/dredd/api-key)" \\
  ${dreddUrl}/api/auth-check
# Expected: HTTP 200 with {"authenticated":true,"ownerEmail":"…"}
# A 401 means the key file is missing, malformed, or revoked.
\`\`\`

Then start a Claude Code session in any project. Open the dashboard at:

    ${dreddUrl}/

You should see your session appear in the Live Feed the moment you send
your first prompt. Note that \`${dreddUrl}/api/health\` answers without
auth — useful for proving the server is reachable, but it won't catch a
missing API key. Use \`/api/auth-check\` above for that.

## Troubleshooting

- **Dashboard shows no sessions but \`/api/health\` works** — the API key
  is missing or wrong. Re-run \`curl … /api/auth-check\`; on 401, regenerate
  the key from the dashboard and re-save to \`~/.claude/dredd/api-key\`.
- **Hook runs but blocks nothing** — the server defaults to interactive mode;
  check the dashboard's mode badge. \`autonomous\` mode blocks on hijack,
  \`learn\` mode blocks nothing by design.
- **Every tool call is denied** — the judge's reconstructed goal is wrong
  (common after context compaction). Either start a fresh session or send
  a \`/pivot\` to the server with the real goal.

## Disable the hook

Three scopes depending on how you installed it.

### Global (installed via \`~/.claude/settings.json\`)

\`\`\`bash
mv ~/.claude/settings.json ~/.claude/settings.json.dredd-off
# re-enable with: mv ~/.claude/settings.json.dredd-off ~/.claude/settings.json
\`\`\`

If the file has unrelated settings you want to keep, delete just the
\`hooks\` and \`env.DREDD_URL\` keys instead.

### Per-project (installed via \`.claude/settings.json\`)

\`\`\`bash
cd /path/to/your/project
mv .claude/settings.json .claude/settings.json.dredd-off
\`\`\`

### Single session (no config edits)

Point \`DREDD_URL\` at an unreachable address — the hook's health-check
probe fails, the hook returns an empty response, and Claude Code proceeds
as if no hook were installed:

\`\`\`bash
DREDD_URL=http://127.0.0.1:1 claude
\`\`\`
`;
}

/**
 * Render the "let Claude install Dredd for you" prompt.
 *
 * The user feeds this to Claude (e.g. `claude < claude-install-prompt.txt`
 * or pastes it as the first prompt) and Claude walks through the install
 * one step at a time, describing each action and asking permission before
 * running it. The dredd-on-dredd bootstrap problem (Dredd isn't installed
 * yet so it can't judge this install session) is handled by deliberately
 * keeping the instructions narrow: only the API-key path, the hook script
 * path under ~/.claude/dredd/, and the settings.json wiring are in scope.
 *
 * Two guardrails:
 *  - The prompt INSTRUCTS Claude to describe each step and ask permission
 *    before running it. The user retains a human-in-the-loop checkpoint
 *    on every file write.
 *  - The prompt scopes filesystem writes to ~/.claude/dredd/ and
 *    ~/.claude/settings.json (or <project>/.claude/settings.json) ONLY.
 *    Any other path is out of scope and Claude is told to stop and flag it.
 *
 * The bundle URL is embedded into the prompt so the installer can curl
 * the hook script directly rather than relying on a separate `unzip` step.
 */
export function renderInstallPrompt(dreddUrl: string): string {
  return `# Install Judge AI Dredd

You are being asked to install Judge AI Dredd — a prompt-injection
defence layer for Claude Code — into the user's environment. Dredd
intercepts your tool calls at PreToolUse and blocks ones the judge
classifies as goal-hijacking.

The judge server this install targets is:

    ${dreddUrl}

## Before you do anything

Print a numbered summary of what you are about to do, then **stop and
ask the user to confirm** before running a single command. The summary
must list:

1. Every file you will create or modify, with its absolute path.
2. The URL you will fetch the hook script from.
3. That you will ask the user to paste an API key (which they must
   first generate from the dashboard).
4. The verification step you will run at the end.

Wait for an explicit "yes" / "go ahead" / "proceed" before running
anything. If the user asks questions, answer them, then re-ask for
confirmation.

## What you will do (after the user confirms)

### Step 1 — Get the API key from the user

Tell the user:

> Open the dashboard at ${dreddUrl.replace(/^https:\/\/dredd-hook\./, "https://dredd.")}
> (or whichever dashboard URL Dredd is running on for you).
> Go to the **API Keys** tab → **Generate key** with a description
> like "$(hostname) install — $(date +%Y-%m-%d)".
> Copy the plaintext key (shown ONCE) and paste it back here.

WAIT for the user to paste the key. The key starts with \`jaid_live_\`.
Do not proceed without it. Do not make one up.

When the user pastes it, do NOT echo it back in plaintext anywhere
except as the body of the file you write to disk.

### Step 2 — Install the API key

Create \`~/.claude/dredd/\` if missing. Write the pasted key to
\`~/.claude/dredd/api-key\` with mode 600. Confirm with the user
that the file is there before continuing.

\`\`\`bash
mkdir -p ~/.claude/dredd
# Then write the key (use the user-supplied value, NOT a placeholder):
printf '%s\\n' "<key the user just pasted>" > ~/.claude/dredd/api-key
chmod 600 ~/.claude/dredd/api-key
\`\`\`

### Step 3 — Install the hook script

Fetch the hook script directly from the hook server (Bearer-gated) and
chmod 755. The hook server itself bakes \`DREDD_URL=${dreddUrl}\` into
the script before serving, so no post-install editing is required.

\`\`\`bash
curl -fsSL \\
  -H "Authorization: Bearer $(cat ~/.claude/dredd/api-key)" \\
  -o ~/.claude/dredd/dredd-hook.sh \\
  ${dreddUrl}/api/hook-script
chmod 755 ~/.claude/dredd/dredd-hook.sh
\`\`\`

Confirm the file is at the path above, is non-empty, and is executable.

### Step 4 — Wire the hooks into Claude Code

Ask the user whether to install globally (\`~/.claude/settings.json\` —
affects every Claude Code session on this machine) or per-project
(\`<project>/.claude/settings.json\` — affects only sessions started
in that directory).

The settings template is below. Substitute the actual install path for
the hook script wherever you see \`{HOOK_INSTALL_PATH}\` (it should be
\`$HOME/.claude/dredd/dredd-hook.sh\` expanded to an absolute path):

\`\`\`json
${JSON.stringify(
  {
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "{HOOK_INSTALL_PATH}", timeout: 30 }] }],
      PreToolUse:       [{ matcher: "*", hooks: [{ type: "command", command: "{HOOK_INSTALL_PATH}", timeout: 60 }] }],
      PostToolUse:      [{ matcher: "*", hooks: [{ type: "command", command: "{HOOK_INSTALL_PATH}", timeout: 10 }] }],
      Stop:             [{ hooks: [{ type: "command", command: "{HOOK_INSTALL_PATH}", timeout: 10 }] }],
      SessionEnd:       [{ hooks: [{ type: "command", command: "{HOOK_INSTALL_PATH}", timeout: 10 }] }],
      PreCompact:       [{ hooks: [{ type: "command", command: "{HOOK_INSTALL_PATH}", timeout: 5 }] }],
    },
    env: {
      DREDD_URL: dreddUrl,
    },
  },
  null,
  2,
)}
\`\`\`

Before writing anything, **inspect the current state** of the target
file. Pick the right branch based on what you find:

#### A. Target file does NOT exist

Write the template above (with \`{HOOK_INSTALL_PATH}\` substituted) to
the target path. Report success.

#### B. Target file exists but has NO \`hooks\` block at all

Read the file. Add the \`hooks\` and \`env\` keys from the template,
preserving every other key in the file untouched. Show the user the
diff you propose, wait for "yes", then write.

#### C. Target file exists and ALREADY contains a Dredd hook install

Detect this case by checking BOTH:
1. Does \`env.DREDD_URL\` already exist?
2. Does any \`hooks.*[].hooks[].command\` already reference a path
   ending in \`dredd-hook.sh\`?

If either is true, Dredd hooks are already wired in. Print a one-line
summary of what's there (e.g. "Existing Dredd install detected:
DREDD_URL=https://old-host, hook at /path/to/old-dredd-hook.sh"), then
ask the user what they want:

- **Keep existing as-is** (no change).
- **Update DREDD_URL to ${dreddUrl}** (rewrite just the URL; leave the
  hook command path alone — the existing path may differ if they
  installed manually before).
- **Replace fully** (overwrite both DREDD_URL AND the hook command
  paths with the template values).

Do exactly what they choose. Do not silently rewrite either field.

#### D. Target file exists with NON-Dredd hooks

If there are existing entries under \`UserPromptSubmit\`, \`PreToolUse\`,
\`PostToolUse\`, \`Stop\`, \`SessionEnd\`, or \`PreCompact\` that do NOT
reference a Dredd path, **append** the Dredd hook entry to each
relevant matcher list rather than replacing anyone else's hooks. Claude
Code runs all matching hooks for an event, so appending is non-destructive.

Show the user the diff and wait for "yes" before writing.

### Step 5 — Verify

Run this — it exercises the API-key path, unlike \`/api/health\`:

\`\`\`bash
curl -sfk -H "Authorization: Bearer $(cat ~/.claude/dredd/api-key)" \\
  ${dreddUrl}/api/auth-check
\`\`\`

Expected: HTTP 200 with JSON \`{"authenticated":true,...}\`.

On 401: the key file is missing, malformed, or revoked. Re-run Step 1.
On any other error: report the status code to the user and stop.

## Boundaries

- Do NOT touch any path outside \`~/.claude/dredd/\`,
  \`~/.claude/settings.json\`, or \`<project>/.claude/settings.json\`.
- Do NOT install any other tools, package managers, or shell hooks.
- Do NOT modify \`.bashrc\`, \`.zshrc\`, \`.profile\`, environment files,
  or shell aliases.
- Do NOT exfiltrate the API key. It belongs only in
  \`~/.claude/dredd/api-key\` with mode 600.
- If any step fails, stop and report the failure to the user; do not
  try to "fix" by editing files the user did not ask you to touch.

## After install

Tell the user:

> Restart your Claude Code session for the hooks to take effect.
> Your next session will appear in the Live Feed at the dashboard the
> moment you send your first prompt.

Then you are done. Do not start any other work in this session unless
the user explicitly asks.
`;
}

/**
 * Build the integration bundle for the given judge URL. Called by the
 * /api/integration-bundle route.
 */
export function buildIntegrationBundle(dreddUrl: string): Buffer {
  const hookScriptPath = new URL("../hooks/dredd-hook.sh", import.meta.url);
  const hookScript = readFileSync(hookScriptPath, "utf8");
  const bakedHook = bakeHookScript(hookScript, dreddUrl);

  const entries: ZipEntry[] = [
    { name: "dredd-hook.sh", data: Buffer.from(bakedHook, "utf8"), mode: 0o755 },
    { name: "claude-install-prompt.txt", data: Buffer.from(renderInstallPrompt(dreddUrl), "utf8"), mode: 0o644 },
    { name: "settings.json", data: Buffer.from(renderSettings(dreddUrl), "utf8"), mode: 0o644 },
    { name: "README.md", data: Buffer.from(renderReadme(dreddUrl), "utf8"), mode: 0o644 },
  ];

  return buildZip(entries);
}
