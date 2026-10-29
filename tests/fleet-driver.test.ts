/**
 * The F2 driver applies each committed entry exactly once (0.11, 06 F2;
 * tech-lead's rule): the fold and the new `applied_index` commit together. A
 * fold is not idempotent, since an artifact body's content ref is drawn fresh
 * and an automation placement moves the canvas count, so a crash after the
 * fold and before the index is written must roll the fold back, and the
 * reopened driver must apply the committed entry once more, and only once.
 *
 * The rulings are judged as the authority will: the ruler runs in a
 * transaction that is rolled back, and what it recorded is proposed.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, describe, expect, it } from "vitest";
import { makeAutomationRepositoryLive } from "../src/main/junto/automation/repository";
import { submitAutomationCommand } from "../src/main/junto/automation/ruler";
import { makeContentServiceLive } from "../src/main/junto/content/service";
import { loggedRuling, openCanvasAuthority, type LoggedRuling } from "../src/main/junto/fleet/driver";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import { makeMachineRepositoryLive } from "../src/main/junto/machines/repository";
import { PausePlaneLive } from "../src/main/junto/pause-plane";
import { FactoryPauseRepositoryLive } from "../src/main/junto/pause/repository";
import { ReferencesRepositoryLive } from "../src/main/junto/references/repository";
import { SeatGuidanceRepositoryLive } from "../src/main/junto/seat-guidance/repository";
import { makeSettingsLive } from "../src/main/junto/settings/service";
import { AgentSignalRepositoryLive } from "../src/main/junto/signals/repository";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { ArtifactRepository, ArtifactRepositoryLive } from "../src/main/junto/work/artifact-repository";
import { CrewRepositoryLive } from "../src/main/junto/work/crew-repository";
import { WorkRepository, WorkRepositoryLive, type RecordRulingInput } from "../src/main/junto/work/repository";
import { RulingRecorder, RulingRecordFailed } from "../src/main/junto/work/ruling-recorder";
import type { ArtifactOp } from "../src/shared/artifact";
import type { AutomationOp } from "../src/shared/automation";
import type { InstallationId } from "../src/shared/installation-id";
import { asNodeId } from "../src/shared/physics/schema";
import type { OpId, ResourceCommand, RulingContext } from "../src/shared/resource-command";
import { artifacts, automations, seat } from "./support/model-nodes";
import { ModelStoresLive, seedCanvasRows } from "./support/seed-canvas";

const CANVAS = "factory";
const SELF = "mini" as InstallationId;
const AT = Date.parse("2026-10-28T12:00:00.000Z");
const everywhere: RulingContext = { inReach: () => true };

type Store = {
  readonly root: string;
  readonly runtime: ManagedRuntime.ManagedRuntime<SqlClient.SqlClient | RulingRecorder | ArtifactRepository | WorkRepository, unknown>;
  readonly recorded: Array<RecordRulingInput>;
  /** While set, the recorder fails: the crash comes after the fold and before the applied index is written. */
  failing: boolean;
};
const stores: Array<Store> = [];

afterEach(async () => {
  for (const store of stores.splice(0)) {
    await store.runtime.dispose();
    await rm(store.root, { recursive: true, force: true });
  }
});

const makeStore = async (): Promise<Store> => {
  const root = await mkdtemp(join(tmpdir(), "junto-fleet-driver-"));
  const store: Store = { root, runtime: undefined as never, recorded: [], failing: false };
  const recorder = Layer.effect(
    RulingRecorder,
    Effect.map(WorkRepository, (work) =>
      RulingRecorder.of({
        record: (input) =>
          store.failing
            ? Effect.fail(new RulingRecordFailed({ message: "the machine went down", cause: input.command.opId }))
            : work.recordRuling(input).pipe(Effect.tap(() => Effect.sync(() => store.recorded.push(input))), Effect.asVoid, Effect.orDie),
      })),
  );
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(
      Layer.mergeAll(makeAutomationRepositoryLive(), ArtifactRepositoryLive.pipe(Layer.provideMerge(recorder))),
      Layer.provideMerge(
        ModelStoresLive,
        Layer.provideMerge(
          Layer.mergeAll(
            WorkRepositoryLive,
            CrewRepositoryLive,
            makeSettingsLive(),
            makeContentServiceLive({ root: join(root, "content"), skipInlineMediaMigration: true }),
            SeatGuidanceRepositoryLive,
            AgentSignalRepositoryLive,
            ReferencesRepositoryLive,
            Layer.provideMerge(PausePlaneLive, FactoryPauseRepositoryLive),
            makeMachineRepositoryLive({ defaultName: () => SELF, makeInstallationId: () => SELF }),
          ),
          Layer.mergeAll(makeStateEngineLive(join(root, "junto.db")), makeInstallOpsLive(join(root, "install-ops.db"))),
        ),
      ),
    ),
  );
  (store as { runtime: Store["runtime"] }).runtime = runtime as never;
  await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT OR IGNORE INTO known_installations(installation_id, registered_at) VALUES (${SELF}, ${new Date(AT).toISOString()})`;
          yield* sql`INSERT OR IGNORE INTO installation(singleton, installation_id, created_at) VALUES (1, ${SELF}, ${new Date(AT).toISOString()})`;
          yield* seedCanvasRows({ seq: 1, canvases: new Map([[CANVAS, { nodes: [automations("routines"), artifacts("arts"), seat("lead")] }]]) });
          yield* sql`UPDATE canvases SET editor_installation_id = ${SELF} WHERE canvas_name = ${CANVAS}`;
        }),
      );
    }),
  );
  stores.push(store);
  return store;
};

const ARTIFACT_OP = "01M62AA0000000000000000001" as OpId;
const AUTOMATION_OP = "01M62AV0000000000000000001" as OpId;

const createArtifact = Effect.flatMap(ArtifactRepository, (repo) =>
  repo.submit(SELF, {
    opId: ARTIFACT_OP,
    canvasName: CANVAS,
    actor: { kind: "operator" },
    target: { kind: "artifact", nodeId: asNodeId("arts"), itemId: ARTIFACT_OP },
    basis: null,
    after: [],
    op: { op: "create", title: "Plan", body: { type: "document", markdown: "the plan" } },
  } as unknown as ResourceCommand<ArtifactOp>, everywhere));

const placeAutomation = submitAutomationCommand(
  SELF,
  {
    opId: AUTOMATION_OP,
    canvasName: CANVAS,
    actor: { kind: "operator" },
    target: { kind: "automation", nodeId: asNodeId("routines") },
    basis: null,
    after: [],
    op: {
      kind: "create",
      automationId: AUTOMATION_OP,
      enabled: true,
      definition: {
        name: "Nightly",
        trigger: { kind: "schedule", cron: "0 2 * * *", timezone: "UTC" },
        then: [{ kind: "mail", to: { kind: "seat", nodeId: asNodeId("lead") }, text: "Done?" }],
        limits: { minIntervalMs: 60_000, maxPerHour: 12 },
      },
    },
  } as unknown as ResourceCommand<AutomationOp>,
  everywhere,
  { targetsOf: () => new Set([asNodeId("lead")]), isOverseer: () => false } as never,
);

class Judged {
  readonly _tag = "Judged";
}

/** Judge in a transaction that rolls back, as the authority does, and keep what the ruler recorded. */
const judge = <A, E, R>(store: Store, submit: Effect.Effect<A, E, R>) =>
  store.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const mark = store.recorded.length;
      yield* sql.withTransaction(Effect.flatMap(submit, () => Effect.fail(new Judged()))).pipe(
        Effect.catchIf((error): error is Judged => error instanceof Judged, () => Effect.void),
      );
      return store.recorded.splice(mark).map((input) => loggedRuling(input, AT));
    }) as unknown as Effect.Effect<ReadonlyArray<LoggedRuling>, unknown, never>,
  );

const open = (store: Store) => store.runtime.runPromise(openCanvasAuthority({ canvasName: CANVAS, self: SELF }));

/** What a doubled apply would show: content refs per artifact version, the canvas count, ruling rows, and where the log stands. */
const held = (store: Store) =>
  store.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const [refs] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM content_refs WHERE owner_record_id = ${`${ARTIFACT_OP}@1`}`;
      const [count] = yield* sql<{ seq: number }>`SELECT seq FROM canvases WHERE canvas_name = ${CANVAS}`;
      const rulings = yield* sql<{ op_id: string }>`SELECT op_id FROM resource_rulings WHERE canvas_name = ${CANVAS} ORDER BY op_id`;
      const [consensus] = yield* sql<{ commit_index: number; applied_index: number }>`
        SELECT commit_index, applied_index FROM canvas_consensus WHERE canvas_name = ${CANVAS}`;
      const automations = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM automations WHERE canvas_name = ${CANVAS}`;
      return { refs: refs!.n, seq: count!.seq, rulings: rulings.map((row) => row.op_id), automations: automations[0]!.n, ...consensus! };
    }),
  );

describe("the fleet driver", () => {
  it("opens a canvas as the migration left it, rules it alone, and applies a ruling with its body and its count", async () => {
    const store = await makeStore();
    const before = await held(store);
    const authority = await open(store);
    expect(authority.status()).toMatchObject({ role: "leader", term: 2, members: { list: [SELF] }, canCommit: true });

    for (const ruling of [...(await judge(store, createArtifact)), ...(await judge(store, placeAutomation))]) {
      await store.runtime.runPromise(authority.propose(ruling));
    }
    const after = await held(store);
    expect(after).toMatchObject({ refs: before.refs + 1, seq: before.seq + 1, automations: 1, rulings: [ARTIFACT_OP, AUTOMATION_OP] });
    expect(after.applied_index).toBe(after.commit_index);
    expect(after.commit_index).toBe(authority.status().lastIndex);
  });

  it("applies a committed entry once when the machine went down after its fold and before its index", async () => {
    const store = await makeStore();
    const before = await held(store);
    const rulings = [...(await judge(store, createArtifact)), ...(await judge(store, placeAutomation))];

    const first = await open(store);
    store.failing = true;
    const crashed = await store.runtime.runPromiseExit(first.propose(rulings[0]!));
    expect(crashed._tag).toBe("Failure");
    // The entry is committed and durable; its fold went back with the index.
    const down = await held(store);
    expect(down).toMatchObject({ refs: before.refs, seq: before.seq, rulings: [] });
    expect(down.commit_index).toBe(down.applied_index + 1);
    // A driver that ran ahead of the disk takes nothing more until opened again.
    expect((await store.runtime.runPromiseExit(first.propose(rulings[1]!)))._tag).toBe("Failure");

    store.failing = false;
    const second = await open(store);
    const back = await held(store);
    expect(back).toMatchObject({ refs: before.refs + 1, seq: before.seq, rulings: [ARTIFACT_OP] });
    expect(back.applied_index).toBe(back.commit_index);

    await store.runtime.runPromise(second.propose(rulings[1]!));
    await open(store);
    const settled = await held(store);
    // One ref and one count move, however many times the canvas is opened.
    expect(settled).toMatchObject({ refs: before.refs + 1, seq: before.seq + 1, automations: 1, rulings: [ARTIFACT_OP, AUTOMATION_OP] });
    expect(settled.applied_index).toBe(settled.commit_index);
  });

  it("crashes after an automation placement's fold and moves the count once on reopening", async () => {
    const store = await makeStore();
    const before = await held(store);
    const [placement] = await judge(store, placeAutomation);
    const first = await open(store);
    store.failing = true;
    expect((await store.runtime.runPromiseExit(first.propose(placement!)))._tag).toBe("Failure");
    expect(await held(store)).toMatchObject({ seq: before.seq, automations: 0 });
    store.failing = false;
    await open(store);
    await open(store);
    expect(await held(store)).toMatchObject({ seq: before.seq + 1, automations: 1, rulings: [AUTOMATION_OP] });
  });
});
