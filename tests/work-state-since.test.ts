/**
 * The work repository projects when each task and request entered its
 * current state: the origin time of the fact that changed the state. A fact
 * that leaves the state alone does not move it, and the time survives a
 * reopen because it is stored with the row.
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, describe, expect, it } from "vitest";
import { ActorSeatId } from "../src/shared/actor-seat";
import { serializeCanvas, type CanvasDoc } from "../src/shared/canvas";
import {
  InstallationId,
  type InstallationId as InstallationIdValue,
} from "../src/shared/installation-id";
import {
  AuthorialIntentFactBasis,
  type ActorRef,
} from "../src/shared/work-protocol";
import {
  createAuthorialTaskDependencyScopeCapability,
  WorkRepository,
  WorkRepositoryLive,
} from "../src/main/junto/work/repository";
import {
  makeStateEngineLive,
  StateEngine,
} from "../src/main/junto/state/engine";
import { unjournaledWorkMutationEffect } from "../src/main/junto/work/mutation-seam";
import { authorialMaterialForTest } from "./helpers/authorial-material";
import { seedCanvasAuthority } from "./helpers/canvas-authority-material";

const canvasName = "factory";
const otherCanvasName = "other-factory";
const opened: Array<{
  readonly root: string;
  readonly dispose: () => Promise<void>;
}> = [];

afterEach(async () => {
  const closing = opened.splice(0);
  await Promise.all(closing.map(({ dispose }) => dispose()));
  await Promise.all(
    closing.map(({ root }) => rm(root, { recursive: true, force: true })),
  );
});

const installation = (value: string): InstallationIdValue =>
  Schema.decodeUnknownSync(InstallationId)(value);

const actor = (digit: string, nodeId = `actor-${digit}`): ActorRef => ({
  seatId: Schema.decodeUnknownSync(ActorSeatId)(
    `seat_${digit.repeat(64)}`,
  ),
  canvasName,
  nodeId,
});

const atMinute = (minute: number): string =>
  new Date(Date.UTC(2026, 7, 12, 12, minute)).toISOString();

const factoryTopology: CanvasDoc = {
  nodes: [
    {
      id: "recipient",
      type: "text",
      x: 0,
      y: 0,
      width: 240,
      height: 100,
      text: "Recipient",
      ether: { entity: { kind: "agent", name: "local:recipient" } },
    },
    {
      id: "board",
      type: "text",
      x: 300,
      y: 0,
      width: 240,
      height: 120,
      text: "tasks",
      ether: { entity: { kind: "task" }, host: "local" },
    },
    {
      id: "asks",
      type: "text",
      x: 600,
      y: 0,
      width: 240,
      height: 120,
      text: "requests",
      ether: { entity: { kind: "requests" } },
    },
  ],
  edges: [],
};
const factoryCanvasBody = serializeCanvas(factoryTopology);
const emptyTopology: CanvasDoc = { nodes: [], edges: [] };
const emptyCanvasBody = serializeCanvas(emptyTopology);
const authorialMaterial = authorialMaterialForTest({
  generation: "1",
  documents: new Map([
    [canvasName, { document: factoryTopology, rawBody: factoryCanvasBody }],
    [otherCanvasName, { document: emptyTopology, rawBody: emptyCanvasBody }],
  ]),
});
const intentSha256 = authorialMaterial.intentSha256;

const openRepository = async (
  local: InstallationIdValue,
  peers: ReadonlyArray<InstallationIdValue> = [],
  role: "command-center" | "remote" = "command-center",
) => {
  const root = join(
    tmpdir(),
    `junto-state-since-${local}-${randomUUID()}`,
  );
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(
      WorkRepositoryLive,
      makeStateEngineLive(join(root, "junto.db")),
    ),
  );
  opened.push({ root, dispose: () => runtime.dispose() });
  const repository = await runtime.runPromise(WorkRepository);
  const sql = await runtime.runPromise(SqlClient.SqlClient);
  await runtime.runPromise(
    sql.withTransaction(
      Effect.gen(function* () {
        for (const known of new Set([local, ...peers])) {
          yield* sql.unsafe(
            `
            INSERT INTO station_known_installations(
              installation_id,
              registered_at
            ) VALUES (?, ?)
          `,
            [known, atMinute(0)],
          );
        }
        yield* sql.unsafe(
          `
          INSERT INTO station_installation(
            singleton,
            installation_id,
            created_at
          ) VALUES (1, ?, ?)
        `,
          [local, atMinute(0)],
        );
        yield* sql.unsafe(
          `
          INSERT INTO station_configuration(
            singleton,
            role,
            host_id,
            agent_host_id,
            command_center_installation_id,
            supervised_preferred,
            configured_at
          ) VALUES (1, ?, ?, ?, ?, 1, ?)
        `,
          role === "command-center"
            ? [role, "local", null, null, atMinute(0)]
            : [role, "remote", "remote", peers[0], atMinute(0)],
        );
        yield* seedCanvasAuthority({
          generation: "1",
          documents: new Map([
            [canvasName, factoryTopology],
            [otherCanvasName, emptyTopology],
          ]),
          at: atMinute(0),
        });
      }),
    ),
  );
  const basis = Schema.decodeUnknownSync(AuthorialIntentFactBasis)({
    kind: "authorial-intent",
    generation: "1",
    contentSha256: intentSha256,
  });
  return { runtime, repository, basis, root };
};


const board = { canvasName, nodeId: "board" };
const asks = { canvasName, nodeId: "asks" };
const note = (messageId: string, text: string) => ({
  messageId,
  role: "user" as const,
  parts: [{ kind: "text" as const, text }],
});

describe("WorkRepository stateSince projection", () => {
  it("stamps the fact time of each state change and keeps it through facts that change nothing", async () => {
    const { runtime, repository, basis } = await openRepository(installation("cc-state-since"));
    const seat = actor("1", "recipient");
    const dependencyScope = createAuthorialTaskDependencyScopeCapability({
      authority: authorialMaterial,
      authoringSink: board,
    });
    const taskSince = async (): Promise<string | undefined> =>
      (await runtime.runPromise(repository.readSnapshot(canvasName, "board"))).tasks?.items[0]?.stateSince;

    await runtime.runPromise(
      repository.createTask({
        sink: board,
        basis,
        dependencyScope,
        task: { id: "t1", state: "submitted", history: [note("m1", "Run the migration.")] },
        originAt: atMinute(1),
        receivedAt: atMinute(1),
      }),
    );
    expect(await taskSince()).toBe(atMinute(1));

    await runtime.runPromise(
      repository.claimLocalTask({ sink: board, basis, dependencyScope, taskId: "t1", actor: seat, originAt: atMinute(5), receivedAt: atMinute(5) }),
    );
    expect(await taskSince()).toBe(atMinute(5));

    const transition = await runtime.runPromise(
      repository.transitionTask({ sink: board, basis, taskId: "t1", state: "input-required", originAt: atMinute(9), receivedAt: atMinute(9) }),
    );
    expect(await taskSince()).toBe(atMinute(9));
    // The guard: Task's schema accepts stateSince from any caller, so the
    // journal must be shown to stay free of it. The transition read the task
    // back from a row that already carried a stamp (the claim's); neither the
    // fact it wrote nor the value it returned may contain one.
    expect(JSON.stringify(transition.record)).not.toContain("stateSince");
    expect(transition.value).not.toHaveProperty("stateSince");
    // The projection it hands back is the one place that carries it.
    expect(transition.snapshot.tasks?.items[0]?.stateSince).toBe(atMinute(9));

    // A note on the waiting task is a fact that leaves the state alone.
    await runtime.runPromise(
      repository.describeTask({ sink: board, basis, taskId: "t1", message: note("m2", "Still waiting."), originAt: atMinute(30), receivedAt: atMinute(30) }),
    );
    const snapshot = await runtime.runPromise(repository.readSnapshot(canvasName, "board"));
    expect(snapshot.tasks?.items[0]).toMatchObject({ state: "input-required", stateSince: atMinute(9) });
    // Row bookkeeping only: it is not task metadata.
    expect(snapshot.tasks?.items[0]?.metadata).toBeUndefined();
  });

  it("stamps a request with the time it was raised", async () => {
    const { runtime, repository, basis } = await openRepository(installation("cc-state-since-req"));
    const seat = actor("1", "recipient");
    await runtime.runPromise(
      repository.createRequest({
        sink: asks,
        basis,
        raisedBy: seat,
        request: { id: "r1", state: "input-required", claimedBy: seat.seatId, history: [note("m1", "Which region?")] },
        originAt: atMinute(3),
        receivedAt: atMinute(3),
      }),
    );
    const snapshot = await runtime.runPromise(repository.readSnapshot(canvasName, "asks"));
    expect(snapshot.requests?.items[0]).toMatchObject({ id: "r1", stateSince: atMinute(3) });
  });

  it("keeps the time through a full close and reopen of the database", async () => {
    const { runtime, repository, basis, root } = await openRepository(installation("cc-state-since-reopen"));
    const seat = actor("1", "recipient");
    await runtime.runPromise(
      repository.createRequest({
        sink: asks,
        basis,
        raisedBy: seat,
        request: { id: "r1", state: "input-required", claimedBy: seat.seatId, history: [note("m1", "Which region?")] },
        originAt: atMinute(3),
        receivedAt: atMinute(3),
      }),
    );
    await runtime.dispose();

    // A new process: nothing in memory, only the file.
    const reopened = ManagedRuntime.make(
      Layer.provideMerge(WorkRepositoryLive, makeStateEngineLive(join(root, "junto.db"))),
    );
    opened.push({ root, dispose: () => reopened.dispose() });
    const again = await reopened.runPromise(WorkRepository);
    const snapshot = await reopened.runPromise(again.readSnapshot(canvasName, "asks"));
    expect(snapshot.requests?.items[0]).toMatchObject({ id: "r1", stateSince: atMinute(3) });
  });

  it("reads a row written before the stamp existed as since its last fact", async () => {
    const { runtime, repository, basis } = await openRepository(installation("cc-state-since-old"));
    const seat = actor("1", "recipient");
    await runtime.runPromise(
      repository.createRequest({
        sink: asks,
        basis,
        raisedBy: seat,
        request: { id: "r1", state: "input-required", claimedBy: seat.seatId, history: [note("m1", "Which region?")] },
        originAt: atMinute(3),
        receivedAt: atMinute(3),
      }),
    );
    const sql = await runtime.runPromise(SqlClient.SqlClient);
    await runtime.runPromise(
      sql.withTransaction(
        unjournaledWorkMutationEffect(
          "test.fixture-seed",
          sql.unsafe("UPDATE work_requests SET metadata_json = NULL WHERE request_id = ?", ["r1"]),
        ),
      ),
    );
    const snapshot = await runtime.runPromise(repository.readSnapshot(canvasName, "asks"));
    expect(snapshot.requests?.items[0]?.stateSince).toBe(atMinute(3));
  });
});
