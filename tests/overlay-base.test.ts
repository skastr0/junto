/**
 * The overlay over a base this machine has not completed (plan 0.10, 02,
 * pending state): a replica that has not pulled the body of a ruled artifact
 * edit cannot preview a seat's command across it, so the command is listed
 * at_risk waiting, with no preview on the stale state, and so is every
 * command that builds on it. The editing machine rules it on real state.
 */
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { ActorSeatId } from "../src/shared/actor-seat";
import type { InstallationId } from "../src/shared/installation-id";
import { asNodeId } from "../src/shared/physics/schema";
import {
  emptyRuled,
  type ItemId,
  mintItemId,
  mintOpId,
  type OpId,
  overlay,
  type OverlayContext,
  RefusalReason,
  type ResourceCommand,
  type ResourceDomain,
  type ResourceRef,
  rule,
} from "../src/shared/resource-command";

// One invariant: an item is held by at most one seat.
type Op = { readonly kind: "hold" };
type Fact = { readonly item: ItemId; readonly by: string };
type State = ReadonlyMap<ItemId, string>;

const holdDomain: ResourceDomain<State, Op, Fact> = {
  kind: "artifact",
  rule: (state, { target, actor }) => {
    const holder = state.get(target.itemId!);
    return holder === undefined
      ? { kind: "apply", facts: [{ item: target.itemId!, by: actor.kind === "seat" ? actor.nodeId : actor.kind }] }
      : { kind: "refuse", refusal: { reason: "already_held", message: `Held by ${holder}` } };
  },
  apply: (state, fact) => new Map(state).set(fact.item, fact.by),
};

const mini = "mini" as InstallationId;
const laptop = "laptop" as InstallationId;
const seat = { kind: "seat" as const, seatId: `seat_${"a".repeat(64)}` as ActorSeatId, nodeId: asNodeId("a") };
const shelf = asNodeId("shelf");
const STALE = mintItemId();
const FRESH = mintItemId();
const TAKEN = mintItemId();

const hold = (item: ItemId, after: ReadonlyArray<OpId> = []): ResourceCommand<Op> => ({
  opId: mintOpId(),
  canvasName: "factory",
  actor: seat,
  target: { kind: "artifact", nodeId: shelf, itemId: item },
  basis: null,
  after,
  op: { kind: "hold" },
});

/** Every base is complete but STALE's, whose last edit is not pulled here. */
const context: OverlayContext = {
  inReach: () => true,
  baseComplete: (target: ResourceRef) => target.itemId !== STALE,
};

// TAKEN is already held by a seat on another machine.
const ruled = rule(holdDomain, emptyRuled<State, Fact>(new Map()), laptop, hold(TAKEN), { inReach: () => true }).ruled;

describe("the overlay over an incomplete base", () => {
  const onStale = hold(STALE);
  const onFresh = hold(FRESH);
  const builds = hold(FRESH, [onStale.opId]);
  const buildsOnBuilds = hold(TAKEN, [builds.opId]);
  const onTaken = hold(TAKEN);

  const cases: ReadonlyArray<{ readonly name: string; readonly queued: ReadonlyArray<ResourceCommand<Op>>; readonly expected: ReadonlyArray<object> }> = [
    {
      name: "a command on a base not pulled waits, with itself as root",
      queued: [onStale],
      expected: [{ opId: onStale.opId, status: "at_risk", waiting: "base_not_pulled", root: onStale.opId }],
    },
    {
      name: "a command on a complete base is previewed as before",
      queued: [onFresh],
      expected: [{ opId: onFresh.opId, status: "pending" }],
    },
    {
      name: "every command whose after chain reaches a waiting one waits on its root, even on a complete base",
      queued: [onStale, builds, buildsOnBuilds],
      expected: [
        { opId: onStale.opId, status: "at_risk", waiting: "base_not_pulled", root: onStale.opId },
        { opId: builds.opId, status: "at_risk", waiting: "base_not_pulled", root: onStale.opId },
        { opId: buildsOnBuilds.opId, status: "at_risk", waiting: "base_not_pulled", root: onStale.opId },
      ],
    },
    {
      name: "a refusal on a complete base still reads as a refusal",
      queued: [onTaken],
      expected: [{ opId: onTaken.opId, status: "at_risk", refusal: { reason: "already_held", message: "Held by a" } }],
    },
    {
      name: "unrelated commands beside a waiting one are previewed on their own merits",
      queued: [onStale, onFresh],
      expected: [
        { opId: onStale.opId, status: "at_risk", waiting: "base_not_pulled", root: onStale.opId },
        { opId: onFresh.opId, status: "pending" },
      ],
    },
  ];

  for (const { name, queued, expected } of cases) {
    it(name, () => {
      expect(overlay(holdDomain, ruled, mini, queued, context).pending).toEqual(expected);
    });
  }

  it("leaves a waiting command, and what builds on it, out of the previewed state", () => {
    const view = overlay(holdDomain, ruled, mini, [onStale, builds, onFresh], context);
    expect(view.state.has(STALE)).toBe(false);
    expect([...view.state.keys()].sort()).toEqual([FRESH, TAKEN].sort());
  });

  it("with no answer on the base, every base is complete", () => {
    expect(overlay(holdDomain, ruled, mini, [onStale], { inReach: () => true }).pending).toEqual([{ opId: onStale.opId, status: "pending" }]);
  });

  it("judges a reach exemption on the ruled state, never on the preview", () => {
    // The holder of an item may move it from out of reach; seat b gives it to a, unruled.
    type GiveOp = { readonly kind: "give"; readonly to: string } | { readonly kind: "move" };
    const giveDomain: ResourceDomain<State, GiveOp, Fact> = {
      kind: "artifact",
      rule: (_state, { target, op, actor }) => ({
        kind: "apply",
        facts: [{ item: target.itemId!, by: op.kind === "give" ? op.to : actor.kind === "seat" ? actor.nodeId : actor.kind }],
      }),
      apply: (state, fact) => new Map(state).set(fact.item, fact.by),
      reachExempt: (state, { target, actor }) => actor.kind === "seat" && state.get(target.itemId!) === actor.nodeId,
    };
    const b = { ...seat, nodeId: asNodeId("b") };
    const give: ResourceCommand<GiveOp> = { ...hold(FRESH), actor: b, op: { kind: "give", to: "a" } };
    const move: ResourceCommand<GiveOp> = { ...hold(FRESH), op: { kind: "move" } };
    // Only b reaches the shelf: a holds the item only in the preview.
    const onlyB = { inReach: (actor: { readonly kind: string; readonly nodeId?: string }) => actor.nodeId === "b" };
    const view = overlay(giveDomain, emptyRuled<State, Fact>(new Map()), mini, [give, move], onlyB);
    expect(view.pending).toEqual([
      { opId: give.opId, status: "pending" },
      { opId: move.opId, status: "at_risk", refusal: { reason: "not_in_reach", message: "The resource is not in this actor's reach" } },
    ]);
    // The same exemption on state that is ruled admits it.
    const ruledGive = rule(giveDomain, emptyRuled<State, Fact>(new Map()), laptop, give, onlyB).ruled;
    expect(overlay(giveDomain, ruledGive, mini, [move], onlyB).pending).toEqual([{ opId: move.opId, status: "pending" }]);
  });

  it("waiting is no ruling: base_not_pulled is not a refusal reason", () => {
    expect(Schema.is(RefusalReason)("base_not_pulled")).toBe(false);
  });
});
