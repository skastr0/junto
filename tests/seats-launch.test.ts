/**
 * A seat's launch state crosses the seats channel as durations read on the
 * receiver's clock, bounded and closed; the receiving machine holds it only
 * while the machine that said it still runs that occupant.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FRESH_IN_MAX_MS,
  decodeSeatsLaunch,
  fromSeatsLaunch,
  toSeatsLaunch,
  type SeatLaunchState,
} from "../src/main/junto/term/seats-launch";
import {
  forgetRemoteSeatLaunches,
  heldRemoteSeatLaunch,
  rememberRemoteSeatLaunch,
  remoteSeatLaunch,
  resetRemoteSeatLaunches,
} from "../src/main/junto/term/remote-seat-launch";

const NOW = 1_792_000_000_000;
const warm: SeatLaunchState = { hasSession: true, next: "resume", nextTurn: { fresh: false, freshAt: NOW + 600_000 } };

afterEach(() => resetRemoteSeatLaunches());

describe("the seats wire launch state", () => {
  it("crosses freshAt as a duration and reads it on the receiver's clock", () => {
    const wire = toSeatsLaunch(warm, NOW);
    expect(wire).toEqual({ hasSession: true, next: "resume", nextTurn: { fresh: false, freshInMs: 600_000 } });
    expect(decodeSeatsLaunch(wire)).toEqual(wire);
    // A receiver an hour ahead holds the same ten minutes, from its own now.
    const ahead = NOW + 3_600_000;
    expect(fromSeatsLaunch(wire, ahead)).toEqual({ hasSession: true, next: "resume", nextTurn: { fresh: false, freshAt: ahead + 600_000 } });
    expect(toSeatsLaunch({ hasSession: false, next: "fresh", nextTurn: { fresh: true } }, NOW))
      .toEqual({ hasSession: false, next: "fresh", nextTurn: { fresh: true } });
    expect(toSeatsLaunch({ hasSession: false, next: "offboarded" }, NOW)).toEqual({ hasSession: false, next: "offboarded" });
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
    expect(() => decodeSeatsLaunch({ ...wire, next: "continue" })).toThrow();
    expect(() => decodeSeatsLaunch({ ...wire, sessionId: "s" })).toThrow();
  });
});

describe("a remote seat's launch state on the editing machine", () => {
  const seat = { bindingId: "mac-binding", machine: "macbook" };

  it("reads fresh once freshAt passes, and drops on exit, a new occupant or another machine", () => {
    rememberRemoteSeatLaunch({ ...seat, epoch: "ep_1", gone: false, launch: warm });
    expect(heldRemoteSeatLaunch(seat.bindingId, seat.machine, NOW)).toEqual(warm);
    expect(heldRemoteSeatLaunch(seat.bindingId, seat.machine, NOW + 600_000))
      .toEqual({ hasSession: true, next: "resume", nextTurn: { fresh: true } });
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
    const vacant: SeatLaunchState = { hasSession: false, next: "fresh", nextTurn: { fresh: true } };
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

  it("keeps a state that arrives while a Get is out over the Get's answer", async () => {
    let answer: (launch: SeatLaunchState) => void = () => undefined;
    const pending = remoteSeatLaunch({ ...seat, live: false, now: () => NOW,
      ask: () => new Promise<SeatLaunchState>((resolve) => { answer = resolve; }) });
    rememberRemoteSeatLaunch({ ...seat, epoch: "ep_1", gone: false, launch: warm });
    answer({ hasSession: false, next: "fresh", nextTurn: { fresh: true } });
    expect(await pending).toEqual(warm);
  });
});
