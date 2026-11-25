/**
 * The thread index takes peer seats: another machine's seat, as this
 * machine's copy of the canvas holds it, has its threads with the operator
 * read like any seat's, named by its label, in its region, in the seat's own
 * read and in Global threads.
 */
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { mailExtensionMetadata } from "../src/shared/crew";
import { makeUserMessage } from "../src/shared/task";
import { operatorActorRef } from "../src/shared/work-reference";
import { ModelStoresLive } from "./support/seed-canvas";
import { ModelService } from "../src/core/model/service";
import { Node, asCanvasName } from "../src/shared/model";
import { peer, region, seat as seatNode } from "./support/model-nodes";
import { WorkLive, WorkService } from "../src/core/work/service";
import { CrewRepositoryLive } from "../src/core/work/crew-repository";
import { makeContentServiceLive } from "../src/core/content/service";
import { WorkRepositoryLive } from "../src/core/work/repository";
import { makeStateEngineLive } from "../src/core/state/engine";
import { makeInstallOpsLive } from "../src/core/install-ops/engine";
import { MachineRepositoryLive } from "../src/core/machines/repository";
import { SettingsLive } from "../src/core/settings/service";
import { nameThisMachine } from "./support/name-this-machine";
import { PausePlaneAllPlaying } from "../src/core/pause-plane";
import { seatThreads } from "../src/core/work/operator-threads";
import { operatorThreadsPage } from "../src/core/work/thread-rows";
import { makeTestLog } from "./support/test-log";

const testLog = makeTestLog();
const node = Schema.decodeUnknownSync(Node);
const CANVAS = "peers";
const LOCAL = "s-here";
const PEER = "p-mini";

const makeRuntime = (root: string) => {
  const repositoriesLive = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      CrewRepositoryLive,
      MachineRepositoryLive,
      SettingsLive,
      makeContentServiceLive({ root: join(root, "content"), skipInlineMediaMigration: true }),
    ),
    Layer.mergeAll(makeStateEngineLive(join(root, "state", "junto.db")), makeInstallOpsLive(join(root, "state", "install-ops.db"))),
  );
  const canvasesLive = Layer.provideMerge(ModelStoresLive, repositoriesLive);
  return ManagedRuntime.make(Layer.mergeAll(Layer.provideMerge(WorkLive, canvasesLive), PausePlaneAllPlaying, testLog.log.loggerLayer));
};

let root: string;
let runtime: ReturnType<typeof makeRuntime>;

/** The operator's mail into a seat's mailbox, a new thread, as the desktop writes it (a peer's, as sync writes it); returns its id. */
const write = (to: string, text: string) =>
  runtime.runPromise(
    Effect.flatMap(WorkService, (work) => {
      const sender = operatorActorRef(CANVAS);
      const extension = mailExtensionMetadata({ mailKind: "prompt", fromSeat: sender.seatId, senderNodeId: sender.nodeId, senderName: "operator", senderGeneration: "operator", senderHarness: "unknown" });
      const message = makeUserMessage({ messageId: ulid(), text, contextId: CANVAS, metadata: { factoryMail: true, ...extension } });
      // A copy machine never tells a peer (workSystemMailboxNotify refuses): the row reaches it as sync writes it,
      // an append to the peer's own mailbox, which workSubjectNotice is.
      return to === PEER ? work.workSubjectNotice(CANVAS, to, message, sender) : work.workSystemMailboxNotify(CANVAS, to, message);
    }).pipe(Effect.flatMap((appended) => (appended.ok ? Effect.succeed(appended.data.messageId) : Effect.die(appended.message)))),
  );

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-threads-peer-"));
  const workHome = join(root, "work");
  mkdirSync(workHome, { recursive: true });
  process.env.JUNTO_WORK_HOME = workHome;
  runtime = makeRuntime(root);
  await runtime.runPromise(nameThisMachine);
  // The mini is a machine this one has pinned, so its seats may sit here as peers.
  await runtime.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO known_installations (installation_id, registered_at) VALUES ('mini-installation', 'now')`;
          yield* sql`INSERT INTO machine_peers (machine_name, installation_id, bound_at) VALUES ('mini', 'mini-installation', 'now')`;
        }),
      ),
    ),
  );
  // A copy of a canvas the mini edits: its seat sits here as a peer, beside this machine's own seat.
  await runtime.runPromise(
    Effect.flatMap(ModelService, (model) =>
      model.installCopy({
        canvas: asCanvasName(CANVAS),
        canvasId: "canvas-peers",
        seq: 1,
        editor: "mini-installation",
        nodes: [
          node(region("r-far", { x: 0, y: 0, width: 800, height: 400 }, { label: "Far" } as never)),
          node(seatNode(LOCAL, { x: 1000, y: 40, width: 120, height: 48, bindingId: "bind-here" as never, launch: { kind: "harness", argv: ["claude"] } })),
          node(peer(PEER, { x: 40, y: 40, width: 120, height: 48, label: "Mini seat", host: "mini" as never, seatId: `seat_${"a".repeat(64)}` as never })),
        ],
        wires: [],
      }),
    ),
  );
}, 60_000);

afterAll(async () => {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
  delete process.env.JUNTO_WORK_HOME;
});

describe("a peer seat in the thread index", () => {
  it("has its threads read by its label in its own read and in Global threads, beside a local seat's", async () => {
    const toPeer = await write(PEER, "for the mini seat");
    const toLocal = await write(LOCAL, "for the seat here");

    const own = await runtime.runPromise(seatThreads(CANVAS, PEER));
    expect(own.map((thread) => thread.threadId)).toEqual([toPeer]);

    const read = await runtime.runPromise(operatorThreadsPage({ canvasName: CANVAS as never, limit: 50 }));
    const rows = new Map(read.rows.map((row) => [row.threadId, row]));
    expect(rows.get(toPeer)).toMatchObject({ seat: { nodeId: PEER, name: "Mini seat" }, region: { label: "Far" } });
    expect(rows.get(toLocal)).toMatchObject({ seat: { nodeId: LOCAL } });
    expect(read.total).toBe(2);
  }, 60_000);
});
