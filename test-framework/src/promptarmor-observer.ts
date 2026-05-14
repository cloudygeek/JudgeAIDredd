/**
 * PromptArmor observational adapter for the test-framework.
 *
 * Path C from docs/plan-promptarmor-test-framework-2026-05-13.md:
 * the Claude Agent SDK's PostToolUse hook does not rewrite built-in
 * tool outputs (T-0 probe verdict). This adapter therefore runs in
 * **observational** mode — it screens each captured tool output
 * against the deployed `/screen` endpoint AFTER the agent has
 * already seen the original content, so we record detection rate
 * but cannot enforce.
 *
 * Use case for the paper: a third-corpus PromptArmor comparator on
 * T3e where:
 *   - AIDredd numbers reflect actual enforcement (PreToolUse deny works
 *     fine through the SDK).
 *   - PromptArmor numbers reflect detection only (footnote in
 *     §limitations explains the asymmetry).
 *
 * Failure modes are recorded in the per-turn screen telemetry so the
 * §7 disagreement table can split "PA detected and would have
 * stripped" vs "PA missed" vs "PA detected but sanitisation_failed".
 */

import { TurnLogger } from "./turn-logger.js";
import { TurnLog } from "./types.js";

export interface PromptArmorScreenTelemetry {
  /** Turn number this screen attached to. */
  turnNumber: number;
  /** Index of the tool call within the turn (0-based). */
  toolIndex: number;
  /** Tool name. */
  tool: string;
  /** Verdict from /screen: clean / injected / parse_error / error. */
  verdict: string;
  /** Whether PromptArmor's fuzzy-strip succeeded (only meaningful when
   *  verdict=injected). false → PA detected the injection but couldn't
   *  remove it; the agent saw the original content unchanged. */
  sanitisationFailed: boolean;
  /** Round-trip latency in ms. */
  latencyMs: number;
  /** Error message if the /screen call failed entirely. */
  error?: string;
}

export interface PromptArmorObserverConfig {
  /** Base URL of the Dredd hook serving /screen. */
  dreddUrl: string;
  /** PromptArmor backend ("bedrock" or "openai"). */
  backend: "bedrock" | "openai";
  /** Detector model id (e.g. "eu.anthropic.claude-sonnet-4-6"). */
  model: string;
  /** Optional run id correlator written to the call log. */
  runId?: string;
  /** Bearer token for the hook. Optional in DREDD_AUTH_MODE=optional. */
  apiKey?: string;
  /** Skip TLS verification (sandbox internal ALB has self-signed certs). */
  insecure?: boolean;
}

/**
 * Observer that mirrors TurnLogger's behaviour exactly (no
 * blocking, no goal anchor) but additionally screens every tool
 * output against PromptArmor and records the verdict alongside the
 * turn log.
 *
 * NOT a defence — the agent has already received the original tool
 * output by the time this fires, so PromptArmor's verdict only
 * affects what we *report*, not what the agent does.
 */
export class PromptArmorObserver extends TurnLogger {
  private readonly cfg: PromptArmorObserverConfig;
  private readonly screens: PromptArmorScreenTelemetry[] = [];
  readonly stats = {
    screened: 0,
    clean: 0,
    injected: 0,
    sanitised: 0,
    sanitisationFailed: 0,
    errors: 0,
    totalLatencyMs: 0,
  };

  constructor(cfg: PromptArmorObserverConfig) {
    super();
    this.cfg = cfg;
  }

  /** Called by the executor after each turn. We screen here rather
   *  than per-tool because TurnLog already aggregates the call list. */
  override onTurnComplete(turn: TurnLog): void {
    super.onTurnComplete(turn);

    // Screen every tool output we saw this turn. Sequential by
    // design — /screen is ~1.5s per call, but a turn rarely has
    // more than 2-3 tool calls so the latency is bounded.
    for (let i = 0; i < turn.toolCalls.length; i++) {
      const tc = turn.toolCalls[i];
      if (!tc.output) continue;
      // Fire-and-forget the screen call. We can't `await` here
      // because TurnLogger.onTurnComplete is synchronous in the
      // base class — instead we kick off the request and let
      // results land in `screens` for post-run reporting. The
      // executor's `await screenAll()` after the run finishes
      // ensures everything has landed before results are written.
      this.screenOne(turn.turnNumber, i, tc.tool, tc.output, turn.userMessage)
        .catch(() => { /* counted as error, no rethrow */ });
    }
  }

  /** Block until all in-flight screens have completed. The runner
   *  calls this before writing results so we don't lose telemetry. */
  async drain(): Promise<void> {
    // We don't track promises explicitly; instead, poll the in-flight
    // counter until it goes to zero. Simpler than a Promise.all over
    // a mutable set.
    while (this.inflight > 0) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  getScreens(): PromptArmorScreenTelemetry[] {
    return this.screens;
  }

  override reset(): void {
    super.reset();
    this.screens.length = 0;
    this.stats.screened = 0;
    this.stats.clean = 0;
    this.stats.injected = 0;
    this.stats.sanitised = 0;
    this.stats.sanitisationFailed = 0;
    this.stats.errors = 0;
    this.stats.totalLatencyMs = 0;
  }

  private inflight = 0;

  private async screenOne(
    turnNumber: number,
    toolIndex: number,
    tool: string,
    content: string,
    taskContext: string,
  ): Promise<void> {
    this.inflight++;
    this.stats.screened++;
    const start = Date.now();
    try {
      const url = `${this.cfg.dreddUrl.replace(/\/$/, "")}/screen`;
      const body = {
        content: content.slice(0, 32000), // /screen caps at 32 KB
        task_context: taskContext,
        backend: this.cfg.backend,
        model: this.cfg.model,
        ...(this.cfg.runId ? { run_id: this.cfg.runId } : {}),
      };
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (this.cfg.apiKey) {
        headers["Authorization"] = `Bearer ${this.cfg.apiKey}`;
      }

      // Node 20+ has `fetch` built in (powered by undici). The SDK
      // uses undici under the hood too; we don't import it explicitly
      // to keep the dependency surface minimal.
      const fetchOpts: RequestInit & { dispatcher?: unknown } = {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      };
      if (this.cfg.insecure) {
        // Skip TLS verification for the sandbox's self-signed ALB.
        // Node's fetch doesn't expose this in the standard
        // RequestInit shape; we instead set the global env var that
        // disables verification for the entire process. The
        // sandbox runner image is single-purpose so this is
        // acceptable; outside the sandbox prefer a proper CA bundle.
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
      }

      const resp = await fetch(url, fetchOpts);
      const latencyMs = Date.now() - start;
      this.stats.totalLatencyMs += latencyMs;

      if (!resp.ok) {
        this.stats.errors++;
        this.screens.push({
          turnNumber,
          toolIndex,
          tool,
          verdict: "error",
          sanitisationFailed: false,
          latencyMs,
          error: `HTTP ${resp.status}`,
        });
        return;
      }

      const result = await resp.json() as {
        verdict?: string;
        sanitisation_failed?: boolean;
        latency_ms?: number;
      };
      const verdict = result.verdict ?? "clean";
      const sanitisationFailed = Boolean(result.sanitisation_failed);

      if (verdict === "clean") this.stats.clean++;
      else if (verdict === "injected") {
        this.stats.injected++;
        if (sanitisationFailed) this.stats.sanitisationFailed++;
        else this.stats.sanitised++;
      } else {
        this.stats.errors++;
      }

      this.screens.push({
        turnNumber,
        toolIndex,
        tool,
        verdict,
        sanitisationFailed,
        latencyMs: result.latency_ms ?? latencyMs,
      });
    } catch (e) {
      this.stats.errors++;
      const latencyMs = Date.now() - start;
      this.screens.push({
        turnNumber,
        toolIndex,
        tool,
        verdict: "error",
        sanitisationFailed: false,
        latencyMs,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      this.inflight--;
    }
  }
}
