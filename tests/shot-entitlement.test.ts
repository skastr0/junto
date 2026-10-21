/**
 * Who may pull a page comment's shot (B7), on a real database: a machine a
 * row naming that shot for that comment reached, by entitledTo, as the
 * placement is now. The comment and its notices are written as main writes
 * them: a comment row on the page node, a notice in each recipient's mailbox.
 */
import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, beforeAll, expect, it } from "vitest";
import { shotEntitled } from "../src/main/junto/content/shot-entitlement";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { WorkRepository, WorkRepositoryLive } from "../src/main/junto/work/repository";
import type { MailMessageId } from "../src/shared/crew";
import { InstallationId } from "../src/shared/installation-id";
import type { NodeId } from "../src/shared/model/base";
import { subjectNoticeRow } from "../src/shared/subject-notice";
import { threadSubjectMetadata, type ResourceSubject } from "../src/shared/thread-subject";
import type { ContentRef } from "../src/shared/wire/content-ref";
import type { CanvasPlacement } from "../src/shared/work-exchange";
import { ActorSeatId, type ActorRef } from "../src/shared/work-protocol";
import { seedCanvasRows } from "./support/seed-canvas";
import { page, seat } from "./support/model-nodes";

const id = Schema.decodeUnknownSync(InstallationId);
const EDITOR = id("macbook");
const MINI = id("mini");
const OTHER = id("other-mini");
const THIRD = id("third-mini");
const at = "2026-10-21T12:00:00.000Z";
const seats = ["lead", "peer", "far", "idle"] as const;
const actor = (nodeId: (typeof seats)[number]): ActorRef => ({
  seatId: Schema.decodeUnknownSync(ActorSeatId)(`seat_${(seats.indexOf(nodeId) + 1).toString().repeat(64)}`),
  canvasName: "factory",
  nodeId,
});
const homes = { lead: EDITOR, peer: MINI, far: OTHER, idle: THIRD } as const;
const placementWith = (moved: Partial<Record<(typeof seats)[number], InstallationId>> = {}): CanvasPlacement => ({
  canvasId: "canvas-factory",
  editor: EDITOR,
  holds: (machine) => [EDITOR, MINI, OTHER, THIRD].includes(machine),
  seatOf: (nodeId) => {
    const home = (moved as Record<string, InstallationId>)[nodeId] ?? (homes as Record<string, InstallationId>)[nodeId];
    return home === undefined ? undefined : { seatId: actor(nodeId as (typeof seats)[number]).seatId, machine: home };
  },
});

const shot = (fill: string): ContentRef => ({
  sha256: createHash("sha256").update(fill).digest("hex"),
  byteLength: fill.length,
  mediaType: "image/png",
}) as ContentRef;
const SHOT = shot("the same box, twice");
const OTHER_SHOT = shot("another box");
const subjectFor = (ref: ContentRef): ResourceSubject =>
  ({ kind: "page", nodeId: "page-1", anchor: { kind: "box", x: 0, y: 0, w: 10, h: 10, url: "https://x.example/", scroll: { x: 0, y: 0 }, shot: ref } }) as ResourceSubject;

let root: string;
let runtime: ManagedRuntime.ManagedRuntime<WorkRepository | SqlClient.SqlClient, unknown>;
let work: Context.Service.Shape<typeof WorkRepository>;
let sql: SqlClient.SqlClient;

const append = (nodeId: string, messageId: string, metadata: Record<string, unknown>) =>
  runtime.runPromise(work.appendMessage({
    sink: { canvasName: "factory", nodeId },
    basis: { kind: "canvas", canvasName: "factory", seq: 1 },
    message: { messageId, role: "user", parts: [{ kind: "text", text: "a box" }], metadata } as never,
    sentBy: actor("lead"),
    destination: { kind: "mailbox" },
    originAt: at,
    receivedAt: at,
  }));

/** The operator's comment on the page, and a notice of it to each recipient. */
const comment = async (messageId: string, ref: ContentRef, recipients: ReadonlyArray<NodeId>) => {
  const subject = subjectFor(ref);
  await append("page-1", messageId, { factoryMail: true, ...threadSubjectMetadata(subject), threadId: messageId });
  for (const recipient of recipients) {
    const notice = subjectNoticeRow({
      kind: "comment",
      installationId: EDITOR,
      sourceId: messageId as MailMessageId,
      subject,
      threadId: messageId as MailMessageId,
      recipient,
      text: "a box",
      sender: { senderNodeId: "lead", senderName: "lead" } as never,
    });
    await append(recipient, notice.messageId, notice.metadata);
  }
};

const C1 = "01M5F7P0000000000000000001";
const C2 = "01M5F7P0000000000000000002";

beforeAll(async () => {
  root = join(tmpdir(), `junto-shot-entitlement-${randomUUID()}`);
  runtime = ManagedRuntime.make(Layer.provideMerge(WorkRepositoryLive, makeStateEngineLive(join(root, "junto.db"))));
  work = await runtime.runPromise(WorkRepository);
  sql = await runtime.runPromise(SqlClient.SqlClient);
  await runtime.runPromise(sql.withTransaction(Effect.gen(function* () {
    for (const machine of [EDITOR, MINI, OTHER, THIRD]) yield* sql`INSERT INTO known_installations(installation_id, registered_at) VALUES (${machine}, ${at})`;
    yield* sql`INSERT INTO installation(singleton, installation_id, created_at) VALUES (1, ${EDITOR}, ${at})`;
    yield* seedCanvasRows({ seq: 1, canvases: new Map([["factory", { nodes: [...seats.map((nodeId, index) => seat(nodeId, { y: index * 120 })), page("page-1", { y: 600 })] }]]) });
  })));
  // C1 told the seat on the mini; C2, with the same bytes, told the seat on the other machine.
  await comment(C1, SHOT, ["peer" as NodeId]);
  await comment(C2, SHOT, ["far" as NodeId]);
});

afterAll(async () => {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

const entitled = (recordId: string, machine: InstallationId, placement = placementWith(), sha256 = SHOT.sha256) =>
  runtime.runPromise(shotEntitled(sql, {
    owner: { canvasName: "factory", nodeId: "page-1", recordId },
    sha256,
    machine,
    placement,
    seats: seats.map((nodeId) => nodeId as NodeId),
  }));

it("serves the machine whose seat got the notice, and the editing machine", async () => {
  expect(await entitled(C1, MINI)).toBe(true);
  expect(await entitled(C1, EDITOR)).toBe(true);
});

it("refuses a linked machine that no row of this comment reached, with the right digest", async () => {
  expect(await entitled(C1, THIRD)).toBe(false);
});

it("never opens a comment's shot through a notice of another comment with the same bytes", async () => {
  expect(await entitled(C1, OTHER)).toBe(false);
  expect(await entitled(C2, OTHER)).toBe(true);
  expect(await entitled(C2, MINI)).toBe(false);
});

it("judges the notice with the placement as it is now: a seat that left the machine opens nothing", async () => {
  expect(await entitled(C1, MINI, placementWith({ peer: THIRD }))).toBe(false);
  expect(await entitled(C1, THIRD, placementWith({ peer: THIRD }))).toBe(true);
});

it("serves nothing the comment does not name", async () => {
  expect(await entitled(C1, MINI, placementWith(), OTHER_SHOT.sha256)).toBe(false);
  expect(await entitled("01M5F7P0000000000000000009", MINI)).toBe(false);
});
