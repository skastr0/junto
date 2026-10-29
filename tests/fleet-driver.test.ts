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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeAutomationRepositoryLive } from "../src/main/junto/automation/repository";
import { submitAutomationCommand } from "../src/main/junto/automation/ruler";
import { makeContentServiceLive } from "../src/main/junto/content/service";
import type { Message } from "../src/main/junto/fleet/consensus";
import { loggedRuling, openCanvasAuthority, type CanvasAuthority, type LogData } from "../src/main/junto/fleet/driver";
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

// One frozen clock: a judged store and a direct one stamp every row alike.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(AT);
});

afterEach(async () => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) {
    await store.runtime.dispose();
    await rm(store.root, { recursive: true, force: true });
  }
});

/** One machine's store; `authorities`, when given, is the list F6 seeded for the canvas. */
const makeStore = async (self: InstallationId = SELF, authorities?: ReadonlyArray<InstallationId>): Promise<Store> => {
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
            makeMachineRepositoryLive({ defaultName: () => self, makeInstallationId: () => self }),
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
          yield* sql`INSERT OR IGNORE INTO known_installations(installation_id, registered_at) VALUES (${self}, ${new Date(AT).toISOString()})`;
          yield* sql`INSERT OR IGNORE INTO installation(singleton, installation_id, created_at) VALUES (1, ${self}, ${new Date(AT).toISOString()})`;
          yield* seedCanvasRows({ seq: 1, canvases: new Map([[CANVAS, { nodes: [automations("routines"), artifacts("arts"), seat("lead")] }]]) });
          yield* sql`UPDATE canvases SET editor_installation_id = ${SELF} WHERE canvas_name = ${CANVAS}`;
          for (const [position, id] of (authorities ?? []).entries()) {
            yield* sql`INSERT INTO canvas_consensus (canvas_name, current_term, commit_index, applied_index) VALUES (${CANVAS}, 1, 0, 0) ON CONFLICT DO NOTHING`;
            yield* sql`INSERT INTO canvas_authorities (canvas_name, position, installation_id) VALUES (${CANVAS}, ${position}, ${id})`;
          }
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
      return store.recorded.splice(mark).map((input): LogData => ({ kind: "ruling", ruling: loggedRuling(input, AT) }));
    }) as unknown as Effect.Effect<ReadonlyArray<LogData>, unknown, never>,
  );

const open = (store: Store, self: InstallationId = SELF) =>
  store.runtime.runPromise(openCanvasAuthority({ canvasName: CANVAS, self, electionTicks: 3 }));

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

const editArtifact = (opId: string, baseVersion: number, markdown: string, itemId: string = ARTIFACT_OP) =>
  Effect.flatMap(ArtifactRepository, (repo) =>
    repo.submit(SELF, {
      opId: opId as OpId,
      canvasName: CANVAS,
      actor: { kind: "operator" },
      target: { kind: "artifact", nodeId: asNodeId("arts"), itemId },
      basis: null,
      after: [],
      op: { op: "edit", edit: { kind: "replace", baseVersion, body: { type: "document", markdown } } },
    } as unknown as ResourceCommand<ArtifactOp>, everywhere));

const BATCH = Effect.all([
  createArtifact,
  // Judged after the create in the same batch: the savepoint holds the version it edits.
  editArtifact("01M62AA0000000000000000002", 1, "the plan, longer"),
  placeAutomation,
  // No such artifact: refused, and recorded as refused.
  editArtifact("01M62AA0000000000000000003", 1, "nothing", "01M62AA0000000000000000009"),
]);

const CONSENSUS_TABLES = new Set(["canvas_consensus", "canvas_authorities", "canvas_log", "canvas_log_members", "canvas_log_waiting"]);

/** Every table both paths reach, leaving out the log and a content ref's id (drawn fresh at each put). */
const tablesOf = (store: Store) =>
  store.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const names = (yield* sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
        .map((row) => row.name)
        .filter((name) => !CONSENSUS_TABLES.has(name));
      const tables: Record<string, ReadonlyArray<string>> = {};
      for (const name of names) {
        const rows = yield* sql.unsafe<Record<string, unknown>>(`SELECT * FROM "${name}"`);
        if (rows.length > 0) tables[name] = rows.map(({ ref_id: _refId, ...row }) => JSON.stringify(row)).sort();
      }
      return tables;
    }),
  );

describe("the fleet driver judges a batch", () => {
  it("as the rulers write it directly: answers, facts, bodies, count and ruling rows", async () => {
    const direct = await makeStore();
    const answered = await direct.runtime.runPromise(BATCH as unknown as Effect.Effect<ReadonlyArray<unknown>, unknown, never>);

    const judged = await makeStore();
    const authority = await open(judged);
    const judgment = await judged.runtime.runPromise(authority.judge(BATCH) as unknown as Effect.Effect<{ value: ReadonlyArray<unknown>; entries: ReadonlyArray<unknown> }, unknown, never>);

    expect(judgment.value).toEqual(answered);
    expect(judgment.entries).toHaveLength(4);
    expect(await tablesOf(judged)).toEqual(await tablesOf(direct));
    expect(await held(judged)).toMatchObject({ refs: 1, automations: 1 });
    const status = authority.status();
    expect((await held(judged)).applied_index).toBe(status.lastIndex);
  });

  it("proposes nothing when the batch itself fails, and judges the next one", async () => {
    const store = await makeStore();
    const authority = await open(store);
    const before = await held(store);
    const failing = Effect.flatMap(createArtifact, () => Effect.fail("the batch broke" as const));
    const exit = await store.runtime.runPromiseExit(authority.judge(failing) as Effect.Effect<unknown, unknown, never>);
    expect(exit._tag).toBe("Failure");
    expect(await held(store)).toEqual(before);
    expect(authority.status().lastIndex).toBe(before.commit_index);

    await store.runtime.runPromise(authority.judge(createArtifact) as Effect.Effect<unknown, unknown, never>);
    expect(await held(store)).toMatchObject({ refs: 1, rulings: [ARTIFACT_OP] });
  });
});

// ---------------------------------------------------------------------------
// Two machines: an alone fork must never leave a follower skipping history it counts as applied.

const MACBOOK = "macbook" as InstallationId;
type Seat = { readonly store: Store; readonly authority: CanvasAuthority; readonly failures: Array<string> };

/** Carry messages between the pair while `up` lets them through, until none are left. */
const deliver = async (pair: Record<string, Seat>, messages: ReadonlyArray<Message>, up: () => boolean) => {
  let queue = [...messages];
  for (let round = 0; queue.length > 0 && round < 200; round++) {
    const next: Array<Message> = [];
    for (const message of queue) {
      const seat = pair[message.to];
      if (!up() || seat === undefined) continue;
      const exit = await seat.store.runtime.runPromiseExit(seat.authority.step(message));
      if (exit._tag === "Success") next.push(...exit.value);
      else seat.failures.push(String(exit.cause));
    }
    queue = next;
  }
};

const tickPair = async (pair: Record<string, Seat>, ids: ReadonlyArray<string>, up: () => boolean) => {
  for (const id of ids) {
    const seat = pair[id]!;
    const exit = await seat.store.runtime.runPromiseExit(seat.authority.tick());
    if (exit._tag === "Success") await deliver(pair, exit.value, up);
    else seat.failures.push(String(exit.cause));
  }
};

const proposeOn = async (pair: Record<string, Seat>, id: string, seq: number, up: () => boolean) => {
  const seat = pair[id]!;
  await seat.store.runtime.runPromise(seat.authority.propose({ kind: "structure.changed", seq }));
  await tickPair(pair, [id], up);
};

const logOf = (store: Store) =>
  store.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ log_index: number; term: number; kind: string; structure_seq: number | null }>`
        SELECT log_index, term, kind, structure_seq FROM canvas_log WHERE canvas_name = ${CANVAS} ORDER BY log_index`;
      const [consensus] = yield* sql<{ commit_index: number; applied_index: number }>`
        SELECT commit_index, applied_index FROM canvas_consensus WHERE canvas_name = ${CANVAS}`;
      return { rows: rows.map((row) => ({ ...row })), ...consensus! };
    }),
  );

describe("the fleet driver after an alone fork", () => {
  it("refuses on the machine whose applied entries the fork revoked, and keeps them, instead of skipping the new history", async () => {
    const pair: Record<string, Seat> = {};
    for (const id of [MACBOOK, SELF]) {
      const store = await makeStore(id, [MACBOOK, SELF]);
      pair[id] = { store, authority: await open(store, id), failures: [] };
    }
    let linked = true;
    const up = () => linked;
    const macbook = pair[MACBOOK]!;
    const mini = pair[SELF]!;

    // The MacBook rules term 2 on the mini's vote, and both apply what it commits.
    for (let round = 0; round < 30 && !macbook.authority.status().canCommit; round++) await tickPair(pair, [MACBOOK, SELF], up);
    expect(macbook.authority.status()).toMatchObject({ role: "leader", canCommit: true });
    await proposeOn(pair, MACBOOK, 1, up);
    await tickPair(pair, [MACBOOK, SELF, MACBOOK], up);
    const shared = (await logOf(mini.store)).applied_index;
    expect(shared).toBe((await logOf(macbook.store)).applied_index);

    // The lid closes without a word: the mini takes over on its casting vote and commits alone.
    linked = false;
    for (let round = 0; round < 30 && !mini.authority.status().canCommit; round++) await tickPair(pair, [MACBOOK, SELF], up);
    expect(mini.authority.status()).toMatchObject({ role: "leader", canCommit: true });
    await proposeOn(pair, SELF, 2, up);
    await proposeOn(pair, SELF, 3, up);
    const ruledAlone = await logOf(mini.store);
    expect(ruledAlone.applied_index).toBeGreaterThan(shared);
    expect(macbook.authority.status().canCommit).toBe(false);

    // The operator, on the MacBook, says the mini is dead.
    const forked = await macbook.store.runtime.runPromise(macbook.authority.alone());
    await deliver(pair, forked, up);
    await proposeOn(pair, MACBOOK, 4, up);
    expect(macbook.authority.status()).toMatchObject({ canCommit: true, members: { sole: MACBOOK } });

    // The link comes back: the mini hears the later term, and its applied entries are revoked.
    linked = true;
    for (let round = 0; round < 6 && mini.failures.length === 0; round++) await tickPair(pair, [MACBOOK], up);
    expect(mini.failures.join("\n")).toMatch(/revoked/);
    // Nothing of the new history was taken at indices it counts as applied: its log and index stand as it ruled them.
    expect(await logOf(mini.store)).toEqual(ruledAlone);
    // And it takes nothing more until the operator settles the fork.
    expect((await mini.store.runtime.runPromiseExit(mini.authority.tick()))._tag).toBe("Failure");
    expect(macbook.failures).toEqual([]);
  });
});
