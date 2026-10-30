/**
 * Folding remote firing revisions (0.11, 05 S3): the receiver keeps the
 * highest revision per firingId in `automation_firings` — a late lower rev is
 * ignored, an unseen firing inserts, and a claim-key collision keeps the
 * existing row and warns, since a slot firing on two machines breaks Rule 3.
 * The crossing hook fires exactly for first-state-worthy claims and settles,
 * never for a transient claimed row.
 */
import { DatabaseSync } from "node:sqlite";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
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

const run = async <A, E>(program: Effect.Effect<A, E, AutomationRepository | SqlClient.SqlClient>): Promise<A> => {
  const database = new DatabaseSync(":memory:");
  database.exec(AUTOMATION_STATE_SCHEMA_SQL);
  database.exec(AUTOMATION_RULING_CURSORS_SQL);
  database.exec(`
    CREATE TABLE installation (singleton INTEGER PRIMARY KEY, installation_id TEXT NOT NULL);
    INSERT INTO installation VALUES (1, 'mini');
    CREATE TABLE canvases (canvas_name TEXT PRIMARY KEY, seq INTEGER NOT NULL);
    INSERT INTO canvases VALUES ('factory', 9);
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

const firing = (ulid: string, outcome: Firing["outcome"], cause: Firing["cause"] = { kind: "schedule", slot: 60_000, missed: 0 }): Firing => ({
  firingId: firingId(ulid),
  automationId: AUTO,
  at: 1_000,
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
});
