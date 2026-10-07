/**
 * A session detached from its seat to drain keeps its grid and its reading.
 *
 * At offboard the old process is taken off the seat and allowed to finish its
 * turn. Reading it on a NEW, empty grid does not work: on real captures a
 * grid that starts part-way through a turn ends stuck on "working" for Grok
 * and on an unconfirmed idle for harnesses whose idle is a title set earlier.
 * So the existing grid and seat-state slot MOVE to a drain key instead. These
 * tests feed real captures through the real observer plane and runtime, move
 * them part-way, and require the same confirmed reading as an unmoved run.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { chunkEvents, corpusRoot, feedStream, loadP1Fixture } from "../runner";
import { TerminalObserverPlane } from "../../../src/main/junto/term/observer";
import { SessionObserver } from "../../../src/main/junto/term/observer/session-observer";
import { SeatStateRuntime } from "../../../src/main/junto/term/agent-state/runtime";
import { drainKeyOf, isDrainKey } from "../../../src/shared/seat-drain";
import type { AgentSeatStateEvent } from "../../../src/shared/agent-seat-state";

const BINDING = "seat-1";
const EPOCH = "e1";
const DRAIN = drainKeyOf(BINDING, EPOCH);

const sizeOf = (harness: string): { cols: number; rows: number } => {
  try {
    const manifest = JSON.parse(
      readFileSync(join(corpusRoot(), harness, "manifest.json"), "utf8"),
    ) as { pty?: { cols?: number; rows?: number } };
    return { cols: manifest.pty?.cols ?? 80, rows: manifest.pty?.rows ?? 24 };
  } catch {
    return { cols: 80, rows: 24 };
  }
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A real plane and runtime, wired the way production wires them. */
const rig = (harness: string) => {
  const plane = new TerminalObserverPlane();
  const seatEvents: AgentSeatStateEvent[] = [];
  const drainEvents: AgentSeatStateEvent[] = [];
  const runtime = new SeatStateRuntime({ turnProgressWatch: false });
  const offPlane = plane.subscribeAll((snap) => runtime.observe(snap), { drains: true });
  runtime.subscribe((event) => seatEvents.push(event));
  runtime.subscribeDrain((event) => drainEvents.push(event));
  const { cols, rows } = sizeOf(harness);
  const attach = (epoch: string): SessionObserver =>
    plane.attach({ bindingId: BINDING, epoch, cols, rows });
  attach(EPOCH);
  runtime.bindHarness(BINDING, harness, EPOCH);
  cleanups.push(() => {
    offPlane();
    runtime.stop();
    plane.disposeAll();
  });
  const feed = async (key: string, chunks: ReadonlyArray<{ data: string; seq: bigint }>) => {
    for (const chunk of chunks) {
      plane.feed(key, chunk.data, chunk.seq);
      await plane.get(key)!.snapshot();
    }
  };
  /** What the host does at detach: grid first, then the reading, same step. */
  const detach = (): boolean =>
    plane.rekey(BINDING, DRAIN) && runtime.rekey(BINDING, DRAIN);
  return { plane, runtime, seatEvents, drainEvents, attach, feed, detach };
};

/** Every real capture that ends on a confirmed idle when read whole. */
const settledCaptures = async () => {
  const out: Array<{ harness: string; scenario: string; chunks: Array<{ data: string; seq: bigint }>; reason: string }> = [];
  for (const harness of readdirSync(corpusRoot()).filter((name) => !name.includes("."))) {
    for (const file of readdirSync(join(corpusRoot(), harness))) {
      if (!file.endsWith(".jsonl")) continue;
      const scenario = file.slice(0, -6);
      const fixture = loadP1Fixture(harness, scenario);
      if (!fixture) continue;
      const chunks = chunkEvents(fixture.events, "split-at-escapes");
      const whole = await feedStream(harness, chunks, sizeOf(harness));
      if (whole.isSeatIdle && chunks.length >= 4) {
        out.push({ harness, scenario, chunks, reason: whole.slot!.reason });
      }
    }
  }
  return out;
};

describe("a detached session is read on the grid it already had", () => {
  it("every real capture ends on the same confirmed idle when moved to a drain key part-way", async () => {
    const captures = await settledCaptures();
    // The corpus is the evidence: a silent skip here would prove nothing.
    expect(captures.length).toBeGreaterThan(15);
    expect(new Set(captures.map((c) => c.harness)).size).toBeGreaterThanOrEqual(7);
    const failures: string[] = [];
    for (const { harness, scenario, chunks } of captures) {
      for (const fraction of [0.2, 0.4, 0.6, 0.8]) {
        const at = Math.max(1, Math.floor(chunks.length * fraction));
        const seat = rig(harness);
        await seat.feed(BINDING, chunks.slice(0, at));
        expect(seat.detach(), `${harness}/${scenario}@${String(fraction)} detach`).toBe(true);
        await seat.feed(DRAIN, chunks.slice(at));
        if (!seat.runtime.isSeatIdle(DRAIN)) {
          const slot = seat.runtime.machine.getSlot(DRAIN);
          failures.push(`${harness}/${scenario}@${String(fraction)}: ${slot?.state ?? "none"} (${slot?.reason ?? ""})`);
        }
        for (const cleanup of cleanups.splice(0)) cleanup();
      }
    }
    expect(failures).toEqual([]);
  }, 300_000);

  it("for contrast: Grok read on an empty grid from mid-turn does NOT settle", async () => {
    const fixture = loadP1Fixture("grok", "working-turn")!;
    const chunks = chunkEvents(fixture.events, "split-at-escapes");
    const whole = await feedStream("grok", chunks, sizeOf("grok"));
    expect(whole.isSeatIdle).toBe(true);
    let settled = 0;
    const starts = 12;
    for (let i = 1; i <= starts; i += 1) {
      const from = Math.floor((chunks.length * i) / (starts + 1));
      if ((await feedStream("grok", chunks.slice(from), sizeOf("grok"))).isSeatIdle) settled += 1;
    }
    // Most late starts never reach a confirmed idle. This is why the grid moves.
    expect(settled).toBeLessThan(starts / 2);
  }, 120_000);
});

describe("rekey: the contract the host and the drain manager rely on", () => {
  const capture = () => chunkEvents(loadP1Fixture("claude", "working-turn")!.events, "split-at-escapes");

  it("moves the grid and the reading whole, and the binding reads vacant at once", async () => {
    const chunks = capture();
    const seat = rig("claude");
    await seat.feed(BINDING, chunks.slice(0, 8));
    const before = await seat.plane.get(BINDING)!.snapshot();
    const stateBefore = seat.runtime.getState(BINDING);
    expect(seat.detach()).toBe(true);

    expect(seat.plane.get(BINDING)).toBeUndefined();
    expect(seat.runtime.machine.getSlot(BINDING)).toBeUndefined();
    expect(seat.runtime.getState(BINDING)).toBeUndefined();
    expect(seat.runtime.isSeatIdle(BINDING)).toBe(false);

    const after = await seat.plane.get(DRAIN)!.snapshot();
    expect(after.bindingId).toBe(DRAIN);
    expect(after.epoch).toBe(EPOCH);
    expect(after.text).toBe(before.text);
    expect(after.signals.title).toBe(before.signals.title);
    expect(after.seq).toBe(before.seq);
    expect(seat.runtime.getState(DRAIN)).toBe(stateBefore);
    expect(seat.runtime.machine.getSlot(DRAIN)?.epoch).toBe(EPOCH);
  });

  it("tells the seat its generation is gone, as unbind does, before the drain is announced", async () => {
    const seat = rig("claude");
    const order: string[] = [];
    seat.runtime.subscribe((event) => order.push(`seat:${event.bindingId}:${event.state}`));
    seat.runtime.subscribeDrain((event) => order.push(`drain:${event.state}`));
    seat.runtime.machine.force(BINDING, "working", "test_working", "high");
    order.length = 0;
    expect(seat.runtime.rekey(BINDING, DRAIN, "offboard_detached")).toBe(true);
    expect(order).toEqual(["seat:seat-1:gone", "drain:working"]);
    expect(seat.seatEvents.at(-1)).toMatchObject({
      bindingId: BINDING,
      epoch: EPOCH,
      state: "gone",
      reason: "offboard_detached",
      harness: "claude",
    });
    // A late exit of the drained generation says nothing more about the seat.
    const before = seat.seatEvents.length;
    seat.runtime.unbind(DRAIN, EPOCH, "drain_settled");
    seat.runtime.unbind(BINDING, EPOCH, "late_exit");
    expect(seat.seatEvents.length).toBe(before);
  });

  it("returns false and changes nothing when there is nothing to move, or the key is taken", async () => {
    const seat = rig("claude");
    expect(seat.plane.rekey("no-such-binding", drainKeyOf("no-such-binding", EPOCH))).toBe(false);
    expect(seat.runtime.rekey("no-such-binding", drainKeyOf("no-such-binding", EPOCH))).toBe(false);
    // A key that is not a drain key is refused: a seat is never renamed onto another seat.
    expect(seat.plane.rekey(BINDING, "seat-2")).toBe(false);
    expect(seat.runtime.rekey(BINDING, "seat-2")).toBe(false);
    expect(seat.plane.get(BINDING)).toBeDefined();
    expect(seat.runtime.machine.getSlot(BINDING)).toBeDefined();
    expect(seat.detach()).toBe(true);
    // Same generation twice: the drain key is taken, the second call is a no-op.
    seat.attach(EPOCH);
    seat.runtime.bindHarness(BINDING, "claude", EPOCH);
    expect(seat.plane.rekey(BINDING, DRAIN)).toBe(false);
    expect(seat.runtime.rekey(BINDING, DRAIN)).toBe(false);
    expect(seat.plane.get(BINDING)).toBeDefined();
    expect(seat.runtime.machine.getSlot(BINDING)).toBeDefined();
  });

  it("the fresh generation binds clean on the vacated binding, with no fence from the old one", async () => {
    const chunks = capture();
    const seat = rig("claude");
    await seat.feed(BINDING, chunks.slice(0, 8));
    expect(seat.detach()).toBe(true);

    seat.attach("e2");
    seat.runtime.bindHarness(BINDING, "claude", "e2");
    expect(seat.runtime.machine.getSlot(BINDING)).toMatchObject({ epoch: "e2", state: "unknown", reason: "generation_bound" });
    // The fresh grid is empty; the drained one kept its screen.
    expect((await seat.plane.get(BINDING)!.snapshot()).text.trim()).toBe("");
    expect((await seat.plane.get(DRAIN)!.snapshot()).text.trim()).not.toBe("");

    // Both are read independently from here on.
    await seat.feed(DRAIN, chunks.slice(8));
    expect(seat.runtime.isSeatIdle(DRAIN)).toBe(true);
    expect(seat.runtime.getState(BINDING)).toBe("unknown");
    await seat.feed(BINDING, chunks.map((chunk) => ({ ...chunk })));
    expect(seat.runtime.isSeatIdle(BINDING)).toBe(true);
    expect(seat.runtime.machine.getSlot(BINDING)?.epoch).toBe("e2");

    // The old generation ends the way a binding's does today.
    seat.runtime.unbind(DRAIN, EPOCH, "drain_settled");
    seat.plane.detach(DRAIN, EPOCH);
    expect(seat.runtime.machine.getSlot(DRAIN)).toBeUndefined();
    expect(seat.plane.get(DRAIN)).toBeUndefined();
    expect(seat.runtime.isSeatIdle(BINDING)).toBe(true);
  });

  it("no ordinary subscriber ever sees a drain key; the drain listener sees nothing else", async () => {
    const chunks = capture();
    const seat = rig("claude");
    const globalSnaps: string[] = [];
    const replayed: string[] = [];
    const verdicts: string[] = [];
    seat.plane.subscribeGlobal((snap) => globalSnaps.push(snap.bindingId));
    seat.runtime.subscribeComposerVerdict((bindingId) => verdicts.push(bindingId));
    await seat.feed(BINDING, chunks.slice(0, 8));
    const seatEventsAtDetach = seat.seatEvents.length;
    expect(seat.detach()).toBe(true);
    await seat.feed(DRAIN, chunks.slice(8));
    // A subscriber that arrives while a session drains is not replayed it.
    seat.plane.subscribeAll((snap) => replayed.push(snap.bindingId));

    expect(seat.drainEvents.length).toBeGreaterThan(0);
    expect(seat.drainEvents.every((event) => event.bindingId === DRAIN)).toBe(true);
    // The first thing the drain listener hears is the moved slot, as it was.
    expect(seat.drainEvents[0]).toMatchObject({ bindingId: DRAIN, epoch: EPOCH });
    expect(seat.drainEvents.at(-1)).toMatchObject({ bindingId: DRAIN, state: "idle" });

    expect(seat.seatEvents.some((event) => isDrainKey(event.bindingId))).toBe(false);
    expect(globalSnaps.some(isDrainKey)).toBe(false);
    expect(replayed.some(isDrainKey)).toBe(false);
    expect(verdicts.some(isDrainKey)).toBe(false);
    expect(seat.runtime.currentEvents().some((event) => isDrainKey(event.bindingId))).toBe(false);
    // The seat hears one thing: that generation is gone. Nothing the drained
    // session did afterwards was reported as the seat's.
    expect(seat.seatEvents.slice(seatEventsAtDetach)).toEqual([
      expect.objectContaining({ bindingId: BINDING, epoch: EPOCH, state: "gone", reason: "offboard_detached" }),
    ]);
  });

  it("an idle still waiting out its debounce is published under the drain key, not the seat's", async () => {
    const seat = rig("claude");
    const machine = seat.runtime.machine;
    machine.force(BINDING, "working", "test_working", "high");
    expect(seat.detach()).toBe(true);
    expect(machine.getSlot(DRAIN)).toMatchObject({ state: "working", reason: "test_working" });
    machine.force(DRAIN, "idle", "test_idle", "high");
    expect(seat.drainEvents.at(-1)).toMatchObject({ bindingId: DRAIN, state: "idle" });
    expect(seat.seatEvents.some((event) => event.state === "idle")).toBe(false);
    expect(seat.seatEvents.at(-1)).toMatchObject({ bindingId: BINDING, state: "gone" });
  });

  it("drain keys are told apart from bindings by one shared rule", () => {
    expect(DRAIN).toBe("drain:seat-1:e1");
    expect(isDrainKey(DRAIN)).toBe(true);
    expect(isDrainKey(BINDING)).toBe(false);
    expect(isDrainKey("bind-drain:1")).toBe(false);
  });
});
