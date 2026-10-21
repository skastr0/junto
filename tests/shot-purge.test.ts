/**
 * The operator's purge of a page box comment's shot, across machines (B7,
 * remote-security's ruling), on real databases: the editing machine, the
 * mini whose seat got the comment's notice, and a machine with no notice.
 * Rows cross as the exchange takes them (applyExchangeRows), each machine
 * filtered to what entitledTo gives it.
 */
import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ContentService } from "../src/main/junto/content/service";
import { shotEntitled } from "../src/main/junto/content/shot-entitlement";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { readPageShot } from "../src/main/junto/work/page-shot-read";
import { WorkRepository, WorkRepositoryLive, workRecordContentSha256 } from "../src/main/junto/work/repository";
import { WorkService } from "../src/main/junto/work/service";
import { unlessShotPurged } from "../src/main/junto/work/shot-purge";
import type { MailMessageId } from "../src/shared/crew";
import { EXCHANGE_ROWS_PAGE_BYTES } from "../src/shared/exchange-bounds";
import { InstallationId } from "../src/shared/installation-id";
import type { NodeId } from "../src/shared/model/base";
import { subjectNoticeRow } from "../src/shared/subject-notice";
import { threadSubjectMetadata, type ResourceSubject } from "../src/shared/thread-subject";
import type { ContentRef } from "../src/shared/wire/content-ref";
import { entitledTo, type CanvasPlacement, type RowsFrame } from "../src/shared/work-exchange";
import { ActorSeatId, type ActorRef } from "../src/shared/work-protocol";
import { seedCanvasRows } from "./support/seed-canvas";
import { page, seat } from "./support/model-nodes";

const id = Schema.decodeUnknownSync(InstallationId);
const EDITOR = id("macbook");
const MINI = id("mini");
const OTHER = id("other-mini");
const at = "2026-10-21T12:00:00.000Z";
const seats = ["lead", "peer", "far"] as const;
const homes: Record<string, InstallationId> = { lead: EDITOR, peer: MINI, far: OTHER };
const actor = (nodeId: string): ActorRef => ({
  seatId: Schema.decodeUnknownSync(ActorSeatId)(`seat_${(seats.indexOf(nodeId as never) + 1).toString().repeat(64)}`),
  canvasName: "factory",
  nodeId,
});
const placement: CanvasPlacement = {
  canvasId: "canvas-factory",
  editor: EDITOR,
  holds: (machine) => machine === EDITOR || Object.values(homes).includes(machine),
  seatOf: (nodeId) => (homes[nodeId] === undefined ? undefined : { seatId: actor(nodeId).seatId, machine: homes[nodeId]! }),
};

const SHOT = {
  sha256: createHash("sha256").update("a box").digest("hex"),
  byteLength: 5,
  mediaType: "image/png",
} as ContentRef;
const subject = { kind: "page", nodeId: "page-1", anchor: { kind: "box", x: 0, y: 0, w: 10, h: 10, url: "https://x.example/", scroll: { x: 0, y: 0 }, shot: SHOT } } as ResourceSubject;
const C1 = "01M5F8P0000000000000000001";
const C2 = "01M5F8P0000000000000000002";
const R1 = "01M5F8P0000000000000000003";

type Machine = {
  readonly self: InstallationId;
  readonly root: string;
  readonly runtime: ManagedRuntime.ManagedRuntime<WorkRepository | SqlClient.SqlClient, unknown>;
  readonly work: Context.Service.Shape<typeof WorkRepository>;
  readonly sql: SqlClient.SqlClient;
};

const boot = async (self: InstallationId): Promise<Machine> => {
  const root = join(tmpdir(), `junto-shot-purge-${self}-${randomUUID()}`);
  const runtime = ManagedRuntime.make(Layer.provideMerge(WorkRepositoryLive, makeStateEngineLive(join(root, "junto.db"))));
  const work = await runtime.runPromise(WorkRepository);
  const sql = await runtime.runPromise(SqlClient.SqlClient);
  await runtime.runPromise(sql.withTransaction(Effect.gen(function* () {
    for (const machine of new Set([EDITOR, MINI, OTHER, self])) yield* sql`INSERT INTO known_installations(installation_id, registered_at) VALUES (${machine}, ${at})`;
    yield* sql`INSERT INTO installation(singleton, installation_id, created_at) VALUES (1, ${self}, ${at})`;
    yield* seedCanvasRows({ seq: 1, canvases: new Map([["factory", { nodes: [...seats.map((nodeId, index) => seat(nodeId, { y: index * 120 })), page("page-1", { y: 600 })] }]]) });
    yield* sql`UPDATE canvases SET editor_installation_id = ${EDITOR}`;
  })));
  return { self, root, runtime, work, sql };
};

let editor: Machine;
let mini: Machine;
let other: Machine;

const append = (on: Machine, nodeId: string, messageId: string, metadata: Record<string, unknown>) =>
  on.runtime.runPromise(on.work.appendMessage({
    sink: { canvasName: "factory", nodeId },
    basis: { kind: "canvas", canvasName: "factory", seq: 1 },
    message: { messageId, role: "user", parts: [{ kind: "text", text: "a box" }], metadata } as never,
    sentBy: actor("lead"),
    destination: { kind: "mailbox" },
    originAt: at,
    receivedAt: at,
  }));

/** The comment on the page, with its claim, and a notice of it to each recipient. */
const comment = async (messageId: string, recipients: ReadonlyArray<string>) => {
  await append(editor, "page-1", messageId, { factoryMail: true, ...threadSubjectMetadata(subject), threadId: messageId });
  await claim(editor, messageId);
  for (const recipient of recipients) {
    const notice = subjectNoticeRow({
      kind: "comment",
      installationId: EDITOR,
      sourceId: messageId as MailMessageId,
      subject,
      threadId: messageId as MailMessageId,
      recipient: recipient as NodeId,
      text: "a box",
      sender: { senderNodeId: "lead", senderName: "lead" } as never,
    });
    await append(editor, recipient, notice.messageId, notice.metadata);
  }
};

/** A message owner's claim on the shot, as keepPublished records it. */
const claim = (on: Machine, recordId: string) =>
  on.runtime.runPromise(on.sql.withTransaction(Effect.gen(function* () {
    const { sql } = on;
    yield* sql`INSERT OR IGNORE INTO content_objects(sha256, byte_length, created_at, verified_at) VALUES (${SHOT.sha256}, ${SHOT.byteLength}, ${at}, ${at})`;
    yield* sql`INSERT INTO content_refs(ref_id, sha256, byte_length, media_type, owner_kind, owner_canvas, owner_node, owner_record_id, created_at)
      VALUES (${randomUUID()}, ${SHOT.sha256}, ${SHOT.byteLength}, 'image/png', 'message', 'factory', 'page-1', ${recordId}, ${at})`;
  })));

const claims = (on: Machine, recordId: string) =>
  on.runtime.runPromise(on.sql.unsafe<{ n: number }>("SELECT count(*) AS n FROM content_refs WHERE owner_kind = 'message' AND owner_record_id = ?", [recordId]))
    .then((rows) => rows[0]!.n);

const purged = (on: Machine, recordId: string) =>
  on.runtime.runPromise(on.work.shotPurged({ canvasName: "factory", nodeId: "page-1", recordId }));

/** The editing machine's rows one machine is entitled to, as a frame. */
const frameFor = async (to: Machine, keep: (fact: RowsFrame["facts"][number]) => boolean = () => true): Promise<RowsFrame> => {
  const rows = await editor.runtime.runPromise(
    editor.work.exchangeRows({ canvasName: "factory", writer: EDITOR, after: "0", limit: 64, bytes: EXCHANGE_ROWS_PAGE_BYTES }),
  );
  const facts = rows.rows.map((row) => row.fact).filter((fact) => entitledTo(to.self, fact, placement) && keep(fact));
  return JSON.parse(JSON.stringify({ kind: "rows", canvasName: "factory", canvasId: "canvas-factory", writer: EDITOR, facts, through: rows.through }));
};

const take = (to: Machine, frame: RowsFrame, peer: InstallationId = EDITOR) =>
  to.runtime.runPromise(to.work.applyExchangeRows({ peer, frame, placement }));

const isPurge = (fact: RowsFrame["facts"][number]) => fact.body.operation === "shot.purged";

const serves = (recordId: string, machine: InstallationId) =>
  editor.runtime.runPromise(shotEntitled(editor.sql, {
    owner: { canvasName: "factory", nodeId: "page-1", recordId },
    sha256: SHOT.sha256,
    machine,
    placement,
    seats: seats.map((nodeId) => nodeId as NodeId),
  }));

beforeAll(async () => {
  editor = await boot(EDITOR);
  mini = await boot(MINI);
  other = await boot(OTHER);
  // C1 told the seat on the mini, and has a reply holding a claim of its own; C2 told nobody.
  await comment(C1, ["peer"]);
  await append(editor, "page-1", R1, { factoryMail: true, ...threadSubjectMetadata(subject), threadId: C1 });
  await claim(editor, R1);
  await comment(C2, []);
  // The mini took the notice and pulled the shot under the comment's owner.
  await take(mini, await frameFor(mini));
  await claim(mini, C1);
});

afterAll(async () => {
  for (const machine of [editor, mini, other]) {
    await machine.runtime.dispose();
    await rm(machine.root, { recursive: true, force: true });
  }
});

describe("the operator's purge of a comment's shot", () => {
  it("on the editing machine releases the comment's and its replies' claims, and stops the serve at once", async () => {
    expect(await serves(C1, MINI)).toBe(true);
    const done = await editor.runtime.runPromise(editor.work.purgeShot({ canvasName: "factory", nodeId: "page-1", messageId: C1 }));
    expect(done).toEqual({ comment: { canvasName: "factory", nodeId: "page-1", messageId: C1 }, released: 2, written: true });
    expect(await claims(editor, C1)).toBe(0);
    expect(await claims(editor, R1)).toBe(0);
    expect(await serves(C1, MINI)).toBe(false);
    expect(await serves(C1, EDITOR)).toBe(false);
    // The comment and its text stay.
    const kept = await editor.runtime.runPromise(editor.work.mailMessage("factory", "page-1", C1));
    expect(kept?.messageId).toBe(C1);
  });

  it("reaches the mini: its copy's claim goes, and the shot stays removed", async () => {
    await take(mini, await frameFor(mini));
    expect(await claims(mini, C1)).toBe(0);
    expect(await purged(mini, C1)).toBe(true);
  });

  it("crosses as the comment's ids alone, never its digest, to every linked machine, noticed or not", async () => {
    const frame = await frameFor(other);
    const purges = frame.facts.filter(isPurge);
    expect(purges).toHaveLength(1);
    expect(JSON.stringify(purges)).not.toContain(SHOT.sha256);
    expect(frame.facts.some((fact) => fact.body.operation === "message.append")).toBe(false);
    await take(other, frame);
    expect(await purged(other, C1)).toBe(true);
    expect(await purged(other, C2)).toBe(false);
  });

  it("is idempotent: purging again writes no row, and taking the rows again changes nothing", async () => {
    const again = await editor.runtime.runPromise(editor.work.purgeShot({ canvasName: "factory", nodeId: "page-1", messageId: R1 }));
    expect(again).toMatchObject({ comment: { messageId: C1 }, written: false });
    expect((await frameFor(mini)).facts.filter(isPurge)).toHaveLength(1);
    expect((await take(mini, await frameFor(mini))).taken).toBe(0);
    expect(await purged(mini, C1)).toBe(true);
  });

  it("arriving before its notice keeps the shot unreadable: a later pull is never attempted", async () => {
    // The seat moves to a fresh machine, which takes the purge first and the notice after.
    const late = await boot(id("late-mini"));
    homes.peer = late.self;
    try {
      await take(late, await frameFor(late, isPurge));
      await take(late, await frameFor(late, (fact) => !isPurge(fact)));
      expect(await late.runtime.runPromise(late.work.mailbox("factory", "peer"))).toHaveLength(1);
      expect(await purged(late, C1)).toBe(true);
      let pulled = 0;
      const pull = Effect.sync(() => { pulled += 1; });
      const owner = { kind: "message", canvasName: "factory", nodeId: "page-1", recordId: C1 };
      const refused = await late.runtime.runPromise(unlessShotPurged(late.sql, owner, pull, () => "removed").pipe(Effect.flip));
      expect(refused).toBe("removed");
      expect(pulled).toBe(0);
      // A comment with no purge is pulled as before.
      await late.runtime.runPromise(unlessShotPurged(late.sql, { ...owner, recordId: C2 }, pull, () => "removed"));
      expect(pulled).toBe(1);
    } finally {
      homes.peer = MINI;
      await late.runtime.dispose();
      await rm(late.root, { recursive: true, force: true });
    }
  });

  it("reads removed, ahead of the store, though the comment still names its shot", async () => {
    const read = await editor.runtime.runPromise(readPageShot({ canvasName: "factory", nodeId: "page-1", messageId: R1 }).pipe(
      Effect.provideService(WorkService, { readMailMessage: (canvas: string, nodeId: string, messageId: string) => editor.work.mailMessage(canvas, nodeId, messageId) } as never),
      Effect.provideService(ContentService, {} as never),
    ));
    expect(read).toEqual({ ok: false, reason: "removed" });
  });
});

describe("who may purge", () => {
  it("refuses a purge on any machine but the one that edits the canvas", async () => {
    const result = await mini.runtime.runPromise(mini.work.purgeShot({ canvasName: "factory", nodeId: "page-1", messageId: C2 }).pipe(Effect.flip));
    expect(String((result as { message?: string }).message)).toContain("only the machine that edits a canvas purges a shot");
  });

  it("refuses a purge row another machine wrote, and keeps nothing of it", async () => {
    const honest = (await frameFor(mini, isPurge)).facts[0]!;
    const route = { eventHome: MINI, entityHome: MINI };
    const { contentSha256: _hash, originAt, ...semantic } = {
      ...honest,
      id: { ...honest.id, route: { ...honest.id.route, ...route }, seq: "9001" },
      item: { ...honest.item, itemId: C2 },
      body: { operation: "shot.purged", messageId: C2 },
    };
    const forged = { ...semantic, originAt, contentSha256: workRecordContentSha256(semantic as never) };
    const frame = { kind: "rows", canvasName: "factory", canvasId: "canvas-factory", writer: MINI, facts: [forged], through: "9001" } as unknown as RowsFrame;
    await expect(take(editor, frame, MINI)).rejects.toThrow(/only the machine that edits a canvas writes this row/);
    await expect(take(other, frame, EDITOR)).rejects.toThrow(/only the machine that edits a canvas writes this row/);
    expect(await purged(editor, C2)).toBe(false);
    expect(await purged(other, C2)).toBe(false);
  });
});
