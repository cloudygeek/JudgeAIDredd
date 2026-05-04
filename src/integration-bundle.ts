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

## 1. Install the hook script

\`\`\`bash
mkdir -p ~/.claude/dredd
cp dredd-hook.sh ~/.claude/dredd/
chmod +x ~/.claude/dredd/dredd-hook.sh
\`\`\`

## 2. Wire it up in ~/.claude/settings.json

Either merge \`settings.json\` from this bundle into your existing
\`~/.claude/settings.json\`, or — if you have no hooks yet — just copy it:

\`\`\`bash
mkdir -p ~/.claude
cp settings.json ~/.claude/settings.json
\`\`\`

The script defaults to the URL above but respects \`$DREDD_URL\` if set.

## 3. Prerequisites

- \`curl\` and \`jq\` on your PATH (preinstalled on macOS / most Linux).

## 4. Verify

Start a Claude Code session in any project. Open the dashboard at:

    ${dreddUrl}/

You should see your session appear in the Live Feed the moment you send
your first prompt.

## Troubleshooting

- **Dashboard shows no sessions** — check that \`curl ${dreddUrl}/api/health\`
  returns JSON with a \`version\` field. If not, the URL is wrong or the
  server is down.
- **Hook runs but blocks nothing** — the server defaults to interactive mode;
  check the dashboard's mode badge. \`autonomous\` mode blocks on hijack,
  \`learn\` mode blocks nothing by design.
- **Every tool call is denied** — the judge server is probably mis-pointed at
  a different project's intent. Run \`rm ~/.claude/projects/*/\` session JSONL
  or start a new session.
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
    { name: "settings.json", data: Buffer.from(renderSettings(dreddUrl), "utf8"), mode: 0o644 },
    { name: "README.md", data: Buffer.from(renderReadme(dreddUrl), "utf8"), mode: 0o644 },
  ];

  return buildZip(entries);
}
