import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EtherTerminal } from "../src/shared/canvas";
import { applySettingsPatch, defaultSettings, Settings } from "../src/shared/settings";
import {
  composeOffboardNudge,
  defaultTokenPressure,
  effectiveThreshold,
  formatTokens,
  pressureGaugeLabel,
  resolveLimit,
  stepPressure,
  tokenPressureSettings,
  type PressurePhase,
  type SeatPressureSnapshot,
  type TokenPressureSettings,
} from "../src/shared/token-pressure";
import {
  encodeClaudeProjectCwd,
  encodeGrokSessionCwd,
  encodePiSessionCwd,
} from "../src/main/junto/term/session-existence";
import { contextReaderFor, kimiWindowFromToml, parseClaudeLine } from "../src/main/junto/token-pressure/readers";
import { ompSessionsDir } from "../src/main/junto/term/templates/omp-session";
import { SessionTail, TAIL_FIRST_WINDOW_BYTES } from "../src/main/junto/token-pressure/session-tail";
import {
  pressureKey,
  TokenPressureMonitor,
  type PressureRotateResult,
  type PressureSeat,
  type TokenPressureChange,
} from "../src/main/junto/token-pressure/monitor";

// Fixtures are real session records from this machine's Claude Code 2.1.282
// and Codex 0.157.1 transcripts, stripped to structure and usage: ids, paths,
// and every text body replaced.
const FIXTURES = join(__dirname, "fixtures", "token-pressure");
const CLAUDE_SESSION = "11111111-2222-4333-8444-555555555555";
const CODEX_THREAD = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
const CWD = "/work/fixture";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "junto-pressure-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const placeClaude = (): string => {
  const dir = join(home, ".claude", "projects", encodeClaudeProjectCwd(CWD));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${CLAUDE_SESSION}.jsonl`);
  copyFileSync(join(FIXTURES, "claude-session.jsonl"), path);
  return path;
};

const placeCodex = (): string => {
  const dir = join(home, ".codex", "sessions", "2026", "09", "26");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-09-26T13-19-10-${CODEX_THREAD}.jsonl`);
  copyFileSync(join(FIXTURES, "codex-rollout.jsonl"), path);
  return path;
};

const readOnce = (harness: string, seat: Omit<PressureSeat, "harness" | "canvasName" | "nodeId" | "bindingId">) => {
  const opened = contextReaderFor(harness)!.open({ harness, ...seat }, home);
  return opened === undefined ? undefined : new SessionTail(opened.path, opened.parse).read();
};

describe("context readers on recorded sessions", () => {
  it("reads Claude's last main-thread usage as input plus cache read plus cache creation", () => {
    placeClaude();
    const reading = readOnce("claude", { sessionId: CLAUDE_SESSION, cwd: CWD });
    // Last real assistant record: 2 + 131313 + 949. The sidechain and
    // synthetic records after it are not the main context.
    expect(reading).toMatchObject({ usedTokens: 132_264, model: "claude-opus-5-5" });
    // The transcript has no window; Claude reports it only to its status line.
    expect(reading?.window).toBeUndefined();
  });

  it("finds a Claude session whose folder is not the seat's cwd", () => {
    placeClaude();
    expect(readOnce("claude", { sessionId: CLAUDE_SESSION, cwd: "/moved/elsewhere" })?.usedTokens).toBe(132_264);
  });

  it("reads Codex's last prompt size and the exact window from token_count", () => {
    placeCodex();
    expect(readOnce("codex", { sessionId: CODEX_THREAD })).toMatchObject({
      usedTokens: 196_620,
      window: 258_400,
      windowSource: "session",
    });
  });

  it("has no reading for a session that is not on disk, and no reader for other harnesses", () => {
    expect(readOnce("claude", { sessionId: "missing", cwd: CWD })).toBeUndefined();
    expect(contextReaderFor("devin")).toBeUndefined();
    expect(contextReaderFor("hermes")).toBeUndefined();
  });
});

describe("context readers for the other harnesses, on recorded sessions", () => {
  const put = (path: string, fixture: string): void => {
    mkdirSync(dirname(path), { recursive: true });
    copyFileSync(join(FIXTURES, fixture), path);
  };
  const ID = "019a0000-0000-7000-8000-00000000000a";

  it("reads Pi's last assistant usage and the window from its model store", () => {
    put(join(home, ".pi", "agent", "sessions", encodePiSessionCwd(CWD), `2026-09-16T18-00-00-000Z_${ID}.jsonl`), "pi-session.jsonl");
    put(join(home, ".pi", "agent", "models-store.json"), "pi-models-store.json");
    // 2390 input + 70144 cache read + 0 cache write.
    expect(readOnce("pi", { sessionId: ID, cwd: CWD })).toMatchObject({
      usedTokens: 72_534,
      model: "gpt-5.5",
      window: 272_000,
      windowSource: "config",
    });
  });

  it("reads Oh My Pi's usage and the window from its model cache database", () => {
    put(join(ompSessionsDir(CWD, home), `2026-09-14T15-50-00-000Z_${ID}.jsonl`), "omp-session.jsonl");
    const cache = JSON.parse(readFileSync(join(FIXTURES, "omp-model-cache.json"), "utf8")) as {
      provider_id: string;
      models: unknown;
    };
    mkdirSync(join(home, ".omp", "agent"), { recursive: true });
    const db = new DatabaseSync(join(home, ".omp", "agent", "models.db"));
    db.exec("CREATE TABLE model_cache (provider_id TEXT PRIMARY KEY, models TEXT NOT NULL)");
    db.prepare("INSERT INTO model_cache VALUES (?, ?)").run(cache.provider_id, JSON.stringify(cache.models));
    db.close();
    expect(readOnce("omp", { sessionId: ID, cwd: CWD })).toMatchObject({
      usedTokens: 21_238,
      model: "glm-5.3-flash",
      window: 1_000_000,
    });
  });

  it("reads Prime Agent's usage and leaves the window unknown when its cache does not list the model", () => {
    put(join(home, ".prime", "agent", "sessions", `${ID}.jsonl`), "prime-session.jsonl");
    const reading = readOnce("prime-agent", { sessionId: ID });
    expect(reading).toMatchObject({ usedTokens: 14_113, model: "gpt-5.6-sol" });
    expect(reading?.window).toBeUndefined();
  });

  it("reads Kimi's per-step usage record and the window from config.toml", () => {
    const sid = `session_${ID}`;
    put(join(home, ".kimi-code", "sessions", "wd_fixture_000000000000", sid, "agents", "main", "wire.jsonl"), "kimi-wire.jsonl");
    put(join(home, ".kimi-code", "config.toml"), "kimi-config.toml");
    // 21655 other + 18944 cache read + 0 cache creation.
    expect(readOnce("kimi", { sessionId: sid })).toMatchObject({
      usedTokens: 40_599,
      model: "kimi-code/k3",
      window: 1_048_576,
    });
  });

  it("reads Muse's model_completed prompt and the window from its model catalog", () => {
    put(join(home, ".local", "share", "muse", "sessions", "2026", "09", "16", ID, "session.jsonl"), "muse-session.jsonl");
    put(join(home, ".local", "share", "muse", "model-catalog", "fixture.json"), "muse-model-catalog.json");
    expect(readOnce("muse", { sessionId: ID })).toMatchObject({
      usedTokens: 73_110,
      model: "muse-spark-1.3",
      window: 1_007_997,
    });
  });

  it("reads Grok's live context from streamed updates, never the turn's running total", () => {
    const dir = join(home, ".grok", "sessions", encodeGrokSessionCwd(CWD), ID);
    put(join(dir, "updates.jsonl"), "grok-updates.jsonl");
    put(join(dir, "signals.json"), "grok-signals.json");
    expect(readOnce("grok", { sessionId: ID, cwd: CWD })).toMatchObject({
      usedTokens: 203_385,
      window: 500_000,
      windowSource: "session",
    });
  });

  it("reads Kimi's window for the model alias it names", () => {
    const toml = readFileSync(join(FIXTURES, "kimi-config.toml"), "utf8");
    expect(kimiWindowFromToml(toml, "kimi-code/k3-256k")).toBe(262_144);
    expect(kimiWindowFromToml(toml, "kimi-code/unknown")).toBeUndefined();
  });
});

describe("SessionTail", () => {
  const usageLine = (tokens: number): string =>
    `${JSON.stringify({ type: "assistant", isSidechain: false, timestamp: "2026-09-28T10:00:00.000Z", message: { model: "claude-opus-5-5", usage: { input_tokens: tokens } } })}\n`;
  const parse = (line: string) => parseClaudeLine(line);

  it("reads only what was appended, and waits for a line to finish", () => {
    const path = join(home, "s.jsonl");
    writeFileSync(path, usageLine(100));
    const tail = new SessionTail(path, parse);
    expect(tail.read()?.usedTokens).toBe(100);
    const next = usageLine(250);
    appendFileSync(path, next.slice(0, 20));
    expect(tail.read()?.usedTokens).toBe(100);
    appendFileSync(path, next.slice(20));
    expect(tail.read()?.usedTokens).toBe(250);
  });

  it("starts near the end of a large file and starts over when it is replaced", () => {
    const path = join(home, "big.jsonl");
    const filler = `${JSON.stringify({ type: "user", message: { content: "x".repeat(1000) } })}\n`;
    writeFileSync(path, usageLine(1) + filler.repeat(Math.ceil((TAIL_FIRST_WINDOW_BYTES * 1.5) / filler.length)) + usageLine(77));
    const tail = new SessionTail(path, parse);
    expect(tail.read()?.usedTokens).toBe(77);
    rmSync(path);
    writeFileSync(path, usageLine(5));
    expect(tail.read()?.usedTokens).toBe(5);
  });
});

describe("thresholds", () => {
  it("resolves percent only against a known window", () => {
    expect(resolveLimit({ kind: "percent", percent: 75 }, 200_000)).toEqual({ ok: true, limitTokens: 150_000 });
    expect(resolveLimit({ kind: "percent", percent: 75 }, undefined)).toEqual({ ok: false, reason: "no-window" });
    expect(resolveLimit({ kind: "tokens", tokens: 120_000 }, undefined)).toEqual({ ok: true, limitTokens: 120_000 });
  });

  it("lets a seat's own choice win, and off mean off", () => {
    const defaults = defaultTokenPressure();
    expect(effectiveThreshold(undefined, defaults)).toEqual({ threshold: defaults.threshold, from: "default" });
    expect(effectiveThreshold({ kind: "tokens", tokens: 90_000 }, defaults)?.from).toBe("seat");
    expect(effectiveThreshold({ kind: "off" }, defaults)).toBeUndefined();
    expect(effectiveThreshold(undefined, { ...defaults, enabled: false })).toBeUndefined();
  });

  it("formats the gauge in thousands", () => {
    expect(formatTokens(142_300)).toBe("142k");
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(1_500_000)).toBe("1.5M");
    const snapshot: SeatPressureSnapshot = {
      canvasName: "c", nodeId: "n", status: "reading", usedTokens: 142_000, limitTokens: 200_000, phase: "below", at: 0,
    };
    expect(pressureGaugeLabel(snapshot)).toBe("142k of 200k");
  });

  it("writes a nudge with no middle dots", () => {
    const text = composeOffboardNudge({ usedTokens: 160_000, limitTokens: 150_000, graceMinutes: 10 });
    expect(text).toContain("160k");
    expect(text).toContain("offboard");
    expect(text).not.toContain("·");
  });
});

describe("stepPressure", () => {
  const input = { limitTokens: 100, graceMs: 60_000 };

  it("nudges once per crossing, and only when idle", () => {
    let phase: PressurePhase = { phase: "below" };
    const actions: string[] = [];
    const tick = (usedTokens: number, idle: boolean, now: number) => {
      const step = stepPressure(phase, { ...input, usedTokens, idle, now });
      phase = step.next;
      if (step.action) actions.push(step.action);
    };
    tick(99, true, 0);
    tick(120, false, 1); // over, mid-turn: wait
    expect(phase.phase).toBe("over");
    tick(125, true, 2); // between turns: nudge
    tick(130, true, 3);
    tick(95, true, 4); // wobble above the re-arm point is the same crossing
    tick(130, true, 5);
    expect(actions).toEqual(["nudge"]);
    tick(50, true, 6); // compaction: pressure gone, re-armed
    expect(phase.phase).toBe("below");
    tick(101, true, 7);
    expect(actions).toEqual(["nudge", "nudge"]);
  });

  it("rotates once after the grace period, between turns", () => {
    let phase: PressurePhase = { phase: "nudged", at: 0 };
    expect(stepPressure(phase, { ...input, usedTokens: 150, idle: true, now: 59_999 }).action).toBeUndefined();
    expect(stepPressure(phase, { ...input, usedTokens: 150, idle: false, now: 60_000 }).action).toBeUndefined();
    const step = stepPressure(phase, { ...input, usedTokens: 150, idle: true, now: 60_000 });
    expect(step.action).toBe("rotate");
    phase = step.next;
    expect(stepPressure(phase, { ...input, usedTokens: 150, idle: true, now: 120_000 }).action).toBeUndefined();
  });
});

describe("settings and seat override", () => {
  it("defaults, patches, and decodes a row without the section", () => {
    const settings = defaultSettings();
    expect(tokenPressureSettings(settings)).toEqual(defaultTokenPressure());
    const { tokenPressure: _absent, ...older } = settings;
    expect(tokenPressureSettings(Schema.decodeUnknownSync(Settings)(older))).toEqual(defaultTokenPressure());
    const patched = applySettingsPatch(settings, { tokenPressure: { threshold: { kind: "tokens", tokens: 180_000 } } });
    expect(patched.tokenPressure).toEqual({ ...defaultTokenPressure(), threshold: { kind: "tokens", tokens: 180_000 } });
    expect(() =>
      Schema.decodeUnknownSync(Settings)({ ...settings, tokenPressure: { ...defaultTokenPressure(), threshold: { kind: "percent", percent: 150 } } }),
    ).toThrow();
  });

  it("stores a seat's override on its terminal", () => {
    const decode = Schema.decodeUnknownSync(EtherTerminal);
    expect(decode({ bindingId: "b", tokenPressure: { kind: "off" } }).tokenPressure).toEqual({ kind: "off" });
    expect(decode({ bindingId: "b", tokenPressure: { kind: "percent", percent: 60 } }).tokenPressure).toEqual({ kind: "percent", percent: 60 });
    expect(() => decode({ bindingId: "b", tokenPressure: { kind: "tokens", tokens: 5 } })).toThrow();
  });
});

describe("TokenPressureMonitor", () => {
  type Harness = {
    readonly monitor: TokenPressureMonitor;
    readonly nudges: string[];
    readonly rotations: string[];
    readonly changes: TokenPressureChange[];
    idle: boolean;
    live: boolean;
    now: number;
    settings: TokenPressureSettings;
    rotateAvailable: boolean;
    seats: PressureSeat[];
    offboard?: (event: { seatId: string; canvasName: string; sessionId?: string }) => void;
  };

  const make = (seats: PressureSeat[]): Harness => {
    const h = {
      nudges: [] as string[],
      rotations: [] as string[],
      changes: [] as TokenPressureChange[],
      idle: true,
      live: true,
      now: 1_000,
      settings: { ...defaultTokenPressure(), threshold: { kind: "tokens" as const, tokens: 100_000 }, graceMinutes: 1 },
      rotateAvailable: true,
      seats,
    } as Harness;
    const monitor = new TokenPressureMonitor({
      listSeats: async () => h.seats,
      isLive: () => h.live,
      isIdle: () => h.idle,
      settings: () => h.settings,
      nudge: async (seat, text) => {
        h.nudges.push(`${seat.nodeId}: ${text.split("\n")[0]}`);
        return true;
      },
      rotate: () =>
        h.rotateAvailable
          ? async (seat): Promise<PressureRotateResult> => {
              h.rotations.push(seat.nodeId);
              return { ok: true };
            }
          : undefined,
      onOffboard: (listener) => {
        h.offboard = listener;
        return () => undefined;
      },
      publish: (change) => h.changes.push(change),
      home: () => home,
      now: () => h.now,
    });
    monitor.start(3_600_000);
    return Object.assign(h, { monitor });
  };

  const codexSeat = (extra: Partial<PressureSeat> = {}): PressureSeat => ({
    canvasName: "main",
    nodeId: "seat-1",
    bindingId: "bind-1",
    harness: "codex",
    sessionId: CODEX_THREAD,
    ...extra,
  });

  it("nudges a seat over its limit once, only between turns, then rotates after grace", async () => {
    placeCodex();
    const h = make([codexSeat()]);
    h.idle = false;
    await h.monitor.tick();
    expect(h.nudges).toEqual([]);
    expect(h.monitor.current()[0]).toMatchObject({ status: "reading", usedTokens: 196_620, limitTokens: 100_000, phase: "over" });
    h.idle = true;
    h.now += 5_000;
    await h.monitor.tick();
    h.now += 5_000;
    await h.monitor.tick();
    expect(h.nudges).toHaveLength(1);
    expect(h.nudges[0]).toContain("197k");
    expect(h.rotations).toEqual([]);
    h.now += 60_000;
    await h.monitor.tick();
    expect(h.rotations).toEqual(["seat-1"]);
    expect(h.monitor.current()[0]?.phase).toBe("rotating");
    h.monitor.stop();
  });

  it("rotates at the next idle tick after the agent offboards", async () => {
    placeCodex();
    const h = make([codexSeat()]);
    h.settings = { ...h.settings, threshold: { kind: "tokens", tokens: 900_000 } };
    await h.monitor.tick();
    h.idle = false;
    h.offboard?.({ seatId: "seat-1", canvasName: "main", sessionId: CODEX_THREAD });
    await h.monitor.tick();
    expect(h.rotations).toEqual([]);
    h.idle = true;
    await h.monitor.tick();
    await h.monitor.tick();
    expect(h.rotations).toEqual(["seat-1"]);
    h.monitor.stop();
  });

  it("does not rotate an offboarded seat whose pressure is off", async () => {
    placeCodex();
    const h = make([codexSeat({ override: { kind: "off" } })]);
    h.offboard?.({ seatId: "seat-1", canvasName: "main" });
    await h.monitor.tick();
    expect(h.rotations).toEqual([]);
    expect(h.nudges).toEqual([]);
    h.monitor.stop();
  });

  it("marks the seat when rotation is not available on this build", async () => {
    placeCodex();
    const h = make([codexSeat()]);
    h.rotateAvailable = false;
    await h.monitor.tick();
    h.now += 61_000;
    await h.monitor.tick();
    expect(h.monitor.current()[0]).toMatchObject({ phase: "rotating", rotation: "unavailable" });
    h.monitor.stop();
  });

  it("starts clean when the seat moves to a new session", async () => {
    placeCodex();
    const h = make([codexSeat()]);
    await h.monitor.tick();
    expect(h.nudges).toHaveLength(1);
    // The new session's file shows the same pressure, but it is a new crossing.
    const fresh = "0199aaaa-bbbb-7ccc-8ddd-ffffffffffff";
    const dir = join(home, ".codex", "sessions", "2026", "09", "27");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `rollout-2026-09-27T10-00-00-${fresh}.jsonl`), readFileSync(join(FIXTURES, "codex-rollout.jsonl")));
    h.seats = [codexSeat({ sessionId: fresh })];
    h.monitor.invalidateSeats();
    await h.monitor.tick();
    expect(h.nudges).toHaveLength(2);
    h.monitor.stop();
  });

  it("says percent cannot apply when the window is unknown", async () => {
    const dir = join(home, ".codex", "sessions", "2026", "09", "26");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `rollout-x-${CODEX_THREAD}.jsonl`),
      `${JSON.stringify({ timestamp: "2026-09-26T16:40:08.603Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 5000 } } } })}\n`,
    );
    const h = make([codexSeat()]);
    h.settings = defaultTokenPressure();
    await h.monitor.tick();
    expect(h.monitor.current()[0]).toMatchObject({ status: "reading", usedTokens: 5000, limitBlocked: "no-window" });
    expect(h.monitor.current()[0]?.limitTokens).toBeUndefined();
    h.monitor.stop();
  });

  it("reports harnesses it cannot read, and drops seats that stop", async () => {
    const h = make([codexSeat({ nodeId: "seat-2", harness: "devin", sessionId: "x" })]);
    await h.monitor.tick();
    expect(h.monitor.current()[0]).toMatchObject({ status: "unsupported" });
    h.live = false;
    await h.monitor.tick();
    expect(h.changes.at(-1)?.removed).toEqual([pressureKey("main", "seat-2")]);
    h.monitor.stop();
  });
});
