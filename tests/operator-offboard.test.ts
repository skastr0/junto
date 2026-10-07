/**
 * Operator offboard over fakes: the one operation behind the buttons, the
 * overseer command and the automatic rules, and the durable motionless clock.
 * No app, no harness, no real seats: every port is scripted.
 */
import { describe, expect, it } from "vitest";
import {
  SeatMotionClock,
  makeOperatorOffboard,
  parseSeatMotionRecord,
  type OffboardSeat,
  type OperatorOffboardPorts,
  type SeatMotionRecord,
} from "../src/main/junto/seat-sessions/operator-offboard";
import {
  OFFBOARD_REFUSAL_REASON,
  applyOffboardRulesPatch,
  defaultOffboardRules,
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
  state: "idle",
  ...over,
});

const world = (initial: OffboardSeat[], options: { rules?: OffboardRules; restored?: SeatMotionRecord; at?: number } = {}) => {
  let at = options.at ?? T0;
  let rules = options.rules ?? defaultOffboardRules();
  const seats = new Map(initial.map((s) => [s.seatId, s]));
  const closing = new Set<string>();
  const closed: Array<{ seatId: string; by: OffboardBy }> = [];
  const asked: Array<{ seatId: string; mode: string }> = [];
  const ended: Array<{ seatId: string; sessionId: string; by: OffboardBy; at: number }> = [];
  const saved: SeatMotionRecord[] = [];
  const fail = { close: new Set<string>(), ask: new Set<string>() };
  const unused = new Set<string>();
  const clock = new SeatMotionClock(() => at, options.restored);
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
    sessionHasHistory: (s) => !unused.has(s.seatId),
    rules: () => rules,
    saveClock: (record) => saved.push(record),
    now: () => at,
  };
  const offboard = makeOperatorOffboard(ports, clock);
  return {
    offboard,
    clock,
    seats,
    closing,
    closed,
    asked,
    ended,
    saved,
    fail,
    unused,
    advance: (minutes: number) => {
      at += minutes * MIN;
    },
    setRules: (next: OffboardRules) => {
      rules = next;
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

  it("closes an offline or resting seat: there is no turn to cut", async () => {
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
      "Junto cannot tell that this seat is idle. Offboard now only closes a seat that is idle, offline or resting.",
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
    w.clock.note("bind-a");
    w.clock.note("bind-off");
    w.advance(45);
    let status = await w.offboard.status(CANVAS, ["a", "b", "off", "ghost"]);
    expect(status[0]).toEqual({
      seatId: "a",
      now: { allowed: true },
      motionlessSince: T0,
      idleMinutes: 45,
      pastWindow: false,
      preferred: "ask",
    });
    expect(status[1]).toEqual({
      seatId: "b",
      now: { allowed: false, code: "working", reason: OFFBOARD_REFUSAL_REASON.working },
      idleMinutes: null,
      pastWindow: false,
      preferred: "ask",
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
      harness: { codex: { cacheWindowMinutes: 10, nudge: { minutes: 5 }, auto: { minutes: 15 } } },
    });
    const w = world([seat("c", { harness: "codex" }), seat("a")], { rules });
    w.clock.note("bind-c");
    w.clock.note("bind-a");
    w.advance(12);
    const status = await w.offboard.status(CANVAS, ["c", "a"]);
    expect(status.map((row) => [row.pastWindow, row.preferred])).toEqual([[true, "now"], [false, "ask"]]);
  });
});

describe("auto offboard (on by default, 2 hours)", () => {
  it("closes a seat only after it has sat completely still for the interval", async () => {
    const w = world([seat("a")]);
    w.clock.note("bind-a");
    w.advance(119);
    expect((await w.offboard.tick()).closed).toBe(0);
    w.advance(1);
    const result = await w.offboard.tick();
    expect(result).toMatchObject({ closed: 1 });
    expect(w.closed).toEqual([{ seatId: "a", by: "automatic" }]);
    expect(w.ended[0]).toMatchObject({ by: "automatic", sessionId: "session-a" });
    expect(w.asked).toEqual([]);
  });

  it("any movement starts the interval again", async () => {
    const w = world([seat("a")]);
    w.clock.note("bind-a");
    w.advance(110);
    w.clock.note("bind-a"); // output, input, or mail
    w.advance(110);
    expect((await w.offboard.tick()).closed).toBe(0);
    w.advance(10);
    expect((await w.offboard.tick()).closed).toBe(1);
  });

  it("never touches a seat that is working, waiting on the operator, or already offboarding", async () => {
    const w = world([seat("w", { state: "working" }), seat("d", { state: "attention" }), seat("c")]);
    w.closing.add("c");
    w.advance(600);
    expect(await w.offboard.tick()).toMatchObject({ closed: 0, refused: 0 });
    expect(w.closed).toEqual([]);
  });

  it("includes offline and resting seats, and leaves an unused or already fresh session alone", async () => {
    const w = world([
      seat("resting", { running: false, state: undefined }),
      seat("unused", { running: false, state: undefined }),
      seat("nosession", { running: false, state: undefined, sessionId: undefined }),
    ]);
    w.unused.add("unused");
    w.advance(120);
    expect((await w.offboard.tick()).closed).toBe(1);
    expect(w.closed).toEqual([{ seatId: "resting", by: "automatic" }]);
    // Hours later, still nothing moved: the fresh session is not cut again.
    w.advance(600);
    expect((await w.offboard.tick()).closed).toBe(0);
    // Once it moves and goes still again, it is a session worth cutting.
    w.clock.note("bind-resting");
    w.advance(120);
    expect((await w.offboard.tick()).closed).toBe(1);
  });

  it("can be turned off, and follows a harness override", async () => {
    const off = world([seat("a")], { rules: applyOffboardRulesPatch(defaultOffboardRules(), { auto: { enabled: false } }) });
    off.advance(1000);
    expect((await off.offboard.tick()).closed).toBe(0);

    const rules = applyOffboardRulesPatch(defaultOffboardRules(), {
      harness: { codex: { cacheWindowMinutes: 10, nudge: { minutes: 5 }, auto: { minutes: 15 } } },
    });
    const w = world([seat("c", { harness: "codex" }), seat("a")], { rules });
    w.advance(15);
    expect((await w.offboard.tick()).closed).toBe(1);
    expect(w.closed).toEqual([{ seatId: "c", by: "automatic" }]);
  });

  it("a failed automatic close is reported once per pass and nothing is recorded", async () => {
    const w = world([seat("a")]);
    w.fail.close.add("a");
    w.advance(120);
    const result = await w.offboard.tick();
    expect(result.results[0]).toMatchObject({ ok: false, code: "failed" });
    expect(w.ended).toEqual([]);
  });
});

describe("idle nudge (off by default, 40 minutes)", () => {
  const nudging = () => applyOffboardRulesPatch(defaultOffboardRules(), { nudge: { enabled: true } });

  it("is off unless turned on", async () => {
    const w = world([seat("a")]);
    w.advance(50);
    expect(await w.offboard.tick()).toMatchObject({ asked: 0, closed: 0 });
  });

  it("asks a still, idle seat to offboard and continue, once per stretch", async () => {
    const w = world([seat("a")], { rules: nudging() });
    w.clock.note("bind-a");
    w.advance(39);
    expect((await w.offboard.tick()).asked).toBe(0);
    w.advance(1);
    expect((await w.offboard.tick()).asked).toBe(1);
    expect(w.asked).toEqual([{ seatId: "a", mode: "continue" }]);
    // Still idle a few minutes later: not asked again.
    w.advance(10);
    expect((await w.offboard.tick()).asked).toBe(0);
    // It moved (the agent took its turn), then sat still again: a new stretch.
    w.clock.note("bind-a");
    w.advance(40);
    expect((await w.offboard.tick()).asked).toBe(1);
  });

  it("does not ask a seat that is offline, on a paused canvas, working, or just given a fresh session", async () => {
    const w = world(
      [
        seat("off", { running: false, state: undefined }),
        seat("paused", { paused: true }),
        seat("working", { state: "working" }),
        seat("fresh"),
      ],
      { rules: nudging() },
    );
    w.clock.markOffboarded("bind-fresh");
    w.advance(45);
    expect((await w.offboard.tick()).asked).toBe(0);
    expect(w.asked).toEqual([]);
  });

  it("an ask that cannot be delivered is not retried in the same stretch", async () => {
    const w = world([seat("a")], { rules: nudging() });
    w.fail.ask.add("a");
    w.advance(40);
    expect((await w.offboard.tick()).refused).toBe(1);
    w.advance(5);
    expect(await w.offboard.tick()).toMatchObject({ asked: 0, refused: 0 });
  });
});

describe("the clock across a restart", () => {
  it("is saved on every pass and carries on where it was", async () => {
    const first = world([seat("a")]);
    first.clock.note("bind-a");
    first.advance(90);
    await first.offboard.tick();
    const saved = first.saved.at(-1)!;
    expect(saved).toEqual({ savedAt: T0 + 90 * MIN, seats: { "bind-a": { movedAt: T0 } } });

    // Restart one minute later: the seat is at 91 minutes, not at zero.
    const second = world([seat("a")], { restored: parseSeatMotionRecord(JSON.stringify(saved)), at: T0 + 91 * MIN });
    expect((await second.offboard.tick()).closed).toBe(0);
    second.advance(28);
    expect((await second.offboard.tick()).closed).toBe(0);
    second.advance(1);
    expect((await second.offboard.tick()).closed).toBe(1);
  });

  it("catches up: time while Junto was closed counts like any other", async () => {
    const first = world([seat("a")]);
    first.clock.note("bind-a");
    first.advance(30);
    await first.offboard.tick();
    // Closed for eight hours: the seat has been still for eight and a half.
    const second = world([seat("a")], { restored: first.saved.at(-1)!, at: T0 + 30 * MIN + 480 * MIN });
    const [status] = await second.offboard.status(CANVAS, ["a"]);
    expect(status).toMatchObject({ motionlessSince: T0, idleMinutes: 510, pastWindow: true, preferred: "now" });
    // Its session is closed without waiting out another two hours...
    second.advance(5);
    expect((await second.offboard.tick()).closed).toBe(1);
    expect(second.closed).toEqual([{ seatId: "a", by: "automatic" }]);
  });

  it("...but never as a batch at start: nothing for five minutes, then one seat per pass, longest still first", async () => {
    const first = world([seat("a"), seat("b"), seat("c")]);
    first.clock.note("bind-b");
    first.advance(10);
    first.clock.note("bind-a");
    first.advance(10);
    first.clock.note("bind-c");
    first.advance(60);
    await first.offboard.tick();

    // Closed overnight. Every seat is far past two hours the moment Junto opens.
    const second = world([seat("a"), seat("b"), seat("c")], { restored: first.saved.at(-1)!, at: first.now() + 600 * MIN });
    for (let minute = 0; minute < 5; minute += 1) {
      expect(await second.offboard.tick()).toMatchObject({ closed: 0, asked: 0 });
      second.advance(1);
    }
    expect(second.closed).toEqual([]);
    expect((await second.offboard.tick()).closed).toBe(1);
    second.advance(1);
    expect((await second.offboard.tick()).closed).toBe(1);
    second.advance(1);
    expect((await second.offboard.tick()).closed).toBe(1);
    expect(second.closed.map((entry) => entry.seatId)).toEqual(["b", "a", "c"]);
    second.advance(1);
    expect((await second.offboard.tick()).closed).toBe(0);
  });

  it("a seat cold past the auto offboard interval is closed, not asked for an expensive turn", async () => {
    const rules = applyOffboardRulesPatch(defaultOffboardRules(), { nudge: { enabled: true } });
    const first = world([seat("a")], { rules });
    first.clock.note("bind-a");
    first.advance(10);
    await first.offboard.tick();
    const second = world([seat("a")], { rules, restored: first.saved.at(-1)!, at: T0 + 10 * MIN + 480 * MIN });
    second.advance(5);
    expect(await second.offboard.tick()).toMatchObject({ closed: 1, asked: 0 });
    expect(second.asked).toEqual([]);
  });

  it("remembers that a seat was already given a fresh session, and that it was nudged", async () => {
    const first = world([seat("a"), seat("b")], { rules: applyOffboardRulesPatch(defaultOffboardRules(), { nudge: { enabled: true } }) });
    first.advance(40);
    await first.offboard.tick();
    first.advance(1);
    await first.offboard.tick(); // both nudged, one per pass
    expect(first.asked.map((entry) => entry.seatId).sort()).toEqual(["a", "b"]);
    first.set("a", { running: false, state: undefined });
    first.advance(80);
    await first.offboard.tick();
    first.advance(1);
    await first.offboard.tick(); // both closed, one per pass
    expect(first.closed).toHaveLength(2);
    const saved = parseSeatMotionRecord(JSON.stringify(first.saved.at(-1)!))!;
    expect(saved.seats["bind-a"]).toMatchObject({ offboarded: true });

    const second = world(
      [seat("a", { running: false, state: undefined }), seat("b", { running: false, state: undefined })],
      { restored: saved, at: first.now() + MIN },
    );
    second.advance(500);
    expect(await second.offboard.tick()).toMatchObject({ closed: 0, asked: 0 });
  });

  it("a seat the clock has never seen has been still since this run started", async () => {
    const w = world([seat("new")]);
    w.advance(119);
    expect((await w.offboard.tick()).closed).toBe(0);
    w.advance(1);
    expect((await w.offboard.tick()).closed).toBe(1);
  });

  it("an unreadable saved clock is no clock, and a save that fails stops nothing", async () => {
    expect(parseSeatMotionRecord("not json")).toBeUndefined();
    expect(parseSeatMotionRecord('{"seats":{}}')).toBeUndefined();
    expect(parseSeatMotionRecord('{"savedAt":1,"seats":{"x":{"movedAt":"soon"},"y":{"movedAt":5}}}')).toEqual({
      savedAt: 1,
      seats: { y: { movedAt: 5 } },
    });
    // A clock from the future (a changed system time) is ignored for that seat.
    const clock = new SeatMotionClock(() => T0, { savedAt: T0 - MIN, seats: { later: { movedAt: T0 + 5 * MIN } } });
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
