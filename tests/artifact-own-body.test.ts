/**
 * A seat's own applied artifact body reads on its machine with no link. The
 * editing machine rules the seat's queued commands; its rows reach the seat's
 * machine and a third machine, and no link is open when either reads. The
 * seat's machine makes each body from its own command, or from the edit and
 * the version before it, and keeps it only when its digest is the ruled ref.
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, Effect, Layer, ManagedRuntime, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, beforeAll, expect, it } from "vitest";
import { makeContentServiceLive } from "../src/main/junto/content/service";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { ArtifactRepository, ArtifactRepositoryLive } from "../src/main/junto/work/artifact-repository";
import { WorkRepository, WorkRepositoryLive } from "../src/main/junto/work/repository";
import { RulingRecorderLive } from "../src/main/junto/work/ruling-recorder";
import { ActorSeatId } from "../src/shared/actor-seat";
import type { ArtifactBody, ArtifactOp } from "../src/shared/artifact";
import type { QueuedCommand } from "../src/shared/command-row";
import { EXCHANGE_ROWS_PAGE_BYTES } from "../src/shared/exchange-bounds";
import { InstallationId } from "../src/shared/installation-id";
import type { ResourceCommand } from "../src/shared/resource-command";
import { rulingContextOf } from "../src/shared/ruling-context";
import type { CanvasPlacement, RowsFrame } from "../src/shared/work-exchange";
import { ItemId, OpId } from "../src/shared/work-ids";
import { seedCanvasRows } from "./support/seed-canvas";
import { artifacts, canvasOf, seat } from "./support/model-nodes";

const id = Schema.decodeUnknownSync(InstallationId);
const EDITOR = id("macbook");
const MINI = id("mini");
const OTHER = id("other-mini");
const at = "2026-10-21T12:00:00.000Z";
const seatId = Schema.decodeUnknownSync(ActorSeatId)(`seat_${"2".repeat(64)}`);
const nodes = [seat("peer", { y: 0 }), artifacts("arts-1", { y: 200 })];
const placement: CanvasPlacement = {
  canvasId: "canvas-factory",
  editor: EDITOR,
  holds: (machine) => machine === EDITOR || machine === MINI || machine === OTHER,
  seatOf: (nodeId) => (nodeId === "peer" ? { seatId, machine: MINI } : undefined),
};
let next = 0;
const op = () => Schema.decodeUnknownSync(OpId)(`01M5F4A${String(next++).padStart(19, "0")}`);
const item = (n: number) => Schema.decodeUnknownSync(ItemId)(`01M5F4B${String(n).padStart(19, "0")}`);

type Machine = {
  readonly root: string;
  readonly runtime: ManagedRuntime.ManagedRuntime<WorkRepository | ArtifactRepository | SqlClient.SqlClient, unknown>;
  readonly work: Context.Service.Shape<typeof WorkRepository>;
  readonly artifacts: Context.Service.Shape<typeof ArtifactRepository>;
};

const boot = async (self: InstallationId): Promise<Machine> => {
  const root = join(tmpdir(), `junto-own-body-${self}-${randomUUID()}`);
  const state = Layer.mergeAll(makeStateEngineLive(join(root, "state", "junto.db")), makeInstallOpsLive(join(root, "state", "install-ops.db")));
  const services = Layer.provideMerge(
    ArtifactRepositoryLive,
    Layer.provideMerge(
      Layer.mergeAll(RulingRecorderLive, makeContentServiceLive({ root: join(root, "content"), skipInlineMediaMigration: true })),
      Layer.provideMerge(WorkRepositoryLive, state),
    ),
  );
  const runtime = ManagedRuntime.make(services as never) as Machine["runtime"];
  await runtime.runPromise(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.withTransaction(Effect.gen(function* () {
      for (const machine of [EDITOR, MINI, OTHER]) yield* sql`INSERT INTO known_installations(installation_id, registered_at) VALUES (${machine}, ${at})`;
      yield* sql`INSERT INTO installation(singleton, installation_id, created_at) VALUES (1, ${self}, ${at})`;
      yield* seedCanvasRows({ seq: 1, canvases: new Map([["factory", { nodes }]]) });
      if (self !== EDITOR) yield* sql`UPDATE canvases SET editor_installation_id = ${EDITOR} WHERE canvas_name = 'factory'`;
    }));
  }));
  return { root, runtime, work: await runtime.runPromise(WorkRepository), artifacts: await runtime.runPromise(ArtifactRepository) };
};

let editor: Machine, mini: Machine, other: Machine;
beforeAll(async () => {
  [editor, mini, other] = await Promise.all([boot(EDITOR), boot(MINI), boot(OTHER)]);
});
afterAll(async () => {
  for (const machine of [editor, mini, other]) {
    await machine.runtime.dispose();
    await rm(machine.root, { recursive: true, force: true });
  }
});

const command = (artifactId: ItemId, write: ArtifactOp): ResourceCommand<ArtifactOp> =>
  ({
    opId: op(),
    canvasName: "factory",
    actor: { kind: "seat", seatId, nodeId: "peer" },
    target: { kind: "artifact", nodeId: "arts-1", itemId: artifactId },
    basis: null,
    after: [],
    op: write,
  }) as unknown as ResourceCommand<ArtifactOp>;

let through = "0";
/** The seat's machine queues the command, the editing machine rules it, and its rows reach both replicas. */
const write = async (artifactId: ItemId, written: ArtifactOp) => {
  const queued = command(artifactId, written);
  await mini.runtime.runPromise(mini.work.queueCommand({ command: queued as unknown as QueuedCommand, basis: { kind: "canvas", canvasName: "factory", seq: 1 } as never }));
  const outcome = await editor.runtime.runPromise(editor.artifacts.submit(MINI, queued, rulingContextOf(canvasOf(nodes), () => undefined)));
  expect(outcome.kind).toBe("applied");
  const page = await editor.runtime.runPromise(editor.work.exchangeRows({ canvasName: "factory", writer: EDITOR, after: through, limit: 100, bytes: EXCHANGE_ROWS_PAGE_BYTES }));
  const frame = { kind: "rows", canvasName: "factory", canvasId: "canvas-factory", writer: EDITOR, facts: page.rows.map((row) => row.fact), through: page.through } as unknown as RowsFrame;
  through = page.through;
  for (const replica of [mini, other]) {
    await replica.runtime.runPromise(replica.work.applyExchangeRows({ peer: EDITOR, frame, placement, receivedAt: at }));
  }
};

const headOn = async (on: Machine, artifactId: ItemId) => {
  const head = await on.runtime.runPromise(on.artifacts.head("factory", artifactId));
  if (Option.isNone(head)) throw new Error(`no artifact ${artifactId} held`);
  return head.value;
};

const big = (fill: string): ArtifactBody => ({ type: "document", markdown: fill.repeat(60 * 1024) });

it("reads its own small edit at once, as every replica does: the edit applied to the version before", async () => {
  const a1 = item(1);
  await write(a1, { op: "create", title: "A1", body: { type: "document", markdown: "first" } });
  await write(a1, { op: "edit", edit: { kind: "patch", type: "document", baseVersion: 1, patches: [{ op: "splice", at: 5, remove: 0, insert: " draft" }] } } as unknown as ArtifactOp);
  for (const replica of [mini, other]) {
    const head = await headOn(replica, a1);
    expect(head.artifact.version).toBe(2);
    expect(head.body).toEqual({ type: "document", markdown: "first draft" });
  }
});

it("reads its own large edit and large create from its own command, where no fact carries the body", async () => {
  const a2 = item(2);
  await write(a2, { op: "create", title: "A2", body: big("a") });
  expect((await headOn(mini, a2)).body).toEqual(big("a"));
  await write(a2, { op: "edit", edit: { kind: "replace", baseVersion: 1, body: big("b") } } as unknown as ArtifactOp);
  expect((await headOn(mini, a2)).body).toEqual(big("b"));
  // Another machine has no such command: its body rode by ref and waits for a pull.
  expect((await headOn(other, a2)).body).toBeNull();
});
