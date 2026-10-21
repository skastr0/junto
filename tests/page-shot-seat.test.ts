/**
 * A page box comment's shot as a seat on another machine reads it (B7, the
 * asking side; remote-security's condition 2 on the purge), on real
 * databases: the seat's notice crosses, the seat's read pulls the shot under
 * the thread's root comment at its page node with the page node reached,
 * the copy lands in the seat's workspace, and the operator's purge, crossing
 * after, leaves the mini's store no claim on the shot.
 */
import { createHash, randomUUID } from "node:crypto";
import { access, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BodyPuller } from "../src/main/junto/content/body-puller";
import { ContentService, makeContentServiceLive } from "../src/main/junto/content/service";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { seatPageShot } from "../src/main/junto/work/page-shot-seat";
import { WorkRepository, WorkRepositoryLive } from "../src/main/junto/work/repository";
import type { MailMessageId } from "../src/shared/crew";
import { EXCHANGE_ROWS_PAGE_BYTES } from "../src/shared/exchange-bounds";
import { InstallationId } from "../src/shared/installation-id";
import type { NodeId } from "../src/shared/model/base";
import { subjectNoticeRow } from "../src/shared/subject-notice";
import { threadSubjectMetadata, type ResourceSubject } from "../src/shared/thread-subject";
import type { ContentRef } from "../src/shared/wire/content-ref";
import { WORK_HOME_ENV } from "../src/shared/work-control";
import { entitledTo, type CanvasPlacement, type RowsFrame } from "../src/shared/work-exchange";
import { ActorSeatId, type ActorRef } from "../src/shared/work-protocol";
import { canvasOf, page, region, seat } from "./support/model-nodes";
import { seedCanvasRows } from "./support/seed-canvas";

const id = Schema.decodeUnknownSync(InstallationId);
const EDITOR = id("macbook");
const MINI = id("mini");
const at = "2026-10-21T12:00:00.000Z";
const seats = ["lead", "peer", "far"] as const;
const homes: Record<string, InstallationId> = { lead: EDITOR, peer: MINI, far: MINI };
const actor = (nodeId: string): ActorRef => ({
  seatId: Schema.decodeUnknownSync(ActorSeatId)(`seat_${(seats.indexOf(nodeId as never) + 1).toString().repeat(64)}`),
  canvasName: "factory",
  nodeId,
});
const placement: CanvasPlacement = {
  canvasId: "canvas-factory",
  editor: EDITOR,
  holds: (machine) => machine === EDITOR || machine === MINI,
  seatOf: (nodeId) => (homes[nodeId] === undefined ? undefined : { seatId: actor(nodeId).seatId, machine: homes[nodeId]! }),
};

/** A PNG whose header declares 20 by 10. */
const PNG = (() => {
  const out = new Uint8Array(64);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(out.buffer).setUint32(16, 20);
  new DataView(out.buffer).setUint32(20, 10);
  return out;
})();
const SHOT = { sha256: createHash("sha256").update(PNG).digest("hex"), byteLength: PNG.byteLength, mediaType: "image/png" } as ContentRef;
const subject = { kind: "page", nodeId: "page-1", anchor: { kind: "box", x: 0, y: 0, w: 10, h: 10, url: "https://x.example/", scroll: { x: 0, y: 0 }, shot: SHOT } } as ResourceSubject;
const C1 = "01M5F8P0000000000000000001";
// "lead", "peer" and the page share a region; "far" sits in another, out of the page's reach.
const NODES = [
  region("team", { x: -40, y: -40, width: 900, height: 900 }),
  seat("lead"),
  seat("peer", { y: 120 }),
  page("page-1", { y: 600 }),
  region("away", { x: 2000, y: 0, width: 400, height: 400 }),
  seat("far", { x: 2100, y: 100 }),
];
const CANVAS = canvasOf(NODES, [], "factory");

type Machine = {
  readonly self: InstallationId;
  readonly root: string;
  readonly runtime: ManagedRuntime.ManagedRuntime<WorkRepository | ContentService | SqlClient.SqlClient, unknown>;
  readonly work: Context.Service.Shape<typeof WorkRepository>;
  readonly sql: SqlClient.SqlClient;
};

const boot = async (self: InstallationId): Promise<Machine> => {
  const root = join(tmpdir(), `junto-page-shot-seat-${self}-${randomUUID()}`);
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(
      Layer.mergeAll(WorkRepositoryLive, makeContentServiceLive({ root: join(root, "content"), skipInlineMediaMigration: true })),
      Layer.mergeAll(makeStateEngineLive(join(root, "junto.db")), makeInstallOpsLive(join(root, "install-ops.db"))),
    ),
  );
  const work = await runtime.runPromise(WorkRepository);
  const sql = await runtime.runPromise(SqlClient.SqlClient);
  await runtime.runPromise(sql.withTransaction(Effect.gen(function* () {
    for (const machine of [EDITOR, MINI]) yield* sql`INSERT INTO known_installations(installation_id, registered_at) VALUES (${machine}, ${at})`;
    yield* sql`INSERT INTO installation(singleton, installation_id, created_at) VALUES (1, ${self}, ${at})`;
    yield* seedCanvasRows({ seq: 1, canvases: new Map([["factory", { nodes: NODES }]]) });
    yield* sql`UPDATE canvases SET editor_installation_id = ${EDITOR}`;
  })));
  return { self, root, runtime, work, sql };
};

let editor: Machine;
let mini: Machine;
let miniContent: Context.Service.Shape<typeof ContentService>;
let workHome: string;
let noticeId: string;
let copyPath: string | undefined;
let farNoticeId: string;
const pulls: Array<Parameters<Context.Service.Shape<typeof BodyPuller>["pull"]>[0]> = [];

const append = (nodeId: string, messageId: string, metadata: Record<string, unknown>) =>
  editor.runtime.runPromise(editor.work.appendMessage({
    sink: { canvasName: "factory", nodeId },
    basis: { kind: "canvas", canvasName: "factory", seq: 1 },
    message: { messageId, role: "user", parts: [{ kind: "text", text: "a box" }], metadata } as never,
    sentBy: actor("lead"),
    destination: { kind: "mailbox" },
    originAt: at,
    receivedAt: at,
  }));

const notice = async (recipient: string) => {
  const row = subjectNoticeRow({
    kind: "comment",
    installationId: EDITOR,
    sourceId: C1 as MailMessageId,
    subject,
    threadId: C1 as MailMessageId,
    recipient: recipient as NodeId,
    text: "a box",
    sender: { senderNodeId: "lead", senderName: "lead" } as never,
  });
  await append(recipient, row.messageId, row.metadata);
  return row.messageId;
};

/** Every row of the editing machine the mini is entitled to, taken there. */
const crossToMini = async () => {
  const rows = await editor.runtime.runPromise(
    editor.work.exchangeRows({ canvasName: "factory", writer: EDITOR, after: "0", limit: 64, bytes: EXCHANGE_ROWS_PAGE_BYTES }),
  );
  const facts = rows.rows.map((row) => row.fact).filter((fact) => entitledTo(MINI, fact, placement));
  const frame: RowsFrame = JSON.parse(JSON.stringify({ kind: "rows", canvasName: "factory", canvasId: "canvas-factory", writer: EDITOR, facts, through: rows.through }));
  await mini.runtime.runPromise(mini.work.applyExchangeRows({ peer: EDITOR, frame, placement }));
};

/** The pull as pullContent does it: the editing machine's bytes, kept under exactly the owner passed. */
const puller: Context.Service.Shape<typeof BodyPuller> = {
  pull: (input) =>
    Effect.suspend(() => {
      pulls.push(input);
      return miniContent.put({ source: PNG, mediaType: "image/png", owner: input.owner });
    }).pipe(Effect.asVoid, Effect.orDie),
};

const read = (seatNodeId: string, messageId: string) =>
  mini.runtime.runPromise(Effect.gen(function* () {
    const message = yield* mini.work.mailMessage("factory", seatNodeId, messageId);
    if (message === undefined) throw new Error(`no ${messageId} at ${seatNodeId}`);
    return yield* seatPageShot({ canvasName: "factory", canvas: CANVAS, seatNodeId }, message);
  }).pipe(Effect.provideService(BodyPuller, puller)));

const miniClaims = () =>
  mini.runtime.runPromise(Effect.flatMap(ContentService, (content) => content.listRefs(SHOT.sha256)));

const settled = async (done: () => Promise<boolean>) => {
  for (let tries = 0; tries < 100 && !(await done()); tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
};

beforeAll(async () => {
  workHome = join(tmpdir(), `junto-page-shot-seat-home-${randomUUID()}`);
  process.env[WORK_HOME_ENV] = workHome;
  editor = await boot(EDITOR);
  mini = await boot(MINI);
  miniContent = await mini.runtime.runPromise(ContentService);
  await append("page-1", C1, { factoryMail: true, ...threadSubjectMetadata(subject), threadId: C1 });
  // The writer's claim on the editing machine, as keepPublished records it.
  await editor.runtime.runPromise(editor.sql.withTransaction(Effect.gen(function* () {
    const { sql } = editor;
    yield* sql`INSERT OR IGNORE INTO content_objects(sha256, byte_length, created_at, verified_at) VALUES (${SHOT.sha256}, ${SHOT.byteLength}, ${at}, ${at})`;
    yield* sql`INSERT INTO content_refs(ref_id, sha256, byte_length, media_type, owner_kind, owner_canvas, owner_node, owner_record_id, created_at)
      VALUES (${randomUUID()}, ${SHOT.sha256}, ${SHOT.byteLength}, 'image/png', 'message', 'factory', 'page-1', ${C1}, ${at})`;
  })));
  noticeId = await notice("peer");
  farNoticeId = await notice("far");
  await crossToMini();
});

afterAll(async () => {
  delete process.env[WORK_HOME_ENV];
  for (const machine of [editor, mini]) {
    await machine.runtime.dispose();
    await rm(machine.root, { recursive: true, force: true });
  }
  await rm(workHome, { recursive: true, force: true });
});

describe("a page box shot a seat on another machine reads", () => {
  it("is pulled under the root comment at its page node, the page reached, and lands in the seat's workspace", async () => {
    expect(await read("peer", noticeId)).toEqual({ state: "pending" });
    await settled(async () => (await miniClaims()).length > 0);
    expect(pulls).toHaveLength(1);
    expect(pulls[0]!.owner).toEqual({ kind: "message", canvasName: "factory", nodeId: "page-1", recordId: C1 });
    expect(pulls[0]!.reached).toMatchObject({ canvasName: "factory", resourceId: "page-1" });
    expect((await miniClaims()).map(({ owner }) => owner)).toEqual([{ kind: "message", canvasName: "factory", nodeId: "page-1", recordId: C1 }]);
    const ready = await read("peer", noticeId);
    if (ready?.state !== "ready") throw new Error(`not ready: ${JSON.stringify(ready)}`);
    expect(ready.path.startsWith(workHome)).toBe(true);
    expect(new Uint8Array(await readFile(ready.path))).toEqual(PNG);
    copyPath = ready.path;
    expect(pulls).toHaveLength(1);
  });

  it("tells a seat whose reach misses the page nothing, and pulls nothing for it", async () => {
    expect(await read("far", farNoticeId)).toBeUndefined();
    expect(pulls).toHaveLength(1);
  });

  it("after the operator's purge crosses, the mini holds no claim on the shot and the seat reads it removed", async () => {
    await editor.runtime.runPromise(editor.work.purgeShot({ canvasName: "factory", nodeId: "page-1", messageId: C1 }));
    await crossToMini();
    expect(await miniClaims()).toEqual([]);
    expect(await read("peer", noticeId)).toEqual({ state: "removed" });
    expect(pulls).toHaveLength(1);
  });

  it("takes the seat's workspace copy away once the purge commits there, and the comment still reads", async () => {
    if (copyPath === undefined) throw new Error("the seat never read the shot ready");
    await expect(access(copyPath)).rejects.toThrow();
    expect((await mini.runtime.runPromise(mini.work.mailMessage("factory", "peer", noticeId)))?.messageId).toBe(noticeId);
    expect((await editor.runtime.runPromise(editor.work.mailMessage("factory", "page-1", C1)))?.messageId).toBe(C1);
  });
});
