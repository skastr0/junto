/**
 * A seat's launch state crosses the seats channel as durations read on the
 * receiver's clock, bounded and closed; the receiving machine holds it only
 * while the machine that said it still runs that occupant.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVITY_AGO_MAX_MS,
  FRESH_IN_MAX_MS,
  SESSION_TOKENS_MAX,
  SESSION_WORK_MAX_MS,
  cardSeatLaunch,
  decodeSeatsLaunch,
  fromSeatsLaunch,
  toSeatsLaunch,
  type SeatLaunchState,
} from "../src/main/junto/term/seats-launch";
import {
  forgetRemoteSeatLaunches,
  heldRemoteSeatLaunch,
  openedRemoteSeatLaunches,
  rememberRemoteSeatLaunch,
  remoteSeatLaunch,
  resetRemoteSeatLaunches,
} from "../src/main/junto/term/remote-seat-launch";
import { OFFBOARD_MINUTES_MAX } from "../src/shared/seat-offboard";

const NOW = 1_792_000_000_000;
const warm: SeatLaunchState = { settingsFixed: true, nextTurn: { fresh: false, freshAt: NOW + 600_000 } };

afterEach(() => resetRemoteSeatLaunches());

describe("the seats wire launch state", () => {
  it("crosses freshAt as a duration and reads it on the receiver's clock", () => {
    const wire = toSeatsLaunch(warm, NOW);
    expect(wire).toEqual({ settingsFixed: true, nextTurn: { fresh: false, freshInMs: 600_000 } });
    expect(decodeSeatsLaunch(wire)).toEqual(wire);
    // A receiver an hour ahead holds the same ten minutes, from its own now.
    const ahead = NOW + 3_600_000;
    expect(fromSeatsLaunch(wire, ahead)).toEqual({ settingsFixed: true, nextTurn: { fresh: false, freshAt: ahead + 600_000 } });
    expect(toSeatsLaunch({ settingsFixed: false, nextTurn: { fresh: true } }, NOW))
      .toEqual({ settingsFixed: false, nextTurn: { fresh: true } });
    expect(toSeatsLaunch({ settingsFixed: false }, NOW)).toEqual({ settingsFixed: false });
  });

  it("clamps on sending and refuses anything over the bound, open or not whole", () => {
    expect(toSeatsLaunch({ ...warm, nextTurn: { fresh: false, freshAt: NOW + FRESH_IN_MAX_MS * 2 } }, NOW).nextTurn)
      .toEqual({ fresh: false, freshInMs: FRESH_IN_MAX_MS });
    expect(toSeatsLaunch({ ...warm, nextTurn: { fresh: false, freshAt: NOW - 5 } }, NOW).nextTurn)
      .toEqual({ fresh: false, freshInMs: 0 });
    const wire = toSeatsLaunch(warm, NOW);
    expect(() => decodeSeatsLaunch({ ...wire, nextTurn: { fresh: false, freshInMs: FRESH_IN_MAX_MS + 1 } })).toThrow();
    expect(() => decodeSeatsLaunch({ ...wire, nextTurn: { fresh: false, freshInMs: 2.5 } })).toThrow();
    expect(() => decodeSeatsLaunch({ ...wire, nextTurn: { fresh: false, freshAt: NOW } })).toThrow();
    // The seat's own start plan and whether it holds a harness session never cross.
    expect(() => decodeSeatsLaunch({ ...wire, next: "resume" })).toThrow();
    expect(() => decodeSeatsLaunch({ ...wire, hasSession: true })).toThrow();
    expect(() => decodeSeatsLaunch({ ...wire, sessionId: "s" })).toThrow();
  });
});

describe("the seat's cache window on the wire", () => {
  const facts = { stillSince: NOW - 70 * 60_000, windowMinutes: 2, workMs: 25 * 60_000, tokens: 250_791, worth: true };

  it("crosses its rest as a duration and reads it on the receiver's clock", () => {
    const wire = toSeatsLaunch(warm, NOW, facts);
    expect(wire.offboard).toEqual({ stillForMs: 70 * 60_000, windowMinutes: 2, workMs: 25 * 60_000, tokens: 250_791, worth: true });
    expect(decodeSeatsLaunch(wire)).toEqual(wire);
    const ahead = NOW + 3_600_000;
    const held = fromSeatsLaunch(wire, ahead);
    expect(held.offboard).toEqual({ ...facts, stillSince: ahead - 70 * 60_000 });
    // Not at rest, size unknown: both absent.
    expect(toSeatsLaunch(warm, NOW, { windowMinutes: 60, workMs: 0, worth: false }).offboard)
      .toEqual({ windowMinutes: 60, workMs: 0, worth: false });
    // The seat's machine's cache mode goes with it, for the card's warning.
    const moded = toSeatsLaunch(warm, NOW, { ...facts, cacheMode: "manual" });
    expect(decodeSeatsLaunch(moded).offboard).toMatchObject({ cacheMode: "manual" });
    expect(fromSeatsLaunch(moded, ahead).offboard).toMatchObject({ cacheMode: "manual" });
    expect(cardSeatLaunch(fromSeatsLaunch(moded, ahead), ahead).cacheWindow).toMatchObject({ cacheMode: "manual" });
  });

  it("tells the card the seat against its cache window on the receiver's clock; the window itself never crosses", () => {
    // The size the seat's machine estimated goes with it, from the facts that already cross.
    const shown = { windowMinutes: 2, stillSince: NOW - 70 * 60_000, windowEndsAt: NOW - 68 * 60_000, pastWindow: true, pastByMs: 68 * 60_000, tokens: 250_791 };
    const wire = toSeatsLaunch({ ...warm, cacheWindow: shown }, NOW, facts);
    expect(wire).not.toHaveProperty("cacheWindow");
    expect(() => decodeSeatsLaunch({ ...wire, cacheWindow: shown })).toThrow();
    const ahead = NOW + 3_600_000;
    const card = cardSeatLaunch(fromSeatsLaunch(wire, ahead), ahead);
    expect(card).toEqual({
      ...fromSeatsLaunch(toSeatsLaunch(warm, NOW), ahead),
      cacheWindow: { ...shown, stillSince: ahead - 70 * 60_000, windowEndsAt: ahead - 68 * 60_000 },
    });
    expect(card).not.toHaveProperty("offboard");
    // Ten minutes later on this clock, ten minutes further past.
    expect(cardSeatLaunch(fromSeatsLaunch(wire, ahead), ahead + 10 * 60_000).cacheWindow)
      .toMatchObject({ pastWindow: true, pastByMs: 78 * 60_000 });
    expect(cardSeatLaunch(fromSeatsLaunch(toSeatsLaunch(warm, NOW, { ...facts, windowMinutes: 120 }), ahead), ahead).cacheWindow)
      .toMatchObject({ windowMinutes: 120, pastWindow: false, pastByMs: 0, windowEndsAt: ahead + 50 * 60_000 });
    // No estimate on the seat's machine: none told.
    const { tokens: _unsized, ...unsized } = facts;
    expect(cardSeatLaunch(fromSeatsLaunch(toSeatsLaunch(warm, NOW, unsized), ahead), ahead).cacheWindow).not.toHaveProperty("tokens");
    // In a turn, a next turn that starts fresh or is not known, or nothing said: no window told.
    expect(cardSeatLaunch(fromSeatsLaunch(toSeatsLaunch(warm, NOW, { windowMinutes: 2, workMs: 0, worth: false }), ahead), ahead))
      .not.toHaveProperty("cacheWindow");
    expect(cardSeatLaunch(fromSeatsLaunch(toSeatsLaunch({ settingsFixed: true, nextTurn: { fresh: true } }, NOW, facts), ahead), ahead))
      .not.toHaveProperty("cacheWindow");
    expect(cardSeatLaunch(fromSeatsLaunch(toSeatsLaunch({ settingsFixed: false }, NOW, facts), ahead), ahead))
      .not.toHaveProperty("cacheWindow");
    expect(cardSeatLaunch(fromSeatsLaunch(toSeatsLaunch(warm, NOW), ahead), ahead)).toEqual(fromSeatsLaunch(toSeatsLaunch(warm, NOW), ahead));
  });

  it("clamps on sending and refuses anything over a bound or any other key", () => {
    expect(toSeatsLaunch(warm, NOW, { stillSince: 0, windowMinutes: OFFBOARD_MINUTES_MAX + 1, workMs: Number.MAX_SAFE_INTEGER, tokens: 1e12, worth: true }).offboard)
      .toEqual({ stillForMs: ACTIVITY_AGO_MAX_MS, windowMinutes: OFFBOARD_MINUTES_MAX, workMs: SESSION_WORK_MAX_MS, tokens: SESSION_TOKENS_MAX, worth: true });
    const wire = toSeatsLaunch(warm, NOW, facts);
    const offboard = wire.offboard!;
    for (const bad of [
      { ...offboard, stillForMs: ACTIVITY_AGO_MAX_MS + 1 },
      { ...offboard, windowMinutes: 0 },
      { ...offboard, workMs: -1 },
      { ...offboard, tokens: SESSION_TOKENS_MAX + 1 },
      { ...offboard, tokens: 2.5 },
      { ...offboard, stillSince: NOW },
      { ...offboard, sessionId: "s" },
      { ...offboard, cacheMode: "sometimes" },
    ]) expect(() => decodeSeatsLaunch({ ...wire, offboard: bad })).toThrow();
  });
});

describe("a remote seat's launch state on the editing machine", () => {
  const seat = { bindingId: "mac-binding", machine: "macbook" };

  it("reads fresh once freshAt passes, and drops on exit, a new occupant or another machine", () => {
    rememberRemoteSeatLaunch({ ...seat, epoch: "ep_1", gone: false, launch: warm });
    expect(heldRemoteSeatLaunch(seat.bindingId, seat.machine, NOW)).toEqual(warm);
    expect(heldRemoteSeatLaunch(seat.bindingId, seat.machine, NOW + 600_000))
      .toEqual({ settingsFixed: true, nextTurn: { fresh: true } });
    // A state of the same occupant that carries none keeps the answer; a new occupant's drops it.
    rememberRemoteSeatLaunch({ ...seat, epoch: "ep_1", gone: false });
    expect(heldRemoteSeatLaunch(seat.bindingId, seat.machine, NOW)).toEqual(warm);
    rememberRemoteSeatLaunch({ ...seat, epoch: "ep_2", gone: false });
    expect(heldRemoteSeatLaunch(seat.bindingId, seat.machine, NOW)).toBeUndefined();
    rememberRemoteSeatLaunch({ ...seat, epoch: "ep_2", gone: false, launch: warm });
    rememberRemoteSeatLaunch({ ...seat, epoch: "ep_2", gone: true, launch: warm });
    expect(heldRemoteSeatLaunch(seat.bindingId, seat.machine, NOW)).toBeUndefined();
    rememberRemoteSeatLaunch({ ...seat, epoch: "ep_3", gone: false, launch: warm });
    expect(heldRemoteSeatLaunch(seat.bindingId, "studio", NOW)).toBeUndefined();
    expect(heldRemoteSeatLaunch(seat.bindingId, seat.machine, NOW)).toBeUndefined();
  });

  it("drops everything a machine said when its link closes", () => {
    rememberRemoteSeatLaunch({ ...seat, epoch: "ep_1", gone: false, launch: warm });
    rememberRemoteSeatLaunch({ bindingId: "other", machine: "studio", epoch: "ep_1", gone: false, launch: warm });
    forgetRemoteSeatLaunches("macbook");
    expect(heldRemoteSeatLaunch(seat.bindingId, seat.machine, NOW)).toBeUndefined();
    expect(heldRemoteSeatLaunch("other", "studio", NOW)).toEqual(warm);
  });

  it("asks a seat with no live state once per link and per state, and never a live one", async () => {
    const vacant: SeatLaunchState = { settingsFixed: false, nextTurn: { fresh: true } };
    const ask = vi.fn(async () => vacant);
    const read = (live = false) => remoteSeatLaunch({ ...seat, live, ask, now: () => NOW });
    expect(await read(true)).toBeUndefined();
    expect(ask).not.toHaveBeenCalled();
    expect(await read()).toEqual(vacant);
    expect(await read()).toEqual(vacant);
    expect(ask).toHaveBeenCalledTimes(1);
    // The seat starts and exits: one more ask, for what its exit left.
    rememberRemoteSeatLaunch({ ...seat, epoch: "ep_1", gone: false });
    rememberRemoteSeatLaunch({ ...seat, epoch: "ep_1", gone: true });
    expect(await read()).toEqual(vacant);
    expect(ask).toHaveBeenCalledTimes(2);
    // A failed ask is not asked again until the link reopens.
    forgetRemoteSeatLaunches(seat.machine);
    ask.mockRejectedValueOnce(new Error("link down"));
    expect(await read()).toBeUndefined();
    expect(await read()).toBeUndefined();
    expect(ask).toHaveBeenCalledTimes(3);
    forgetRemoteSeatLaunches(seat.machine);
    expect(await read()).toEqual(vacant);
  });

  it("asks again on the first link a seat asked before any link was up", async () => {
    const vacant: SeatLaunchState = { settingsFixed: true, nextTurn: { fresh: true } };
    const ask = vi.fn(async () => vacant);
    const read = () => remoteSeatLaunch({ ...seat, live: false, ask, now: () => NOW });
    // A window's card asks while the link to that machine is still opening.
    ask.mockRejectedValueOnce(new Error("no path to the machine"));
    expect(await read()).toBeUndefined();
    expect(await read()).toBeUndefined();
    expect(ask).toHaveBeenCalledTimes(1);
    openedRemoteSeatLaunches(seat.machine);
    expect(await read()).toEqual(vacant);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("keeps a state that arrives while a Get is out over the Get's answer", async () => {
    let answer: (launch: SeatLaunchState) => void = () => undefined;
    const pending = remoteSeatLaunch({ ...seat, live: false, now: () => NOW,
      ask: () => new Promise<SeatLaunchState>((resolve) => { answer = resolve; }) });
    rememberRemoteSeatLaunch({ ...seat, epoch: "ep_1", gone: false, launch: warm });
    answer({ settingsFixed: false, nextTurn: { fresh: true } });
    expect(await pending).toEqual(warm);
  });
});
