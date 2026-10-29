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
import { Cause, Deferred, Effect, Layer, ManagedRuntime } from "effect";
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
import { RulingCapture, WorkRepository, WorkRepositoryLive, type RecordRulingInput } from "../src/main/junto/work/repository";
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

/** One machine's store; `authorities` is the list F6 seeded for the canvas, this machine alone unless given. */
const makeStore = async (self: InstallationId = SELF, authorities: ReadonlyArray<InstallationId> = [self]): Promise<Store> => {
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
          // Under all-on createCanvas has seeded this machine alone; the list here replaces it.
          yield* sql`DELETE FROM canvas_authorities WHERE canvas_name = ${CANVAS}`;
          for (const [position, id] of authorities.entries()) {
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

/** Drop a handle, as the host does once it broke, and open the canvas again. */
const reopen = async (store: Store, previous: CanvasAuthority) => {
  await store.runtime.runPromise(previous.close());
  return open(store);
};

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
    const second = await reopen(store, first);
    const back = await held(store);
    expect(back).toMatchObject({ refs: before.refs + 1, seq: before.seq, rulings: [ARTIFACT_OP] });
    expect(back.applied_index).toBe(back.commit_index);

    await store.runtime.runPromise(second.propose(rulings[1]!));
    await reopen(store, second);
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
    await reopen(store, await reopen(store, first));
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

describe("the fleet driver, one batch in flight", () => {
  it("refuses a second batch, retryable, while the first is appended and not committed", async () => {
    const pair: Record<string, Seat> = {};
    for (const id of [SELF, MACBOOK]) {
      const store = await makeStore(id, [SELF, MACBOOK]);
      pair[id] = { store, authority: await open(store, id), failures: [] };
    }
    let linked = true;
    const up = () => linked;
    const mini = pair[SELF]!;
    for (let round = 0; round < 30 && !mini.authority.status().canCommit; round++) await tickPair(pair, [SELF, MACBOOK], up);
    expect(mini.authority.status()).toMatchObject({ role: "leader", canCommit: true });

    // The MacBook, the pair's fallback, stops answering: the first batch is appended here and waits for it.
    linked = false;
    const first = await mini.store.runtime.runPromise(mini.authority.judge(createArtifact) as unknown as Effect.Effect<{ entries: ReadonlyArray<{ index: number }> }, unknown, never>);
    expect(mini.authority.status().lastIndex).toBe(first.entries.at(-1)!.index);
    expect(mini.authority.status().commit).toBeLessThan(first.entries.at(-1)!.index);

    const second = await mini.store.runtime.runPromiseExit(
      mini.authority.judge(editArtifact("01M62AA0000000000000000002", 1, "the plan, longer")) as unknown as Effect.Effect<unknown, unknown, never>,
    );
    expect(second._tag).toBe("Failure");
    expect(String(second._tag === "Failure" ? second.cause : "")).toMatch(/not yet committed/);
    expect(mini.failures).toEqual([]);

    // Once the fallback answers, the first commits and the next batch is judged.
    linked = true;
    for (let round = 0; round < 10 && mini.authority.status().lastIndex > mini.authority.status().commit; round++) await tickPair(pair, [SELF, MACBOOK], up);
    expect(mini.authority.status().commit).toBe(mini.authority.status().lastIndex);
    await mini.store.runtime.runPromise(
      mini.authority.judge(editArtifact("01M62AA0000000000000000002", 1, "the plan, longer")) as unknown as Effect.Effect<unknown, unknown, never>,
    );
    for (let round = 0; round < 10 && mini.authority.status().lastIndex > mini.authority.status().commit; round++) await tickPair(pair, [SELF, MACBOOK], up);
    expect(await held(mini.store)).toMatchObject({ rulings: [ARTIFACT_OP, "01M62AA0000000000000000002"] });
  });
});

/** A canvas nothing can name an authority for: no list, no editor named, and no installation row yet. */
const unnamed = async () => {
  const store = await makeStore(SELF, []);
  await store.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE canvases SET editor_installation_id = NULL WHERE canvas_name = ${CANVAS}`;
      yield* sql`DELETE FROM installation`;
    }),
  );
  return store;
};

describe("the fleet driver begins a canvas's log", () => {
  it("only from the authority list F6 seeded, and refuses without one rather than guess the editor", async () => {
    const store = await unnamed();
    const exit = await store.runtime.runPromiseExit(openCanvasAuthority({ canvasName: CANVAS, self: SELF }));
    expect(exit._tag).toBe("Failure");
    expect(String(exit._tag === "Failure" ? exit.cause : "")).toMatch(/no authority list/);
    // Nothing was written at (1,1): a later open, once F6 seeds the list, begins it.
    expect((await logOf(store)).rows).toEqual([]);
  });
});

describe("the fleet driver holds a canvas while it drains", () => {
  it("judges the next batch only once a step's commit is applied", async () => {
    let gap: Deferred.Deferred<void> | undefined;
    let entered: (() => void) | undefined;
    const beforeApply = Effect.suspend(() => {
      entered?.();
      return gap === undefined ? Effect.void : Deferred.await(gap);
    });
    const pair: Record<string, Seat> = {};
    for (const id of [SELF, MACBOOK]) {
      const store = await makeStore(id, [SELF, MACBOOK]);
      const authority = await store.runtime.runPromise(openCanvasAuthority({ canvasName: CANVAS, self: id, electionTicks: 3, ...(id === SELF ? { beforeApply } : {}) }));
      pair[id] = { store, authority, failures: [] };
    }
    let linked = true;
    const up = () => linked;
    const mini = pair[SELF]!;
    const macbook = pair[MACBOOK]!;
    for (let round = 0; round < 30 && !mini.authority.status().canCommit; round++) await tickPair(pair, [SELF, MACBOOK], up);
    expect(mini.authority.status()).toMatchObject({ role: "leader", canCommit: true });

    // The create is appended here; the MacBook's acknowledgement is what commits it.
    const first = await mini.store.runtime.runPromise(mini.authority.judge(createArtifact) as unknown as Effect.Effect<{ messages: ReadonlyArray<Message> }, unknown, never>);
    const acks: Array<Message> = [];
    for (const message of first.messages) acks.push(...(await macbook.store.runtime.runPromise(macbook.authority.step(message))));
    expect(acks.length).toBeGreaterThan(0);

    // The acknowledgement commits the create; its apply waits in the gap, and the edit of it is judged meanwhile.
    gap = await mini.store.runtime.runPromise(Deferred.make<void>());
    const inGap = new Promise<void>((resolve) => (entered = resolve));
    const stepped = Promise.all(acks.map((ack) => mini.store.runtime.runPromise(mini.authority.step(ack))));
    await inGap;
    expect(mini.authority.status().commit).toBe(mini.authority.status().lastIndex);
    const edited = mini.store.runtime.runPromise(
      mini.authority.judge(editArtifact("01M62AA0000000000000000002", 1, "the plan, longer")) as unknown as Effect.Effect<{ value: unknown }, unknown, never>,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    await mini.store.runtime.runPromise(Deferred.succeed(gap, undefined));
    gap = undefined;
    await stepped;
    const judged = await edited;

    // The edit saw the create applied: it was accepted, not refused as an edit of nothing.
    expect((judged.value as { kind: string }).kind).not.toBe("refused");
    for (let round = 0; round < 10 && mini.authority.status().lastIndex > mini.authority.status().commit; round++) await tickPair(pair, [SELF, MACBOOK], up);
    expect(await held(mini.store)).toMatchObject({ rulings: [ARTIFACT_OP, "01M62AA0000000000000000002"] });
    expect(mini.failures).toEqual([]);
  });
});

describe("the fleet driver refuses a proposal it cannot take", () => {
  it("retryable, and stays open: a follower's proposal changes nothing and the next tick runs", async () => {
    const pair: Record<string, Seat> = {};
    for (const id of [SELF, MACBOOK]) {
      const store = await makeStore(id, [SELF, MACBOOK]);
      pair[id] = { store, authority: await open(store, id), failures: [] };
    }
    const up = () => true;
    for (let round = 0; round < 30 && !pair[SELF]!.authority.status().canCommit; round++) await tickPair(pair, [SELF, MACBOOK], up);
    const macbook = pair[MACBOOK]!;
    expect(macbook.authority.status().role).toBe("follower");
    const before = await logOf(macbook.store);

    const exit = await macbook.store.runtime.runPromiseExit(macbook.authority.propose({ kind: "structure.changed", seq: 1 }));
    expect(exit._tag).toBe("Failure");
    const error = exit._tag === "Failure" ? Cause.squash(exit.cause) : undefined;
    expect(error).toMatchObject({ _tag: "FleetDriverError", retryable: true, message: expect.stringMatching(/not-leader/) });
    expect(await logOf(macbook.store)).toEqual(before);
    expect((await macbook.store.runtime.runPromiseExit(macbook.authority.tick()))._tag).toBe("Success");
  });

  it("not retryable for alone's refusals, which repeating never changes", async () => {
    const store = await makeStore();
    const authority = await open(store);
    // A lone canvas is no pair: alone is refused, however often it is asked.
    const exit = await store.runtime.runPromiseExit(authority.alone());
    const error = exit._tag === "Failure" ? Cause.squash(exit.cause) : undefined;
    expect(error).toMatchObject({ _tag: "FleetDriverError", message: expect.stringMatching(/not-pair/) });
    expect((error as { retryable?: boolean }).retryable).toBeUndefined();
    expect((await store.runtime.runPromiseExit(authority.tick()))._tag).toBe("Success");
  });
});

describe("the fleet driver judges one canvas's batch", () => {
  it("fails a batch that rules on another canvas, writing and proposing nothing", async () => {
    const store = await makeStore();
    const authority = await open(store);
    const before = authority.status().lastIndex;
    const reachesElsewhere = Effect.flatMap(createArtifact, (created) =>
      Effect.flatMap(RulingCapture, (capture) =>
        Effect.sync(() => {
          capture?.({ ...store.recorded.at(-1)!, canvasName: "home" });
          return created;
        })));
    const exit = await store.runtime.runPromiseExit(authority.judge(reachesElsewhere) as unknown as Effect.Effect<unknown, unknown, never>);
    expect(exit._tag).toBe("Failure");
    expect(String(exit._tag === "Failure" ? exit.cause : "")).toMatch(/ruled on home/);
    expect(authority.status().lastIndex).toBe(before);
    expect(await held(store)).toMatchObject({ rulings: [] });
    // Nothing broke: the next batch is judged.
    await store.runtime.runPromise(authority.judge(createArtifact) as unknown as Effect.Effect<unknown, unknown, never>);
    expect(await held(store)).toMatchObject({ rulings: [ARTIFACT_OP] });
  });

  it("refuses a batch that reaches another canvas's judge, rather than wait on itself", async () => {
    const store = await makeStore();
    await store.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO canvases (canvas_name, canvas_id, created_at, updated_at) VALUES ('home', 'canvas-home', ${new Date(AT).toISOString()}, ${new Date(AT).toISOString()})`;
        yield* sql`DELETE FROM canvas_authorities WHERE canvas_name = 'home'`;
        yield* sql`INSERT INTO canvas_authorities (canvas_name, position, installation_id) VALUES ('home', 0, ${SELF})`;
      }),
    );
    const factory = await open(store);
    const home = await store.runtime.runPromise(openCanvasAuthority({ canvasName: "home", self: SELF }));
    const nested = Effect.andThen(createArtifact, home.judge(Effect.void));
    const exit = await store.runtime.runPromiseExit(
      (factory.judge(nested) as unknown as Effect.Effect<unknown, unknown, never>).pipe(Effect.timeout("2 seconds")),
    );
    expect(exit._tag).toBe("Failure");
    expect(String(exit._tag === "Failure" ? exit.cause : "")).toMatch(/drives no authority itself/);
    expect(await held(store)).toMatchObject({ rulings: [] });
    // Each judges on its own afterwards.
    await store.runtime.runPromise(home.judge(Effect.void));
    await store.runtime.runPromise(factory.judge(createArtifact) as unknown as Effect.Effect<unknown, unknown, never>);
  });
});

describe("the fleet driver logs only the rulings that stand", () => {
  it("drops a ruling the batch recorded and then undid in a transaction of its own", async () => {
    const store = await makeStore();
    const authority = await open(store);
    const undone = Effect.flatMap(SqlClient.SqlClient, (sql) =>
      Effect.ignore(sql.withTransaction(Effect.andThen(createArtifact, Effect.fail(new Error("the caller changed its mind"))))));
    const judged = await store.runtime.runPromise(authority.judge(undone) as unknown as Effect.Effect<{ entries: ReadonlyArray<unknown> }, unknown, never>);
    expect(judged.entries).toEqual([]);
    expect(await held(store)).toMatchObject({ rulings: [] });
  });
});

describe("the fleet driver, from inside a judged batch", () => {
  it.each([
    ["propose", (authority: CanvasAuthority) => authority.propose({ kind: "structure.changed", seq: 1 })],
    ["tick", (authority: CanvasAuthority) => authority.tick()],
    ["step", (authority: CanvasAuthority) => authority.step({ type: "append-reply", from: MACBOOK, to: SELF, term: 1, success: false, index: 0 } as Message)],
    ["alone", (authority: CanvasAuthority) => authority.alone()],
  ] as const)("refuses %s rather than wait on the lock its judge holds", async (_name, reach) => {
    const store = await makeStore();
    const authority = await open(store);
    const exit = await store.runtime.runPromiseExit(
      (authority.judge(Effect.andThen(createArtifact, reach(authority) as Effect.Effect<unknown, unknown, never>)) as unknown as Effect.Effect<unknown, unknown, never>).pipe(Effect.timeout("2 seconds")),
    );
    expect(exit._tag).toBe("Failure");
    expect(String(exit._tag === "Failure" ? exit.cause : "")).toMatch(/drives no authority itself/);
    expect(await held(store)).toMatchObject({ rulings: [] });
    // The refusal broke nothing.
    await store.runtime.runPromise(authority.judge(createArtifact) as unknown as Effect.Effect<unknown, unknown, never>);
    expect(await held(store)).toMatchObject({ rulings: [ARTIFACT_OP] });
  });
});

describe("the fleet driver opens a canvas once per process", () => {
  it("refuses a second handle while one is live, and opens again once it is closed", async () => {
    const store = await makeStore();
    const first = await open(store);
    const twice = await store.runtime.runPromiseExit(openCanvasAuthority({ canvasName: CANVAS, self: SELF }));
    expect(twice._tag).toBe("Failure");
    expect(String(twice._tag === "Failure" ? twice.cause : "")).toMatch(/already open here/);
    // The refused open touched nothing of the live handle.
    await store.runtime.runPromise(first.judge(createArtifact) as unknown as Effect.Effect<unknown, unknown, never>);

    // A broken handle still holds the canvas until it is dropped.
    store.failing = true;
    const edit = first.judge(editArtifact("01M62AA0000000000000000002", 1, "the plan, longer")) as unknown as Effect.Effect<unknown, unknown, never>;
    expect((await store.runtime.runPromiseExit(edit))._tag).toBe("Failure");
    store.failing = false;
    expect((await store.runtime.runPromiseExit(openCanvasAuthority({ canvasName: CANVAS, self: SELF })))._tag).toBe("Failure");

    const second = await reopen(store, first);
    expect((await store.runtime.runPromiseExit(first.tick()))._tag).toBe("Failure");
    await store.runtime.runPromise(second.tick());
    // Closing a dropped handle again releases nothing of the new one.
    await store.runtime.runPromise(first.close());
    expect((await store.runtime.runPromiseExit(openCanvasAuthority({ canvasName: CANVAS, self: SELF })))._tag).toBe("Failure");
  });

  it("releases the canvas when its open fails", async () => {
    const store = await unnamed();
    expect((await store.runtime.runPromiseExit(openCanvasAuthority({ canvasName: CANVAS, self: SELF })))._tag).toBe("Failure");
    expect(String(await store.runtime.runPromiseExit(openCanvasAuthority({ canvasName: CANVAS, self: SELF })).then((exit) => exit._tag === "Failure" ? exit.cause : ""))).toMatch(/no authority list/);
  });
});

describe("the fleet driver fills every canvas's list before the first opens", () => {
  it("for a canvas created with the authority off, and one whose step 61 ran before the installation row", async () => {
    const store = await makeStore(SELF, []);
    await store.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // Created with the gate off: no consensus row, no list.
        yield* sql`DELETE FROM canvas_consensus WHERE canvas_name = ${CANVAS}`;
        // An engine-made home: step 61 ran with no installation row, so a consensus row and no list.
        yield* sql`INSERT INTO canvases (canvas_name, canvas_id, created_at, updated_at) VALUES ('home', 'canvas-home', ${new Date(AT).toISOString()}, ${new Date(AT).toISOString()})`;
        yield* sql`DELETE FROM canvas_authorities WHERE canvas_name = 'home'`;
        yield* sql`INSERT INTO canvas_consensus (canvas_name, current_term, commit_index, applied_index) VALUES ('home', 1, 0, 0) ON CONFLICT DO NOTHING`;
      }),
    );
    const factory = await open(store);
    const lists = await store.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{ canvas_name: string; installation_id: string }>`SELECT canvas_name, installation_id FROM canvas_authorities ORDER BY canvas_name`;
        const consensus = yield* sql<{ canvas_name: string; current_term: number }>`SELECT canvas_name, current_term FROM canvas_consensus ORDER BY canvas_name`;
        return { lists: rows.map((row) => ({ ...row })), consensus: consensus.map((row) => ({ ...row })) };
      }),
    );
    expect(lists).toEqual({
      lists: [{ canvas_name: CANVAS, installation_id: SELF }, { canvas_name: "home", installation_id: SELF }],
      // The factory's open settled its lone election, a term up; home is as the seed left it.
      consensus: [{ canvas_name: CANVAS, current_term: 2 }, { canvas_name: "home", current_term: 1 }],
    });
    // Both open and rule.
    await store.runtime.runPromise(factory.judge(createArtifact) as unknown as Effect.Effect<unknown, unknown, never>);
    const home = await store.runtime.runPromise(openCanvasAuthority({ canvasName: "home", self: SELF }));
    expect(home.status()).toMatchObject({ canCommit: true });
  });
});

describe("the fleet driver fills a replica's list", () => {
  it("with the copy's editor, never this machine, for a copy taken in while the authority was off", async () => {
    const store = await makeStore();
    await store.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // A copy installed with the gate off: the MacBook named as editor, no consensus row, no list.
        yield* sql`INSERT INTO canvases (canvas_name, canvas_id, created_at, updated_at, editor_installation_id)
          VALUES ('home', 'canvas-home', ${new Date(AT).toISOString()}, ${new Date(AT).toISOString()}, ${MACBOOK})`;
        yield* sql`DELETE FROM canvas_authorities WHERE canvas_name = 'home'`;
        yield* sql`DELETE FROM canvas_consensus WHERE canvas_name = 'home'`;
      }),
    );
    await open(store);
    const home = await store.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const list = yield* sql<{ installation_id: string }>`SELECT installation_id FROM canvas_authorities WHERE canvas_name = 'home' ORDER BY position`;
        const consensus = yield* sql<{ current_term: number }>`SELECT current_term FROM canvas_consensus WHERE canvas_name = 'home'`;
        return { list: list.map((row) => row.installation_id), terms: consensus.map((row) => row.current_term) };
      }),
    );
    expect(home).toEqual({ list: [MACBOOK], terms: [1] });
  });
});
