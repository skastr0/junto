// vitest-lane: alone
/**
 * The screen channel reads limits, retries and compaction off real bytes.
 *
 * Each signal capture (tests/pty-e2e/signal-capture.ts: real claude and
 * codex binaries against a scripted provider) is fed through the REAL
 * SessionObserver frame by frame, and every frame is evaluated by the REAL
 * rule packs. The test names the signals each recording must produce, with
 * the fields the screen gives, and the status the seat ends in.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluate } from "../../../src/main/junto/term/agent-state";
import { SeatStateRuntime } from "../../../src/main/junto/term/agent-state/runtime";
import { SessionObserver } from "../../../src/main/junto/term/observer/session-observer";
import { topNeed, type SeatSignal, type SeatSnapshot, type SeatStatus } from "../../../src/shared/harness-domain";
import { chunkEvents, corpusRoot, loadFixture } from "../runner";

const BINDING = "seat-1";
/**
 * The captures were recorded on 2026-10-16, a little after 03:00, with the
 * harness spawned under TZ=UTC (signal-capture.ts): bare clock times on
 * their screens are UTC, so the replay binds the seat in that zone.
 */
const NOW = Date.UTC(2026, 9, 16, 3, 0);
const CAPTURE_ZONE = "UTC";

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

const replay = async (
  harness: string,
  scenario: string,
  timeZone = CAPTURE_ZONE,
): Promise<{
  readonly signals: ReadonlyArray<SeatSignal>;
  readonly final: SeatStatus | undefined;
  readonly snapshot: SeatSnapshot | undefined;
}> => {
  const manifest = JSON.parse(readFileSync(join(corpusRoot(), harness, "manifest.json"), "utf8")) as {
    pty?: { cols?: number; rows?: number };
  };
  const observer = new SessionObserver({
    bindingId: BINDING,
    epoch: "e1",
    cols: manifest.pty?.cols ?? 80,
    rows: manifest.pty?.rows ?? 24,
  });
  const runtime = new SeatStateRuntime({ now: () => NOW, turnProgressWatch: false });
  runtime.bindHarness(BINDING, harness, "e1", timeZone);
  disposers.push(() => {
    runtime.stop();
    observer.dispose();
  });
  const seen = new Map<string, SeatSignal>();
  for (const chunk of chunkEvents(loadFixture(harness, scenario).events, "split-at-escapes")) {
    observer.feed(chunk.data, chunk.seq);
    const snapshot = await observer.snapshot();
    runtime.observe(snapshot);
    const evaluation = evaluate(snapshot, { harness, now: NOW, timeZone });
    for (const signal of [evaluation.signal, ...(evaluation.facts ?? [])]) {
      if (signal !== null) seen.set(JSON.stringify(signal), signal);
    }
  }
  const last = runtime.snapshot(BINDING);
  return { signals: [...seen.values()], final: last?.status, snapshot: last };
};

/** A retry the screen counted down: its delay ticks, so any delay is the same retry. */
const retrying = (cause: string, attempt: number) =>
  expect.objectContaining({ _tag: "Retrying", cause, attempt, max: 3, retryInMs: expect.any(Number) });

describe("claude", () => {
  it("retry-overloaded: each retry, with its cause, attempt and countdown", async () => {
    const { signals, final } = await replay("claude", "retry-overloaded");
    expect(signals).toContainEqual(retrying("unknown", 1));
    expect(signals).toContainEqual(retrying("overloaded", 3));
    expect(final).toEqual({ _tag: "Idle" });
  });

  it("retry-rate", async () => {
    const { signals } = await replay("claude", "retry-rate");
    expect(signals).toContainEqual(retrying("rate", 3));
  });

  it("retry-network", async () => {
    const { signals } = await replay("claude", "retry-network");
    expect(signals).toContainEqual(retrying("network", 3));
  });

  it("compaction-manual", async () => {
    const { signals, final } = await replay("claude", "compaction-manual");
    expect(signals).toContainEqual({ _tag: "CompactionStarted", trigger: "unknown" });
    expect(final).toEqual({ _tag: "Idle" });
  });

  it("usage-limit: the 5h limit continues by itself at the reset, so Junto need not wake it", async () => {
    const { final, snapshot } = await replay("claude", "usage-limit");
    expect(final).toEqual({
      _tag: "Blocked",
      reason: { _tag: "UsageLimit", scope: "session", resetsAt: Date.UTC(2026, 9, 16, 6, 23), autoResume: true },
    });
    expect(topNeed(snapshot!).cause).toBe("usage_limit_resuming");
  });

  it("error-auth: not logged in blocks the seat on auth", async () => {
    const { final } = await replay("claude", "error-auth");
    expect(final).toEqual({
      _tag: "Blocked",
      reason: { _tag: "Error", kind: "auth", message: "Not logged in, Please run /login" },
    });
  });

  it("error-server: the turn's error is recorded, the seat is idle", async () => {
    const { final, snapshot } = await replay("claude", "error-server");
    expect(final).toEqual({ _tag: "Idle" });
    expect(snapshot?.lastError).toMatchObject({ kind: "provider" });
    expect(snapshot?.lastError?.message).toMatch(/^500 Internal server error\./u);
  });

  it("error-context: a prompt too long is a context overflow", async () => {
    const { final, snapshot } = await replay("claude", "error-context");
    expect(final).toEqual({ _tag: "Idle" });
    expect(snapshot?.lastError).toMatchObject({ kind: "contextOverflow" });
    expect(snapshot?.lastError?.message).toMatch(/^Prompt is too long, the request is ~250000 tokens/u);
  });

  it("usage-limit-weekly: the what-to-do dialog is the weekly limit, with its reset in UTC", async () => {
    const { final } = await replay("claude", "usage-limit-weekly");
    expect(final).toEqual({
      _tag: "Blocked",
      reason: { _tag: "UsageLimit", scope: "weekly", resetsAt: Date.UTC(2026, 9, 21, 6, 23) },
    });
  });
});

/** Codex's error-server and error-context replays, run together, took past 5s at a load near 170. */
describe("codex", { timeout: 30_000 }, () => {
  it("usage-limit: the model picker after the limit is the limit, with its reset", async () => {
    const { final } = await replay("codex", "usage-limit");
    // "try again at 6:25 AM.": 06:25 in the zone codex ran in.
    expect(final).toEqual({
      _tag: "Blocked",
      reason: { _tag: "UsageLimit", scope: "unknown", resetsAt: Date.UTC(2026, 9, 16, 6, 25) },
    });
  });

  it("usage-limit-weekly: a dated reset", async () => {
    const { final } = await replay("codex", "usage-limit-weekly");
    expect(final).toEqual({
      _tag: "Blocked",
      reason: { _tag: "UsageLimit", scope: "unknown", resetsAt: Date.UTC(2026, 9, 21, 6, 25) },
    });
  });

  it("a seat spawned in another zone: the same bare times read there, not in UTC", async () => {
    // Sao Paulo is UTC-3: a bare 6:25 AM there is 09:25 UTC.
    const fiveHour = await replay("codex", "usage-limit", "America/Sao_Paulo");
    expect(fiveHour.final).toMatchObject({ reason: { resetsAt: Date.UTC(2026, 9, 16, 9, 25) } });
    const weekly = await replay("codex", "usage-limit-weekly", "America/Sao_Paulo");
    expect(weekly.final).toMatchObject({ reason: { resetsAt: Date.UTC(2026, 9, 21, 9, 25) } });
    // Claude names its zone, "(UTC)": that wins over the seat's.
    const claude = await replay("claude", "usage-limit-weekly", "America/Sao_Paulo");
    expect(claude.final).toMatchObject({ reason: { resetsAt: Date.UTC(2026, 9, 21, 6, 23) } });
  });

  it("retry-rate: reconnecting, with the status it last saw", async () => {
    const { signals, final } = await replay("codex", "retry-rate");
    expect(signals).toContainEqual({ _tag: "Retrying", cause: "rate", attempt: 1, max: 3 });
    expect(final).toEqual({ _tag: "Idle" });
  });

  it("error-auth: 401 Unauthorized blocks the seat on auth", async () => {
    const { final } = await replay("codex", "error-auth");
    expect(final).toMatchObject({ _tag: "Blocked", reason: { _tag: "Error", kind: "auth" } });
  });

  it("error-server and error-context: recorded, the seat idle", async () => {
    const server = await replay("codex", "error-server");
    expect(server.final).toEqual({ _tag: "Idle" });
    expect(server.snapshot?.lastError).toMatchObject({ kind: "provider" });
    const context = await replay("codex", "error-context");
    expect(context.final).toEqual({ _tag: "Idle" });
    expect(context.snapshot?.lastError).toMatchObject({ kind: "contextOverflow" });
  });

  it("compaction-manual", async () => {
    const { signals, final } = await replay("codex", "compaction-manual");
    expect(signals).toContainEqual({ _tag: "CompactionStarted", trigger: "unknown" });
    expect(final).toEqual({ _tag: "Idle" });
  });

  it("compaction-auto: only the finished line shows, so it is the compaction's end", async () => {
    const { signals, final, snapshot } = await replay("codex", "compaction-auto");
    expect(signals).toContainEqual({ _tag: "CompactionEnded", ok: true });
    expect(final).toEqual({ _tag: "Idle" });
    expect(snapshot?.compaction).toBeUndefined();
    // The turn ended and nobody has looked.
    expect(topNeed(snapshot!).cause).toBe("turn_unseen");
  });
});

/** Kimi counts its retries to ten and shows each wait. */
const kimiRetrying = (cause: string) =>
  expect.objectContaining({ _tag: "Retrying", cause, attempt: 2, max: 10, retryInMs: expect.any(Number) });

/**
 * Kimi's retry and limit recordings run to ~800 chunks, and each awaits a
 * grid write: a replay takes ~3s on a loaded machine, past the 5s default
 * for the tests that replay two or three of them.
 */
describe("kimi", { timeout: 30_000 }, () => {
  it("retry-overloaded, retry-rate, retry-network: the status line under the retry names the cause", async () => {
    for (const [scenario, cause] of [
      ["retry-overloaded", "overloaded"],
      ["retry-rate", "rate"],
      ["retry-network", "network"],
    ] as const) {
      const { signals, final } = await replay("kimi", scenario);
      expect(signals, scenario).toContainEqual(kimiRetrying(cause));
      expect(final, scenario).toEqual({ _tag: "Idle" });
    }
  });

  it("error-server: still retrying the 500s when the recording ends", async () => {
    const { signals, final, snapshot } = await replay("kimi", "error-server");
    expect(signals).toContainEqual(kimiRetrying("server"));
    expect(final).toEqual({ _tag: "Working", phase: "retrying" });
    expect(topNeed(snapshot!).cause).toBe("retrying");
  });

  it("usage-limit, usage-limit-weekly: a limit kimi retries, with no window and no reset on screen", async () => {
    for (const scenario of ["usage-limit", "usage-limit-weekly"]) {
      const { final, snapshot } = await replay("kimi", scenario);
      expect(final, scenario).toEqual({ _tag: "Blocked", reason: { _tag: "UsageLimit", scope: "unknown" } });
      expect(topNeed(snapshot!).cause, scenario).toBe("usage_limit");
    }
  });

  it("error-auth: a rejected API key blocks the seat on auth", async () => {
    const { final, snapshot } = await replay("kimi", "error-auth");
    expect(final).toEqual({
      _tag: "Blocked",
      reason: { _tag: "Error", kind: "auth", message: "[provider.auth_error] 401 Incorrect API key provided." },
    });
    expect(topNeed(snapshot!).cause).toBe("auth_error");
  });

  it("error-context: the overflow cancels the compaction it started, and is recorded", async () => {
    const { signals, final, snapshot } = await replay("kimi", "error-context");
    expect(signals).toContainEqual({ _tag: "CompactionStarted", trigger: "unknown" });
    expect(signals).toContainEqual({ _tag: "CompactionEnded", ok: false });
    expect(final).toEqual({ _tag: "Idle" });
    expect(snapshot?.lastError).toMatchObject({ kind: "contextOverflow" });
    expect(snapshot?.lastError?.message).toMatch(/^\[compaction\.failed\] APIContextOverflowError: 400 /u);
  });

  it("compaction-manual: started, then complete with its token counts", async () => {
    const { signals, final } = await replay("kimi", "compaction-manual");
    expect(signals).toContainEqual({ _tag: "CompactionStarted", trigger: "unknown" });
    expect(signals).toContainEqual({ _tag: "CompactionEnded", ok: true, tokensBefore: 21169, tokensAfter: 21735 });
    expect(final).toEqual({ _tag: "Idle" });
  });
});
