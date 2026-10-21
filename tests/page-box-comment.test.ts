/**
 * A page box comment (B7): the writer sends only the box; main takes the
 * shot, stores it staged to the writer and claims it for the comment's own
 * record before the row is written. A reply and a retried write take no
 * new shot. Every store lives under a temp root.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ActorSeatId } from "../src/shared/actor-seat";
import { asNodeId } from "../src/shared/physics/schema";
import type { Rect } from "../src/shared/page-box";
import type { SubjectCommentInput } from "../src/shared/subject-comment";
import { pageShotOf, threadSubjectOf } from "../src/shared/thread-subject";
import type { WorkErrorBody } from "../src/shared/work-control";
import { OpId } from "../src/shared/work-ids";
import { ContentService, makeContentServiceLive } from "../src/main/junto/content/service";
import { MachineRepositoryLive } from "../src/main/junto/machines/repository";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import { PausePlaneAllPlaying } from "../src/main/junto/pause-plane";
import { SettingsLive } from "../src/main/junto/settings/service";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { CrewRepositoryLive } from "../src/main/junto/work/crew-repository";
import { WorkRepositoryLive } from "../src/main/junto/work/repository";
import { WorkLive, WorkService } from "../src/main/junto/work/service";
import { postSubjectComment, type StagedPageShot, type SubjectCommentContext } from "../src/main/junto/work/subject-comment";
import { discardOperatorPageBox, postOperatorPageBox, releaseStagedShots, startOperatorPageBox } from "../src/main/junto/work/page-box-comment";
import { contentStageOwner } from "../src/main/junto/content/stage";
import { ulid } from "ulid";
import { readPageShot } from "../src/main/junto/work/page-shot-read";
import { formatNodeRef } from "../src/shared/node-ref";
import { canvasOf, page, region, seat as seatNode } from "./support/model-nodes";
import { nameThisMachine } from "./support/name-this-machine";
import { ModelStoresLive, seedCanvas } from "./support/seed-canvas";

const CANVAS = "pages";
const PAGE = "web";

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
  return ManagedRuntime.make(Layer.mergeAll(Layer.provideMerge(WorkLive, Layer.provideMerge(ModelStoresLive, repositoriesLive)), PausePlaneAllPlaying));
};

const NODES = [
  region("team", { x: -40, y: -40, width: 900, height: 400 }),
  seatNode("agent", { x: 0, y: 40, width: 120, height: 48, bindingId: "bind-agent" as never, launch: { kind: "harness", argv: ["claude"] } }),
  page(PAGE, { x: 400, y: 40, width: 300, height: 200 }),
];

/** A PNG whose header declares 20 by 10. */
const PNG = (() => {
  const out = new Uint8Array(64);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(out.buffer).setUint32(16, 20);
  new DataView(out.buffer).setUint32(20, 10);
  return out;
})();

let root: string;
let runtime: ReturnType<typeof makeRuntime>;
let shots: Array<Rect>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-page-box-"));
  runtime = makeRuntime(root);
  await runtime.runPromise(nameThisMachine);
  await runtime.runPromise(seedCanvas(CANVAS, NODES, []));
  shots = [];
});

afterEach(async () => {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

/** Main's shot of the box, staged to `stager` as main stages it. */
const capture = (url = "https://example.com/a", stager = "agent"): SubjectCommentContext["pageShot"] => (rect) =>
  Effect.gen(function* () {
    shots.push(rect);
    const content = yield* ContentService;
    const seat = { canvasName: CANVAS, nodeId: stager };
    const put = yield* content.put({ source: PNG, mediaType: "image/png", owner: contentStageOwner(seat, ulid()) });
    return { ref: put.ref, stager: seat, url, scroll: { x: 0, y: 120 }, rect } satisfies StagedPageShot;
  }).pipe(Effect.orDie) as never;

const context = (pageShot?: SubjectCommentContext["pageShot"]): SubjectCommentContext => ({
  canvas: canvasOf(NODES, [], CANVAS),
  canvasName: CANVAS,
  people: [],
  ...(pageShot === undefined ? {} : { pageShot }),
});

const comment = (opId: string, more: Partial<Extract<SubjectCommentInput, { subject: { kind: "page" } }>> = {}): SubjectCommentInput => ({
  text: "this button is cut off",
  actor: { kind: "seat", seatId: `seat_${"a".repeat(64)}` as ActorSeatId, nodeId: asNodeId("agent") },
  opId: OpId.make(opId),
  subject: { kind: "page", nodeId: asNodeId(PAGE) },
  anchor: { kind: "box", x: 10, y: 150, w: 40, h: 20 },
  ...more,
});

const post = (input: SubjectCommentInput, ctx: SubjectCommentContext) => runtime.runPromise(Effect.result(postSubjectComment(input, ctx)));
const rows = () => runtime.runPromise(Effect.flatMap(WorkService, (work) => work.readMailbox(CANVAS, PAGE)));
const owners = (sha256: string) =>
  runtime.runPromise(Effect.flatMap(ContentService, (content) => content.listRefs(sha256))).then((refs) => refs.map((row) => row.owner));
const failure = (result: Awaited<ReturnType<typeof post>>): WorkErrorBody | undefined => (result._tag === "Failure" ? result.failure : undefined);

describe("a page box comment", () => {
  it("carries the shot main took, held by the comment's own record and nobody else, and the url without its query", async () => {
    const posted = await post(comment("01M5ESMJV6GNZ0891YFFWS0S3Q"), context(capture("https://example.com/a?session=s3cret#top")));
    if (posted._tag === "Failure") throw new Error(posted.failure.message);
    expect(shots).toEqual([{ kind: "box", x: 10, y: 150, w: 40, h: 20 }]);
    const row = (await rows()).find((message) => message.messageId === posted.success.messageId)!;
    expect(threadSubjectOf(row)).toMatchObject({
      kind: "page",
      nodeId: PAGE,
      anchor: { kind: "box", x: 10, y: 150, w: 40, h: 20, url: "https://example.com/a", scroll: { x: 0, y: 120 } },
    });
    const shot = pageShotOf(row)!;
    expect(shot).toMatchObject({ byteLength: PNG.byteLength, mediaType: "image/png" });
    expect(await owners(shot.sha256)).toEqual([{ kind: "message", canvasName: CANVAS, nodeId: PAGE, recordId: posted.success.messageId }]);
  });

  it("takes no new shot for a retried write or a reply, and a reply may not send a box", async () => {
    const input = comment("01M5ESMJV6GNZ0891YFFWS0S3R");
    const first = await post(input, context(capture()));
    const again = await post(input, context(capture()));
    if (first._tag === "Failure" || again._tag === "Failure") throw new Error("not posted");
    expect(again.success.messageId).toBe(first.success.messageId);
    expect(shots).toHaveLength(1);
    const { anchor: _anchor, ...whole } = comment("01M5ESMJV6GNZ0891YFFWS0S3S", { threadId: first.success.threadId });
    const reply = await post(whole as SubjectCommentInput, context(capture()));
    if (reply._tag === "Failure") throw new Error(reply.failure.message);
    const replied = (await rows()).find((message) => message.messageId === reply.success.messageId)!;
    expect(pageShotOf(replied)).toEqual(pageShotOf((await rows()).find((message) => message.messageId === first.success.messageId)!));
    expect(shots).toHaveLength(1);
    expect(failure(await post(comment("01M5ESMJV6GNZ0891YFFWS0S3T", { threadId: first.success.threadId }), context(capture())))).toMatchObject({
      type: "InputError",
      details: { path: "anchor" },
    });
  });

  it("is refused without the live page, for an automation, and for a box with no size", async () => {
    expect(failure(await post(comment("01M5ESMJV6GNZ0891YFFWS0S3V"), context()))).toMatchObject({ type: "ScopeError" });
    expect(
      failure(await post(comment("01M5ESMJV6GNZ0891YFFWS0S3W", { actor: { kind: "automation", nodeId: asNodeId("agent") } as never }), context(capture()))),
    ).toBeDefined();
    expect(failure(await post(comment("01M5ESMJV6GNZ0891YFFWS0S3X", { anchor: { kind: "box", x: 0, y: 0, w: 0, h: 5 } }), context(capture())))).toMatchObject({
      type: "InputError",
    });
    expect(shots).toEqual([]);
    expect(await rows()).toEqual([]);
  });

  it("keeps no name or password from the page's address", async () => {
    const posted = await post(comment("01M5ESMJV6GNZ0891YFFWS0S43"), context(capture("https://user:t0ken@example.com/a?q=1")));
    if (posted._tag === "Failure") throw new Error(posted.failure.message);
    const row = (await rows()).find((message) => message.messageId === posted.success.messageId)!;
    expect(threadSubjectOf(row)).toMatchObject({ anchor: { url: "https://example.com/a" } });
    expect(JSON.stringify(row.metadata)).not.toContain("t0ken");
  });

  it("refuses an address that does not parse, keeping nothing of it", async () => {
    expect(failure(await post(comment("01M5ESMJV6GNZ0891YFFWS0S44"), context(capture("not a url"))))).toMatchObject({ type: "InputError" });
    expect(await rows()).toEqual([]);
  });

  it("claims only a shot the writer staged, and only once", async () => {
    expect(failure(await post(comment("01M5ESMJV6GNZ0891YFFWS0S45"), context(capture("https://example.com/a", "operator"))))).toMatchObject({
      type: "InputError",
      message: expect.stringMatching(/not yours/),
    });
    let first: StagedPageShot | undefined;
    const once: SubjectCommentContext["pageShot"] = (rect) =>
      first === undefined ? capture()!(rect).pipe(Effect.tap((shot) => Effect.sync(() => (first = shot)))) : Effect.succeed(first);
    expect((await post(comment("01M5ESMJV6GNZ0891YFFWS0S46"), context(once)))._tag).toBe("Success");
    expect(failure(await post(comment("01M5ESMJV6GNZ0891YFFWS0S47"), context(once)))).toMatchObject({ type: "InputError" });
    expect(await rows()).toHaveLength(1);
  });

  it("lets the claim go when the page's address cannot be named", async () => {
    const refused = await post(comment("01M5ESMJV6GNZ0891YFFWS0S3Y"), context(capture("file:///etc/hosts")));
    expect(failure(refused)).toMatchObject({ type: "InputError" });
    const { createHash } = await import("node:crypto");
    expect(await owners(createHash("sha256").update(PNG).digest("hex"))).toEqual([]);
    expect(await rows()).toEqual([]);
  });
});

describe("the operator's box comment", () => {
  const sessions = (url: string, drawn: Rect | null = { x: 1, y: 2, w: 30, h: 40 }) => ({
    state: (sessionId: string) =>
      sessionId === "s1"
        ? ({ ok: true, data: { sessionId, ref: formatNodeRef({ canvasName: CANVAS, nodeId: PAGE }), nodeId: PAGE } } as never)
        : ({ ok: false, code: "not_found", message: "no session" } as never),
    drawBox: async () => ({ ok: true as const, data: drawn === null ? undefined : { png: PNG, url, scroll: { x: 0, y: 0 }, rect: drawn } }),
  });
  const start = (url = "https://example.com/a?token=1", drawn?: Rect) =>
    runtime.runPromise(startOperatorPageBox(sessions(url, drawn), "s1"));
  const postDraft = (shotId: string, url = "https://example.com/") =>
    runtime.runPromise(postOperatorPageBox(sessions(url), { sessionId: "s1", shotId, text: "look" }));

  it("shows the staged shot, then posts exactly it as operator mail", async () => {
    const started = await start();
    if (!started.ok || started.data.kind !== "drawn") throw new Error("not drawn");
    const { draft } = started.data;
    expect(draft).toMatchObject({ rect: { x: 1, y: 2, w: 30, h: 40 }, url: "https://example.com/a", width: 20, height: 10 });
    expect(Buffer.compare(Buffer.from(draft.png), Buffer.from(PNG))).toBe(0);
    const posted = await postDraft(draft.shotId);
    if (!posted.ok) throw new Error(posted.message);
    const row = (await rows()).find((message) => message.messageId === posted.data.messageId)!;
    expect(row.metadata?.senderName).toBe("operator");
    const shot = pageShotOf(row)!;
    expect(await owners(shot.sha256)).toEqual([{ kind: "message", canvasName: CANVAS, nodeId: PAGE, recordId: posted.data.messageId }]);
    // Posted once: the id is spent.
    expect(await postDraft(draft.shotId)).toMatchObject({ ok: false, code: "invalid", message: expect.stringMatching(/already posted/) });
  });

  it("keeps the shot for a retry when the post is refused before its claim", async () => {
    const started = await start();
    if (!started.ok || started.data.kind !== "drawn") throw new Error("not drawn");
    const { shotId } = started.data.draft;
    const send = (text: string) => runtime.runPromise(postOperatorPageBox(sessions("https://example.com/"), { sessionId: "s1", shotId, text }));
    expect(await send("   ")).toMatchObject({ ok: false, code: "invalid" });
    expect(await rows()).toEqual([]);
    const posted = await send("fixed words");
    if (!posted.ok) throw new Error(posted.message);
    expect(await rows()).toHaveLength(1);
    expect(await send("again")).toMatchObject({ ok: false, message: expect.stringMatching(/already posted/) });
  });

  it("drops a shot that is discarded, and ends with no box on Escape", async () => {
    const started = await start();
    if (!started.ok || started.data.kind !== "drawn") throw new Error("not drawn");
    const { createHash } = await import("node:crypto");
    const sha = createHash("sha256").update(PNG).digest("hex");
    expect(await owners(sha)).toHaveLength(1);
    await runtime.runPromise(discardOperatorPageBox("s1", started.data.draft.shotId));
    expect(await owners(sha)).toEqual([]);
    expect(await postDraft(started.data.draft.shotId)).toMatchObject({ ok: false, code: "invalid" });
    expect(await runtime.runPromise(startOperatorPageBox(sessions("https://example.com/", null), "s1"))).toEqual({ ok: true, data: { kind: "ended" } });
    expect(await rows()).toEqual([]);
  });

  it("lets go of every staged shot of a session that ended, and only that session's", async () => {
    const first = await start();
    const second = await start();
    if (!first.ok || first.data.kind !== "drawn" || !second.ok || second.data.kind !== "drawn") throw new Error("not drawn");
    const { createHash } = await import("node:crypto");
    const sha = createHash("sha256").update(PNG).digest("hex");
    expect(await owners(sha)).toHaveLength(2);
    await runtime.runPromise(releaseStagedShots("s2"));
    expect(await owners(sha)).toHaveLength(2);
    await runtime.runPromise(releaseStagedShots("s1"));
    expect(await owners(sha)).toEqual([]);
    expect(await postDraft(first.data.draft.shotId)).toMatchObject({ ok: false, message: expect.stringMatching(/already posted/) });
  });

  it("refuses a page that is not open, and an address that cannot be named", async () => {
    expect(await runtime.runPromise(startOperatorPageBox(sessions("https://example.com/"), "s2"))).toMatchObject({ ok: false, code: "invalid" });
    const started = await start("about:blank");
    if (!started.ok || started.data.kind !== "drawn") throw new Error("not drawn");
    expect(await postDraft(started.data.draft.shotId)).toMatchObject({ ok: false, code: "invalid", message: expect.stringMatching(/http or https/) });
    expect(await rows()).toEqual([]);
  });
});

describe("a page box shot's read", () => {
  const read = (messageId: string) => runtime.runPromise(readPageShot({ canvasName: CANVAS, nodeId: PAGE, messageId }));

  it("serves the shot for the comment and for a reply in its thread, judged again", async () => {
    const posted = await post(comment("01M5ESMJV6GNZ0891YFFWS0S40"), context(capture()));
    if (posted._tag === "Failure") throw new Error(posted.failure.message);
    const { anchor: _anchor, ...whole } = comment("01M5ESMJV6GNZ0891YFFWS0S41", { threadId: posted.success.threadId });
    const reply = await post(whole as SubjectCommentInput, context(capture()));
    if (reply._tag === "Failure") throw new Error(reply.failure.message);
    for (const id of [posted.success.messageId, reply.success.messageId]) {
      const shot = await read(id);
      expect(shot.ok && Buffer.compare(shot.bytes, Buffer.from(PNG))).toBe(0);
    }
  });

  it("serves nothing for a comment with no shot, or a shot its comment no longer holds", async () => {
    const posted = await post(comment("01M5ESMJV6GNZ0891YFFWS0S42"), context(capture()));
    if (posted._tag === "Failure") throw new Error(posted.failure.message);
    expect(await read("01M5ESMJV6GNZ0891YFFWS0S4Z")).toEqual({ ok: false, reason: "not-named" });
    await runtime.runPromise(
      Effect.flatMap(ContentService, (content) =>
        content.releaseOwner({ kind: "message", canvasName: CANVAS, nodeId: PAGE, recordId: posted.success.messageId }),
      ),
    );
    expect(await read(posted.success.messageId)).toEqual({ ok: false, reason: "missing" });
  });
});
