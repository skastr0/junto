import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { ActorSeatId } from "../src/shared/actor-seat";
import type { InstallationId } from "../src/shared/installation-id";
import { asNodeId } from "../src/shared/physics/schema";
import {
  afterOf,
  emptyRuled,
  type ItemId,
  mintItemId,
  mintOpId,
  OpId,
  overlay,
  REFUSAL,
  type RefusalReason,
  type ResourceActor,
  type ResourceCommand,
  type ResourceDomain,
  resourceCommandSchema,
  rule,
  type RulingContext,
  writtenOn,
} from "../src/shared/resource-command";

// A stand-in domain with one invariant, enough to exercise the envelope:
// an item is held by at most one seat, and only its holder releases it.
type Op = { readonly kind: "hold" } | { readonly kind: "release" };
type Fact = { readonly kind: "held" | "released"; readonly item: ItemId; readonly by: string };
type State = ReadonlyMap<ItemId, string>;

const holdDomain: ResourceDomain<State, Op, Fact> = {
  kind: "task",
  rule: (state, { op, target, actor }) => {
    const item = target.itemId!;
    const by = actor.kind === "seat" ? actor.nodeId : actor.kind;
    const holder = state.get(item);
    switch (op.kind) {
      case "hold":
        return holder === undefined
          ? { kind: "apply", facts: [{ kind: "held", item, by }] }
          : { kind: "refuse", refusal: { reason: "already_held", message: `Held by ${holder}`, expected: holder } };
      case "release":
        return holder === by
          ? { kind: "apply", facts: [{ kind: "released", item, by }] }
          : { kind: "refuse", refusal: { reason: "invalid_transition", message: "Only the holder releases" } };
    }
  },
  apply: (state, fact) => {
    const next = new Map(state);
    if (fact.kind === "held") next.set(fact.item, fact.by);
    else next.delete(fact.item);
    return next;
  },
};

const mini = "mini" as InstallationId;
const laptop = "laptop" as InstallationId;
const everywhere: RulingContext = { inReach: () => true };
const seat = (name: string): ResourceActor => ({ kind: "seat", seatId: `seat_${name.padEnd(64, "0")}` as ActorSeatId, nodeId: asNodeId(name) });
const tasks = asNodeId("tasks");

const command = (actor: ResourceActor, item: ItemId, op: Op, after: ReadonlyArray<OpId> = []): ResourceCommand<Op> => ({
  opId: mintOpId(),
  canvasName: "factory",
  actor,
  target: { kind: "task", nodeId: tasks, itemId: item },
  basis: null,
  after,
  op,
});

describe("rule", () => {
  it("applies, and answers a repeated command with the first ruling and no new state", () => {
    const item = mintItemId();
    const hold = command(seat("a"), item, { kind: "hold" });
    const first = rule(holdDomain, emptyRuled<State, Fact>(new Map()), mini, hold, everywhere);
    expect(first.ruling.kind).toBe("applied");
    const again = rule(holdDomain, first.ruled, mini, hold, everywhere);
    expect(again.ruling).toBe(first.ruling);
    expect(again.ruled).toBe(first.ruled);
  });

  it("keys rulings by writer: the same opId from another machine is its own command", () => {
    const item = mintItemId();
    const hold = command(seat("a"), item, { kind: "hold" });
    const first = rule(holdDomain, emptyRuled<State, Fact>(new Map()), mini, hold, everywhere);
    const other = rule(holdDomain, first.ruled, laptop, { ...hold, actor: seat("b") }, everywhere);
    expect(other.ruling.kind).toBe("refused");
    expect(other.ruled.rulings.size).toBe(2);
  });

  it("first ruled wins, and the refusal carries the typed error", () => {
    const item = mintItemId();
    const a = rule(holdDomain, emptyRuled<State, Fact>(new Map()), mini, command(seat("a"), item, { kind: "hold" }), everywhere);
    const b = rule(holdDomain, a.ruled, laptop, command(seat("b"), item, { kind: "hold" }), everywhere);
    expect(b.ruling.kind).toBe("refused");
    if (b.ruling.kind !== "refused") return;
    expect(b.ruling.error).toMatchObject({ type: "ClaimConflict", details: { reason: "already_held", retryable: false, expected: "a" } });
    expect(b.ruled.state).toBe(a.ruled.state);
  });

  it("refuses out of reach before the domain sees the command", () => {
    const ruled = rule(holdDomain, emptyRuled<State, Fact>(new Map()), mini, command(seat("a"), mintItemId(), { kind: "hold" }), { inReach: () => false });
    expect(ruled.ruling.kind === "refused" && ruled.ruling.error).toMatchObject({ type: "ScopeError", details: { reason: "not_in_reach" } });
  });

  it("refuses the dependents of a refused command, naming the root", () => {
    const item = mintItemId();
    const taken = rule(holdDomain, emptyRuled<State, Fact>(new Map()), laptop, command(seat("b"), item, { kind: "hold" }), everywhere).ruled;
    const hold = command(seat("a"), item, { kind: "hold" });
    const release = command(seat("a"), item, { kind: "release" }, [hold.opId]);
    const again = command(seat("a"), item, { kind: "hold" }, [release.opId]);
    const one = rule(holdDomain, taken, mini, hold, everywhere);
    const two = rule(holdDomain, one.ruled, mini, release, everywhere);
    const three = rule(holdDomain, two.ruled, mini, again, everywhere);
    for (const step of [two, three]) {
      expect(step.ruling.kind === "refused" && step.ruling.root).toBe(hold.opId);
      expect(step.ruling.kind === "refused" && step.ruling.error.details).toMatchObject({ reason: "depends_on_refused", from: hold.opId });
    }
  });
});

describe("overlay", () => {
  it("shows the writer's unruled commands over ruled state, and drops one once ruled", () => {
    const item = mintItemId();
    const hold = command(seat("a"), item, { kind: "hold" });
    const ruled = emptyRuled<State, Fact>(new Map());
    const view = overlay(holdDomain, ruled, mini, [hold], everywhere);
    expect(view.state.get(item)).toBe("a");
    expect(view.pending).toEqual([{ opId: hold.opId, status: "pending" }]);
    const afterRuling = rule(holdDomain, ruled, mini, hold, everywhere).ruled;
    expect(overlay(holdDomain, afterRuling, mini, [hold], everywhere).pending).toEqual([]);
  });

  it("marks a command the ruled state would now refuse as at risk and leaves it out of the state", () => {
    const item = mintItemId();
    const taken = rule(holdDomain, emptyRuled<State, Fact>(new Map()), laptop, command(seat("b"), item, { kind: "hold" }), everywhere).ruled;
    const hold = command(seat("a"), item, { kind: "hold" });
    const view = overlay(holdDomain, taken, mini, [hold], everywhere);
    expect(view.state.get(item)).toBe("b");
    expect(view.pending).toEqual([{ opId: hold.opId, status: "at_risk", refusal: { reason: "already_held", message: "Held by b" } }]);
  });

  it("lists as after the earlier pending commands on the same item only", () => {
    const item = mintItemId();
    const mine = command(seat("a"), item, { kind: "hold" });
    const elsewhere = command(seat("a"), mintItemId(), { kind: "hold" });
    expect(afterOf([mine, elsewhere], mine.target)).toEqual([mine.opId]);
  });
});

describe("envelope", () => {
  const decode = Schema.decodeUnknownSync(resourceCommandSchema(Schema.Struct({ kind: Schema.Literals(["hold", "release"]) })));

  it("decodes a command and refuses an opId with a writer prefix", () => {
    const item = mintItemId();
    const good = command(seat("a"), item, { kind: "hold" });
    expect(decode(good)).toEqual(good);
    expect(() => decode({ ...good, opId: `mini:${good.opId}` })).toThrow();
    expect(() => decode({ ...good, op: { kind: "steal" } })).toThrow();
  });

  it("writes the operator's and an automation's commands only on the editing machine", () => {
    expect(writtenOn(seat("a"))).toBe("seat-machine");
    expect(writtenOn({ kind: "operator" })).toBe("editing-machine");
    expect(writtenOn({ kind: "automation", nodeId: asNodeId("auto"), automationId: mintItemId() })).toBe("editing-machine");
  });

  it("marks only stale, rebase conflicts and a full queue as retryable", () => {
    const retryable = (Object.keys(REFUSAL) as RefusalReason[]).filter((reason) => REFUSAL[reason].retryable).sort();
    expect(retryable).toEqual(["queue_full", "rebase_conflict", "stale"]);
  });

  it("closes the id, reason and actor types", () => {
    // @ts-expect-error: an opId is minted or decoded, never a bare string.
    const bare: OpId = "01J00000000000000000000000";
    // @ts-expect-error: no reason outside the closed set.
    const reason: RefusalReason = "forbidden";
    // @ts-expect-error: a seat actor carries its seat id, as a mail author does.
    const unnamed: ResourceActor = { kind: "seat", nodeId: asNodeId("a") };
    // @ts-expect-error: a create names its item with a minted id, not a node id.
    const item: ItemId = asNodeId("task-1");
    expect([bare, reason, unnamed, item]).toHaveLength(4);
  });
});
