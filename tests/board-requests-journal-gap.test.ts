/**
 * Step 39 leaves gaps in a writer's journal where its retired facts were.
 * Two real machines prove a peer reads past one: the editing machine writes
 * mail around one fact of every retired operation, the step's journal pass
 * deletes them, and the other machine then catches up across the gap in one
 * exchange, and the next fact takes a new seq.
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Context, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, describe, expect, it } from "vitest";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { BOARD_REQUESTS_RETIRED_OPERATIONS, rebuildJournal } from "../src/main/junto/state/migrate-board-requests";
import { makeRowExchange, type RowExchange } from "../src/main/junto/work/exchange/session";
import { WorkRepository, WorkRepositoryLive } from "../src/main/junto/work/repository";
import { InstallationId } from "../src/shared/installation-id";
import type { CanvasPlacement, ExchangeFrame } from "../src/shared/work-exchange";
import type { Message } from "../src/shared/work-model";
import { ActorSeatId, type ActorRef } from "../src/shared/work-protocol";
import { seedCanvasRows } from "./support/seed-canvas";
import { seat } from "./support/model-nodes";

const id = Schema.decodeUnknownSync(InstallationId);
const EDITOR = id("macbook");
const MINI = id("mini");
const at = "2026-10-09T12:00:00.000Z";
const basis = { kind: "canvas" as const, canvasName: "factory", seq: 1 };

const homes: Record<string, InstallationId> = { lead: EDITOR, peer: MINI };
const actor = (nodeId: string): ActorRef => ({
  seatId: Schema.decodeUnknownSync(ActorSeatId)(`seat_${(Object.keys(homes).indexOf(nodeId) + 1).toString().repeat(64)}`),
  canvasName: "factory",
  nodeId,
});
const placement: CanvasPlacement = {
  canvasId: "canvas-factory",
  editor: EDITOR,
  holds: (machine) => Object.values(homes).includes(machine),
  seatOf: (nodeId) => (homes[nodeId] === undefined ? undefined : { seatId: actor(nodeId).seatId, machine: homes[nodeId]! }),
};

type Machine = {
  readonly self: InstallationId;
  readonly runtime: ManagedRuntime.ManagedRuntime<WorkRepository | SqlClient.SqlClient, unknown>;
  readonly repository: Context.Service.Shape<typeof WorkRepository>;
  readonly exchange: RowExchange;
};

type Queued = { readonly from: InstallationId; readonly to: InstallationId; readonly frame: unknown };
const queue: Queued[] = [];
const machines = new Map<InstallationId, Machine>();
const roots: string[] = [];

/** A machine over the database at `path`, seeded with its canvas the first time. */
const boot = async (self: InstallationId, path: string, seed: boolean): Promise<Machine> => {
  const runtime = ManagedRuntime.make(Layer.provideMerge(WorkRepositoryLive, makeStateEngineLive(path)));
  const repository = await runtime.runPromise(WorkRepository);
  if (seed) {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO known_installations(installation_id, registered_at) VALUES (${self}, ${at})`;
            yield* sql`INSERT INTO installation(singleton, installation_id, created_at) VALUES (1, ${self}, ${at})`;
            yield* seedCanvasRows({
              seq: 1,
              canvases: new Map([["factory", { nodes: Object.keys(homes).map((nodeId, index) => seat(nodeId, { y: index * 120 })) }]]),
            });
          }),
        );
      }),
    );
  }
  const exchange = makeRowExchange({
    self,
    repository,
    canvases: Effect.succeed(["factory"]),
    placement: () => Effect.succeed(placement),
    mailArrived: (_canvas, _nodeId, _message: Message) => undefined,
    commandArrived: () => undefined,
    cutCopy: () => Effect.succeed(undefined),
    copySent: () => Effect.void,
    installCopy: () => Effect.die("no copy is sent between these machines"),
    signals: () => Effect.succeed([]),
    takeSignal: () => Effect.die("no signal is stated between these machines"),
  });
  const machine: Machine = { self, runtime, repository, exchange };
  machines.set(self, machine);
  return machine;
};

const link = async (left: Machine, right: Machine): Promise<void> => {
  const end = (from: Machine, to: Machine) => ({
    peer: to.self,
    send: (frame: ExchangeFrame) =>
      Effect.sync(() => {
        queue.push({ from: from.self, to: to.self, frame: JSON.parse(JSON.stringify(frame)) });
      }),
  });
  await left.runtime.runPromise(left.exchange.opened(end(left, right)));
  await right.runtime.runPromise(right.exchange.opened(end(right, left)));
};

const settle = async (): Promise<void> => {
  const quiet = async () => {
    for (const machine of machines.values()) await machine.runtime.runPromise(machine.exchange.quiet);
  };
  for (await quiet(); queue.length > 0; await quiet()) {
    const next = queue.shift()!;
    const to = machines.get(next.to)!;
    if (to.exchange.linked(next.from)) await to.runtime.runPromise(to.exchange.receive(next.from, next.frame));
  }
};

const send = (on: Machine, from: string, to: string, messageId: string) =>
  on.runtime.runPromise(
    on.repository.appendMessage({
      sink: { canvasName: "factory", nodeId: to },
      basis,
      message: { messageId, role: "agent", parts: [{ kind: "text", text: `from ${from}` }] },
      sentBy: actor(from),
      destination: { kind: "mailbox" },
      originAt: at,
      receivedAt: at,
    }),
  );

const inbox = async (on: Machine, nodeId: string): Promise<string[]> =>
  (await on.runtime.runPromise(on.repository.mailbox("factory", nodeId))).map((message) => message.messageId);

const journal = (path: string) => {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      seqs: (database.prepare("SELECT seq FROM work_events WHERE event_home = ? ORDER BY length(seq), seq").all(EDITOR) as Array<{ seq: string }>).map(
        ({ seq }) => seq,
      ),
      last: String(database.prepare("SELECT last_seq FROM work_event_sequences WHERE event_home = ? AND entity_home = ?").get(EDITOR, EDITOR)!.last_seq),
    };
  } finally {
    database.close();
  }
};

afterAll(async () => {
  for (const machine of machines.values()) await machine.runtime.dispose();
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

describe("a journal with the retired facts deleted (step 39)", () => {
  it("is caught up across the gap in one exchange, and never reuses a seq", async () => {
    const root = join(tmpdir(), `junto-journal-gap-${randomUUID()}`);
    roots.push(root);
    const editorPath = join(root, "editor", "junto.db");
    let editor = await boot(EDITOR, editorPath, true);
    const mini = await boot(MINI, join(root, "mini", "junto.db"), true);
    await editor.runtime.runPromise(
      editor.repository.recordCanvasCopySent({
        canvasName: "factory",
        target: MINI,
        seq: 1,
        seats: Object.keys(homes).map((nodeId) => ({ nodeId, seatId: actor(nodeId).seatId, machine: homes[nodeId]! })),
        sentAt: at,
      }),
    );

    await send(editor, "lead", "peer", "before-gap");
    // One fact of every retired operation, written the way the old code wrote
    // them: the editing machine's own seqs, allocated in turn.
    await editor.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            for (const operation of BOARD_REQUESTS_RETIRED_OPERATIONS) {
              const [{ last_seq }] = yield* sql<{ last_seq: string }>`
                SELECT last_seq FROM work_event_sequences WHERE event_home = ${EDITOR} AND entity_home = ${EDITOR}`;
              const seq = String(BigInt(last_seq) + 1n);
              yield* sql`UPDATE work_event_sequences SET last_seq = ${seq} WHERE event_home = ${EDITOR} AND entity_home = ${EDITOR}`;
              yield* sql`INSERT INTO work_events(event_home, entity_home, seq, protocol, record_type, item_kind, item_id,
                item_canvas_name, item_node_id, operation, content_sha256, origin_at, received_at)
                VALUES (${EDITOR}, ${EDITOR}, ${seq}, 'junto/work/v1', 'fact', 'retired', ${`retired-${seq}`},
                  'factory', 'board', ${operation}, ${"c".repeat(64)}, ${at}, ${at})`;
              yield* sql`INSERT INTO work_facts(event_home, entity_home, seq, result_json, basis_kind, basis_canvas_name, basis_canvas_seq)
                VALUES (${EDITOR}, ${EDITOR}, ${seq}, '{}', 'canvas', 'factory', 1)`;
            }
          }),
        );
      }),
    );
    await send(editor, "lead", "peer", "after-gap");
    await editor.runtime.dispose();
    machines.delete(EDITOR);

    const held = journal(editorPath);
    const database = new DatabaseSync(editorPath, { enableForeignKeyConstraints: false });
    try {
      database.exec("BEGIN IMMEDIATE");
      rebuildJournal(database);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      database.exec("COMMIT");
    } finally {
      database.close();
    }
    const gapped = journal(editorPath);
    expect(gapped.last).toBe(held.last);
    expect(gapped.seqs).toEqual([held.seqs[0], held.seqs.at(-1)]);
    expect(held.seqs).toHaveLength(BOARD_REQUESTS_RETIRED_OPERATIONS.length + 2);

    editor = await boot(EDITOR, editorPath, false);
    await link(editor, mini);
    await settle();
    expect(await inbox(mini, "peer")).toEqual(["before-gap", "after-gap"]);
    const have = await mini.runtime.runPromise(mini.repository.exchangeHave("factory"));
    expect(have).toEqual(expect.arrayContaining([expect.objectContaining({ writer: EDITOR, through: held.last })]));

    await send(editor, "lead", "peer", "past-gap");
    await editor.runtime.runPromise(editor.exchange.committed("factory"));
    await settle();
    expect(await inbox(mini, "peer")).toEqual(["before-gap", "after-gap", "past-gap"]);
    expect(journal(editorPath).seqs.at(-1)).toBe(String(BigInt(held.last) + 1n));
  }, 120_000);
});
