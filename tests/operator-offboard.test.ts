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

const world = (
  initial: OffboardSeat[],
  options: {
    rules?: OffboardRules;
    restored?: SeatMotionRecord;
    at?: number;
    /** Seats whose session has done no work. Every other seat starts with an hour of it. */
    noWork?: ReadonlyArray<string>;
  } = {},
) => {
  let at = options.at ?? T0;
  let rules = options.rules ?? defaultOffboardRules();
  const seats = new Map(initial.map((s) => [s.seatId, s]));
  const closing = new Set<string>();
  const closed: Array<{ seatId: string; by: OffboardBy }> = [];
  const asked: Array<{ seatId: string; mode: string }> = [];
  const ended: Array<{ seatId: string; sessionId: string; by: OffboardBy; at: number }> = [];
  const saved: SeatMotionRecord[] = [];
  const fail = { close: new Set<string>(), ask: new Set<string>() };
  /** Transcript size per seat, in tokens. A seat not listed has no locatable transcript. */
  const sizes = new Map<string, number>();
  // A session worth cutting, unless the test says otherwise: an hour of work.
  const seeded: SeatMotionRecord = {
    savedAt: at,
    seats: Object.fromEntries(
      initial
        .filter((s) => !(options.noWork ?? []).includes(s.seatId))
        .map((s) => [s.bindingId, { movedAt: at, workMs: 60 * MIN, ...(s.sessionId ? { sessionId: s.sessionId } : {}) }]),
    ),
  };
  const clock = new SeatMotionClock(() => at, options.restored ?? seeded);
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
    sizes,
    advance: (minutes: number) => {
      at += minutes * MIN;
    },
    /** The seat works for this long, then goes idle: time passes for everyone. */
    work: (seatId: string, minutes: number) => {
      const bindingId = seats.get(seatId)!.bindingId;
      clock.syncSession(bindingId, seats.get(seatId)!.sessionId);
      clock.noteState(bindingId, "working");
      clock.note(bindingId);
      at += minutes * MIN;
      clock.noteState(bindingId, "idle");
      clock.note(bindingId);
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

const resting = (seatId: string, over: Partial<OffboardSeat> = {}): OffboardSeat =>
  seat(seatId, { running: false, state: undefined, ...over });

describe("auto offboard (on by default, 2 hours): only as a seat is about to be woken", () => {
  const wake = (w: ReturnType<typeof world>, seatId: string) =>
    w.offboard.beforeWake({ canvasName: CANVAS, seatId });

  it("never ends a session on a timer, however long the seat has sat still", async () => {
    const w = world([seat("idle"), resting("rest")]);
    for (let hour = 0; hour < 48; hour += 1) {
      w.advance(60);
      expect(await w.offboard.tick()).toMatchObject({ closed: 0 });
    }
    expect(w.closed).toEqual([]);
  });

  it("a resting seat still for two hours is given a fresh session just before it wakes", async () => {
    const w = world([resting("a")]);
    w.clock.note("bind-a");
    w.advance(119);
    expect(await wake(w, "a")).toBe(false);
    expect(w.closed).toEqual([]);
    w.advance(1);
    expect(await wake(w, "a")).toBe(true);
    expect(w.closed).toEqual([{ seatId: "a", by: "automatic" }]);
    expect(w.ended[0]).toMatchObject({ by: "automatic", sessionId: "session-a" });
    // Nothing is typed to anyone, and the seat is left for the wake that follows.
    expect(w.asked).toEqual([]);
    expect(w.seats.get("a")).toMatchObject({ running: false, sessionId: "fresh-a" });
  });

  it("is one seat at a time: waking one seat touches no other", async () => {
    const w = world([resting("a"), resting("b"), resting("c")]);
    w.advance(600);
    expect(await wake(w, "b")).toBe(true);
    expect(w.closed).toEqual([{ seatId: "b", by: "automatic" }]);
    expect(w.seats.get("a")).toMatchObject({ sessionId: "session-a" });
    expect(w.seats.get("c")).toMatchObject({ sessionId: "session-c" });
  });

  it("the same wake twice does not cut twice", async () => {
    const w = world([resting("a")]);
    w.advance(200);
    expect(await wake(w, "a")).toBe(true);
    expect(await wake(w, "a")).toBe(false);
    w.advance(600);
    expect(await wake(w, "a")).toBe(false);
    expect(w.closed).toHaveLength(1);
  });

  it("leaves a running seat alone, whatever its state: only a seat with no process is cut at its wake", async () => {
    const w = world([seat("idle"), seat("working", { state: "working" }), seat("dialog", { state: "attention" })]);
    w.advance(600);
    for (const id of ["idle", "working", "dialog"]) expect(await wake(w, id)).toBe(false);
    expect(w.closed).toEqual([]);
  });

  it("does nothing for a seat already offboarding, on another installation, on a paused canvas, without a session, or unknown", async () => {
    const w = world([
      resting("busy"),
      resting("remote", { local: false }),
      resting("paused", { paused: true }),
      resting("nosession", { sessionId: undefined }),
    ]);
    w.closing.add("busy");
    w.advance(600);
    for (const id of ["busy", "remote", "paused", "nosession", "ghost"]) expect(await wake(w, id)).toBe(false);
    expect(w.closed).toEqual([]);
  });

  it("can be turned off, and follows a harness override", async () => {
    const off = world([resting("a")], { rules: applyOffboardRulesPatch(defaultOffboardRules(), { auto: { enabled: false } }) });
    off.advance(1000);
    expect(await wake(off, "a")).toBe(false);

    const rules = applyOffboardRulesPatch(defaultOffboardRules(), {
      harness: { codex: { cacheWindowMinutes: 10, nudge: { minutes: 5 }, auto: { minutes: 15 } } },
    });
    const w = world([resting("c", { harness: "codex" }), resting("a")], { rules });
    w.advance(15);
    expect(await wake(w, "c")).toBe(true);
    expect(await wake(w, "a")).toBe(false);
  });

  it("a close that fails never holds up the wake, and records nothing", async () => {
    const w = world([resting("a")]);
    w.fail.close.add("a");
    w.advance(200);
    expect(await wake(w, "a")).toBe(false);
    expect(w.ended).toEqual([]);
    // A port that throws is the same: the wake goes ahead.
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
      new SeatMotionClock(() => T0),
    );
    expect(await broken.beforeWake({ canvasName: CANVAS, seatId: "a" })).toBe(false);
  });
});

describe("auto offboard as mail is about to be typed into a running, idle seat", () => {
  const mail = (w: ReturnType<typeof world>, seatId: string) =>
    w.offboard.beforeMail({ canvasName: CANVAS, seatId });

  it("a seat idle past the interval gets a fresh session first; the mail then wakes it there", async () => {
    const w = world([seat("a")]);
    w.clock.note("bind-a");
    w.advance(119);
    expect(await mail(w, "a")).toBe(false);
    w.advance(1);
    expect(await mail(w, "a")).toBe(true);
    expect(w.closed).toEqual([{ seatId: "a", by: "automatic" }]);
    expect(w.ended[0]).toMatchObject({ by: "automatic", sessionId: "session-a" });
    // The seat rests on its fresh session; nothing was typed into the old one.
    expect(w.seats.get("a")).toMatchObject({ running: false, sessionId: "fresh-a" });
    expect(w.asked).toEqual([]);
    // The wake that follows finds nothing more to cut.
    expect(await w.offboard.beforeWake({ canvasName: CANVAS, seatId: "a" })).toBe(false);
    expect(w.closed).toHaveLength(1);
  });

  it("never cuts a turn: a working seat, one waiting on the operator, or one Junto cannot read is left alone", async () => {
    const w = world([seat("w", { state: "working" }), seat("d", { state: "attention" }), seat("u", { state: "unknown" })]);
    w.advance(600);
    for (const id of ["w", "d", "u"]) expect(await mail(w, id)).toBe(false);
    expect(w.closed).toEqual([]);
  });

  it("is gated like every automatic cut: tiny sessions, paused canvases, the rule turned off", async () => {
    const w = world([seat("tiny"), seat("paused", { paused: true })], { noWork: ["tiny"] });
    w.work("tiny", 3);
    w.advance(600);
    expect(await mail(w, "tiny")).toBe(false);
    expect(await mail(w, "paused")).toBe(false);
    const off = world([seat("a")], { rules: applyOffboardRulesPatch(defaultOffboardRules(), { auto: { enabled: false } }) });
    off.advance(600);
    expect(await mail(off, "a")).toBe(false);
  });

  it("does not cut under the operator's own ask: that prompt is meant for this session", async () => {
    const w = world([seat("a")]);
    w.advance(300);
    const asked = await w.offboard.run({ canvasName: CANVAS, seatIds: ["a"], action: "ask" }, "operator");
    expect(asked).toMatchObject({ asked: 1 });
    // The ask travels as mail; delivery checks before typing it.
    expect(await mail(w, "a")).toBe(false);
    expect(w.closed).toEqual([]);
    // Much later, ordinary mail to the still-cold seat does cut.
    w.advance(11);
    expect(await mail(w, "a")).toBe(true);
  });

  it("a resting seat is the wake's business, not the mail's", async () => {
    const w = world([resting("a")]);
    w.advance(600);
    expect(await mail(w, "a")).toBe(false);
    expect(await w.offboard.beforeWake({ canvasName: CANVAS, seatId: "a" })).toBe(true);
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

describe("worth cutting: the automatic rules never recycle an empty or tiny session", () => {
  const nudging = () => applyOffboardRulesPatch(defaultOffboardRules(), { nudge: { enabled: true } });
  const wake = (w: ReturnType<typeof world>, seatId: string) =>
    w.offboard.beforeWake({ canvasName: CANVAS, seatId });
  /** The seat's process ends and it rests, as after an idle seat is stopped. */
  const rest = (w: ReturnType<typeof world>, seatId: string) => w.set(seatId, { running: false, state: undefined });

  it("case 1: one small task, then hours of stillness: not cut at its wake, not nudged", async () => {
    const w = world([seat("a")], { rules: nudging(), noWork: ["a"] });
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
    expect(w.closed).toHaveLength(1);
    // The work before the cut does not count for the session after it.
    expect((await w.offboard.status(CANVAS, ["a"]))[0]).toMatchObject({ workMinutes: 4, worthCutting: false });
  });

  it("case 3: a new session that never really starts is never cut", async () => {
    const w = world([resting("never-ran"), seat("banner-only")], { noWork: ["never-ran", "banner-only"] });
    // It printed a banner and sat at its prompt: output, but no work.
    w.clock.note("bind-banner-only");
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

  it("the thresholds are settings, with a harness override", async () => {
    const rules = applyOffboardRulesPatch(defaultOffboardRules(), {
      worth: { workMinutes: 10 },
      harness: { codex: { worth: { tokens: 50_000, workMinutes: 90 } } },
    });
    const w = world([seat("a"), seat("c", { harness: "codex" }), seat("c2", { harness: "codex" })], {
      rules,
      noWork: ["a", "c", "c2"],
    });
    for (const id of ["a", "c", "c2"]) {
      w.work(id, 10);
      rest(w, id);
    }
    w.sizes.set("c", 60_000);
    w.advance(120);
    expect(await wake(w, "a")).toBe(true); // ten minutes is enough for the installation
    expect(await wake(w, "c")).toBe(true); // codex: by size
    expect(await wake(w, "c2")).toBe(false); // codex: ten of ninety minutes, no size
  });

  it("the idle nudge is gated the same way", async () => {
    const w = world([seat("tiny"), seat("real")], { rules: nudging(), noWork: ["tiny"] });
    w.work("tiny", 3);
    w.clock.note("bind-real");
    w.advance(40);
    expect(await w.offboard.tick()).toMatchObject({ asked: 1 });
    w.advance(1);
    expect(await w.offboard.tick()).toMatchObject({ asked: 0 });
    expect(w.asked).toEqual([{ seatId: "real", mode: "continue" }]);
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

describe("the clock across a restart", () => {
  const wake = (w: ReturnType<typeof world>, seatId: string) =>
    w.offboard.beforeWake({ canvasName: CANVAS, seatId });

  it("is saved on every pass and carries on where it was", async () => {
    const first = world([resting("a")]);
    first.clock.note("bind-a");
    first.advance(90);
    await first.offboard.tick();
    const saved = first.saved.at(-1)!;
    expect(saved).toEqual({
      savedAt: T0 + 90 * MIN,
      seats: { "bind-a": { movedAt: T0, workMs: 60 * MIN, sessionId: "session-a" } },
    });

    // Restart one minute later: the seat is at 91 minutes, not at zero.
    const second = world([resting("a")], { restored: parseSeatMotionRecord(JSON.stringify(saved)), at: T0 + 91 * MIN });
    expect(await wake(second, "a")).toBe(false);
    second.advance(28);
    expect(await wake(second, "a")).toBe(false);
    second.advance(1);
    expect(await wake(second, "a")).toBe(true);
  });

  it("catches up: closed for eight hours means still for eight hours plus what it already had", async () => {
    const first = world([resting("a")]);
    first.clock.note("bind-a");
    first.advance(30);
    await first.offboard.tick();
    const second = world([resting("a")], { restored: first.saved.at(-1)!, at: T0 + 30 * MIN + 480 * MIN });
    const [status] = await second.offboard.status(CANVAS, ["a"]);
    expect(status).toMatchObject({ motionlessSince: T0, idleMinutes: 510, pastWindow: true, preferred: "now" });
    // So the first thing that wakes it finds a session to cut.
    expect(await wake(second, "a")).toBe(true);
  });

  it("opening the app after a night ends no session: not at start, not later, until a seat is woken", async () => {
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
    // Mail arrives for one seat: that seat, and only that seat, wakes fresh.
    expect(await wake(second, "b")).toBe(true);
    expect(second.closed).toEqual([{ seatId: "b", by: "automatic" }]);
  });

  it("the idle nudge waits five minutes after the app opens and asks one seat per pass", async () => {
    const rules = applyOffboardRulesPatch(defaultOffboardRules(), { nudge: { enabled: true } });
    const first = world([seat("a"), seat("b")], { rules });
    first.clock.note("bind-b");
    first.advance(1);
    first.clock.note("bind-a");
    first.advance(44);
    await first.offboard.tick();
    await first.offboard.tick();
    expect(first.asked.map((entry) => entry.seatId)).toEqual(["b", "a"]);

    const fresh = world([seat("a"), seat("b")], { rules, restored: { savedAt: T0, seats: {
      "bind-a": { movedAt: T0 - 50 * MIN, workMs: 60 * MIN, sessionId: "session-a" },
      "bind-b": { movedAt: T0 - 50 * MIN, workMs: 60 * MIN, sessionId: "session-b" },
    } } });
    for (let minute = 0; minute < 5; minute += 1) {
      expect(await fresh.offboard.tick()).toMatchObject({ asked: 0 });
      fresh.advance(1);
    }
    expect((await fresh.offboard.tick()).asked).toBe(1);
  });

  it("a seat cold past the auto offboard interval is not asked for an expensive turn", async () => {
    const rules = applyOffboardRulesPatch(defaultOffboardRules(), { nudge: { enabled: true } });
    const w = world([seat("a")], { rules });
    w.advance(200);
    expect(await w.offboard.tick()).toMatchObject({ asked: 0, closed: 0 });
    expect(w.asked).toEqual([]);
  });

  it("remembers that a seat was already given a fresh session", async () => {
    const first = world([resting("a")]);
    first.advance(200);
    expect(await wake(first, "a")).toBe(true);
    await first.offboard.tick();
    const saved = parseSeatMotionRecord(JSON.stringify(first.saved.at(-1)!))!;
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
    const saved = parseSeatMotionRecord(JSON.stringify(first.saved.at(-1)!))!;
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
