import { Result } from "effect";
import { describe, expect, it } from "vitest";
import type { AgentSeatState } from "../src/shared/wire/seat-activity";
import type { AgentSignal } from "../src/shared/wire/agent-signals";
import { BROADCAST_SEATS_MAX, decodeOverseerArgs } from "../src/shared/overseer-control";
import { THIS_MACHINE } from "./support/machines";
import { canvasOf, peer, region, seat } from "./support/model-nodes";
import {
  audienceDigest,
  checkBroadcastSet,
  readAudience,
  type AudienceReadings,
  type BroadcastSelection,
} from "../src/core/overseer/broadcast";

// Junto holds CLI and Product; CLI holds lead and boss (the overseer);
// Product holds design, a seat of another machine and a peer. A second region
// is also called "CLI", inside Product, so the name is shared.
const at = (x: number, y: number) => ({ x, y, width: 100, height: 50 });
const board = canvasOf([
  region("junto", { x: 0, y: 0, width: 2000, height: 1000 }, { label: "Junto" }),
  region("cli", { x: 10, y: 10, width: 800, height: 400 }, { label: "CLI" }),
  region("product", { x: 1000, y: 10, width: 900, height: 900 }, { label: "Product" }),
  region("cli-2", { x: 1500, y: 500, width: 300, height: 300 }, { label: "cli" }),
  seat("lead", { ...at(20, 20), label: "cli-lead" }),
  seat("boss", { ...at(200, 20), label: "cli-overseer", overseer: true }),
  seat("design", { ...at(1010, 20), label: "product-design" }),
  seat("far", { ...at(1020, 200), label: "remote-seat", host: "other-machine" }),
  peer("copy", { ...at(1600, 600), label: "copied-seat" }),
  seat("outside", { ...at(5000, 5000), label: "outside" }),
]);

const signal = (nodeId: string, kind: AgentSignal["kind"], more: Partial<AgentSignal> = {}): AgentSignal => ({
  signalId: `sig-${nodeId}-${kind}`,
  canvasName: "factory",
  nodeId,
  kind,
  text: "t",
  createdAt: 1,
  state: "open",
  level: "review",
  rank: 7,
  ready: true,
  waitingOn: [],
  ...more,
} as AgentSignal);

// lead works and waits on the operator; design has nothing bound, so it is off;
// far's machine reported it idle over a link that still holds.
const local: Record<string, AgentSeatState> = { "binding-lead": "working", "binding-boss": "working" };
const readingsWith = (more: Partial<AudienceReadings> = {}): AudienceReadings => ({
  machineName: THIS_MACHINE,
  localState: (bindingId) => local[bindingId],
  remoteState: (bindingId) => bindingId === "binding-far"
    ? { event: { state: "idle" }, current: true }
    : { event: undefined, current: false },
  signals: [
    signal("lead", "escalate"),
    signal("design", "feedback"),
    // Closed, and an automation's: neither is what a seat needs.
    signal("far", "blocked", { state: "answered" }),
    signal("far", "feedback", { source: { kind: "automation" } } as Partial<AgentSignal>),
  ],
  ...more,
});

const audience = (selection: BroadcastSelection, readings = readingsWith()) =>
  readAudience({ canvasName: "factory", canvas: board, callerId: "boss", selection, readings });

const success = <A, E>(read: Result.Result<A, E>): A => {
  if (!Result.isSuccess(read)) throw new Error(`expected a set, got ${JSON.stringify(read.failure)}`);
  return read.success;
};

describe("the broadcast set", () => {
  it("is every seat in a region and the regions inside it, by node id, never the overseer's own", () => {
    const read = success(audience({ region: ["Junto"] }));
    expect(read.seats.map((seat) => seat.nodeId)).toEqual(["copy", "design", "far", "lead"]);
    expect(read.count).toBe(4);
    expect(read.seats.find((seat) => seat.nodeId === "lead")).toEqual({
      canvasName: "factory",
      nodeId: "lead",
      name: "cli-lead",
      running: true,
      elsewhere: false,
    });
    // design is off, the peer has no reading; far and the peer sit on another machine.
    expect(read.notRunning).toBe(2);
    expect(read.elsewhere).toBe(2);
    expect(read.picks).toEqual([{ region: "Junto", regionId: "junto", count: 4, unread: 0 }]);
    expect(read.unread).toEqual({ count: 0, seats: [] });
    expect(read.set).toBe(audienceDigest(["copy", "design", "far", "lead"]));
    expect(read.set).toMatch(/^[0-9a-f]{16}$/u);
  });

  it("adds regions and single seats up in pick order, with no seat twice", () => {
    const read = success(audience({ region: ["product", "Product"], seat: ["outside", "product-design", "cli-overseer"] }));
    expect(read.seats.map((seat) => seat.nodeId)).toEqual(["copy", "design", "far", "outside"]);
    expect(read.picks.map((pick) => pick.count)).toEqual([3, 3, 1, 1, 0]);
  });

  it("narrows every region pick by what the seat is doing, any of the chosen", () => {
    const working = success(audience({ region: ["Junto"], doing: ["working"] }));
    expect(working.seats.map((seat) => seat.nodeId)).toEqual(["lead"]);
    const idleOrOff = success(audience({ region: ["Junto"], doing: ["idle", "off"] }));
    expect(idleOrOff.seats.map((seat) => seat.nodeId)).toEqual(["design", "far"]);
  });

  it("names apart, never drops, the seats a doing limit cannot read", () => {
    const read = success(audience({ region: ["Junto"], doing: ["working"] }));
    // The peer has no current reading: it is neither in the set nor silently gone.
    expect(read.unread.count).toBe(1);
    expect(read.unread.seats.map((seat) => seat.nodeId)).toEqual(["copy"]);
    expect(read.picks).toEqual([{ region: "Junto", regionId: "junto", count: 1, unread: 1 }]);
    // A seat elsewhere whose link was lost is unread too.
    const lost = success(audience({ region: ["Junto"], doing: ["idle", "off"] }, readingsWith({
      remoteState: () => ({ event: { state: "idle" }, current: false }),
    })));
    expect(lost.seats.map((seat) => seat.nodeId)).toEqual(["design"]);
    expect(lost.unread.seats.map((seat) => seat.nodeId)).toEqual(["copy", "far"]);
  });

  it("narrows by what the seat needs, from its own open signals only, and both limits together", () => {
    const needs = success(audience({ region: ["Junto"], needs: ["escalate", "feedback"] }));
    expect(needs.seats.map((seat) => seat.nodeId)).toEqual(["design", "lead"]);
    const blocked = audience({ region: ["Junto"], needs: ["blocked"] });
    expect(Result.isFailure(blocked) && blocked.failure.type).toBe("InputError");
    const both = success(audience({ region: ["Junto"], doing: ["working"], needs: ["escalate", "feedback"] }));
    expect(both.seats.map((seat) => seat.nodeId)).toEqual(["lead"]);
  });

  it("puts no limit on a single seat", () => {
    const read = success(audience({ region: ["cli"], seat: ["product-design"], doing: ["working"] }));
    expect(read.seats.map((seat) => seat.nodeId)).toEqual(["lead", "design"]);
  });

  it("refuses a name two regions share, listing each with its node id and the regions around it", () => {
    const read = audience({ region: ["CLI"] });
    expect(Result.isFailure(read)).toBe(true);
    if (!Result.isFailure(read)) return;
    expect(read.failure.type).toBe("InputError");
    expect(read.failure.message).toContain("CLI [cli] in Junto");
    expect(read.failure.message).toContain("cli [cli-2] in Junto / Product");
    expect(read.failure.message).toContain("never a path");
    expect(read.failure.details?.candidates?.map((candidate) => candidate.nodeId)).toEqual(["cli", "cli-2"]);
    // The node id names the one meant.
    expect(success(audience({ region: ["cli"] })).seats.map((seat) => seat.nodeId)).toEqual(["lead"]);
  });

  it("refuses a region or a seat it does not know, and a set with nothing in it", () => {
    const unknown = audience({ region: ["Nowhere"] });
    expect(Result.isFailure(unknown) && unknown.failure.type).toBe("UnknownTarget");
    const noSeat = audience({ seat: ["nobody"] });
    expect(Result.isFailure(noSeat) && noSeat.failure.type).toBe("UnknownTarget");
    const onlySelf = audience({ seat: ["cli-overseer"] });
    expect(Result.isFailure(onlySelf) && onlySelf.failure.type).toBe("InputError");
    expect(Result.isFailure(onlySelf) && onlySelf.failure.message).toContain("nothing to send");
    // An empty set that left seats out unread names them.
    const unreadOnly = audience({ region: ["cli-2"], doing: ["working"] });
    expect(Result.isFailure(unreadOnly) && unreadOnly.failure.message).toContain("copied-seat");
  });

  it("refuses a set past the cap whole, in the audience too", () => {
    const many = canvasOf([
      region("all", { x: 0, y: 0, width: 100_000, height: 100 }, { label: "All" }),
      ...Array.from({ length: BROADCAST_SEATS_MAX + 1 }, (_, index) => seat(`s${index}`, { ...at(index * 200, 20), label: `s${index}` })),
    ]);
    const capped = readAudience({ canvasName: "factory", canvas: many, callerId: "boss", selection: { region: ["All"] }, readings: readingsWith() });
    expect(Result.isFailure(capped)).toBe(true);
    if (!Result.isFailure(capped)) return;
    expect(capped.failure.type).toBe("InputError");
    expect(capped.failure.details).toMatchObject({ reason: "set_too_large", received: { count: BROADCAST_SEATS_MAX + 1 } });
  });

  it("takes a digest over the sorted node ids that order and repeats do not change", () => {
    expect(audienceDigest(["b", "a", "a"])).toBe(audienceDigest(["a", "b"]));
    expect(audienceDigest(["a", "b"])).not.toBe(audienceDigest(["a", "c"]));
    // Pick order does not change it either.
    expect(success(audience({ region: ["cli"], seat: ["product-design"] })).set)
      .toBe(success(audience({ seat: ["product-design", "cli-lead"] })).set);
  });
});

describe("the broadcast guard", () => {
  const set = success(audience({ region: ["Junto"] }));

  it("passes the set the overseer named, by count, and by digest when it sent one", () => {
    expect(Result.isSuccess(checkBroadcastSet(set, { expect: 4 }))).toBe(true);
    expect(Result.isSuccess(checkBroadcastSet(set, { expect: 4, set: set.set }))).toBe(true);
  });

  it("refuses another count, or the same count with another digest, with the set as it is now", () => {
    const count = checkBroadcastSet(set, { expect: 3 });
    expect(Result.isFailure(count)).toBe(true);
    if (!Result.isFailure(count)) return;
    expect(count.failure.type).toBe("Stale");
    expect(count.failure.message).toContain("Nothing was sent");
    expect(count.failure.details).toMatchObject({
      reason: "set_changed",
      expected: { count: 3 },
      received: { count: 4, set: set.set },
    });
    const digest = checkBroadcastSet(set, { expect: 4, set: "0000000000000000" });
    expect(Result.isFailure(digest) && digest.failure.details?.reason).toBe("set_changed");
  });
});

describe("the broadcast arguments", () => {
  const decode = (args: unknown) => decodeOverseerArgs("msg.broadcast", args);

  it("take the shared function's own limits, and need --expect within the cap", () => {
    expect(Result.isSuccess(decode({ region: ["Junto"], doing: ["working", "off"], needs: ["blocked"], text: "stop", expect: 3 }))).toBe(true);
    expect(Result.isFailure(decode({ region: ["Junto"], doing: ["busy"], text: "stop", expect: 3 }))).toBe(true);
    expect(Result.isFailure(decode({ region: ["Junto"], needs: ["waiting"], text: "stop", expect: 3 }))).toBe(true);
    expect(Result.isFailure(decode({ region: ["Junto"], text: "stop" }))).toBe(true);
    expect(Result.isFailure(decode({ region: ["Junto"], text: "stop", expect: BROADCAST_SEATS_MAX + 1 }))).toBe(true);
    expect(Result.isFailure(decode({ region: ["Junto"], text: "stop", expect: 3, set: "3f9a0c21b7de" }))).toBe(true);
  });

  it("refuse a limit with no region to narrow, and a mark the caller supplies", () => {
    expect(Result.isFailure(decode({ seat: ["cli-lead"], doing: ["working"], text: "stop", expect: 1 }))).toBe(true);
    expect(Result.isFailure(decode({ region: ["Junto"], text: "stop", expect: 3, broadcast: true }))).toBe(true);
    expect(Result.isFailure(decodeOverseerArgs("msg.audience", { region: ["Junto"], noWake: true }))).toBe(true);
  });
});
