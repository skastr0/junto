/**
 * Operator offboard over fakes: the one operation behind the buttons, the
 * overseer command and the automatic rules, and the durable status clock.
 * No app, no harness, no real seats: every port is scripted.
 */
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { NodeOf } from "../src/shared/model";
import type { SeatSessionRepository as SeatSessions } from "../src/main/junto/seat-sessions/repository";
import {
  SeatStatusClock,
  makeOperatorOffboard,
  parseSeatClockRecord,
  waitsOnOperator,
  type OffboardSeat,
  type OperatorOffboardPorts,
  type SeatCacheQuestion,
  type SeatClockRecord,
  type SeatOffboardFacts,
} from "../src/main/junto/seat-sessions/operator-offboard";
import { makeOperatorHolds, type OperatorHolds } from "../src/main/junto/term/operator-holds";
import { OPERATOR_TYPING_GRACE_MS } from "../src/shared/operator-hold";
import { initialSnapshot, type SeatSnapshot, type SeatStatus } from "../src/shared/harness-domain";
import type { BindingId } from "../src/shared/terminal-session-domain";
import type { SeatCacheDue } from "../src/shared/seat-cache-due";
import type { SeatStartCause } from "../src/main/junto/term/seat-start-cause";
import {
  CACHE_MODES,
  OFFBOARD_REFUSAL_REASON,
  applyOffboardRulesPatch,
  defaultOffboardRules,
  type CacheMode,
  type OffboardBy,
  type OffboardRules,
} from "../src/shared/seat-offboard";

const MIN = 60_000;
const T0 = 1_791_000_000_000;
const CANVAS = "factory";

const seat = (seatId: string, over: Partial<OffboardSeat> = {}): OffboardSeat => ({
  seatId,
  canvasName: CANVAS,
  title: seatId.toUpperCase(),
  bindingId: `bind-${seatId}`,
  harness: "claude",
  local: true,
  sessionId: `session-${seatId}`,
  running: true,
  generation: `gen-${seatId}`,
  state: "idle",
  ...over,
});

/** The n-th question id a world mints: the attach handle's pattern. */
const qid = (n: number): string => `q${String(n).padStart(21, "0")}`;

/** A seat's status as the clock reads it. */
const status = (
  tag: SeatStatus["_tag"],
  since: number,
  activitySince?: number,
): Pick<SeatSnapshot, "status" | "since" | "activitySince"> => ({
  status: tag === "Working" ? { _tag: "Working", phase: "thinking" } : ({ _tag: tag } as SeatStatus),
  since,
  ...(activitySince === undefined ? {} : { activitySince }),
});

const world = (
  initial: OffboardSeat[],
  options: {
    rules?: OffboardRules;
    restored?: SeatClockRecord;
    at?: number;
    /** Seats whose session has done no work. Every other seat starts with an hour of it. */
    noWork?: ReadonlyArray<string>;
    /** The operator's real holds, on this world's clock, keyed by binding. */
    holds?: (now: () => number) => OperatorHolds;
  } = {},
) => {
  let at = options.at ?? T0;
  let rules = options.rules ?? defaultOffboardRules();
  const seats = new Map(initial.map((s) => [s.seatId, s]));
  const closing = new Set<string>();
  /** Seats the operator views, by seat id: a scripted hold. */
  const held = new Map<string, { readonly until?: number; readonly typedUntil?: number }>();
  const holds = options.holds?.(() => at);
  const closed: Array<{ seatId: string; by: OffboardBy }> = [];
  const asked: Array<{ seatId: string; mode: string }> = [];
  const ended: Array<{ seatId: string; sessionId: string; by: OffboardBy; at: number }> = [];
  const saved: SeatClockRecord[] = [];
  /** Every list of seats due the auto mode's question, as main told it. */
  const dues: Array<ReadonlyArray<SeatCacheQuestion>> = [];
  let minted = 0;
  const fail = { close: new Set<string>(), ask: new Set<string>() };
  /** Transcript size per seat, in tokens. A seat not listed has no locatable transcript. */
  const sizes = new Map<string, number>();
  /** What a seat's own machine last said of it, for a seat run elsewhere. */
  const told = new Map<string, SeatOffboardFacts>();
  // A session worth cutting, unless the test says otherwise: an hour of work.
  const seeded: SeatClockRecord = {
    savedAt: at,
    seats: Object.fromEntries(
      initial
        .filter((s) => !(options.noWork ?? []).includes(s.seatId))
        .map((s) => [s.bindingId, { idleSince: at, workMs: 60 * MIN, ...(s.sessionId ? { sessionId: s.sessionId } : {}) }]),
    ),
  };
  const clock = new SeatStatusClock(() => at, options.restored ?? seeded);
  const ports: OperatorOffboardPorts = {
    locate: async ({ canvasName, seatId }) => (canvasName === CANVAS ? seats.get(seatId) : undefined),
    seats: async () => [...seats.values()],
    isClosing: ({ seatId }) => closing.has(seatId),
    closeNow: async (s, by) => {
      if (fail.close.has(s.seatId)) return { ok: false, message: "could not give the seat a fresh session on its canvas" };
      closed.push({ seatId: s.seatId, by });
      // What the closer does: a fresh session id, and the seat rests.
      seats.set(s.seatId, { ...s, sessionId: `fresh-${s.seatId}`, running: false, state: undefined });
      return { ok: true };
    },
    ask: async (s, mode) => {
      if (fail.ask.has(s.seatId)) return { ok: false, message: "" };
      asked.push({ seatId: s.seatId, mode });
      return { ok: true };
    },
    markEnded: (s, sessionId, by, when) => ended.push({ seatId: s.seatId, sessionId, by, at: when }),
    sessionSize: (s) => (sizes.has(s.seatId) ? { tokens: sizes.get(s.seatId)! } : undefined),
    rules: () => rules,
    held: (s, when) => holds?.hold(s.bindingId, when) ?? held.get(s.seatId),
    remote: async (s) => told.get(s.seatId),
    saveClock: (record) => saved.push(record),
    dueChanged: (due) => dues.push(due),
    mintQuestion: () => qid(++minted),
    now: () => at,
  };
  const offboard = makeOperatorOffboard(ports, clock);
  return {
    offboard,
    clock,
    seats,
    closing,
    held,
    holds,
    closed,
    asked,
    ended,
    saved,
    dues,
    fail,
    sizes,
    told,
    advance: (minutes: number) => {
      at += minutes * MIN;
    },
    /** The seat works for this long, then goes idle: time passes for everyone. */
    work: (seatId: string, minutes: number) => {
      const bindingId = seats.get(seatId)!.bindingId;
      clock.syncSession(bindingId, seats.get(seatId)!.sessionId);
      const began = at;
      clock.noteState(bindingId, "working");
      clock.noteStatus(bindingId, status("Working", began, began));
      at += minutes * MIN;
      clock.noteState(bindingId, "idle");
      clock.noteStatus(bindingId, status("Idle", at, began));
    },
    /** The seat takes a turn and comes back to rest now. */
    settle: (seatId: string) => {
      const bindingId = seats.get(seatId)!.bindingId;
      clock.noteStatus(bindingId, status("Working", at, at));
      clock.noteStatus(bindingId, status("Idle", at, at));
    },
    setRules: (next: OffboardRules) => {
      rules = next;
    },
    /**
     * A start of the seat, as sessionBeforeStart makes it: the decision, and
     * on a cold session the fresh path, which ends the old session, names a
     * new one and records that Junto ended it. Mail starts it unless the
     * test says otherwise.
     */
    start: async (seatId: string, cause: SeatStartCause = "mail"): Promise<boolean> => {
      const fresh = await offboard.coldAtStart({ canvasName: CANVAS, seatId }, cause);
      const before = seats.get(seatId);
      if (fresh && before?.sessionId !== undefined) {
        seats.set(seatId, { ...before, sessionId: `fresh-${seatId}` });
        offboard.endedAtStart({ canvasName: CANVAS, seatId }, before.bindingId, before.sessionId);
      }
      return fresh;
    },
    set: (seatId: string, over: Partial<OffboardSeat>) => seats.set(seatId, { ...seats.get(seatId)!, ...over }),
    now: () => at,
  };
};

describe("offboard now", () => {
  it("closes an idle seat without its agent, records who, and leaves it resting", async () => {
    const w = world([seat("a")]);
    const result = await w.offboard.run({ canvasName: CANVAS, seatIds: ["a"], action: "now" }, "operator");
    expect(result).toEqual({
      results: [{ seatId: "a", title: "A", ok: true, action: "now", outcome: "closed", pastWindow: false }],
      closed: 1,
      asked: 0,
      refused: 0,
    });
    expect(w.closed).toEqual([{ seatId: "a", by: "operator" }]);
    // The marker names the session that ENDED, not the fresh one.
    expect(w.ended).toEqual([{ seatId: "a", sessionId: "session-a", by: "operator", at: T0 }]);
    // Nothing was typed to the agent: no ask, no notes.
    expect(w.asked).toEqual([]);
    expect(w.seats.get("a")).toMatchObject({ running: false, sessionId: "fresh-a" });
  });

  it("closes a not running or resting seat: there is no turn to cut", async () => {
    const w = world([seat("off", { running: false, state: undefined })]);
    const result = await w.offboard.run({ canvasName: CANVAS, seatIds: ["off"], action: "now" }, "overseer");
    expect(result.results[0]).toMatchObject({ ok: true, outcome: "closed" });
    expect(w.ended[0]).toMatchObject({ by: "overseer", sessionId: "session-off" });
  });

  it("refuses, with a code and a sentence, and never queues or cuts a turn", async () => {
    const w = world([
      seat("working", { state: "working" }),
      seat("dialog", { state: "attention" }),
      seat("starting", { state: "unknown" }),
      seat("unread", { state: undefined }),
      seat("remote", { local: false }),
      seat("busy"),
    ]);
    w.closing.add("busy");
    const result = await w.offboard.run(
      { canvasName: CANVAS, seatIds: ["working", "dialog", "starting", "unread", "remote", "busy", "ghost"], action: "now" },
      "operator",
    );
    expect(result.results.map((row) => [row.seatId, row.ok ? "ok" : row.code])).toEqual([
      ["working", "working"],
      ["dialog", "attention"],
      ["starting", "working"],
      ["unread", "working"],
      ["remote", "not-local"],
      ["busy", "closing"],
      ["ghost", "not-a-seat"],
    ]);
    expect(result).toMatchObject({ closed: 0, refused: 7 });
    const reasons = Object.fromEntries(result.results.map((row) => [row.seatId, row.ok ? "" : row.reason]));
    expect(reasons.working).toBe(OFFBOARD_REFUSAL_REASON.working);
    expect(reasons.dialog).toBe(OFFBOARD_REFUSAL_REASON.attention);
    expect(reasons.starting).toBe(
      "Junto cannot tell that this seat is idle. Offboard now only closes a seat that is idle, not running or resting.",
    );
    expect(reasons.busy).toBe("This seat is already offboarding.");
    expect(reasons.ghost).toBe("Junto could not find that seat.");
    // Nothing was closed, asked or recorded for any of them.
    expect(w.closed).toEqual([]);
    expect(w.asked).toEqual([]);
    expect(w.ended).toEqual([]);
  });

  it("many seats at once: each is its own, rows come back in the order asked", async () => {
    const w = world([seat("a"), seat("b", { state: "working" }), seat("c"), seat("d")]);
    w.fail.close.add("c");
    const result = await w.offboard.run({ canvasName: CANVAS, seatIds: ["d", "c", "b", "a", "a"], action: "now" }, "operator");
    expect(result.results.map((row) => row.seatId)).toEqual(["d", "c", "b", "a"]);
    expect(result).toMatchObject({ closed: 2, refused: 2 });
    expect(result.results[1]).toMatchObject({
      ok: false,
      code: "failed",
      reason: "could not give the seat a fresh session on its canvas",
    });
    // A failed close records nothing and is not retried.
    expect(w.ended.map((entry) => entry.seatId).sort()).toEqual(["a", "d"]);
    expect(w.closed.map((entry) => entry.seatId).sort()).toEqual(["a", "d"]);
  });
});

describe("ask to offboard", () => {
  it("sends the prompt to each seat, default continue, whatever the seat is doing", async () => {
    const w = world([seat("a"), seat("b", { state: "working" }), seat("c", { running: false, state: undefined })]);
    const result = await w.offboard.run({ canvasName: CANVAS, seatIds: ["a", "b", "c"], action: "ask" }, "operator");
    expect(result).toMatchObject({ asked: 3, closed: 0, refused: 0 });
    expect(w.asked).toEqual([
      { seatId: "a", mode: "continue" },
      { seatId: "b", mode: "continue" },
      { seatId: "c", mode: "continue" },
    ]);
    expect(w.closed).toEqual([]);
    await w.offboard.run({ canvasName: CANVAS, seatIds: ["a"], action: "ask", mode: "rest" }, "operator");
    expect(w.asked.at(-1)).toEqual({ seatId: "a", mode: "rest" });
  });

  it("an ask that could not be delivered is a refused row, not a retry", async () => {
    const w = world([seat("a"), seat("remote", { local: false })]);
    w.fail.ask.add("a");
    const result = await w.offboard.run({ canvasName: CANVAS, seatIds: ["a", "remote", "ghost"], action: "ask" }, "operator");
    expect(result.results.map((row) => (row.ok ? "ok" : row.code))).toEqual(["undelivered", "not-local", "not-a-seat"]);
    expect(result.results[0]).toMatchObject({ reason: "Junto could not send the offboard prompt." });
    expect(w.asked).toEqual([]);
  });
});

describe("before the click", () => {
  it("says whether offboard now is allowed, how long the seat has sat still, and which action is preferred", async () => {
    const w = world([seat("a"), seat("b", { state: "working" }), seat("off", { running: false, state: undefined })]);
    w.settle("a");
    w.settle("off");
    w.advance(45);
    let status = await w.offboard.status(CANVAS, ["a", "b", "off", "ghost"]);
    expect(status[0]).toEqual({
      seatId: "a",
      now: { allowed: true },
      stillSince: T0,
      idleMinutes: 45,
      pastWindow: false,
      preferred: "ask",
      workMinutes: 60,
      worthCutting: true,
    });
    expect(status[1]).toEqual({
      seatId: "b",
      now: { allowed: false, code: "working", reason: OFFBOARD_REFUSAL_REASON.working },
      idleMinutes: null,
      pastWindow: false,
      preferred: "ask",
      workMinutes: 60,
      worthCutting: true,
    });
    expect(status[2]).toMatchObject({ now: { allowed: true }, idleMinutes: 45 });
    expect(status[3]).toMatchObject({ now: { allowed: false, code: "not-a-seat" }, idleMinutes: null });
    // Past the cache window (60 min) a turn is expensive: offboard now is preferred.
    w.advance(15);
    status = await w.offboard.status(CANVAS, ["a"]);
    expect(status[0]).toMatchObject({ idleMinutes: 60, pastWindow: true, preferred: "now" });
  });

  it("uses the harness's own cache window", async () => {
    const rules = applyOffboardRulesPatch(defaultOffboardRules(), {
      harness: { codex: { cacheWindowMinutes: 10 } },
    });
    const w = world([seat("c", { harness: "codex" }), seat("a")], { rules });
    w.settle("c");
    w.settle("a");
    w.advance(12);
    const status = await w.offboard.status(CANVAS, ["c", "a"]);
    expect(status.map((row) => [row.pastWindow, row.preferred])).toEqual([[true, "now"], [false, "ask"]]);
  });
});

describe("a seat on another machine", () => {
  it("shows the idle time, work and size its own machine reports, never this machine's count", async () => {
    const w = world([seat("far", { local: false, machine: "mini" }), seat("unheard", { local: false, machine: "mini" })]);
    // The mini said, five minutes ago here, that the seat came to rest 70 minutes ago, under a 2 minute window.
    w.told.set("far", { stillSince: T0 - 70 * MIN, windowMinutes: 2, workMs: 25 * MIN, tokens: 250_791, worth: true });
    w.advance(5);
    const [far, unheard] = await w.offboard.status(CANVAS, ["far", "unheard"]);
    expect(far).toEqual({
      seatId: "far",
      now: { allowed: false, code: "not-local", reason: OFFBOARD_REFUSAL_REASON["not-local"] },
      stillSince: T0 - 70 * MIN,
      idleMinutes: 75,
      pastWindow: true,
      // This machine refuses to close it, so the row never recommends that.
      preferred: "ask",
      workMinutes: 25,
      sessionTokens: 250_791,
      worthCutting: true,
    });
    // A machine that has said nothing: nothing is known, nothing counted here.
    expect(unheard).toEqual({
      seatId: "unheard",
      now: { allowed: false, code: "not-local", reason: OFFBOARD_REFUSAL_REASON["not-local"] },
      idleMinutes: null,
      pastWindow: false,
      preferred: "ask",
    });
    w.told.set("far", { windowMinutes: 2, workMs: 0, worth: false });
    expect((await w.offboard.status(CANVAS, ["far"]))[0]).toMatchObject({ idleMinutes: null, pastWindow: false, workMinutes: 0, worthCutting: false });
  });

  it("what it reports never enters this clock or a cut here", async () => {
    const w = world([seat("far", { local: false, machine: "mini" })], { noWork: ["far"] });
    w.told.set("far", { stillSince: T0 - 600 * MIN, windowMinutes: 2, workMs: 600 * MIN, tokens: 900_000, worth: true });
    await w.offboard.status(CANVAS, ["far"]);
    expect(await w.offboard.tick()).toMatchObject({ closed: 0 });
    expect(await w.offboard.coldAtStart({ canvasName: CANVAS, seatId: "far" }, "mail")).toBe(false);
    expect(w.closed).toEqual([]);
    expect(w.clock.workMs("bind-far")).toBe(0);
    expect(w.clock.stillSince("bind-far")).toBe(T0);
  });

  it("is told by this machine for a seat it runs: its clock, its window, its size", async () => {
    const w = world([seat("a"), seat("far", { local: false })]);
    w.sizes.set("a", 180_000);
    w.settle("a");
    w.advance(7);
    expect(await w.offboard.facts({ canvasName: CANVAS, seatId: "a" })).toEqual({
      stillSince: T0, windowMinutes: 60, cacheMode: "hybrid", workMs: 60 * MIN, tokens: 180_000, worth: true,
    });
    w.set("a", { state: "working" });
    expect(await w.offboard.facts({ canvasName: CANVAS, seatId: "a" })).toEqual({
      windowMinutes: 60, cacheMode: "hybrid", workMs: 60 * MIN, tokens: 180_000, worth: true,
    });
    expect(await w.offboard.facts({ canvasName: CANVAS, seatId: "far" })).toBeUndefined();
    expect(await w.offboard.facts({ canvasName: CANVAS, seatId: "ghost" })).toBeUndefined();
  });
});

const resting = (seatId: string, over: Partial<OffboardSeat> = {}): OffboardSeat =>
  seat(seatId, { running: false, state: undefined, ...over });

describe("the start decision: mail to a resting seat whose session has gone cold starts it fresh (60 minutes, hybrid, by default)", () => {
  it("the minute pass never ends a resting seat's session, and never asks for a turn, however long it has sat still", async () => {
    const w = world([resting("rest"), resting("other")]);
    for (let hour = 0; hour < 48; hour += 1) {
      w.advance(60);
      expect(await w.offboard.tick()).toMatchObject({ closed: 0, asked: 0 });
    }
    expect(w.closed).toEqual([]);
    expect(w.asked).toEqual([]);
  });

  it("a start of a seat still for its cache window starts it fresh; a minute short of it, it resumes", async () => {
    const w = world([resting("a")]);
    w.settle("a");
    w.advance(59);
    expect(await w.start("a")).toBe(false);
    expect(w.seats.get("a")).toMatchObject({ sessionId: "session-a" });
    w.advance(1);
    expect(await w.start("a")).toBe(true);
    expect(w.seats.get("a")).toMatchObject({ sessionId: "fresh-a" });
    // The start takes the fresh path itself: nothing is closed, and nothing is typed to anyone.
    expect(w.closed).toEqual([]);
    expect(w.asked).toEqual([]);
    // Onboard is told Junto ended the session it follows.
    expect(w.ended).toEqual([{ seatId: "a", sessionId: "session-a", by: "automatic", at: T0 + 60 * MIN }]);
  });

  it("is one seat at a time: starting one seat touches no other", async () => {
    const w = world([resting("a"), resting("b"), resting("c")]);
    w.advance(600);
    expect(await w.start("b")).toBe(true);
    expect(w.seats.get("a")).toMatchObject({ sessionId: "session-a" });
    expect(w.seats.get("b")).toMatchObject({ sessionId: "fresh-b" });
    expect(w.seats.get("c")).toMatchObject({ sessionId: "session-c" });
  });

  it("the next start resumes the fresh session, however long it rests", async () => {
    const w = world([resting("a")]);
    w.advance(200);
    expect(await w.start("a")).toBe(true);
    expect(await w.start("a")).toBe(false);
    w.advance(600);
    expect(await w.start("a")).toBe(false);
  });

  it("a running seat is not starting: it keeps its session whatever its state", async () => {
    const w = world([seat("idle"), seat("working", { state: "working" }), seat("dialog", { state: "attention" })]);
    w.advance(600);
    for (const id of ["idle", "working", "dialog"]) expect(await w.start(id)).toBe(false);
  });

  it("resumes a seat already offboarding, on another installation, without a session, or unknown", async () => {
    const w = world([
      resting("busy"),
      resting("remote", { local: false }),
      resting("nosession", { sessionId: undefined }),
    ]);
    w.closing.add("busy");
    w.advance(600);
    for (const id of ["busy", "remote", "nosession", "ghost"]) expect(await w.start(id)).toBe(false);
  });

  it("the operator's hold does not keep a cold session at the start: the start is what it holds off", async () => {
    const w = world([resting("rest"), seat("idle")]);
    w.held.set("rest", {});
    w.held.set("idle", {});
    w.advance(120);
    expect(await w.start("rest")).toBe(true);
    // A held running seat is not starting: its card continues, and the pass leaves it.
    expect(await w.offboard.nextTurn({ canvasName: CANVAS, seatId: "idle" }, "resume")).toEqual({ fresh: false });
    expect(await w.offboard.tick()).toMatchObject({ closed: 0 });
  });

  it("a paused canvas changes nothing: a start there is judged the same", async () => {
    const w = world([resting("paused", { paused: true })]);
    w.advance(600);
    expect(await w.start("paused")).toBe(true);
  });

  it("does not start fresh under the operator's own ask: that prompt is mail for this session", async () => {
    const w = world([resting("a")]);
    w.advance(300);
    const asked = await w.offboard.run({ canvasName: CANVAS, seatIds: ["a"], action: "ask" }, "operator");
    expect(asked).toMatchObject({ asked: 1 });
    expect(await w.start("a")).toBe(false);
    // Much later, a start of the still-cold seat starts fresh.
    w.advance(11);
    expect(await w.start("a")).toBe(true);
  });

  it("follows the harness's own cache window", async () => {
    const rules = applyOffboardRulesPatch(defaultOffboardRules(), {
      harness: { codex: { cacheWindowMinutes: 10 } },
    });
    const w = world([resting("c", { harness: "codex" }), resting("a")], { rules });
    w.advance(10);
    expect(await w.start("c")).toBe(true);
    expect(await w.start("a")).toBe(false);
  });

  it("a decision that fails resumes", async () => {
    const broken = makeOperatorOffboard(
      {
        locate: async () => {
          throw new Error("canvas unreadable");
        },
        seats: async () => [],
        isClosing: () => false,
        closeNow: async () => ({ ok: true }),
        ask: async () => ({ ok: true }),
        markEnded: () => undefined,
        rules: () => defaultOffboardRules(),
      },
      new SeatStatusClock(() => T0),
    );
    expect(await broken.coldAtStart({ canvasName: CANVAS, seatId: "a" }, "mail")).toBe(false);
  });
});

describe("the eager cut: a running seat at rest is cut at the first pass past its cache window", () => {
  const tickAt = async (w: ReturnType<typeof world>) => w.offboard.tick();

  it("cuts an idle seat once its session goes cold, not a minute before, and records the automatic end", async () => {
    const w = world([seat("a")]);
    w.settle("a");
    w.advance(59);
    expect(await tickAt(w)).toMatchObject({ closed: 0 });
    w.advance(1);
    expect(await tickAt(w)).toMatchObject({ closed: 1 });
    expect(w.closed).toEqual([{ seatId: "a", by: "automatic" }]);
    expect(w.ended[0]).toMatchObject({ by: "automatic", sessionId: "session-a" });
    expect(w.asked).toEqual([]);
    // Fresh now: later passes leave it alone.
    w.advance(120);
    expect(await tickAt(w)).toMatchObject({ closed: 0 });
  });

  it("cuts every due seat in one pass, each on its own: one that fails costs no other", async () => {
    const w = world([seat("a"), seat("b"), seat("c")]);
    w.fail.close.add("b");
    w.advance(60);
    const result = await tickAt(w);
    expect(w.closed.map((entry) => entry.seatId).sort()).toEqual(["a", "c"]);
    expect(result).toMatchObject({ closed: 2 });
  });

  it("leaves a seat held by the operator, and cuts it at the first pass after they let go", async () => {
    const w = world([seat("a")]);
    w.held.set("a", {});
    w.advance(180);
    expect(await tickAt(w)).toMatchObject({ closed: 0 });
    w.held.delete("a");
    expect(await tickAt(w)).toMatchObject({ closed: 1 });
  });

  it("exempts a seat that waits on the operator, a paused canvas, a turn, another machine, a close under way, a tiny session and a fresh one", async () => {
    const w = world(
      [
        seat("waits", { waitsOnOperator: true }),
        seat("paused", { paused: true }),
        seat("working", { state: "working" }),
        seat("attention", { state: "attention" }),
        seat("unread", { state: "unknown" }),
        seat("remote", { local: false }),
        seat("closing"),
        seat("tiny"),
        resting("rest"),
      ],
      { noWork: ["tiny"] },
    );
    w.closing.add("closing");
    w.advance(600);
    expect(await tickAt(w)).toMatchObject({ closed: 0 });
    expect(w.closed).toEqual([]);
  });

  it("a seat that waits on the operator is never cold, and its card says nothing", async () => {
    const w = world([seat("waits", { waitsOnOperator: true })]);
    w.advance(600);
    expect(await w.offboard.nextTurn({ canvasName: CANVAS, seatId: "waits" }, "resume")).toEqual({ fresh: false });
    expect(await w.offboard.tick()).toMatchObject({ closed: 0 });
  });

  it("past the window, a key at t holds the seat until t plus the grace, the card is told so, and it is cold after", async () => {
    const w = world([seat("a")], { holds: (now) => makeOperatorHolds(now) });
    w.advance(90);
    const typedAt = w.now();
    w.holds!.typed(1, "bind-a");
    w.advance(0.25);
    expect(await w.offboard.nextTurn({ canvasName: CANVAS, seatId: "a" }, "resume"))
      .toEqual({ fresh: false, freshAt: typedAt + OPERATOR_TYPING_GRACE_MS });
    expect(await w.offboard.tick()).toMatchObject({ closed: 0 });
    w.advance(OPERATOR_TYPING_GRACE_MS / MIN);
    expect(await w.offboard.nextTurn({ canvasName: CANVAS, seatId: "a" }, "resume")).toEqual({ fresh: true });
    expect(await w.offboard.tick()).toMatchObject({ closed: 1 });
  });

  it("before the window, a key's hold never brings the cold time forward", async () => {
    const w = world([seat("a")], { holds: (now) => makeOperatorHolds(now) });
    w.settle("a");
    w.advance(10);
    w.holds!.typed(1, "bind-a");
    expect(await w.offboard.nextTurn({ canvasName: CANVAS, seatId: "a" }, "resume"))
      .toEqual({ fresh: false, freshAt: T0 + 60 * MIN });
  });

  it("does not cut under the operator's own ask", async () => {
    const w = world([seat("a")]);
    w.advance(90);
    await w.offboard.run({ canvasName: CANVAS, seatIds: ["a"], action: "ask" }, "operator");
    expect(await tickAt(w)).toMatchObject({ closed: 0 });
  });

});

describe("waits on the operator", () => {
  const at = (over: Partial<SeatSnapshot>): SeatSnapshot => ({
    ...initialSnapshot("seat-a" as BindingId, T0),
    status: { _tag: "Idle" },
    ...over,
  });

  it("a blocked seat, an open signal or an escalation waits; a plain or done seat does not", () => {
    expect(waitsOnOperator(undefined)).toBe(false);
    expect(waitsOnOperator(at({}))).toBe(false);
    expect(waitsOnOperator(at({ turnUnseen: { outcome: "completed", since: T0 } }))).toBe(false);
    expect(waitsOnOperator(at({ turnUnseen: { outcome: "failed", since: T0 } }))).toBe(false);
    expect(waitsOnOperator(at({ status: { _tag: "Blocked", reason: { _tag: "Permission" } } as SeatStatus }))).toBe(true);
    for (const kind of ["blocked", "escalate", "feedback"] as const)
      expect(waitsOnOperator(at({ reports: [{ kind, signalId: "s1", since: T0 }] }))).toBe(true);
  });
});

describe("the seat's next turn: the same test as the cut", () => {
  const next = (w: ReturnType<typeof world>, seatId: string, launch: "resume" | "offboarded" | "fresh" = "resume") =>
    w.offboard.nextTurn({ canvasName: CANVAS, seatId }, launch);

  it("an idle seat continues until its session goes cold, says when that is, then starts fresh as mail would", async () => {
    const w = world([seat("a")]);
    w.settle("a");
    expect(await next(w, "a")).toEqual({ fresh: false, freshAt: T0 + 60 * MIN });
    w.advance(59);
    expect(await next(w, "a")).toEqual({ fresh: false, freshAt: T0 + 60 * MIN });
    w.advance(1);
    expect(await next(w, "a")).toEqual({ fresh: true });
    // Asking never cuts; the pass agrees with the card.
    expect(w.closed).toEqual([]);
    expect(await w.offboard.tick()).toMatchObject({ closed: 1 });
  });

  it("a seat in a turn, or one waiting on the operator, continues with no time to watch", async () => {
    const w = world([seat("w", { state: "working" }), seat("d", { state: "attention" })]);
    w.advance(600);
    expect(await next(w, "w")).toEqual({ fresh: false });
    expect(await next(w, "d")).toEqual({ fresh: false });
  });

  it("a resting seat starts fresh when it has no session to resume, and as the operator's open would when it has", async () => {
    const w = world([resting("a")]);
    expect(await next(w, "a", "offboarded")).toEqual({ fresh: true });
    expect(await next(w, "a", "fresh")).toEqual({ fresh: true });
    expect(await next(w, "a", "resume")).toMatchObject({ fresh: false });
    w.advance(600);
    // Hybrid: the operator's open continues it, with the warning.
    expect(await next(w, "a", "resume")).toEqual({ fresh: false });
    w.setRules(applyOffboardRulesPatch(defaultOffboardRules(), { cacheMode: "auto" }));
    expect(await next(w, "a", "resume")).toEqual({ fresh: true });
  });

  it("a tiny session never goes cold; a seat on another machine is answered by its own", async () => {
    const w = world([seat("tiny"), seat("far", { local: false })], { noWork: ["tiny"] });
    w.work("tiny", 3);
    w.advance(600);
    expect(await next(w, "tiny")).toEqual({ fresh: false });
    expect(await next(w, "far")).toBeUndefined();
  });
});

describe("the seat against its cache window, as its card reads it", () => {
  it("tells a still seat that picks up where it was how far past its harness's window it is, by this machine's clock and rules", async () => {
    const { setOperatorOffboard } = await import("../src/main/junto/seat-sessions/operator-offboard");
    const { SeatSessionRepository } = await import("../src/main/junto/seat-sessions/repository");
    const { seatLaunchState } = await import("../src/main/junto/term/seat-launch-state");
    const w = world([seat("a", { harness: "amp" })], {
      rules: { ...defaultOffboardRules(), cacheMode: "hybrid", harness: { amp: { cacheWindowMinutes: 5 } } },
    });
    // Amp keeps its thread by id, so an open one resumes with nothing on disk.
    let open: { harness: string; sessionId: string } | undefined = { harness: "amp", sessionId: "T-a" };
    const sessions = {
      current: () => Effect.succeed(open),
      list: () => Effect.succeed([]),
    } as unknown as SeatSessions["Service"];
    const node = { kind: "agent", id: "a", bindingId: "bind-a", harness: "amp" } as unknown as NodeOf<"agent">;
    let elapsed = 0;
    const readAfter = (minutes: number) => {
      w.advance(minutes);
      elapsed += minutes;
      vi.setSystemTime(T0 + elapsed * MIN);
      return Effect.runPromise(seatLaunchState(CANVAS, node).pipe(Effect.provideService(SeatSessionRepository, sessions)));
    };
    setOperatorOffboard(w.offboard);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // At rest since T0, under amp's own five minute window and this machine's mode,
      // with the offboard status's estimate of what it re-reads.
      w.sizes.set("a", 251_000);
      const told = { windowMinutes: 5, stillSince: T0, windowEndsAt: T0 + 5 * MIN, cacheMode: "hybrid", tokens: 251_000 };
      expect(await readAfter(3)).toMatchObject({ settingsFixed: true, cacheWindow: { ...told, pastWindow: false, pastByMs: 0 } });
      // Past it, held in front of the operator: its next turn picks up where it was, told how far past.
      w.held.set("a", {});
      expect((await readAfter(9)).cacheWindow).toEqual({ ...told, pastWindow: true, pastByMs: 7 * MIN });
      // Let go, its next turn starts fresh: the fresh next line says so, not the warning.
      w.held.delete("a");
      const fresh = await readAfter(0);
      expect(fresh.nextTurn).toEqual({ fresh: true });
      expect(fresh).not.toHaveProperty("cacheWindow");
      // In a turn it is not still: nothing told.
      w.held.set("a", {});
      w.seats.set("a", { ...w.seats.get("a")!, state: "working" });
      expect(await readAfter(1)).not.toHaveProperty("cacheWindow");
      // Resting with nothing to pick up: its settings are free, and nothing is told however long it rests.
      w.seats.set("a", { ...w.seats.get("a")!, running: false, state: undefined });
      open = undefined;
      const rested = await readAfter(60);
      expect(rested).toMatchObject({ settingsFixed: false, nextTurn: { fresh: true } });
      expect(rested).not.toHaveProperty("cacheWindow");
    } finally {
      vi.useRealTimers();
      setOperatorOffboard(undefined);
    }
  });
});

describe("worth cutting: the automatic rules never recycle an empty or tiny session", () => {
  const wake = (w: ReturnType<typeof world>, seatId: string) => w.start(seatId);
  /** The seat's process ends and it rests, as after an idle seat is stopped. */
  const rest = (w: ReturnType<typeof world>, seatId: string) => w.set(seatId, { running: false, state: undefined });

  it("case 1: one small task, then hours of stillness: not cut at its wake, not asked", async () => {
    const w = world([seat("a")], { noWork: ["a"] });
    w.work("a", 5);
    w.advance(45);
    expect(await w.offboard.tick()).toMatchObject({ asked: 0, closed: 0 });
    rest(w, "a");
    w.advance(600);
    expect(await wake(w, "a")).toBe(false);
    expect(w.closed).toEqual([]);
    expect(w.asked).toEqual([]);
    expect((await w.offboard.status(CANVAS, ["a"]))[0]).toMatchObject({ workMinutes: 5, worthCutting: false, pastWindow: true });
  });

  it("case 2: cut, a small task in the fresh session, then stillness: not cut again", async () => {
    const w = world([resting("a")]);
    w.advance(120);
    expect(await wake(w, "a")).toBe(true);
    // The fresh session wakes, does one small task, and rests again.
    w.set("a", { running: true, state: "idle", sessionId: "fresh-a" });
    w.work("a", 4);
    rest(w, "a");
    for (let hour = 0; hour < 12; hour += 1) {
      w.advance(60);
      expect(await wake(w, "a")).toBe(false);
    }
    expect(w.seats.get("a")).toMatchObject({ sessionId: "fresh-a" });
    // The work before the fresh start does not count for the session after it.
    expect((await w.offboard.status(CANVAS, ["a"]))[0]).toMatchObject({ workMinutes: 4, worthCutting: false });
  });

  it("case 3: a new session that never really starts is never cut", async () => {
    const w = world([resting("never-ran"), seat("banner-only")], { noWork: ["never-ran", "banner-only"] });
    // It printed a banner and sat at its prompt: an Idle with no turn behind it.
    w.clock.noteStatus("bind-banner-only", status("Idle", w.now()));
    rest(w, "banner-only");
    // A large transcript does not rescue a session that has done no work.
    w.sizes.set("never-ran", 900_000);
    w.sizes.set("banner-only", 900_000);
    for (let hour = 0; hour < 24; hour += 1) {
      w.advance(60);
      expect(await wake(w, "never-ran")).toBe(false);
      expect(await wake(w, "banner-only")).toBe(false);
      expect(await w.offboard.tick()).toMatchObject({ closed: 0, asked: 0 });
    }
    expect(w.closed).toEqual([]);
  });

  it("thirty minutes of work is enough, summed across turns", async () => {
    const w = world([seat("a")], { noWork: ["a"] });
    w.work("a", 10);
    w.advance(20);
    w.work("a", 10);
    w.advance(20);
    w.work("a", 9);
    rest(w, "a");
    w.advance(120);
    expect(await wake(w, "a")).toBe(false); // 29 minutes
    w.set("a", { running: true, state: "idle" });
    w.work("a", 1);
    rest(w, "a");
    w.advance(120);
    expect(await wake(w, "a")).toBe(true); // 30
  });

  it("or a transcript of about 200,000 tokens, with only a little work", async () => {
    const w = world([seat("big"), seat("small"), seat("lost")], { noWork: ["big", "small", "lost"] });
    for (const id of ["big", "small", "lost"]) {
      w.work(id, 2);
      rest(w, id);
    }
    w.sizes.set("big", 200_000);
    w.sizes.set("small", 199_999);
    // "lost": its transcript cannot be located, so size does not count.
    w.advance(120);
    expect(await wake(w, "big")).toBe(true);
    expect(await wake(w, "small")).toBe(false);
    expect(await wake(w, "lost")).toBe(false);
    const status = await w.offboard.status(CANVAS, ["small", "lost"]);
    expect(status[0]).toMatchObject({ sessionTokens: 199_999, worthCutting: false });
    expect(status[1]).toMatchObject({ worthCutting: false });
    expect("sessionTokens" in status[1]!).toBe(false);
  });

  it("work is counted per session: a seat that got a new session by any route starts from zero", async () => {
    const w = world([resting("a")]);
    expect((await w.offboard.status(CANVAS, ["a"]))[0]).toMatchObject({ workMinutes: 60 });
    // Its own agent offboarded: the canvas names a new session.
    w.set("a", { sessionId: "session-a-2" });
    expect((await w.offboard.status(CANVAS, ["a"]))[0]).toMatchObject({ workMinutes: 0, worthCutting: false });
    w.advance(600);
    expect(await wake(w, "a")).toBe(false);
  });

  it("a session id that appears late names the same session: its work is kept", async () => {
    const w = world([seat("a", { sessionId: undefined })], { noWork: ["a"] });
    w.work("a", 40);
    w.set("a", { sessionId: "announced-later" });
    expect((await w.offboard.status(CANVAS, ["a"]))[0]).toMatchObject({ workMinutes: 40, worthCutting: true });
  });

  it("the buttons are not gated: the operator may cut a tiny session", async () => {
    const w = world([seat("a")], { noWork: ["a"] });
    const result = await w.offboard.run({ canvasName: CANVAS, seatIds: ["a"], action: "now" }, "operator");
    expect(result).toMatchObject({ closed: 1 });
    const asked = await w.offboard.run({ canvasName: CANVAS, seatIds: ["a"], action: "ask" }, "operator");
    expect(asked).toMatchObject({ asked: 1 });
  });
});

describe("the status clock", () => {
  const clockAt = (start = T0, restored?: SeatClockRecord) => {
    let at = start;
    const clock = new SeatStatusClock(() => at, restored);
    return { clock, at: (next: number) => { at = next; } };
  };

  it("comes to rest when the seat goes idle after a turn; tools, phases and blocks inside it do not move it", () => {
    const { clock, at } = clockAt();
    at(T0 + MIN);
    clock.noteStatus("s", status("Working", T0 + MIN, T0 + MIN));
    at(T0 + 2 * MIN);
    clock.noteStatus("s", { status: { _tag: "Working", phase: "tool" }, since: T0 + 2 * MIN, activitySince: T0 + MIN });
    clock.noteStatus("s", { status: { _tag: "Blocked", reason: { _tag: "Permission" } }, since: T0 + 2 * MIN, activitySince: T0 + MIN });
    // Active since it last rested: still now, whatever the screen says.
    expect(clock.stillSince("s")).toBe(T0 + 2 * MIN);
    at(T0 + 5 * MIN);
    clock.noteStatus("s", status("Idle", T0 + 5 * MIN, T0 + MIN));
    at(T0 + 50 * MIN);
    // A done seat's detail changes keep the Idle's time.
    clock.noteStatus("s", status("Idle", T0 + 5 * MIN, T0 + MIN));
    expect(clock.stillSince("s")).toBe(T0 + 5 * MIN);
  });

  it("a start's or a resume's idle does not warm the session; an exit from work is when it came to rest", () => {
    const { clock, at } = clockAt();
    at(T0 + 10 * MIN);
    clock.noteStatus("s", status("Working", T0 + 10 * MIN, T0 + 10 * MIN));
    clock.noteStatus("s", status("Idle", T0 + 20 * MIN, T0 + 10 * MIN));
    // Its exit from rest changes nothing; a new process idles with no turn behind it.
    at(T0 + 30 * MIN);
    clock.noteStatus("s", status("Exited", T0 + 30 * MIN, T0 + 10 * MIN));
    clock.noteStatus("s", status("Starting", T0 + 40 * MIN));
    clock.noteStatus("s", status("Idle", T0 + 41 * MIN));
    expect(clock.stillSince("s")).toBe(T0 + 20 * MIN);
    // A turn, then the process exits mid-work: it came to rest at the exit.
    at(T0 + 60 * MIN);
    clock.noteStatus("s", status("Working", T0 + 60 * MIN, T0 + 60 * MIN));
    at(T0 + 70 * MIN);
    clock.noteStatus("s", status("Exited", T0 + 70 * MIN, T0 + 60 * MIN));
    expect(clock.stillSince("s")).toBe(T0 + 70 * MIN);
  });

  it("a cut session stays fresh through a start's idle, until the seat next leaves rest", () => {
    const { clock, at } = clockAt();
    clock.noteStatus("s", status("Working", T0, T0));
    clock.noteStatus("s", status("Idle", T0, T0));
    clock.markOffboarded("s");
    at(T0 + 5 * MIN);
    clock.noteStatus("s", status("Idle", T0 + 5 * MIN));
    expect(clock.isFresh("s")).toBe(true);
    at(T0 + 6 * MIN);
    clock.noteStatus("s", status("Working", T0 + 6 * MIN, T0 + 6 * MIN));
    expect(clock.isFresh("s")).toBe(false);
  });

  it("a seat working when Junto closed came to rest by the last save", () => {
    const { clock } = clockAt(T0 + 600 * MIN, {
      savedAt: T0 + 30 * MIN,
      seats: { s: { idleSince: T0, activitySince: T0 + 10 * MIN } },
    });
    expect(clock.stillSince("s")).toBe(T0 + 30 * MIN);
    expect(clock.record().seats.s).toEqual({ idleSince: T0 + 30 * MIN, activitySince: T0 + 10 * MIN });
  });
});

describe("the clock across a restart", () => {
  const wake = (w: ReturnType<typeof world>, seatId: string) => w.start(seatId);

  it("is saved on every pass and carries on where it was", async () => {
    const first = world([resting("a")]);
    first.settle("a");
    first.advance(30);
    await first.offboard.tick();
    const saved = first.saved.at(-1)!;
    expect(saved).toEqual({
      savedAt: T0 + 30 * MIN,
      seats: { "bind-a": { idleSince: T0, activitySince: T0, workMs: 60 * MIN, sessionId: "session-a" } },
    });

    // Restart one minute later: the seat is at 31 minutes, not at zero.
    const second = world([resting("a")], { restored: parseSeatClockRecord(JSON.stringify(saved)), at: T0 + 31 * MIN });
    expect(await wake(second, "a")).toBe(false);
    second.advance(28);
    expect(await wake(second, "a")).toBe(false);
    second.advance(1);
    expect(await wake(second, "a")).toBe(true);
  });

  it("catches up: closed for eight hours means still for eight hours plus what it already had", async () => {
    const first = world([resting("a")]);
    first.settle("a");
    first.advance(30);
    await first.offboard.tick();
    const second = world([resting("a")], { restored: first.saved.at(-1)!, at: T0 + 30 * MIN + 480 * MIN });
    const [status] = await second.offboard.status(CANVAS, ["a"]);
    expect(status).toMatchObject({ stillSince: T0, idleMinutes: 510, pastWindow: true, preferred: "now" });
    // So the first thing that wakes it finds a session to cut.
    expect(await wake(second, "a")).toBe(true);
  });

  it("opening the app after a night ends no session: not at start, not later, until a seat is started", async () => {
    const first = world([resting("a"), resting("b"), resting("c")]);
    first.advance(60);
    await first.offboard.tick();
    const second = world([resting("a"), resting("b"), resting("c")], {
      restored: first.saved.at(-1)!,
      at: first.now() + 600 * MIN,
    });
    for (let minute = 0; minute < 180; minute += 1) {
      expect(await second.offboard.tick()).toMatchObject({ closed: 0, asked: 0 });
      second.advance(1);
    }
    expect(second.closed).toEqual([]);
    // Mail arrives for one seat: that seat, and only that seat, starts fresh.
    expect(await wake(second, "b")).toBe(true);
    expect([...second.seats.values()].map((s) => s.sessionId)).toEqual(["session-a", "fresh-b", "session-c"]);
    expect(second.ended.map((e) => e.seatId)).toEqual(["b"]);
  });

  it("remembers that a seat was already given a fresh session", async () => {
    const first = world([resting("a")]);
    first.advance(200);
    expect(await wake(first, "a")).toBe(true);
    await first.offboard.tick();
    const saved = parseSeatClockRecord(JSON.stringify(first.saved.at(-1)!))!;
    expect(saved.seats["bind-a"]).toMatchObject({ offboarded: true });
    expect("workMs" in saved.seats["bind-a"]!).toBe(false);

    const second = world([resting("a", { sessionId: "fresh-a" })], { restored: saved, at: first.now() + MIN });
    second.advance(500);
    expect(await wake(second, "a")).toBe(false);
  });

  it("work time survives a restart with the clock, and a turn cut off by the quit is counted up to the save", async () => {
    const first = world([seat("a")], { noWork: ["a"] });
    first.work("a", 20);
    first.clock.noteState("bind-a", "working");
    first.advance(15);
    await first.offboard.tick(); // saved mid-turn
    const saved = parseSeatClockRecord(JSON.stringify(first.saved.at(-1)!))!;
    expect(saved.seats["bind-a"]).toMatchObject({ workMs: 35 * MIN, sessionId: "session-a" });
    const second = world([resting("a")], { restored: saved, at: first.now() + 10 * MIN });
    // Not working any more after the restart: the count stands, it does not run.
    second.advance(30);
    expect((await second.offboard.status(CANVAS, ["a"]))[0]).toMatchObject({ workMinutes: 35, worthCutting: true });
  });

  it("a seat the clock has never seen has been still since this run started, and has done no work", async () => {
    const w = world([resting("new")], { noWork: ["new"] });
    w.advance(119);
    expect((await w.offboard.status(CANVAS, ["new"]))[0]).toMatchObject({ idleMinutes: 119, workMinutes: 0, worthCutting: false });
    w.advance(600);
    expect(await wake(w, "new")).toBe(false);
  });

  it("an unreadable saved clock is no clock", async () => {
    expect(parseSeatClockRecord("not json")).toBeUndefined();
    expect(parseSeatClockRecord('{"seats":{}}')).toBeUndefined();
    expect(parseSeatClockRecord('{"savedAt":1,"seats":{"x":{"idleSince":"soon"},"y":{"idleSince":5,"activitySince":3}}}')).toEqual({
      savedAt: 1,
      seats: { y: { idleSince: 5, activitySince: 3 } },
    });
    // A clock saved before the status fed it: when the seat last moved reads as when it came to rest.
    expect(parseSeatClockRecord('{"savedAt":9,"seats":{"z":{"movedAt":7,"nudged":true}}}')).toEqual({
      savedAt: 9,
      seats: { z: { idleSince: 7 } },
    });
    // A clock from the future (a changed system time) is ignored for that seat.
    const clock = new SeatStatusClock(() => T0, { savedAt: T0 - MIN, seats: { later: { idleSince: T0 + 5 * MIN } } });
    expect(clock.stillSince("later")).toBe(T0);
  });
});

describe("the renderer's two calls", () => {
  it("check what arrives off IPC and never throw", async () => {
    const { handleSeatOffboardRun, handleSeatOffboardStatus } = await import(
      "../src/main/junto/seat-sessions/operator-offboard-ipc"
    );
    const { setOperatorOffboard } = await import("../src/main/junto/seat-sessions/operator-offboard");
    const w = world([seat("a"), seat("b", { state: "working" })]);
    setOperatorOffboard(w.offboard);
    try {
      const ran = await handleSeatOffboardRun({ canvasName: CANVAS, seatIds: ["a", "b"], action: "now" });
      expect(ran).toMatchObject({ closed: 1, refused: 1 });
      expect(w.closed).toEqual([{ seatId: "a", by: "operator" }]);
      // The overseer handler calls the same function and says who it is.
      await handleSeatOffboardRun({ canvasName: CANVAS, seatIds: ["b"], action: "ask" }, "overseer");
      expect(w.asked).toEqual([{ seatId: "b", mode: "continue" }]);

      expect(await handleSeatOffboardRun(undefined)).toMatchObject({ results: [], refused: 0 });
      expect(await handleSeatOffboardRun({ canvasName: CANVAS, seatIds: [], action: "now" })).toMatchObject({ results: [] });
      expect(await handleSeatOffboardRun({ canvasName: CANVAS, seatIds: ["a"], action: "delete" })).toMatchObject({
        refused: 1,
        results: [{ seatId: "a", ok: false, code: "failed", reason: "Ask the seat to offboard, or offboard it now." }],
      });
      expect(await handleSeatOffboardRun({ canvasName: CANVAS, seatIds: ["a"], action: "ask", mode: "soon" })).toMatchObject({
        results: [{ ok: false, reason: "Offboard to rest or to continue." }],
      });
      expect(await handleSeatOffboardRun({ canvasName: "", seatIds: ["a"], action: "now" })).toMatchObject({
        results: [{ ok: false, code: "not-a-seat" }],
      });
      expect(await handleSeatOffboardRun({ canvasName: CANVAS, seatIds: Array.from({ length: 201 }, (_, i) => `s${String(i)}`), action: "now" })).toMatchObject({ results: [] });

      const status = await handleSeatOffboardStatus(CANVAS, ["b"]);
      expect(status).toEqual([
        expect.objectContaining({ seatId: "b", now: { allowed: false, code: "working", reason: OFFBOARD_REFUSAL_REASON.working } }),
      ]);
      expect(await handleSeatOffboardStatus(7, ["a"])).toEqual([]);
      expect(await handleSeatOffboardStatus(CANVAS, "a")).toEqual([]);
    } finally {
      setOperatorOffboard(undefined);
    }
  });

  it("before the app has wired the operation, every seat is refused in plain words", async () => {
    const { handleSeatOffboardRun, handleSeatOffboardStatus } = await import(
      "../src/main/junto/seat-sessions/operator-offboard-ipc"
    );
    expect(await handleSeatOffboardRun({ canvasName: CANVAS, seatIds: ["a"], action: "now" })).toMatchObject({
      refused: 1,
      results: [{ seatId: "a", ok: false, code: "failed", reason: "Junto is still starting. Try again in a moment." }],
    });
    expect(await handleSeatOffboardStatus(CANVAS, ["a"])).toMatchObject([{ now: { allowed: false, code: "failed" } }]);
  });
});

describe("the start decision, as every start asks it", () => {
  it("judges each start by why it starts, and resumes when nothing is installed or the decision fails", async () => {
    const { coldSessionStartsFresh, setOperatorOffboard } = await import(
      "../src/main/junto/seat-sessions/operator-offboard"
    );
    const cold = { canvasName: CANVAS, seatId: "cold" };
    const warm = { canvasName: CANVAS, seatId: "warm" };
    expect(await coldSessionStartsFresh(cold, "operator")).toBe(false);
    const w = world([resting("cold"), resting("warm")]);
    w.advance(600);
    w.settle("warm");
    setOperatorOffboard(w.offboard);
    try {
      // Hybrid, the default: mail and a restart start a cold seat fresh, the operator's open continues it.
      for (const cause of ["mail", "restart"] as const) {
        expect(await coldSessionStartsFresh(cold, cause)).toBe(true);
        expect(await coldSessionStartsFresh(warm, cause)).toBe(false);
      }
      expect(await coldSessionStartsFresh(cold, "operator")).toBe(false);
      setOperatorOffboard({ ...w.offboard, coldAtStart: () => Promise.reject(new Error("rules could not be read")) });
      expect(await coldSessionStartsFresh(cold, "mail")).toBe(false);
    } finally {
      setOperatorOffboard(undefined);
    }
  });
});

describe("the cache mode, case by case", () => {
  const inMode = (mode: CacheMode) => applyOffboardRulesPatch(defaultOffboardRules(), { cacheMode: mode });
  const address = (seatId: string) => ({ canvasName: CANVAS, seatId });
  /** The window's entry for a seat asked a question. */
  const asked = (seatId: string, question: string, windowEndsAt: number, tokens?: number): SeatCacheDue =>
    ({ canvasName: CANVAS, seatId, question, windowEndsAt, ...(tokens === undefined ? {} : { tokens }) });
  const questionOf = (w: ReturnType<typeof world>, seatId: string): string =>
    w.offboard.dueList().find((ask) => ask.seatId === seatId)?.question ?? "";

  it("off and manual never cut a running seat past its window, on screen or off, ask nothing, and say it continues", async () => {
    for (const mode of ["off", "manual"] as const) {
      const w = world([seat("away"), seat("shown")], { rules: inMode(mode) });
      w.held.set("shown", {});
      w.advance(600);
      expect(await w.offboard.tick(), mode).toMatchObject({ closed: 0 });
      expect(w.closed).toEqual([]);
      expect(w.offboard.dueList()).toEqual([]);
      expect(w.dues).toEqual([]);
      for (const id of ["away", "shown"])
        expect(await w.offboard.nextTurn(address(id), "resume"), `${mode} ${id}`).toEqual({ fresh: false });
    }
  });

  it("auto and hybrid cut a running seat past its window off screen", async () => {
    for (const mode of ["auto", "hybrid"] as const) {
      const w = world([seat("a")], { rules: inMode(mode) });
      w.advance(59);
      expect(await w.offboard.tick(), mode).toMatchObject({ closed: 0 });
      w.advance(1);
      expect(await w.offboard.tick(), mode).toMatchObject({ closed: 1 });
      expect(w.closed).toEqual([{ seatId: "a", by: "automatic" }]);
    }
  });

  it("hybrid leaves a seat on screen alone: no cut, and no question", async () => {
    const w = world([seat("a")], { rules: inMode("hybrid") });
    w.held.set("a", {});
    w.advance(600);
    expect(await w.offboard.tick()).toMatchObject({ closed: 0 });
    expect(w.offboard.dueList()).toEqual([]);
    expect(w.dues).toEqual([]);
  });

  it("auto asks about a seat on screen, once, with its size, never cuts it without an answer, and the first answer settles it", async () => {
    const w = world([seat("a"), seat("b")], { rules: inMode("auto") });
    w.sizes.set("a", 251_000);
    w.held.set("a", {});
    w.held.set("b", {});
    w.advance(59);
    await w.offboard.tick();
    expect(w.dues).toEqual([]);
    w.advance(1);
    for (let minute = 0; minute < 120; minute += 1) {
      expect(await w.offboard.tick()).toMatchObject({ closed: 0 });
      w.advance(1);
    }
    const both = [asked("a", qid(1), T0 + 60 * MIN, 251_000), asked("b", qid(2), T0 + 60 * MIN)];
    // Told when it changed, not every minute; and there for a window that asks.
    expect(w.offboard.dueList()).toEqual(both);
    expect(w.dues).toEqual([[
      { ...both[0], bindingId: "bind-a", generation: "gen-a" },
      { ...both[1], bindingId: "bind-b", generation: "gen-b" },
    ]]);
    expect(w.closed).toEqual([]);
    expect(await w.offboard.answerDue(address("a"), qid(1), "fresh")).toEqual({ settled: true, cut: true });
    expect(w.closed).toEqual([{ seatId: "a", by: "operator" }]);
    expect(w.ended).toMatchObject([{ seatId: "a", sessionId: "session-a", by: "operator" }]);
    expect(w.offboard.dueList()).toEqual([both[1]]);
    // Settled: a second answer, one naming another seat's question or another process, settles nothing.
    expect(await w.offboard.answerDue(address("a"), qid(1), "keep")).toEqual({ settled: false });
    expect(await w.offboard.answerDue(address("b"), qid(1), "fresh")).toEqual({ settled: false });
    expect(await w.offboard.answerDue(address("b"), qid(2), "fresh", "gen-other")).toEqual({ settled: false });
    expect(w.closed).toHaveLength(1);
    expect(w.offboard.dueList()).toEqual([both[1]]);
  });

  it("a question is one fall due: due again after a key, or on a new process, is a new question, and the old one settles nothing", async () => {
    const w = world([seat("a")], { rules: inMode("auto") });
    w.held.set("a", {});
    w.advance(60);
    await w.offboard.tick();
    const first = questionOf(w, "a");
    w.advance(5);
    await w.offboard.tick();
    expect(questionOf(w, "a")).toBe(first);
    // A key warms it: withdrawn.
    w.clock.noteTyped("bind-a");
    await w.offboard.tick();
    expect(w.offboard.dueList()).toEqual([]);
    expect(w.dues.at(-1)).toEqual([]);
    w.advance(60);
    await w.offboard.tick();
    const second = questionOf(w, "a");
    expect(second).not.toBe(first);
    expect(await w.offboard.answerDue(address("a"), first, "fresh")).toEqual({ settled: false });
    // The seat restarted on a new process: the question asked of the old one is gone.
    w.seats.set("a", { ...w.seats.get("a")!, generation: "gen-a2" });
    await w.offboard.tick();
    expect(questionOf(w, "a")).not.toBe(second);
    expect(await w.offboard.answerDue(address("a"), second, "fresh")).toEqual({ settled: false });
    expect(w.closed).toEqual([]);
  });

  it("Start fresh re-checks the rule: a window still showing the seat does not stop it; a typing grace, a turn or a pause does", async () => {
    const w = world([seat("shown"), seat("typed"), seat("busy"), seat("paused")], { rules: inMode("auto") });
    for (const id of ["shown", "typed", "busy", "paused"]) w.held.set(id, {});
    w.advance(60);
    await w.offboard.tick();
    const question = Object.fromEntries(["shown", "typed", "busy", "paused"].map((id) => [id, questionOf(w, id)]));
    // Another window shows it still: being shown is what was asked, so it cuts.
    expect(await w.offboard.answerDue(address("shown"), question.shown!, "fresh")).toEqual({ settled: true, cut: true });
    // Shown, and a Hold typed:true 10 s ago: inside the typing grace, nothing is cut.
    w.held.set("typed", { typedUntil: w.now() + 20_000 });
    expect(await w.offboard.answerDue(address("typed"), question.typed!, "fresh")).toEqual({ settled: true, cut: false });
    w.seats.set("busy", { ...w.seats.get("busy")!, state: "working" });
    expect(await w.offboard.answerDue(address("busy"), question.busy!, "fresh")).toEqual({ settled: true, cut: false });
    w.seats.set("paused", { ...w.seats.get("paused")!, paused: true });
    expect(await w.offboard.answerDue(address("paused"), question.paused!, "fresh")).toEqual({ settled: true, cut: false });
    expect(w.closed).toEqual([{ seatId: "shown", by: "operator" }]);
  });

  it("Keep is not asked again while the seat stays on screen; off screen it is cut, and back on screen asked again", async () => {
    const w = world([seat("a"), seat("b")], { rules: inMode("auto") });
    w.held.set("a", {});
    w.held.set("b", {});
    w.advance(60);
    await w.offboard.tick();
    expect(await w.offboard.answerDue(address("a"), qid(1), "keep")).toEqual({ settled: true, cut: false });
    expect(await w.offboard.answerDue(address("b"), qid(2), "keep")).toEqual({ settled: true, cut: false });
    expect(w.dues.at(-1)).toEqual([]);
    for (let minute = 0; minute < 30; minute += 1) {
      w.advance(1);
      expect(await w.offboard.tick()).toMatchObject({ closed: 0 });
    }
    expect(w.offboard.dueList()).toEqual([]);
    // "a" leaves the screen still cold: auto cuts it off screen.
    w.held.delete("a");
    expect(await w.offboard.tick()).toMatchObject({ closed: 1 });
    expect(w.closed).toEqual([{ seatId: "a", by: "automatic" }]);
    // "b" is typed into, then let go: warm, it is left alone off screen.
    w.clock.noteTyped("bind-b");
    const typedAt = w.now();
    w.held.delete("b");
    w.advance(1);
    expect(await w.offboard.tick()).toMatchObject({ closed: 0 });
    // Back on screen and past its window again: asked again, a new question.
    w.held.set("b", {});
    w.advance(60);
    await w.offboard.tick();
    expect(w.offboard.dueList()).toEqual([asked("b", qid(3), typedAt + 60 * MIN)]);
  });

  it("typing holds the cut in every mode, and a key warms the session, running or resting", async () => {
    for (const mode of CACHE_MODES) {
      const w = world([seat("a"), resting("r")], { rules: inMode(mode) });
      w.advance(600);
      // Typed into a moment ago: held for the grace, and not asked about.
      w.held.set("a", { until: w.now() + 20_000 });
      expect(await w.offboard.tick(), mode).toMatchObject({ closed: 0 });
      expect(w.offboard.dueList()).toEqual([]);
      // The keys warmed both: still from then, past the hold too.
      w.clock.noteTyped("bind-a");
      w.clock.noteTyped("bind-r");
      w.held.delete("a");
      w.advance(1);
      expect(await w.offboard.tick(), mode).toMatchObject({ closed: 0 });
      expect(await w.start("r"), mode).toBe(false);
      // A window after the keys, cold again where the mode acts on it.
      w.advance(59);
      const acts = mode === "auto" || mode === "hybrid";
      expect((await w.offboard.tick()).closed, mode).toBe(acts ? 1 : 0);
      expect(await w.start("r"), mode).toBe(acts);
    }
  });

  it("the start, by mode and by why the seat starts; the card says what the operator's open does", async () => {
    const fresh: Record<CacheMode, Record<SeatStartCause, boolean>> = {
      off: { operator: false, mail: false, restart: false },
      manual: { operator: false, mail: false, restart: false },
      auto: { operator: true, mail: true, restart: true },
      hybrid: { operator: false, mail: true, restart: true },
    };
    for (const mode of CACHE_MODES) {
      for (const cause of ["operator", "mail", "restart"] as const) {
        const w = world([resting("cold"), resting("warm")], { rules: inMode(mode) });
        w.advance(600);
        w.settle("warm");
        expect(await w.offboard.nextTurn(address("cold"), "resume"), mode).toEqual({ fresh: fresh[mode].operator });
        expect(await w.start("cold", cause), `${mode} ${cause}`).toBe(fresh[mode][cause]);
        expect(await w.start("warm", cause), `${mode} ${cause}`).toBe(false);
        expect(w.ended.length, `${mode} ${cause}`).toBe(fresh[mode][cause] ? 1 : 0);
      }
    }
  });

  it("the window's answer is decoded closed, names the open question, and never throws", async () => {
    const { handleSeatCacheDueAnswer, seatCacheDueForWindow } = await import("../src/main/junto/seat-sessions/operator-offboard-ipc");
    const { CACHE_QUESTION_GONE, setOperatorOffboard } = await import("../src/main/junto/seat-sessions/operator-offboard");
    const good = { canvasName: CANVAS, seatId: "a", question: qid(1), answer: "keep" };
    expect(await handleSeatCacheDueAnswer(good)).toEqual({ ok: false, message: "Junto is still starting. Try again in a moment." });
    const w = world([seat("a")], { rules: inMode("auto") });
    w.held.set("a", {});
    w.advance(60);
    await w.offboard.tick();
    setOperatorOffboard(w.offboard);
    try {
      expect(await seatCacheDueForWindow()).toEqual([asked("a", qid(1), T0 + 60 * MIN)]);
      // Closed: a field past these, a question not by the link's pattern, or another answer is refused before use.
      for (const bad of [undefined, { ...good, canvasName: "" }, { ...good, window: 1 }, { ...good, question: "short" },
        { ...good, answer: "later" }])
        expect(await handleSeatCacheDueAnswer(bad)).toEqual({ ok: false, message: "Start fresh, or keep this session." });
      // A well-formed id that is not the open question settles nothing.
      expect(await handleSeatCacheDueAnswer({ ...good, question: qid(9), answer: "fresh" }))
        .toEqual({ ok: false, message: CACHE_QUESTION_GONE });
      expect(w.closed).toEqual([]);
      expect(await handleSeatCacheDueAnswer({ ...good, answer: "fresh" })).toEqual({ ok: true });
      expect(w.closed).toEqual([{ seatId: "a", by: "operator" }]);
      expect(await seatCacheDueForWindow()).toEqual([]);
      expect(await handleSeatCacheDueAnswer({ ...good, answer: "fresh" })).toEqual({ ok: false, message: CACHE_QUESTION_GONE });
    } finally {
      setOperatorOffboard(undefined);
    }
  });
});
