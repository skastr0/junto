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
import type { BrowserPageBoxShot } from "../src/main/junto/browser/sessions";
import { ContentService, makeContentServiceLive } from "../src/main/junto/content/service";
import { MachineRepositoryLive } from "../src/main/junto/machines/repository";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import { PausePlaneAllPlaying } from "../src/main/junto/pause-plane";
import { SettingsLive } from "../src/main/junto/settings/service";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { CrewRepositoryLive } from "../src/main/junto/work/crew-repository";
import { WorkRepositoryLive } from "../src/main/junto/work/repository";
import { WorkLive, WorkService } from "../src/main/junto/work/service";
import { postSubjectComment, type SubjectCommentContext } from "../src/main/junto/work/subject-comment";
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

const capture = (url = "https://example.com/a"): SubjectCommentContext["captureBox"] => (rect) =>
  Effect.sync((): BrowserPageBoxShot => {
    shots.push(rect);
    return { png: PNG, url, scroll: { x: 0, y: 120 }, rect };
  });

const context = (captureBox?: SubjectCommentContext["captureBox"]): SubjectCommentContext => ({
  canvas: canvasOf(NODES, [], CANVAS),
  canvasName: CANVAS,
  people: [],
  ...(captureBox === undefined ? {} : { captureBox }),
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
  it("carries the shot main took, held by the comment's own record and nobody else", async () => {
    const posted = await post(comment("01M5ESMJV6GNZ0891YFFWS0S3Q"), context(capture()));
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

  it("lets the claim go when the page's address cannot be named", async () => {
    const refused = await post(comment("01M5ESMJV6GNZ0891YFFWS0S3Y"), context(capture("file:///etc/hosts")));
    expect(failure(refused)).toMatchObject({ type: "InputError" });
    const { createHash } = await import("node:crypto");
    expect(await owners(createHash("sha256").update(PNG).digest("hex"))).toEqual([]);
    expect(await rows()).toEqual([]);
  });
});
