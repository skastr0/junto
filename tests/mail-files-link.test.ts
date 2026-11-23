/**
 * Operator mail files across machines over the link's `content` channel
 * (threads order line 2): two real SQLite + content stores under temporary
 * homes, joined by real link sessions with no SSH route.
 *
 * Locks:
 * (a) resumes from partial and delivers after the editing machine restarts part way;
 * (b) works over a link alone with no SSH route;
 * (c) `msg list` / `msg read` (`asSeatReadsIt`) report `filesPending` (`state: "pending"`)
 *     while bytes are on their way, then `files` once pulled;
 * (d) `keepPublished` keeps bytes under `operatorMailOwner` so `collectContentGarbage`
 *     preserves them past the 7-day orphan grace window;
 * plus remote-security's refusal matrix (peer seat mint refusal, same digest under
 * operator mail vs forged seat mail, unnamed ref, right sha256 with wrong byteLength,
 * moved seat, third linked machine, non-editor, disk floor, and LONG_TEXT_FILE).
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { type Context, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BodyPuller } from "../src/core/content/body-puller";
import { collectContentGarbage } from "../src/core/content/gc";
import { operatorMailFileEntitled } from "../src/core/content/mail-file-entitlement";
import { deliverOperatorAttachmentLines, seatMailFiles } from "../src/core/content/mail-files-pull";
import { writeMailCarryingText } from "../src/core/content/mail-text-file";
import { ContentManifest } from "../src/core/content/manifest";
import { operatorMailOwner } from "../src/core/content/operator-attachments";
import { ContentLink, makeContentChannel, makeContentPulls, pullContent, type ContentPullAsk } from "../src/core/content/pull";
import { ContentService, makeContentServiceLive } from "../src/core/content/service";
import { shotEntitled } from "../src/core/content/shot-entitlement";
import { makeInstallOpsLive } from "../src/core/install-ops/engine";
import { linkClient } from "../src/core/link/contract";
import { LinkHelloSchema } from "../src/core/link/protocol";
import { makeLinkSession } from "../src/core/link/session";
import { MachineLink } from "../src/core/link/service";
import { linkClosed, type LinkSession } from "../src/core/link/types";
import { makeStateEngineLive } from "../src/core/state/engine";
import { WorkRepository, WorkRepositoryLive } from "../src/core/work/repository";
import { asSeatReadsIt } from "../src/core/work-control/mail";
import { contentObjectPath, contentPartialPath } from "../src/node/content/paths";
import { contentTransferPartialId, statContentForTransfer } from "../src/node/content/transfer-local";
import {
  CONTENT_PULL_PIECE_BYTES,
  ContentPullRefused,
  OWNER_ENTITLEMENT,
  isPullableOwnerKind,
  seatReachesOwnMail,
  type ContentPullRequest,
} from "../src/shared/content-pull";
import { EXCHANGE_ROWS_PAGE_BYTES } from "../src/shared/exchange-bounds";
import { InstallationId } from "../src/shared/installation-id";
import { LONG_TEXT_FILE } from "../src/shared/mail-text-bound";
import { OPERATOR_ATTACHMENT_MAX_BYTES, OPERATOR_ATTACHMENTS_MAX } from "../src/shared/operator-attachments";
import type { Node } from "../src/shared/model";
import type { NodeId } from "../src/shared/model/base";
import type { ContentRef } from "../src/shared/wire/content-ref";
import { WORK_HOME_ENV } from "../src/shared/work-control";
import { entitledTo, type CanvasPlacement, type RowsFrame } from "../src/shared/work-exchange";
import type { Message } from "../src/shared/work-model";
import { ActorSeatId, type ActorRef } from "../src/shared/work-protocol";
import { OPERATOR_SEAT_ID, operatorActorRef } from "../src/shared/work-reference";
import { machineLinkOver } from "./support/link-pair";
import { canvasOf, peer as peerNode, seat } from "./support/model-nodes";
import { seedCanvasRows } from "./support/seed-canvas";

const id = Schema.decodeUnknownSync(InstallationId);
const EDITOR = id("macbook");
const MINI = id("mini");
const OTHER = id("other-mini");
const THIRD = id("third-mini");
const at = "2026-11-23T18:00:00.000Z";
const hello = (machineName: string, installationId: InstallationId) =>
  Schema.decodeUnknownSync(LinkHelloSchema)({ build: "b".repeat(64), installationId, machineName });

const seats = ["lead", "peer", "far", "idle"] as const;
const seatActor = (nodeId: (typeof seats)[number]): ActorRef => ({
  seatId: Schema.decodeUnknownSync(ActorSeatId)(`seat_${(seats.indexOf(nodeId) + 1).toString().repeat(64)}`),
  canvasName: "factory",
  nodeId,
});
const homes: Record<string, InstallationId> = { lead: EDITOR, peer: MINI, far: OTHER, idle: THIRD };
const placementWith = (moved: Partial<Record<(typeof seats)[number], InstallationId>> = {}, editor: InstallationId = EDITOR): CanvasPlacement => ({
  canvasId: "canvas-factory",
  editor,
  holds: (machine) => [EDITOR, MINI, OTHER, THIRD].includes(machine),
  seatOf: (nodeId) => {
    const home = (moved as Record<string, InstallationId>)[nodeId] ?? homes[nodeId];
    return home === undefined ? undefined : { seatId: seatActor(nodeId as (typeof seats)[number]).seatId, machine: home };
  },
});

const EDITOR_NODES: ReadonlyArray<Node> = seats.map((nodeId, index) => seat(nodeId, { y: index * 120 }));
// Cut copy on mini: `peer` is its own agent seat, `lead` and `far` arrive as peer nodes.
const MINI_NODES: ReadonlyArray<Node> = [
  peerNode("lead", { host: "macbook", seatId: seatActor("lead").seatId }),
  seat("peer", { y: 120, host: "mini" }),
  peerNode("far", { y: 240, host: "other-mini", seatId: seatActor("far").seatId }),
];
const MINI_CANVAS = canvasOf(MINI_NODES, [], "factory");
// Edge-case canvas where a remote seat kept kind "agent" so we prove placement gates the mint too.
const ALL_AGENT_CANVAS = canvasOf(EDITOR_NODES, [], "factory");

type Machine = {
  readonly self: InstallationId;
  readonly root: string;
  readonly runtime: ManagedRuntime.ManagedRuntime<WorkRepository | ContentService | ContentManifest | SqlClient.SqlClient, unknown>;
  readonly work: Context.Service.Shape<typeof WorkRepository>;
  readonly content: Context.Service.Shape<typeof ContentService>;
  readonly manifest: Context.Service.Shape<typeof ContentManifest>;
  readonly sql: SqlClient.SqlClient;
};

const boot = async (self: InstallationId, nodes: ReadonlyArray<Node> = EDITOR_NODES): Promise<Machine> => {
  const root = await mkdtemp(join(tmpdir(), `junto-mail-files-${self}-`));
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(
      Layer.mergeAll(
        WorkRepositoryLive,
        makeContentServiceLive({ root: join(root, "content"), skipInlineMediaMigration: true }),
        ContentManifest.layer,
      ),
      Layer.mergeAll(makeStateEngineLive(join(root, "junto.db")), makeInstallOpsLive(join(root, "install-ops.db"))),
    ),
  );
  const work = await runtime.runPromise(WorkRepository);
  const content = await runtime.runPromise(ContentService);
  const manifest = await runtime.runPromise(ContentManifest);
  const sql = await runtime.runPromise(SqlClient.SqlClient);
  await runtime.runPromise(
    sql.withTransaction(
      Effect.gen(function* () {
        for (const machine of [EDITOR, MINI, OTHER, THIRD]) {
          yield* sql`INSERT INTO known_installations(installation_id, registered_at) VALUES (${machine}, ${at})`;
        }
        yield* sql`INSERT INTO installation(singleton, installation_id, created_at) VALUES (1, ${self}, ${at})`;
        yield* seedCanvasRows({ seq: 1, canvases: new Map([["factory", { nodes }]]) });
        yield* sql`UPDATE canvases SET editor_installation_id = ${EDITOR}`;
      }),
    ),
  );
  return { self, root, runtime, work, content, manifest, sql };
};

const openContentLink = async (
  server: Machine,
  clientId: InstallationId,
  clientName: string,
  placement: CanvasPlacement,
  sessions: LinkSession[],
) => {
  const channel = makeContentChannel({
    root: server.content.root,
    canvas: (canvasName, peer) =>
      Effect.succeed({
        edits: canvasName === "factory" && placement.editor === server.self,
        peerLinked: canvasName === "factory" && placement.holds(peer),
      }),
    verified: (ref) => server.content.heldVerified(ref),
    owners: (sha256, canvasName, peer, byteLength) =>
      Effect.gen(function* () {
        const rows = yield* server.content.listRefs(sha256);
        const ruleOf = (kind: string) => (isPullableOwnerKind(kind) ? OWNER_ENTITLEMENT[kind] : undefined);
        return yield* Effect.forEach(rows, ({ owner }) =>
          ruleOf(owner.kind) === "row" && owner.canvasName === canvasName
            ? Effect.gen(function* () {
                const entitled =
                  (yield* shotEntitled(server.sql, {
                    owner,
                    sha256,
                    machine: peer,
                    placement,
                    seats: seats.map((nodeId) => nodeId as NodeId),
                  })) ||
                  (yield* operatorMailFileEntitled(server.sql, {
                    owner,
                    sha256,
                    byteLength,
                    machine: peer,
                    self: server.self,
                    placement,
                  }));
                return { kind: owner.kind, canvasName: owner.canvasName, rowEntitled: entitled };
              })
            : Effect.succeed({ kind: owner.kind, canvasName: owner.canvasName }),
        );
      }),
  });
  const ab = new PassThrough();
  const ba = new PassThrough();
  const editorSession = makeLinkSession({
    readable: ba,
    writable: ab,
    self: hello("macbook", server.self),
    admit: async () => {},
    channels: { content: channel },
    run: Effect.runPromise,
  });
  const peerSession = makeLinkSession({
    readable: ab,
    writable: ba,
    self: hello(clientName, clientId),
    admit: async () => {},
    channels: { content: channel },
    run: Effect.runPromise,
  });
  sessions.push(editorSession, peerSession);
  await Promise.all([editorSession.ready, peerSession.ready]);
  const client = await Effect.runPromise(linkClient(ContentLink).pipe(Effect.provideService(MachineLink, machineLinkOver(peerSession))));
  const ask: ContentPullAsk = (request) => client.Pull("macbook", request);
  return { editorSession, peerSession, ask };
};

const settled = async (done: () => Promise<boolean>) => {
  for (let tries = 0; tries < 200 && !(await done()); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

let editor: Machine;
let mini: Machine;
let other: Machine;
let workHome: string;
const sessions: LinkSession[] = [];
const pulls = makeContentPulls();

const crossTo = async (target: Machine, placement: CanvasPlacement) => {
  const rows = await editor.runtime.runPromise(
    editor.work.exchangeRows({ canvasName: "factory", writer: EDITOR, after: "0", limit: 64, bytes: EXCHANGE_ROWS_PAGE_BYTES }),
  );
  const facts = rows.rows.map((row) => row.fact).filter((fact) => entitledTo(target.self, fact, placement));
  const frame: RowsFrame = JSON.parse(
    JSON.stringify({ kind: "rows", canvasName: "factory", canvasId: "canvas-factory", writer: EDITOR, after: "0", facts, through: rows.through }),
  );
  await target.runtime.runPromise(target.work.applyExchangeRows({ peer: EDITOR, frame, placement }));
};

/** Multi-piece attachment (> 1 piece so partial resume is exercised). */
const BIG_BYTES = Buffer.from(
  Array.from({ length: CONTENT_PULL_PIECE_BYTES + 24_576 }, (_, index) => (index * 17 + 3) & 0xff),
);
const LONG_TEXT = `# Long operator note\n${"line of prose for remote seat\n".repeat(400)}`;
const M_FILE = "01M854P0000000000000000001";
const M_LONG = "01M854P0000000000000000002";
const M_FORGED_SEAT = "01M854P0000000000000000003";
const M_NO_ATTACH = "01M854P0000000000000000004";

let bigRef: ContentRef;
let longRef: ContentRef;
const defaultPlacement = placementWith();

beforeAll(async () => {
  workHome = await mkdtemp(join(tmpdir(), "junto-mail-files-work-"));
  process.env[WORK_HOME_ENV] = workHome;
  editor = await boot(EDITOR, EDITOR_NODES);
  mini = await boot(MINI, MINI_NODES);
  other = await boot(OTHER, EDITOR_NODES);

  // 1) Operator mail with a multi-piece attached file, owned under operatorMailOwner on editor.
  const putBig = await editor.runtime.runPromise(
    editor.content.put({
      source: BIG_BYTES,
      mediaType: "application/octet-stream",
      displayName: "report.bin",
      owner: operatorMailOwner("factory", "peer", M_FILE),
    }),
  );
  bigRef = putBig.ref;
  await editor.runtime.runPromise(
    editor.work.appendMessage({
      sink: { canvasName: "factory", nodeId: "peer" },
      basis: { kind: "canvas", canvasName: "factory", seq: 1 },
      message: {
        messageId: M_FILE,
        role: "user",
        parts: [{ kind: "text", text: "See attached report." }],
        metadata: {
          factoryMail: true,
          fromSeat: OPERATOR_SEAT_ID,
          senderName: "operator",
          threadId: M_FILE,
          attachments: [bigRef],
        },
      } as never,
      sentBy: operatorActorRef("factory"),
      destination: { kind: "mailbox" },
      originAt: at,
      receivedAt: at,
    }),
  );

  // 2) Operator mail whose text exceeded one row and was written as LONG_TEXT_FILE (message.md).
  const longOwner = operatorMailOwner("factory", "peer", M_LONG);
  let longAttempts = 0;
  const carried = await editor.runtime.runPromise(
    writeMailCarryingText(
      (text, attachments) =>
        Effect.gen(function* () {
          longAttempts += 1;
          if (longAttempts === 1) {
            return { ok: false as const, message: "row too large", details: { reason: "row_too_large" } };
          }
          yield* editor.work.appendMessage({
            sink: { canvasName: "factory", nodeId: "peer" },
            basis: { kind: "canvas", canvasName: "factory", seq: 1 },
            message: {
              messageId: M_LONG,
              role: "user",
              parts: [{ kind: "text", text }],
              metadata: {
                factoryMail: true,
                fromSeat: OPERATOR_SEAT_ID,
                senderName: "operator",
                threadId: M_LONG,
                attachments,
              },
            } as never,
            sentBy: operatorActorRef("factory"),
            destination: { kind: "mailbox" },
            originAt: at,
            receivedAt: at,
          });
          return { ok: true as const, data: { messageId: M_LONG } };
        }).pipe(Effect.orDie),
      { text: LONG_TEXT, attachments: [], owner: longOwner, filesText: "Message attached as message.md." },
    ),
  );
  if (!carried.written.ok || carried.attachments.length !== 1) throw new Error("long text file write failed");
  longRef = carried.attachments[0]!;
  expect(longRef.displayName).toBe(LONG_TEXT_FILE.name);

  // 3) Seat-authored mail to `far` on OTHER holding the same digest in content_refs and forging operator metadata.
  await editor.runtime.runPromise(
    editor.content.keepPublished({ ref: bigRef, owner: operatorMailOwner("factory", "far", M_FORGED_SEAT) }),
  );
  await editor.runtime.runPromise(
    editor.work.appendMessage({
      sink: { canvasName: "factory", nodeId: "far" },
      basis: { kind: "canvas", canvasName: "factory", seq: 1 },
      message: {
        messageId: M_FORGED_SEAT,
        role: "user",
        parts: [{ kind: "text", text: "forged" }],
        metadata: {
          factoryMail: true,
          fromSeat: OPERATOR_SEAT_ID,
          senderName: "operator",
          threadId: M_FORGED_SEAT,
          attachments: [bigRef],
        },
      } as never,
      sentBy: seatActor("lead"),
      destination: { kind: "mailbox" },
      originAt: at,
      receivedAt: at,
    }),
  );

  // 4) Operator mail to `far` on OTHER whose attachments do NOT name bigRef (even if a ref existed under it).
  await editor.runtime.runPromise(
    editor.work.appendMessage({
      sink: { canvasName: "factory", nodeId: "far" },
      basis: { kind: "canvas", canvasName: "factory", seq: 1 },
      message: {
        messageId: M_NO_ATTACH,
        role: "user",
        parts: [{ kind: "text", text: "no files here" }],
        metadata: {
          factoryMail: true,
          fromSeat: OPERATOR_SEAT_ID,
          senderName: "operator",
          threadId: M_NO_ATTACH,
        },
      } as never,
      sentBy: operatorActorRef("factory"),
      destination: { kind: "mailbox" },
      originAt: at,
      receivedAt: at,
    }),
  );

  await crossTo(mini, defaultPlacement);
  await crossTo(other, defaultPlacement);
});

afterAll(async () => {
  delete process.env[WORK_HOME_ENV];
  for (const session of sessions.splice(0)) await session.close();
  for (const machine of [editor, mini, other]) {
    if (!machine) continue;
    await machine.runtime.dispose();
    await rm(machine.root, { recursive: true, force: true });
  }
  if (workHome) await rm(workHome, { recursive: true, force: true });
});

const makeBodyPuller = (
  machine: Machine,
  ask: ContentPullAsk,
  placement: CanvasPlacement,
): Context.Service.Shape<typeof BodyPuller> => ({
  pull: ({ ref, owner, reached }) =>
    pullContent(
      {
        root: machine.content.root,
        ask,
        keep: (kept, keptOwner) => machine.content.keepPublished({ ref: kept, owner: keptOwner }),
        once: (object, transfer) => Effect.flatMap(Effect.promise(() => pulls.pull(object, () => Effect.runPromiseExit(transfer))), (exit) => exit),
      },
      { ref, owner, reached },
    ),
  placement: (canvasName) =>
    Effect.succeed(canvasName === "factory" ? { self: machine.self, placement } : undefined),
});

describe("operator mail files over the link content channel", () => {
  it("reports filesPending before pull, survives an editing-machine restart mid-transfer, resumes from partial, delivers both attachment and message.md, and survives 30-day GC", async () => {
    const mailBig = await mini.runtime.runPromise(mini.work.mailMessage("factory", "peer", M_FILE));
    const mailLong = await mini.runtime.runPromise(mini.work.mailMessage("factory", "peer", M_LONG));
    if (mailBig === undefined || mailLong === undefined) throw new Error("crossed mail missing on mini");

    // Before any puller is linked, msg list/read reports pending instead of silently dropping files.
    const beforeRead = await mini.runtime.runPromise(
      asSeatReadsIt(MINI_CANVAS, "factory", "peer")(mailBig),
    );
    expect("files" in beforeRead).toBe(false);
    expect("filesPending" in beforeRead && beforeRead.filesPending).toEqual([
      { state: "pending", name: "report.bin", mediaType: "application/octet-stream", byteLength: BIG_BYTES.byteLength },
    ]);

    // First link cuts after piece 1 (simulating editing-machine core restart part way).
    const first = await openContentLink(editor, MINI, "mini", defaultPlacement, sessions);
    let served = 0;
    const cuttingAsk: ContentPullAsk = (request) =>
      served++ === 1
        ? Effect.fail(linkClosed({ by: "peer", reason: "shutting-down" }))
        : first.ask(request);
    const cuttingPuller = makeBodyPuller(mini, cuttingAsk, defaultPlacement);

    let readyFired = 0;
    const firstAttempt = await mini.runtime.runPromise(
      deliverOperatorAttachmentLines({
        content: mini.content,
        canvasName: "factory",
        canvas: MINI_CANVAS,
        nodeId: "peer",
        message: mailBig,
        onReady: () => { readyFired += 1; },
      }).pipe(Effect.provideService(BodyPuller, cuttingPuller)),
    );
    expect(firstAttempt).toBeUndefined();
    await settled(async () => pulls.inFlight() === 0 && statContentForTransfer(mini.content.root, bigRef).state === "partial");
    expect(statContentForTransfer(mini.content.root, bigRef)).toMatchObject({
      state: "partial",
      partialBytes: CONTENT_PULL_PIECE_BYTES,
    });
    expect(readyFired).toBe(0);
    await first.editorSession.close();
    await first.peerSession.close();

    // Fresh link opens (no SSH route, no in-memory push queue): resumes from partial and finishes.
    const second = await openContentLink(editor, MINI, "mini", defaultPlacement, sessions);
    const resumedOffsets: number[] = [];
    const trackingAsk: ContentPullAsk = (request) => {
      resumedOffsets.push(request.offset);
      return second.ask(request);
    };
    const livePuller = makeBodyPuller(mini, trackingAsk, defaultPlacement);

    const secondAttempt = await mini.runtime.runPromise(
      deliverOperatorAttachmentLines({
        content: mini.content,
        canvasName: "factory",
        canvas: MINI_CANVAS,
        nodeId: "peer",
        message: mailBig,
        onReady: () => { readyFired += 1; },
      }).pipe(Effect.provideService(BodyPuller, livePuller)),
    );
    expect(secondAttempt).toBeUndefined();
    await settled(async () => readyFired === 1);
    // Resumed strictly from the partial offset, never re-fetching piece 0.
    expect(resumedOffsets).toEqual([CONTENT_PULL_PIECE_BYTES]);

    // Delivery now produces the Attached: line with exact bytes materialized.
    const delivered = await mini.runtime.runPromise(
      deliverOperatorAttachmentLines({
        content: mini.content,
        canvasName: "factory",
        canvas: MINI_CANVAS,
        nodeId: "peer",
        message: mailBig,
      }).pipe(Effect.provideService(BodyPuller, livePuller)),
    );
    expect(delivered).toHaveLength(1);
    const bigPath = /^Attached: report\.bin \(application\/octet-stream, .+\): (.+)$/.exec(delivered![0]!)?.[1];
    expect(bigPath).toBeDefined();
    expect(await readFile(bigPath!)).toEqual(BIG_BYTES);

    // Seat read (msg list / msg read) now shows `files` and omits `filesPending`.
    const afterRead = await mini.runtime.runPromise(
      asSeatReadsIt(MINI_CANVAS, "factory", "peer")(mailBig).pipe(Effect.provideService(BodyPuller, livePuller)),
    );
    expect("files" in afterRead && afterRead.files).toEqual(delivered);
    expect("filesPending" in afterRead).toBe(false);

    // Long text stored as LONG_TEXT_FILE (message.md) pulls via seat read and delivers the same way.
    const pendingLong = await mini.runtime.runPromise(
      asSeatReadsIt(MINI_CANVAS, "factory", "peer")(mailLong).pipe(Effect.provideService(BodyPuller, livePuller)),
    );
    expect("filesPending" in pendingLong && pendingLong.filesPending).toEqual([
      { state: "pending", name: LONG_TEXT_FILE.name, mediaType: LONG_TEXT_FILE.mediaType, byteLength: longRef.byteLength },
    ]);
    await settled(async () => (await mini.runtime.runPromise(mini.content.listRefs(longRef.sha256))).length > 0);
    const deliveredLong = await mini.runtime.runPromise(
      deliverOperatorAttachmentLines({
        content: mini.content,
        canvasName: "factory",
        canvas: MINI_CANVAS,
        nodeId: "peer",
        message: mailLong,
      }).pipe(Effect.provideService(BodyPuller, livePuller)),
    );
    expect(deliveredLong).toHaveLength(1);
    const longPath = /^Attached: message\.md \(text\/markdown, .+\): (.+)$/.exec(deliveredLong![0]!)?.[1];
    expect(longPath).toBeDefined();
    expect(await readFile(longPath!, "utf8")).toBe(LONG_TEXT);

    // Both files are owned in content_refs under operatorMailOwner and survive a 30-day live GC sweep.
    const miniBigRefs = await mini.runtime.runPromise(mini.content.listRefs(bigRef.sha256));
    expect(miniBigRefs.map((row) => row.owner)).toEqual([operatorMailOwner("factory", "peer", M_FILE)]);
    const miniLongRefs = await mini.runtime.runPromise(mini.content.listRefs(longRef.sha256));
    expect(miniLongRefs.map((row) => row.owner)).toEqual([operatorMailOwner("factory", "peer", M_LONG)]);

    const gcReport = await mini.runtime.runPromise(
      collectContentGarbage(mini.content.root, mini.manifest, {
        dryRun: false,
        now: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      }),
    );
    expect(gcReport.protectedDigests).toBeGreaterThanOrEqual(2);
    expect(gcReport.actions.filter((action) => action.kind === "unreferenced-object" || action.kind === "orphan-file")).toEqual([]);
    expect(existsSync(contentObjectPath(mini.content.root, bigRef.sha256))).toBe(true);
    expect(existsSync(contentObjectPath(mini.content.root, longRef.sha256))).toBe(true);
  }, 15_000);

  it("refuses disk floor exhaustion before pulling", async () => {
    const mailBig = await mini.runtime.runPromise(mini.work.mailMessage("factory", "peer", M_FILE));
    if (mailBig === undefined) throw new Error("missing mail");
    const freshMini = await boot(MINI, MINI_NODES);
    let asked = 0;
    const puller: Context.Service.Shape<typeof BodyPuller> = {
      pull: () => Effect.sync(() => { asked += 1; }),
      placement: () => Effect.succeed({ self: MINI, placement: defaultPlacement }),
    };
    try {
      const view = await freshMini.runtime.runPromise(
        seatMailFiles({
          canvasName: "factory",
          canvas: MINI_CANVAS,
          nodeId: "peer",
          message: mailBig,
          freeBytes: 0,
        }).pipe(Effect.provideService(BodyPuller, puller)),
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(view?.filesPending).toHaveLength(1);
      expect(asked).toBe(0);
    } finally {
      await freshMini.runtime.dispose();
      await rm(freshMini.root, { recursive: true, force: true });
    }
  });

  it("fails closed on excess attachment count or oversized refs: holds delivery, pulls nothing, and names refused files on read", async () => {
    let asked = 0;
    const puller: Context.Service.Shape<typeof BodyPuller> = {
      pull: () => Effect.sync(() => { asked += 1; }),
      placement: () => Effect.succeed({ self: MINI, placement: defaultPlacement }),
    };

    // Over OPERATOR_ATTACHMENTS_MAX (11 refs).
    const tooManyRefs = Array.from({ length: OPERATOR_ATTACHMENTS_MAX + 1 }, (_, index) => ({
      sha256: createHash("sha256").update(`file-${index}`).digest("hex"),
      byteLength: 10,
      mediaType: "text/plain",
      displayName: `f${index}.txt`,
    })) as unknown as ContentRef[];
    const tooManyMail = {
      messageId: "01M854P0000000000000000010",
      role: "user",
      parts: [{ kind: "text", text: "too many" }],
      metadata: { factoryMail: true, fromSeat: OPERATOR_SEAT_ID, senderName: "operator", attachments: tooManyRefs },
    } as unknown as Message;

    expect(
      await mini.runtime.runPromise(
        deliverOperatorAttachmentLines({
          content: mini.content,
          canvasName: "factory",
          canvas: MINI_CANVAS,
          nodeId: "peer",
          message: tooManyMail,
        }).pipe(Effect.provideService(BodyPuller, puller)),
      ),
    ).toBeUndefined();
    const readTooMany = await mini.runtime.runPromise(
      asSeatReadsIt(MINI_CANVAS, "factory", "peer")(tooManyMail).pipe(Effect.provideService(BodyPuller, puller)),
    );
    expect("files" in readTooMany).toBe(false);
    expect("filesPending" in readTooMany).toBe(false);
    expect("filesRefused" in readTooMany && readTooMany.filesRefused).toHaveLength(OPERATOR_ATTACHMENTS_MAX + 1);
    expect("filesRefused" in readTooMany && readTooMany.filesRefused?.[0]).toEqual({
      state: "refused",
      name: "f0.txt",
      mediaType: "text/plain",
      byteLength: 10,
      reason: "too-many",
    });

    // Oversized ref (OPERATOR_ATTACHMENT_MAX_BYTES + 1).
    const hugeRef = {
      sha256: createHash("sha256").update("huge").digest("hex"),
      byteLength: OPERATOR_ATTACHMENT_MAX_BYTES + 1,
      mediaType: "application/octet-stream",
      displayName: "huge.bin",
    } as ContentRef;
    const hugeMail = {
      messageId: "01M854P0000000000000000011",
      role: "user",
      parts: [{ kind: "text", text: "too big" }],
      metadata: { factoryMail: true, fromSeat: OPERATOR_SEAT_ID, senderName: "operator", attachments: [hugeRef] },
    } as unknown as Message;

    expect(
      await mini.runtime.runPromise(
        deliverOperatorAttachmentLines({
          content: mini.content,
          canvasName: "factory",
          canvas: MINI_CANVAS,
          nodeId: "peer",
          message: hugeMail,
        }).pipe(Effect.provideService(BodyPuller, puller)),
      ),
    ).toBeUndefined();
    const readHuge = await mini.runtime.runPromise(
      asSeatReadsIt(MINI_CANVAS, "factory", "peer")(hugeMail).pipe(Effect.provideService(BodyPuller, puller)),
    );
    expect("files" in readHuge).toBe(false);
    expect("filesPending" in readHuge).toBe(false);
    expect("filesRefused" in readHuge && readHuge.filesRefused).toEqual([
      {
        state: "refused",
        name: "huge.bin",
        mediaType: "application/octet-stream",
        byteLength: OPERATOR_ATTACHMENT_MAX_BYTES + 1,
        reason: "too-large",
      },
    ]);
    expect(asked).toBe(0);
  });
});

describe("operator mail file entitlement and mint refusal matrix", () => {
  it("refuses seatReachesOwnMail for a peer node and for an agent node living on another machine", () => {
    // Peer node on cut copy is refused.
    expect(seatReachesOwnMail("factory", MINI_CANVAS, "lead" as NodeId, defaultPlacement, MINI)).toBeUndefined();
    expect(seatReachesOwnMail("factory", MINI_CANVAS, "far" as NodeId, defaultPlacement, MINI)).toBeUndefined();
    // Even if a remote seat kept kind "agent", placement proves it does not live on MINI.
    expect(seatReachesOwnMail("factory", ALL_AGENT_CANVAS, "lead" as NodeId, defaultPlacement, MINI)).toBeUndefined();
    expect(seatReachesOwnMail("factory", ALL_AGENT_CANVAS, "far" as NodeId, defaultPlacement, MINI)).toBeUndefined();
    // Own agent seat on MINI mints strictly for its own nodeId.
    expect(seatReachesOwnMail("factory", MINI_CANVAS, "peer" as NodeId, defaultPlacement, MINI)).toEqual({
      canvasName: "factory",
      resourceId: "peer",
    });
  });

  it("admits only the operator mail owner and refuses forged seat mail holding the same digest", async () => {
    // Same digest is held under both M_FILE (operator mail to peer on MINI) and M_FORGED_SEAT (seat mail to far on OTHER).
    expect(
      await editor.runtime.runPromise(
        operatorMailFileEntitled(editor.sql, {
          owner: operatorMailOwner("factory", "peer", M_FILE),
          sha256: bigRef.sha256,
          byteLength: bigRef.byteLength,
          machine: MINI,
          self: EDITOR,
          placement: defaultPlacement,
        }),
      ),
    ).toBe(true);
    expect(
      await editor.runtime.runPromise(
        operatorMailFileEntitled(editor.sql, {
          owner: operatorMailOwner("factory", "far", M_FORGED_SEAT),
          sha256: bigRef.sha256,
          byteLength: bigRef.byteLength,
          machine: OTHER,
          self: EDITOR,
          placement: defaultPlacement,
        }),
      ),
    ).toBe(false);

    // Over a real link channel, OTHER asking for bigRef is refused with not-held and writes nothing to disk.
    const otherLink = await openContentLink(editor, OTHER, "other-mini", defaultPlacement, sessions);
    const refused = await other.runtime.runPromise(
      Effect.flip(
        pullContent(
          {
            root: other.content.root,
            ask: otherLink.ask,
            keep: (kept, keptOwner) => other.content.keepPublished({ ref: kept, owner: keptOwner }),
          },
          {
            ref: bigRef,
            owner: { kind: "message", canvasName: "factory", nodeId: "far", recordId: M_FORGED_SEAT },
            reached: seatReachesOwnMail("factory", ALL_AGENT_CANVAS, "far" as NodeId, defaultPlacement, OTHER)!,
          },
        ),
      ),
    );
    expect(refused).toBeInstanceOf(ContentPullRefused);
    expect(refused).toMatchObject({ reason: "not-held", sha256: bigRef.sha256, byteLength: bigRef.byteLength });
    expect(existsSync(contentObjectPath(other.content.root, bigRef.sha256))).toBe(false);
    expect(existsSync(contentPartialPath(other.content.root, contentTransferPartialId(bigRef.sha256)))).toBe(false);
  });

  it("refuses a held mail whose attachments do not name the ref", async () => {
    expect(
      await editor.runtime.runPromise(
        operatorMailFileEntitled(editor.sql, {
          owner: operatorMailOwner("factory", "far", M_NO_ATTACH),
          sha256: bigRef.sha256,
          byteLength: bigRef.byteLength,
          machine: OTHER,
          self: EDITOR,
          placement: defaultPlacement,
        }),
      ),
    ).toBe(false);
    const otherSha = createHash("sha256").update("unrelated").digest("hex");
    expect(
      await editor.runtime.runPromise(
        operatorMailFileEntitled(editor.sql, {
          owner: operatorMailOwner("factory", "peer", M_FILE),
          sha256: otherSha,
          byteLength: 9,
          machine: MINI,
          self: EDITOR,
          placement: defaultPlacement,
        }),
      ),
    ).toBe(false);
  });

  it("refuses right sha256 with wrong byteLength", async () => {
    expect(
      await editor.runtime.runPromise(
        operatorMailFileEntitled(editor.sql, {
          owner: operatorMailOwner("factory", "peer", M_FILE),
          sha256: bigRef.sha256,
          byteLength: bigRef.byteLength - 1,
          machine: MINI,
          self: EDITOR,
          placement: defaultPlacement,
        }),
      ),
    ).toBe(false);
    const link = await openContentLink(editor, MINI, "mini", defaultPlacement, sessions);
    const wrongLength = await Effect.runPromise(
      Effect.flip(
        link.ask({
          canvasName: "factory",
          sha256: bigRef.sha256,
          byteLength: (bigRef.byteLength - 1) as ContentRef["byteLength"],
          offset: 0,
        }),
      ),
    );
    expect(wrongLength).toMatchObject({ _tag: "ContentPullRefusal", reason: "not-held" });
  });

  it("refuses the old machine once the seat moves off it, and refuses a third linked machine or non-editor", async () => {
    const moved = placementWith({ peer: THIRD });
    expect(
      await editor.runtime.runPromise(
        operatorMailFileEntitled(editor.sql, {
          owner: operatorMailOwner("factory", "peer", M_FILE),
          sha256: bigRef.sha256,
          byteLength: bigRef.byteLength,
          machine: MINI,
          self: EDITOR,
          placement: moved,
        }),
      ),
    ).toBe(false);
    expect(
      await editor.runtime.runPromise(
        operatorMailFileEntitled(editor.sql, {
          owner: operatorMailOwner("factory", "peer", M_FILE),
          sha256: bigRef.sha256,
          byteLength: bigRef.byteLength,
          machine: THIRD,
          self: EDITOR,
          placement: moved,
        }),
      ),
    ).toBe(true);
    // Third linked machine whose seats did not receive M_FILE is refused under default placement.
    expect(
      await editor.runtime.runPromise(
        operatorMailFileEntitled(editor.sql, {
          owner: operatorMailOwner("factory", "peer", M_FILE),
          sha256: bigRef.sha256,
          byteLength: bigRef.byteLength,
          machine: THIRD,
          self: EDITOR,
          placement: defaultPlacement,
        }),
      ),
    ).toBe(false);
    // Non-editor refuses even for the right machine.
    expect(
      await editor.runtime.runPromise(
        operatorMailFileEntitled(editor.sql, {
          owner: operatorMailOwner("factory", "peer", M_FILE),
          sha256: bigRef.sha256,
          byteLength: bigRef.byteLength,
          machine: MINI,
          self: MINI,
          placement: defaultPlacement,
        }),
      ),
    ).toBe(false);
  });
});
