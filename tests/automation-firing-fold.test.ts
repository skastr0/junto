/**
 * Folding remote firing revisions (0.11, 05 S3): the receiver keeps the
 * highest revision per firingId in `automation_firings` — a late lower rev is
 * ignored, an unseen firing inserts, and a claim-key collision keeps the
 * existing row and warns, since a slot firing on two machines breaks Rule 3.
 * The crossing hook fires exactly for first-state-worthy claims and settles,
 * never for a transient claimed row.
 */
import { DatabaseSync } from "node:sqlite";
import { Deferred, Effect, Fiber, Layer, ManagedRuntime, Schema } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, it, afterEach } from "vitest";
import { AUTOMATION_RULING_CURSORS_SQL, AUTOMATION_STATE_SCHEMA_SQL } from "../src/main/junto/automation/state-schema";
import {
  AutomationRepository,
  makeAutomationRepositoryLive,
  setFiringCrossing,
} from "../src/main/junto/automation/repository";
import { makeSqliteClient } from "../src/main/junto/state/sqlite-client";
import {
  type ActionRuling,
  AutomationId,
  type Firing,
  FiringId,
} from "../src/shared/automation";
import type { AutomationFiringResult } from "../src/shared/automation-firing-row";
import { AutomationNodeId } from "../src/shared/mail-author";

const id = Schema.decodeUnknownSync(AutomationId);
const firingId = Schema.decodeUnknownSync(FiringId);
const AUTO = id("01M62AAAAAAAAAAAAAAAAAAAAA");
const AUTO_NODE = Schema.decodeUnknownSync(AutomationNodeId)("routines");

const run = async <A, E>(
  program: Effect.Effect<A, E, AutomationRepository | SqlClient.SqlClient>,
  localMachine = "mini",
): Promise<A> => {
  const database = new DatabaseSync(":memory:");
  database.exec(AUTOMATION_STATE_SCHEMA_SQL);
  database.exec(AUTOMATION_RULING_CURSORS_SQL);
  database.exec(`
    CREATE TABLE installation (singleton INTEGER PRIMARY KEY, installation_id TEXT NOT NULL);
    INSERT INTO installation VALUES (1, 'mini');
    CREATE TABLE canvases (canvas_name TEXT PRIMARY KEY, seq INTEGER NOT NULL);
    INSERT INTO canvases VALUES ('factory', 9);
    CREATE TABLE machine_configuration (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), machine_name TEXT NOT NULL);
    INSERT INTO machine_configuration VALUES (1, '${localMachine}');
  `);
  const sql = Layer.effect(SqlClient.SqlClient, makeSqliteClient(database)).pipe(Layer.provide(Reactivity.layer));
  const runtime = ManagedRuntime.make(makeAutomationRepositoryLive().pipe(Layer.provideMerge(sql)));
  try {
    return await runtime.runPromise(program);
  } finally {
    await runtime.dispose();
    database.close();
  }
};

const firing = (ulid: string, outcome: Firing["outcome"], cause: Firing["cause"] = { kind: "schedule", slot: 60_000, missed: 0 }, at = Date.now()): Firing => ({
  firingId: firingId(ulid),
  automationId: AUTO,
  at,
  cause,
  outcome,
  machine: "mini",
  claimSeq: 9,
});

const bodyOf = (f: Firing, rev: number): AutomationFiringResult => ({
  operation: "automation.firing",
  automationNode: AUTO_NODE,
  automationId: AUTO,
  firingId: f.firingId,
  claimSeq: f.claimSeq ?? 9,
  rev,
  firing: f,
});

const firings = (canvas = "factory") =>
  Effect.flatMap(AutomationRepository, (repository) => repository.firings(canvas, { automationId: AUTO }));

const fold = (writer: string, f: Firing, rev: number) =>
  Effect.flatMap(AutomationRepository, (repository) =>
    repository.foldRemoteFiring("factory", { writer: writer as never, body: bodyOf(f, rev) }),
  );

afterEach(() => {
  setFiringCrossing(undefined);
});

describe("folding a remote firing revision", () => {
  it("inserts an unseen firing and keeps the highest rev on fold", () =>
    run(
      Effect.gen(function* () {
        const settled = { kind: "fired", actions: [{ index: 0, ruling: "applied" } satisfies ActionRuling] } as const;
        const claimed = firing("01M62BBBBBBBBBBBBBBBBBBBBB", { kind: "claimed" });

        expect(yield* fold("mini", claimed, 0)).toEqual({ folded: true });
        expect((yield* firings())[0]).toMatchObject({ firingId: claimed.firingId, outcome: { kind: "claimed" } });

        const done = { ...claimed, outcome: settled };
        expect(yield* fold("mini", done, 1)).toEqual({ folded: true });
        expect((yield* firings())[0]).toMatchObject({ outcome: settled });

        // A late lower or equal rev changes nothing.
        expect(yield* fold("mini", claimed, 0)).toEqual({ folded: false });
        expect(yield* fold("mini", done, 1)).toEqual({ folded: false });
        expect(yield* firings()).toHaveLength(1);
      }),
    ));

  it("keeps the existing row on a claim-key collision and warns", () =>
    run(
      Effect.gen(function* () {
        const slot = { kind: "schedule", slot: 60_000, missed: 0 } as const;
        const first = firing("01M62BBBBBBBBBBBBBBBBBBBBB", { kind: "fired", actions: [] }, slot);
        expect(yield* fold("mini", first, 0)).toEqual({ folded: true });

        // The same slot claimed under another firingId on the macbook: Rule 3
        // says this must not happen, so the existing row stands.
        const collided = { ...firing("01M62CCCCCCCCCCCCCCCCCCCCC", { kind: "fired", actions: [] }, slot), machine: "macbook" };
        expect(yield* fold("macbook", collided, 0)).toEqual({ folded: false });
        expect(yield* firings()).toEqual([expect.objectContaining({ firingId: first.firingId })]);
      }),
    ));

  it("carries heldSince and heldUntil on an applied or refused ruling", () =>
    run(
      Effect.gen(function* () {
        const held: Firing = firing("01M62BBBBBBBBBBBBBBBBBBBBB", {
          kind: "fired",
          actions: [
            { index: 0, ruling: "queued", waitingOn: { machine: "mini", since: 500 } },
            { index: 1, ruling: "applied" },
          ],
        });
        expect(yield* fold("mini", held, 0)).toEqual({ folded: true });

        const resolved: Firing = {
          ...held,
          outcome: {
            kind: "fired",
            actions: [
              { index: 0, ruling: "refused", reason: "not_available", heldSince: 500, heldUntil: 900 },
              { index: 1, ruling: "applied" },
            ],
          },
        };
        expect(yield* fold("mini", resolved, 1)).toEqual({ folded: true });
        expect((yield* firings())[0]!.outcome).toEqual(resolved.outcome);
      }),
    ));
});

describe("the firing's crossing on its own machine", () => {
  it("a skipped claim crosses at once; a live claim waits for its settle", () =>
    run(
      Effect.gen(function* () {
        const repository = yield* AutomationRepository;
        const crossed: Firing[] = [];
        setFiringCrossing((_canvas, f) => Effect.sync(() => void crossed.push(f)));

        const skipped = firing("01M62BBBBBBBBBBBBBBBBBBBBB", { kind: "skipped", reason: "condition_unmet" });
        expect(yield* repository.claimFiring("factory", skipped)).toEqual({ _tag: "Claimed" });
        expect(crossed).toEqual([skipped]);

        const live = firing("01M62CCCCCCCCCCCCCCCCCCCCC", { kind: "claimed" }, { kind: "schedule", slot: 120_000, missed: 0 });
        expect(yield* repository.claimFiring("factory", live)).toEqual({ _tag: "Claimed" });
        expect(crossed).toEqual([skipped]);

        const done = { kind: "fired", actions: [] } as const;
        yield* repository.settleFiring("factory", live, done);
        expect(crossed).toEqual([skipped, { ...live, outcome: done }]);
      }),
    ));

  it("two concurrent settles of one firing cross in write order", () =>
    run(
      Effect.gen(function* () {
        const repository = yield* AutomationRepository;
        // The first crossing waits inside its settle's transaction: without
        // the settle semaphore the second settle's update would land while it
        // waits and cross first, inverting the revision order.
        const gate = yield* Deferred.make<void>();
        const crossed: Firing[] = [];
        let crossings = 0;
        setFiringCrossing((_canvas, f) =>
          Effect.gen(function* () {
            crossings += 1;
            if (crossings === 1) yield* Deferred.await(gate);
            crossed.push(f);
          }),
        );

        const live = firing("01M62CCCCCCCCCCCCCCCCCCCCC", { kind: "claimed" });
        expect(yield* repository.claimFiring("factory", live)).toEqual({ _tag: "Claimed" });
        const first = { kind: "fired", actions: [{ index: 0, ruling: "applied" }] } as const;
        const second = { kind: "fired", actions: [{ index: 0, ruling: "applied" }, { index: 1, ruling: "applied" }] } as const;

        const settleA = yield* Effect.forkDetach(repository.settleFiring("factory", live, first));
        yield* Effect.sleep("10 millis");
        const settleB = yield* Effect.forkDetach(repository.settleFiring("factory", live, second));
        yield* Effect.sleep("10 millis");
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(settleA);
        yield* Fiber.join(settleB);
        expect(crossed).toEqual([{ ...live, outcome: first }, { ...live, outcome: second }]);
      }),
    ));
});

describe("a folded firing this clock cannot back", () => {
  it("refuses a firing ahead of the clock, a slot ahead of its at, and a stale firing", () =>
    run(
      Effect.gen(function* () {
        const future = firing("01M62BBBBBBBBBBBBBBBBBBBBB", { kind: "fired", actions: [] }, { kind: "change", key: "a:1" }, Date.now() + 5 * 60_000);
        expect(yield* fold("mini", future, 0)).toEqual({ folded: false });

        const slotAhead = firing("01M62CCCCCCCCCCCCCCCCCCCCC", { kind: "fired", actions: [] }, { kind: "schedule", slot: Date.now() + 60_000, missed: 0 });
        expect(yield* fold("mini", slotAhead, 0)).toEqual({ folded: false });

        const stale = firing("01M62DDDDDDDDDDDDDDDDDDDDD", { kind: "fired", actions: [] }, { kind: "change", key: "a:2" }, Date.now() - 2 * 24 * 60 * 60_000);
        expect(yield* fold("mini", stale, 0)).toEqual({ folded: false });

        expect(yield* firings()).toEqual([]);
      }),
    ));

  it("a forged future firing neither suppresses the runner's limits nor claims a slot", () =>
    run(
      Effect.gen(function* () {
        const repository = yield* AutomationRepository;
        // A fired firing dated ahead suppresses min_interval while the clock
        // catches up, and a slot claimed ahead returns Duplicate for the real
        // firing there: both folds are refused.
        const forged = firing("01M62BBBBBBBBBBBBBBBBBBBBB", { kind: "fired", actions: [] }, { kind: "schedule", slot: Date.now(), missed: 0 }, Date.now() + 5 * 60_000);
        expect(yield* fold("mini", forged, 0)).toEqual({ folded: false });

        expect(yield* repository.firedSince("factory", AUTO, 0)).toEqual([]);
        const local = firing("01M62CCCCCCCCCCCCCCCCCCCCC", { kind: "claimed" }, { kind: "schedule", slot: Date.now(), missed: 0 });
        expect(yield* repository.claimFiring("factory", local)).toEqual({ _tag: "Claimed" });
      }),
    ));

  it("refuses a rev from a machine that did not mint the firing and keeps the row", () =>
    run(
      Effect.gen(function* () {
        // The mini mints the firing; the macbook's higher rev naming itself
        // is a second writer — refused, the mini's row untouched.
        const minted = firing("01M62BBBBBBBBBBBBBBBBBBBBB", { kind: "claimed" });
        expect(yield* fold("mini", minted, 0)).toEqual({ folded: true });

        const stolen: Firing = { ...minted, machine: "macbook", outcome: { kind: "fired", actions: [] } };
        expect(yield* fold("macbook", stolen, 1)).toEqual({ folded: false });
        expect((yield* firings())[0]).toMatchObject({ outcome: { kind: "claimed" }, machine: "mini" });
      }),
    ));

  it("bounds folded revisions to six a minute per automation", () =>
    run(
      Effect.gen(function* () {
        for (let n = 0; n < 6; n += 1) {
          const f = firing(`01M62BBBBBBBBBBBBBBBBBBBB${n}`, { kind: "fired", actions: [] }, { kind: "change", key: `a:${n}` });
          expect(yield* fold("mini", f, 0)).toEqual({ folded: true });
        }
        const flood = firing("01M62CCCCCCCCCCCCCCCCCCCCC", { kind: "fired", actions: [] }, { kind: "change", key: "a:6" });
        expect(yield* fold("mini", flood, 0)).toEqual({ folded: false });
        expect(yield* firings()).toHaveLength(6);
      }),
    ));
});

describe("a folded firing is not this machine's to run", () => {
  it("the editor never resolves, sweeps or settles a firing minted elsewhere", () =>
    run(
      Effect.gen(function* () {
        const repository = yield* AutomationRepository;
        // On the macbook the mini's queued firing folds in — but nothing on
        // this machine may act on it: no resolve by id, no held-action
        // sweep, no settle (S3).
        const queued = firing("01M62BBBBBBBBBBBBBBBBBBBBB", {
          kind: "fired",
          actions: [{ index: 0, ruling: "queued", waitingOn: { machine: "mini", since: 500 } }],
        });
        expect(yield* fold("mini", queued, 0)).toEqual({ folded: true });

        expect(yield* repository.firing("factory", queued.firingId)).toBeUndefined();
        expect(yield* repository.queuedFirings("factory")).toEqual([]);
        const error = yield* Effect.flip(repository.settleFiring("factory", queued, { kind: "fired", actions: [{ index: 0, ruling: "applied" }] }));
        expect(error._tag).toBe("AutomationPersistenceError");
        expect((yield* firings())[0]!.outcome).toEqual(queued.outcome);
      }),
      "macbook",
    ));

  it("a local firing with no machine still resolves and settles", () =>
    run(
      Effect.gen(function* () {
        const repository = yield* AutomationRepository;
        // Minted before the field existed or on a machine that could not
        // name itself: a firing with no machine is this machine's (S3).
        const local: Firing = { ...firing("01M62BBBBBBBBBBBBBBBBBBBBB", {
          kind: "fired",
          actions: [{ index: 0, ruling: "queued", waitingOn: { machine: "mini", since: 500 } }],
        }) };
        delete (local as { machine?: string }).machine;
        expect(yield* fold("mini", local, 0)).toEqual({ folded: true });

        expect(yield* repository.firing("factory", local.firingId)).toMatchObject({ firingId: local.firingId });
        expect(yield* repository.queuedFirings("factory")).toHaveLength(1);
        yield* repository.settleFiring("factory", local, { kind: "fired", actions: [{ index: 0, ruling: "applied", heldSince: 500, heldUntil: 900 }] });
        expect((yield* firings())[0]!.outcome).toEqual({ kind: "fired", actions: [{ index: 0, ruling: "applied", heldSince: 500, heldUntil: 900 }] });
      }),
    ));
});
