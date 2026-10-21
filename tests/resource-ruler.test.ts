/**
 * The editing machine's ruler, on a real database: the held rows are the
 * truth, so a command held before the ruler starts, or before this machine
 * came to edit the canvas, is ruled by the next sweep, each writer's in order.
 * Only what can never apply is refused; the rest waits queued.
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { WorkRepository, WorkRepositoryLive } from "../src/main/junto/work/repository";
import { ResourceRulerError, makeResourceRuler, type RulerPorts } from "../src/main/junto/work/resource-ruler";
import { RulingRecorder, RulingRecorderLive } from "../src/main/junto/work/ruling-recorder";
import { ActorSeatId } from "../src/shared/actor-seat";
import type { QueuedCommand } from "../src/shared/command-row";
import { InstallationId } from "../src/shared/installation-id";
import { OpId } from "../src/shared/work-ids";
import { seedCanvasRows } from "./support/seed-canvas";
import { canvasOf, seat, taskBoard } from "./support/model-nodes";

const id = Schema.decodeUnknownSync(InstallationId);
const SELF = id("macbook");
const OTHER = id("old-editor");
const at = "2026-10-21T12:00:00.000Z";
const seatId = Schema.decodeUnknownSync(ActorSeatId)(`seat_${"2".repeat(64)}`);
let next = 0;
const op = () => Schema.decodeUnknownSync(OpId)(`01M5EXR${String(next++).padStart(19, "0")}`);

const nodes = [seat("s1", { y: 0 }), taskBoard("board-1", { y: 200 })];
const canvas = canvasOf(nodes);

let root: string;
let runtime: ManagedRuntime.ManagedRuntime<WorkRepository | RulingRecorder | SqlClient.SqlClient, unknown>;
let work: Context.Service.Shape<typeof WorkRepository>;
let recorder: Context.Service.Shape<typeof RulingRecorder>;

const command = (opId: OpId, more: Partial<QueuedCommand> = {}): QueuedCommand =>
  ({
    opId,
    canvasName: "factory",
    actor: { kind: "seat", seatId, nodeId: "s1" },
    target: { kind: "task", nodeId: "board-1" },
    basis: null,
    after: [],
    op: { kind: "start" },
    ...more,
  }) as QueuedCommand;

const queue = (queued: QueuedCommand) =>
  runtime.runPromise(work.queueCommand({ command: queued as never, basis: { kind: "canvas", canvasName: "factory", seq: 1 } as never, originAt: at, receivedAt: at }));

const setEditor = (editor: InstallationId) =>
  runtime.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql`UPDATE canvases SET editor_installation_id = ${editor} WHERE canvas_name = 'factory'`),
  );

const stateOf = (opId: OpId) => runtime.runPromise(work.commandState("factory", SELF, opId));

/** A ruler over the real store; the task domain applies anything but an op named `bad`, in the order it is asked. */
const rulerOver = (ruled: Array<OpId>, held = canvas) =>
  runtime.runPromise(
    makeResourceRuler({
      canvases: Effect.succeed(["factory"]),
      editedCanvas: () =>
        Effect.map(
          Effect.flatMap(SqlClient.SqlClient, (sql) => sql<{ editor: string }>`SELECT editor_installation_id AS editor FROM canvases WHERE canvas_name = 'factory'`),
          (rows) => (rows[0]?.editor === SELF ? held : undefined),
        ).pipe(Effect.provideService(SqlClient.SqlClient, runtime.runSync(SqlClient.SqlClient)), Effect.orDie),
      unruled: (name) => work.unruledCommands(name).pipe(Effect.orDie),
      state: (name, writer, opId) => work.commandState(name, writer, opId).pipe(Effect.orDie),
      record: (input) => recorder.record(input).pipe(Effect.mapError((cause) => new ResourceRulerError({ message: cause.message, cause }))),
      domains: {
        task: (writer, queued) =>
          (queued.op as { kind: string }).kind === "bad"
            ? Effect.succeed({ kind: "refuse", refusal: { reason: "invalid_input", message: "The task op does not decode" } } as const)
            : recorder
              .record({ canvasName: "factory", writer, command: queued, kind: "task", record: { kind: "applied" }, ruling: { kind: "applied", opId: queued.opId, facts: [{ n: ruled.length }] } })
              .pipe(
                Effect.tap(() => Effect.sync(() => ruled.push(queued.opId))),
                Effect.as({ kind: "ruled" } as const),
                Effect.mapError((cause) => new ResourceRulerError({ message: cause.message, cause })),
              ),
      },
    } satisfies RulerPorts),
  );

beforeAll(async () => {
  root = join(tmpdir(), `junto-resource-ruler-${randomUUID()}`);
  runtime = ManagedRuntime.make(
    Layer.provideMerge(Layer.provideMerge(RulingRecorderLive, WorkRepositoryLive), makeStateEngineLive(join(root, "junto.db"))),
  );
  await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO known_installations(installation_id, registered_at) VALUES (${SELF}, ${at})`;
          yield* sql`INSERT INTO installation(singleton, installation_id, created_at) VALUES (1, ${SELF}, ${at})`;
          yield* seedCanvasRows({ seq: 1, canvases: new Map([["factory", { nodes }]]) });
        }),
      );
    }),
  );
  work = await runtime.runPromise(WorkRepository);
  recorder = await runtime.runPromise(RulingRecorder);
});

afterAll(async () => {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

describe("the editing machine's ruler", () => {
  it("rules a backlog held before this machine edited the canvas, once it does, each writer's in order", async () => {
    await setEditor(OTHER);
    const first = op();
    const second = op();
    await queue(command(first));
    await queue(command(second, { after: [first] }));
    const ruled: Array<OpId> = [];
    const ruler = await rulerOver(ruled);
    await runtime.runPromise(ruler.sweepAll);
    expect(ruled).toEqual([]);
    expect(await stateOf(first)).toEqual({ kind: "queued" });

    await setEditor(SELF);
    await runtime.runPromise(ruler.sweep("factory"));
    expect(ruled).toEqual([first, second]);
    // A second sweep finds nothing left: each command is ruled once.
    await runtime.runPromise(ruler.sweep("factory"));
    expect(ruled).toEqual([first, second]);
  });

  it("rules what a ruler started after it was queued finds held", async () => {
    const held = op();
    await queue(command(held));
    const ruled: Array<OpId> = [];
    await runtime.runPromise((await rulerOver(ruled)).sweepAll);
    expect(ruled).toEqual([held]);
  });

  it("keeps queued a kind with no ruler, and every command that builds on it", async () => {
    const artifact = op();
    const built = op();
    await queue(command(artifact, { target: { kind: "thread", nodeId: "board-1" } as never }));
    await queue(command(built, { after: [artifact] }));
    const ruled: Array<OpId> = [];
    await runtime.runPromise((await rulerOver(ruled)).sweep("factory"));
    expect(ruled).toEqual([]);
    expect(await stateOf(artifact)).toEqual({ kind: "queued" });
    expect(await stateOf(built)).toEqual({ kind: "queued" });
  });

  it("refuses what the domain cannot rule, and what builds on a refusal names its root", async () => {
    const bad = op();
    const built = op();
    await queue(command(bad, { op: { kind: "bad" } }));
    await queue(command(built, { after: [bad] }));
    await runtime.runPromise((await rulerOver([])).sweep("factory"));
    const refused = await stateOf(bad);
    expect(refused.kind === "refused" && refused.ruling.reason).toBe("invalid_input");
    const after = await stateOf(built);
    expect(after.kind === "refused" && { reason: after.ruling.reason, root: after.ruling.root }).toEqual({ reason: "depends_on_refused", root: bad });
  });

  it("refuses unknown_target a command whose node is no longer of its kind on the editing machine's canvas", async () => {
    const gone = op();
    await queue(command(gone));
    const ruled: Array<OpId> = [];
    await runtime.runPromise((await rulerOver(ruled, canvasOf([seat("s1", { y: 0 }), seat("board-1", { y: 200 })]))).sweep("factory"));
    expect(ruled).toEqual([]);
    const refused = await stateOf(gone);
    expect(refused.kind === "refused" && refused.ruling.reason).toBe("unknown_target");
  });
});
