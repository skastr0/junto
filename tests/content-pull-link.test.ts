/**
 * A body pulled across two real link sessions into a second store: piece by
 * piece, resumed after a cut, published only whole, and nothing written when
 * the editing machine refuses.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Effect, Schema } from "effect";
import { afterEach, expect, it } from "vitest";
import { ContentPullRefused, CONTENT_PULL_PIECE_BYTES, operatorReachesResource, type ContentPullRequest } from "../src/shared/content-pull";
import { InstallationId } from "../src/shared/installation-id";
import type { NodeId } from "../src/shared/model/base";
import type { ContentRef } from "../src/shared/wire/content-ref";
import { makeContentChannel, pullContent, type PulledOwner } from "../src/main/junto/content/pull";
import { contentObjectPath, contentPartialPath } from "../src/main/junto/content/paths";
import { ingestContentBytes } from "../src/main/junto/content/store";
import { contentTransferPartialId, statContentForTransfer } from "../src/main/junto/content/transfer-local";
import { LinkHelloSchema } from "../src/main/junto/link/protocol";
import { makeLinkSession } from "../src/main/junto/link/session";
import type { LinkChannelContext, LinkSession } from "../src/main/junto/link/types";

const id = Schema.decodeUnknownSync(InstallationId);
const EDITOR = id("macbook-install");
const MINI = id("mini-install");
const hello = (machineName: string, installationId: InstallationId) =>
  Schema.decodeUnknownSync(LinkHelloSchema)({ build: "a".repeat(64), installationId, machineName });

const roots: string[] = [];
const sessions: LinkSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const tempRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), "junto-pull-"));
  roots.push(root);
  return root;
};

/** 1.25 pieces short of three, so the last piece is short. */
const body = Buffer.from(Array.from({ length: 2 * CONTENT_PULL_PIECE_BYTES + 12_345 }, (_, index) => (index * 31 + 7) & 0xff));
const owner: PulledOwner = { kind: "artifact", canvasName: "factory", nodeId: "artifacts-1", recordId: "artifact-1@3" };
const reached = operatorReachesResource("factory", "artifacts-1" as NodeId);

const setUp = async (options: { owners?: ReadonlyArray<{ kind: string; canvasName: string }>; linked?: boolean } = {}) => {
  const editorRoot = await tempRoot();
  const miniRoot = await tempRoot();
  const ingested = await ingestContentBytes({ root: editorRoot, source: body, mediaType: "text/markdown" });
  const ref = { sha256: ingested.ref.sha256, byteLength: ingested.ref.byteLength, mediaType: ingested.ref.mediaType } as ContentRef;
  const served: number[] = [];
  const channel = makeContentChannel({
    root: editorRoot,
    canvas: (canvasName, peer) => Effect.succeed({ edits: canvasName === "factory", peerLinked: (options.linked ?? true) && peer === MINI }),
    verified: (asked) => Effect.sync(() => statContentForTransfer(editorRoot, asked).state === "verified"),
    owners: () => Effect.succeed(options.owners ?? [{ kind: "artifact", canvasName: "factory" }]),
  });
  const counted = { ...channel, handleRequest: (context: LinkChannelContext, payload: unknown) => { served.push((payload as ContentPullRequest).offset); return channel.handleRequest!(context, payload); } };
  const ab = new PassThrough();
  const ba = new PassThrough();
  const editor = makeLinkSession({ readable: ba, writable: ab, self: hello("macbook", EDITOR), admit: async () => {}, channels: { content: counted }, run: Effect.runPromise });
  const mini = makeLinkSession({ readable: ab, writable: ba, self: hello("mini", MINI), admit: async () => {}, channels: { content: channel }, run: Effect.runPromise });
  sessions.push(editor, mini);
  await Promise.all([editor.ready, mini.ready]);
  const kept: Array<{ ref: ContentRef; owner: PulledOwner }> = [];
  const deps = {
    root: miniRoot,
    ask: (request: ContentPullRequest) => Effect.tryPromise({ try: () => mini.request("content", request), catch: (cause) => cause }),
    keep: (keptRef: ContentRef, keptOwner: PulledOwner) => Effect.sync(() => void kept.push({ ref: keptRef, owner: keptOwner })),
  };
  return { ref, miniRoot, served, kept, deps };
};

it("pulls a body in pieces into the asking machine's store and keeps it under its owner", async () => {
  const { ref, miniRoot, served, kept, deps } = await setUp();
  await Effect.runPromise(pullContent(deps, { ref, owner, reached }));
  expect(served).toEqual([0, CONTENT_PULL_PIECE_BYTES, 2 * CONTENT_PULL_PIECE_BYTES]);
  const copy = await readFile(contentObjectPath(miniRoot, ref.sha256));
  expect(createHash("sha256").update(copy).digest("hex")).toBe(ref.sha256);
  expect(kept).toEqual([{ ref, owner }]);
  // Held now: a second pull asks for nothing.
  await Effect.runPromise(pullContent(deps, { ref, owner, reached }));
  expect(served).toHaveLength(3);
});

it("resumes from the asking machine's partial after a cut", async () => {
  const { ref, miniRoot, served, deps } = await setUp();
  let asked = 0;
  const cut = { ...deps, ask: (request: ContentPullRequest) => (asked++ === 1 ? Effect.fail(new Error("link closed")) : deps.ask(request)) };
  const first = await Effect.runPromise(Effect.flip(pullContent(cut, { ref, owner, reached })));
  expect(first).toMatchObject({ _tag: "ContentPullFailed", message: "the link to the editing machine failed" });
  expect(statContentForTransfer(miniRoot, ref)).toMatchObject({ state: "partial", partialBytes: CONTENT_PULL_PIECE_BYTES });
  await Effect.runPromise(pullContent(deps, { ref, owner, reached }));
  expect(served).toEqual([0, CONTENT_PULL_PIECE_BYTES, 2 * CONTENT_PULL_PIECE_BYTES]);
  expect(statContentForTransfer(miniRoot, ref).state).toBe("verified");
});

it("writes nothing when the editing machine refuses, and says why typed", async () => {
  for (const options of [{ owners: [] }, { owners: [{ kind: "artifact", canvasName: "other" }] }, { linked: false }]) {
    const { ref, miniRoot, kept, deps } = await setUp(options);
    const refused = await Effect.runPromise(Effect.flip(pullContent(deps, { ref, owner, reached })));
    expect(refused).toBeInstanceOf(ContentPullRefused);
    expect(refused).toMatchObject({ reason: "not-held", sha256: ref.sha256, byteLength: ref.byteLength });
    expect(existsSync(contentObjectPath(miniRoot, ref.sha256))).toBe(false);
    expect(existsSync(contentPartialPath(miniRoot, contentTransferPartialId(ref.sha256)))).toBe(false);
    expect(kept).toEqual([]);
  }
});

it("takes nothing that does not match its digest", async () => {
  const { ref, miniRoot, kept, deps } = await setUp();
  const flipped = {
    ...deps,
    ask: (request: ContentPullRequest) =>
      deps.ask(request).pipe(Effect.map((piece) => {
        const { offset, bytes } = piece as { offset: number; bytes: string };
        const raw = Buffer.from(bytes, "base64");
        if (offset === 0) raw[0] = raw[0]! ^ 0xff;
        return { offset, bytes: raw.toString("base64") };
      })),
  };
  const failed = await Effect.runPromise(Effect.flip(pullContent(flipped, { ref, owner, reached })));
  expect(failed).toMatchObject({ _tag: "ContentPullFailed" });
  expect(existsSync(contentObjectPath(miniRoot, ref.sha256))).toBe(false);
  expect(existsSync(contentPartialPath(miniRoot, contentTransferPartialId(ref.sha256)))).toBe(false);
  expect(kept).toEqual([]);
});

it("keeps a body only under the resource that was reached", async () => {
  const { ref, deps } = await setUp();
  const elsewhere = operatorReachesResource("factory", "artifacts-2" as NodeId);
  expect(await Effect.runPromise(Effect.flip(pullContent(deps, { ref, owner, reached: elsewhere })))).toMatchObject({ _tag: "ContentPullFailed" });
});
