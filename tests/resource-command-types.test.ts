import { describe, expect, expectTypeOf, it } from "vitest";
import type { ActorSeatId } from "../src/shared/actor-seat";
import type { InstallationId } from "../src/shared/installation-id";
import { asNodeId } from "../src/shared/physics/schema";
import {
  afterOf,
  emptyRuled,
  type ItemId,
  mintItemId,
  mintOpId,
  type OpId,
  overlay,
  type PendingEntry,
  REFUSAL,
  refusalError,
  RefusalReason,
  type ResourceActor,
  type ResourceCommand,
  type ResourceDomain,
  type ResourceKind,
  type ResourceRuling,
  type Ruled,
  rule,
  type RulingContext,
  type SubmitOutcome,
  writtenOn,
} from "../src/shared/resource-command";
import type { WorkErrorType } from "../src/shared/work-control";
import { Schema } from "effect";

// Properties of the ruler and the overlay over random command sequences, and
// the type-level locks, beside the worked examples in resource-command.test.ts.
// Seeded: a failure names the seed that replays it.

type Op = { readonly kind: "hold" } | { readonly kind: "release" };
type Fact = { readonly kind: "held" | "released"; readonly item: ItemId; readonly by: string };
type State = ReadonlyMap<ItemId, string>;

let domainCalls = 0;
const domain: ResourceDomain<State, Op, Fact> = {
  kind: "task",
  rule: (state, { op, target, actor }) => {
    domainCalls += 1;
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

const rng = (seed: number) => {
  let s = seed >>> 0;
  return (below: number): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s % below;
  };
};

const WRITERS = ["mini", "laptop"] as InstallationId[];
const NAMES = ["a", "b", "c"];
const tasks = asNodeId("tasks");
const everywhere: RulingContext = { inReach: () => true };
const seat = (name: string): ResourceActor => ({ kind: "seat", seatId: `seat_${name.padEnd(64, "0")}` as ActorSeatId, nodeId: asNodeId(name) });

type Written = { readonly writer: InstallationId; readonly command: ResourceCommand<Op> };

/** A random run: commands with `after` links only to earlier commands of the same writer. */
const randomRun = (seed: number): ReadonlyArray<Written> => {
  const next = rng(seed);
  const items = Array.from({ length: 3 }, () => mintItemId());
  const run: Written[] = [];
  const length = 4 + next(14);
  for (let i = 0; i < length; i++) {
    const writer = WRITERS[next(WRITERS.length)]!;
    const earlier = run.filter((w) => w.writer === writer);
    const after = earlier.filter(() => next(4) === 0).map((w) => w.command.opId);
    run.push({
      writer,
      command: {
        opId: mintOpId(),
        canvasName: "factory",
        actor: seat(NAMES[next(NAMES.length)]!),
        target: { kind: "task", nodeId: tasks, itemId: items[next(items.length)]! },
        basis: null,
        after,
        op: { kind: next(3) === 0 ? "release" : "hold" },
      },
    });
  }
  return run;
};

const SEEDS = Array.from({ length: 150 }, (_, i) => i + 1);
const forall = (check: (run: ReadonlyArray<Written>) => ReadonlyArray<string>) => () => {
  const violations: string[] = [];
  for (const seed of SEEDS) for (const v of check(randomRun(seed))) if (violations.length < 10) violations.push(`seed ${seed}: ${v}`);
  expect(violations).toEqual([]);
};

const ruleAll = (run: ReadonlyArray<Written>, context: RulingContext = everywhere): Ruled<State, Fact> =>
  run.reduce((ruled, { writer, command }) => rule(domain, ruled, writer, command, context).ruled, emptyRuled<State, Fact>(new Map()));

describe("rule properties", () => {
  it("is idempotent: ruling a command again returns the first ruling and the same ruled value", forall((run) => {
    const out: string[] = [];
    let ruled = emptyRuled<State, Fact>(new Map());
    for (const { writer, command } of run) {
      const first = rule(domain, ruled, writer, command, everywhere);
      const again = rule(domain, first.ruled, writer, command, everywhere);
      if (again.ruling !== first.ruling || again.ruled !== first.ruled) out.push(`${command.opId} ruled twice differently`);
      ruled = first.ruled;
    }
    return out;
  }));

  it("never mutates the ruled value it is given, and a refusal leaves the state untouched", forall((run) => {
    const out: string[] = [];
    let ruled = emptyRuled<State, Fact>(new Map());
    for (const { writer, command } of run) {
      const size = ruled.rulings.size;
      const state = ruled.state;
      const next = rule(domain, ruled, writer, command, everywhere);
      if (ruled.rulings.size !== size || ruled.state !== state) out.push(`${command.opId} mutated its input`);
      if (next.ruling.kind === "refused" && next.ruled.state !== state) out.push(`${command.opId} refused but changed state`);
      if (next.ruled.rulings.size !== size + 1) out.push(`${command.opId} did not record exactly one ruling`);
      ruled = next.ruled;
    }
    return out;
  }));

  it("refuses every dependent of a refused command, transitively, naming the first root", forall((run) => {
    const out: string[] = [];
    let ruled = emptyRuled<State, Fact>(new Map());
    const roots = new Map<string, OpId>();
    for (const { writer, command } of run) {
      const next = rule(domain, ruled, writer, command, everywhere);
      const dependsOn = command.after.map((id) => roots.get(`${writer}/${id}`)).find((root) => root !== undefined);
      if (dependsOn !== undefined) {
        const { ruling } = next;
        if (ruling.kind !== "refused" || ruling.root !== dependsOn || ruling.error.details?.reason !== "depends_on_refused") {
          out.push(`${command.opId} should depend on refused root ${dependsOn}`);
        }
        roots.set(`${writer}/${command.opId}`, dependsOn);
      } else if (next.ruling.kind === "refused") {
        if (next.ruling.root !== command.opId) out.push(`${command.opId} is its own root`);
        roots.set(`${writer}/${command.opId}`, command.opId);
      }
      ruled = next.ruled;
    }
    return out;
  }));

  it("keeps two writers apart: a ruling is read only by its own installation", forall((run) => {
    const out: string[] = [];
    const ruled = ruleAll(run);
    for (const { writer, command } of run) {
      const other = WRITERS.find((w) => w !== writer)!;
      const own = [...ruled.rulings.keys()].filter((k) => k.endsWith(`/${command.opId}`));
      if (own.length !== 1 || !own[0]!.startsWith(`${writer}/`)) out.push(`${command.opId} is keyed to ${own.join(",")}, not only ${writer} (other ${other})`);
    }
    return out;
  }));

  it("sends an out-of-reach command to the domain never, and refuses it not_in_reach", forall((run) => {
    const out: string[] = [];
    domainCalls = 0;
    const ruled = ruleAll(run, { inReach: () => false });
    if (domainCalls !== 0) out.push(`domain ran ${domainCalls} times out of reach`);
    for (const ruling of ruled.rulings.values()) {
      const reason = ruling.kind === "refused" ? ruling.error.details?.reason : undefined;
      if (ruling.kind !== "refused" || (reason !== "not_in_reach" && reason !== "depends_on_refused")) out.push(`unexpected ruling ${ruling.kind} ${String(reason)}`);
    }
    return out;
  }));
});

describe("overlay properties", () => {
  const writerRun = (run: ReadonlyArray<Written>, writer: InstallationId) => run.filter((w) => w.writer === writer).map((w) => w.command);

  it("shows the same state as ruling the queued commands in order, and lists each once", forall((run) => {
    const out: string[] = [];
    for (const writer of WRITERS) {
      const queued = writerRun(run, writer);
      const view = overlay(domain, emptyRuled<State, Fact>(new Map()), writer, queued, everywhere);
      const ruled = queued.reduce((r, command) => rule(domain, r, writer, command, everywhere).ruled, emptyRuled<State, Fact>(new Map()));
      if (JSON.stringify([...view.state]) !== JSON.stringify([...ruled.state])) out.push(`${writer} overlay state differs from ruling`);
      if (view.pending.map((p: PendingEntry) => p.opId).join() !== queued.map((c) => c.opId).join()) out.push(`${writer} pending list differs from queue`);
      queued.forEach((command, i) => {
        const direct = rule(domain, emptyRuled<State, Fact>(new Map()), writer, command, everywhere);
        void direct;
        const entry = view.pending[i]!;
        const ruling = [...ruled.rulings].find(([key]) => key === `${writer}/${command.opId}`)![1];
        if ((entry.status === "pending") !== (ruling.kind === "applied")) out.push(`${command.opId} status ${entry.status} vs ruling ${ruling.kind}`);
      });
    }
    return out;
  }));

  it("never writes: the ruled value it reads is unchanged, and an at-risk entry names a closed reason", forall((run) => {
    const out: string[] = [];
    const ruled = emptyRuled<State, Fact>(new Map());
    for (const writer of WRITERS) {
      const view = overlay(domain, ruled, writer, writerRun(run, writer), everywhere);
      if (ruled.rulings.size !== 0 || ruled.state.size !== 0) out.push("overlay mutated ruled");
      for (const entry of view.pending) {
        // A pending entry carrying a refusal no longer compiles (PendingEntry); with every base complete nothing waits.
        if (entry.status === "at_risk" && (entry.refusal === undefined || !Schema.is(RefusalReason)(entry.refusal.reason))) out.push(`${entry.opId} at risk without a closed reason`);
      }
    }
    return out;
  }));

  it("drops from the overlay every command that already has a ruling", forall((run) => {
    const out: string[] = [];
    const ruled = ruleAll(run);
    for (const writer of WRITERS) {
      const view = overlay(domain, ruled, writer, writerRun(run, writer), everywhere);
      if (view.pending.length !== 0) out.push(`${writer} still lists ${view.pending.length} ruled commands`);
      if (view.state !== ruled.state) out.push(`${writer} overlay changed ruled state with nothing queued`);
    }
    return out;
  }));
});

describe("afterOf", () => {
  const at = (itemId: ItemId | undefined, kind: "task" | "artifact" = "task", node = "tasks"): ResourceCommand<Op> => ({
    opId: mintOpId(),
    canvasName: "factory",
    actor: { kind: "operator" },
    target: { kind, nodeId: asNodeId(node), ...(itemId === undefined ? {} : { itemId }) },
    basis: null,
    after: [],
    op: { kind: "hold" },
  });

  it("takes the same item, or every command of the node when the target names no item, never another kind or node", () => {
    const one = mintItemId();
    const two = mintItemId();
    const a = at(one);
    const b = at(two);
    const nodeWide = at(undefined);
    const otherKind = at(one, "artifact");
    const otherNode = at(one, "task", "elsewhere");
    const pending = [a, b, nodeWide, otherKind, otherNode];
    expect(afterOf(pending, a.target)).toEqual([a.opId, nodeWide.opId]);
    expect(afterOf(pending, nodeWide.target)).toEqual([a.opId, b.opId, nodeWide.opId]);
    expect(afterOf([], a.target)).toEqual([]);
  });
});

describe("refusal mapping", () => {
  const reasons = RefusalReason.literals;

  it("maps every reason, and the details read back as the same reason and retryability", () => {
    for (const reason of reasons) {
      const error = refusalError({ reason, message: "m" });
      expect(error.type).toBe(REFUSAL[reason].type);
      expect(error.details).toMatchObject({ reason, retryable: REFUSAL[reason].retryable });
    }
    expect(Object.keys(REFUSAL).sort()).toEqual([...reasons].sort());
  });

  it("carries the root only when one is given", () => {
    const root = mintOpId();
    expect(refusalError({ reason: "stale", message: "m" }).details).not.toHaveProperty("from");
    expect(refusalError({ reason: "depends_on_refused", message: "m" }, root).details).toMatchObject({ from: root });
  });
});

describe("resource command types", () => {
  it("keeps ids apart and the unions closed", () => {
    expectTypeOf<ItemId>().not.toEqualTypeOf<OpId>();
    // @ts-expect-error: an item id is not an op id.
    const asOp: OpId = mintItemId();
    // @ts-expect-error: an op id is not an item id.
    const asItem: ItemId = mintOpId();
    expect([asOp, asItem]).toHaveLength(2);
    expectTypeOf<ResourceKind>().toEqualTypeOf<"task" | "artifact" | "thread" | "automation">();
    expectTypeOf<RefusalReason>().toEqualTypeOf<(typeof RefusalReason.literals)[number]>();
    expectTypeOf(REFUSAL).toExtend<{ readonly [R in RefusalReason]: { readonly type: WorkErrorType; readonly retryable: boolean } }>();
  });

  it("makes a domain and a command agree on the op", () => {
    type Other = { readonly kind: "other" };
    // Compiled, never run: the misuse below is what tsc must refuse.
    const misuse = () => {
      // @ts-expect-error: a command of another domain's op does not rule against this domain.
      rule(domain, emptyRuled<State, Fact>(new Map()), WRITERS[0]!, {} as ResourceCommand<Other>, everywhere);
      // @ts-expect-error: the domain's ruled state and its facts must agree.
      rule(domain, emptyRuled<string, Fact>(""), WRITERS[0]!, {} as ResourceCommand<Op>, everywhere);
    };
    void misuse;
    expectTypeOf(rule<State, Op, Fact>).returns.toEqualTypeOf<{ readonly ruled: Ruled<State, Fact>; readonly ruling: ResourceRuling<Fact> }>();
  });

  it("makes every outcome and actor match exhaustive", () => {
    const describeOutcome = (outcome: SubmitOutcome<Fact>): string => {
      switch (outcome.kind) {
        case "applied":
          return "applied";
        case "refused":
          return "refused";
        case "queued":
          return "queued";
        default:
          return outcome satisfies never;
      }
    };
    const describeRuling = (ruling: ResourceRuling<Fact>): string => {
      switch (ruling.kind) {
        case "applied":
          return "applied";
        case "refused":
          return ruling.root;
        default:
          return ruling satisfies never;
      }
    };
    expect(describeOutcome({ kind: "queued", opId: mintOpId() })).toBe("queued");
    expect(describeRuling({ kind: "refused", opId: mintOpId(), error: { type: "InputError", message: "m" }, root: mintOpId() })).toBeTypeOf("string");
    const actors: ReadonlyArray<ResourceActor["kind"]> = ["seat", "operator", "automation"];
    expect(actors.map((kind) => writtenOn(kind === "seat" ? seat("a") : kind === "operator" ? { kind } : { kind, nodeId: asNodeId("x"), automationId: mintItemId() }))).toEqual([
      "seat-machine",
      "editing-machine",
      "editing-machine",
    ]);
  });
});
