/**
 * A seat's write on a canvas another machine edits, on a real database: it
 * is queued as this machine's own row, waits for its ruling only while a link
 * to the editing machine is open, and answers applied, refused or queued.
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Exit, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { WorkRepository, WorkRepositoryLive, workRecordContentSha256 } from "../src/main/junto/work/repository";
import { ResourceSubmit, makeResourceSubmitLayer } from "../src/main/junto/work/resource-submit";
import { ActorSeatId } from "../src/shared/actor-seat";
import type { QueuedCommand } from "../src/shared/command-row";
import { InstallationId } from "../src/shared/installation-id";
import { RULING_WAIT_MS } from "../src/shared/resource-command";
import type { CanvasPlacement, RowsFrame } from "../src/shared/work-exchange";
import { OpId } from "../src/shared/work-ids";
import { WORK_PROTOCOL } from "../src/shared/work-protocol";
import { seedCanvasRows } from "./support/seed-canvas";
import { seat, taskBoard } from "./support/model-nodes";

const id = Schema.decodeUnknownSync(InstallationId);
const SELF = id("mini");
const EDITOR = id("macbook");
const at = "2026-10-21T12:00:00.000Z";
const seatId = Schema.decodeUnknownSync(ActorSeatId)(`seat_${"2".repeat(64)}`);
let next = 0;
const op = () => Schema.decodeUnknownSync(OpId)(`01M5EY5${String(next++).padStart(19, "0")}`);

const placement: CanvasPlacement = {
  canvasId: "canvas-factory",
  editor: EDITOR,
  holds: (machine) => machine === EDITOR || machine === SELF,
  seatOf: (nodeId) => (nodeId === "s1" ? { seatId, machine: SELF } : undefined),
};

let linked = false;
let root: string;
let runtime: ManagedRuntime.ManagedRuntime<ResourceSubmit | WorkRepository | SqlClient.SqlClient, unknown>;
let submit: Context.Service.Shape<typeof ResourceSubmit>;
let work: Context.Service.Shape<typeof WorkRepository>;

const command = (opId: OpId): QueuedCommand =>
  ({
    opId,
    canvasName: "factory",
    actor: { kind: "seat", seatId, nodeId: "s1" },
    target: { kind: "task", nodeId: "board-1" },
    basis: null,
    after: [],
    op: { kind: "start" },
  }) as unknown as QueuedCommand;

/** The editing machine's refusal of one of this machine's commands, arriving as a row. */
const refusalArrives = (opId: OpId, seq: string) => {
  const semantic = {
    protocol: WORK_PROTOCOL,
    id: { route: { eventHome: EDITOR, entityHome: EDITOR }, seq },
    recordType: "fact",
    basis: { kind: "canvas", canvasName: "factory", seq: 1 },
    item: { kind: "ruling", itemId: opId, sink: { canvasName: "factory", nodeId: "board-1" } },
    operation: "ruling.refused",
    predecessor: null,
    body: { operation: "ruling.refused", writer: SELF, opId, actor: { kind: "seat", seatId, nodeId: "s1" }, reason: "invalid_transition", root: opId },
  };
  const frame = {
    kind: "rows",
    canvasName: "factory",
    canvasId: "canvas-factory",
    writer: EDITOR,
    facts: [{ ...semantic, originAt: at, contentSha256: workRecordContentSha256(semantic as never) }],
    through: seq,
  } as unknown as RowsFrame;
  return work.applyExchangeRows({ peer: EDITOR, frame, placement, receivedAt: at });
};

beforeAll(async () => {
  root = join(tmpdir(), `junto-resource-submit-${randomUUID()}`);
  runtime = ManagedRuntime.make(
    Layer.provideMerge(
      Layer.provideMerge(makeResourceSubmitLayer((peer) => linked && peer === EDITOR), WorkRepositoryLive),
      makeStateEngineLive(join(root, "junto.db")),
    ),
  );
  await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO known_installations(installation_id, registered_at) VALUES (${SELF}, ${at})`;
          yield* sql`INSERT INTO installation(singleton, installation_id, created_at) VALUES (1, ${SELF}, ${at})`;
          yield* seedCanvasRows({ seq: 1, canvases: new Map([["factory", { nodes: [seat("s1", { y: 0 }), taskBoard("board-1", { y: 200 })] }]]) });
          yield* sql`UPDATE canvases SET editor_installation_id = ${EDITOR} WHERE canvas_name = 'factory'`;
        }),
      );
    }),
  );
  submit = await runtime.runPromise(ResourceSubmit);
  work = await runtime.runPromise(WorkRepository);
});

afterAll(async () => {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

describe("a seat's write on a canvas another machine edits", () => {
  it("is routed to the editing machine, and a canvas naming no editor is ruled here", async () => {
    expect(await runtime.runPromise(submit.route("factory"))).toEqual({ kind: "editor", editor: EDITOR });
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`UPDATE canvases SET editor_installation_id = NULL WHERE canvas_name = 'factory'`));
    try {
      expect(await runtime.runPromise(submit.route("factory"))).toEqual({ kind: "here" });
    } finally {
      await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`UPDATE canvases SET editor_installation_id = ${EDITOR} WHERE canvas_name = 'factory'`));
    }
  });

  it("answers queued at once with no link to the editing machine, and the command is held", async () => {
    linked = false;
    const opId = op();
    const started = Date.now();
    expect(await runtime.runPromise(submit.queue(command(opId), EDITOR))).toEqual({ kind: "queued" });
    expect(Date.now() - started).toBeLessThan(RULING_WAIT_MS / 4);
    expect(await runtime.runPromise(work.commandState("factory", SELF, opId))).toEqual({ kind: "queued" });
  });

  it("answers the ruling that comes back while it waits on an open link", async () => {
    linked = true;
    const opId = op();
    const answered = runtime.runPromise(submit.queue(command(opId), EDITOR));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(Exit.isSuccess(await runtime.runPromiseExit(refusalArrives(opId, "1")))).toBe(true);
    const outcome = await answered;
    expect(outcome.kind === "refused" && { root: outcome.root, reason: outcome.error.details?.reason }).toEqual({ root: opId, reason: "invalid_transition" });
  });

  it("stops waiting after RULING_WAIT_MS on an open link, and answers queued", async () => {
    linked = true;
    const started = Date.now();
    expect(await runtime.runPromise(submit.queue(command(op()), EDITOR))).toEqual({ kind: "queued" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(RULING_WAIT_MS);
  });

  it("never queues the operator's command, which only the editing machine writes, and writes nothing", async () => {
    const opId = op();
    const exit = await runtime.runPromiseExit(submit.queue({ ...command(opId), actor: { kind: "operator" } } as QueuedCommand, EDITOR));
    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("not_permitted");
    expect(await runtime.runPromise(work.commandState("factory", SELF, opId))).toEqual({ kind: "unknown" });
  });

  it("refuses at once, in the ruler's words, a target of the wrong kind", async () => {
    const exit = await runtime.runPromiseExit(
      submit.queue({ ...command(op()), target: { kind: "task", nodeId: "s1" } } as QueuedCommand, EDITOR),
    );
    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("unknown_target");
  });
});
