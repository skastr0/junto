/**
 * The phone's comments (0.11.3, docs/artifacts-proposal.md sections 3 and 4):
 * the desktop's thread read paged newest first and fitted to one frame, and
 * the demo's own comments served from the section 8 fixture.
 */
import { describe, expect, it } from "vitest";
import { companionCommentsPage, type CommentThreadView } from "../src/shared/companion-comments";
import { makeDemoBackend } from "../src/shared/companion-demo";
import { asNodeId } from "../src/shared/model";
import {
  DEMO_ARTIFACTS,
  DEMO_ARTIFACT_PRICING_NOTES,
  DEMO_ARTIFACT_THREADS,
  DEMO_CANVAS,
} from "../src/shared/wire/companion-demo-fixture";
import type { ItemId, OpId } from "../src/shared/wire/ids";

const post = (postId: string, at: number, text = "a note") => ({
  postId,
  author: { kind: "operator" as const, name: "operator" },
  text,
  at,
});

const thread = (threadId: string, at: number, posts = 2): CommentThreadView => ({
  threadId,
  posts: Array.from({ length: posts }, (_, index) => post(`${threadId}-${String(index)}`, at + index)),
});

const threads = [thread("01J9DEM0THR0000000000000A1", 1000), thread("01J9DEM0THR0000000000000A2", 2000), thread("01J9DEM0THR0000000000000A3", 3000)];

describe("companionCommentsPage", () => {
  it("reads the newest thread first, a page at a time", () => {
    const first = companionCommentsPage(threads, { limit: 2 });
    expect(first.threads.map((one) => one.threadId)).toEqual([
      "01J9DEM0THR0000000000000A3",
      "01J9DEM0THR0000000000000A2",
    ]);
    expect(first.cut).toBe(true);
    expect(first.next).toBe("01J9DEM0THR0000000000000A2");
    const second = companionCommentsPage(threads, { before: first.next });
    expect(second.threads.map((one) => one.threadId)).toEqual(["01J9DEM0THR0000000000000A1"]);
    expect(second.cut).toBe(false);
    expect(second.next).toBeUndefined();
  });

  it("starts again from the newest when it is handed a cursor it does not hold", () => {
    const page = companionCommentsPage(threads, { before: "01J9DEM0THR0000000000000ZZ" });
    expect(page.threads.map((one) => one.threadId)[0]).toBe("01J9DEM0THR0000000000000A3");
  });

  it("keeps a thread's newest posts, and says when older ones were left out", () => {
    const long = thread("01J9DEM0THR0000000000000B1", 1000, 250);
    const page = companionCommentsPage([long]);
    expect(page.threads[0]?.posts).toHaveLength(200);
    expect(page.threads[0]?.posts[0]?.postId).toBe("01J9DEM0THR0000000000000B1-50");
    expect(page.threads[0]?.cut).toBe(true);
  });

  it("cuts a thread that cannot fit the frame rather than dropping the answer", () => {
    const huge = thread("01J9DEM0THR0000000000000C1", 1000, 200);
    const wide = { ...huge, posts: huge.posts.map((one) => ({ ...one, text: "x".repeat(8_000) })) };
    const page = companionCommentsPage([wide], { limit: 1 });
    expect(page.threads).toHaveLength(1);
    expect(page.threads[0]?.posts.length).toBeGreaterThan(0);
    expect(page.threads[0]?.posts.length).toBeLessThan(200);
    expect(page.threads[0]?.cut).toBe(true);
  });
});

describe("the demo's comments", () => {
  const backend = makeDemoBackend("macbook");
  const subject = {
    kind: "artifact" as const,
    nodeId: asNodeId("art-inbox"),
    artifactId: DEMO_ARTIFACT_PRICING_NOTES as ItemId,
  };

  it("serves the fixture's text-anchored thread", async () => {
    expect(DEMO_ARTIFACTS.some((artifact) => artifact.head.artifactId === DEMO_ARTIFACT_PRICING_NOTES)).toBe(true);
    const listed = await backend.comments({ canvasName: DEMO_CANVAS, subject });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.threads).toHaveLength(DEMO_ARTIFACT_THREADS.length);
    const [only] = listed.value.threads;
    expect(only?.anchor).toEqual(DEMO_ARTIFACT_THREADS[0]?.anchor);
    expect(only?.posts).toHaveLength(2);
    expect(only?.posts[0]?.author).toMatchObject({ kind: "seat", name: "Quill" });
  });

  it("appends a reply once per opId, and answers a resend as the first did", async () => {
    const threadId = DEMO_ARTIFACT_THREADS[0]!.threadId;
    const args = {
      canvasName: DEMO_CANVAS,
      subject,
      opId: "01KAZ3Q8X4V6W2N5R7T9Y1B3D9" as OpId,
      text: "It stacks on the launch price.",
      threadId,
    };
    const first = await backend.comment(args);
    const again = await backend.comment(args);
    expect(first.ok && again.ok).toBe(true);
    if (!first.ok || !again.ok) return;
    expect(again.value).toEqual(first.value);
    const listed = await backend.comments({ canvasName: DEMO_CANVAS, subject });
    if (!listed.ok) return;
    expect(listed.value.threads[0]?.posts).toHaveLength(3);
  });

  it("opens a new thread when none is named", async () => {
    const before = await backend.comments({ canvasName: DEMO_CANVAS, subject });
    const posted = await backend.comment({
      canvasName: DEMO_CANVAS,
      subject,
      opId: "01KAZ3Q8X4V6W2N5R7T9Y1B3DA" as OpId,
      text: "A new question.",
    });
    expect(posted.ok).toBe(true);
    const after = await backend.comments({ canvasName: DEMO_CANVAS, subject });
    if (!before.ok || !after.ok) return;
    expect(after.value.threads.length).toBe(before.value.threads.length + 1);
    expect(after.value.threads[0]?.posts[0]?.text).toBe("A new question.");
  });

  it("answers not-found for an artifact the demo does not hold", async () => {
    const listed = await backend.comments({
      canvasName: DEMO_CANVAS,
      subject: { ...subject, artifactId: "01J9DEM0ART00000000000000Z" as ItemId },
    });
    expect(listed.ok ? "ok" : listed.error.code).toBe("not-found");
  });
});

describe("the demo's mention picker", () => {
  const backend = makeDemoBackend("macbook");
  const from = asNodeId("atlas");

  it("offers seats and pages for @, from the node's own reach", async () => {
    const found = await backend.mentionCandidates({ canvasName: DEMO_CANVAS, from, trigger: "@" });
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    const kinds = new Set(found.value.candidates.map((candidate) => candidate.kind));
    expect(kinds.has("seat")).toBe(true);
    expect(found.value.candidates.some((candidate) => candidate.ref.kind === "seat" && candidate.title === "Relay")).toBe(true);
    expect(found.value.candidates.some((candidate) => candidate.ref.kind === "page")).toBe(true);
    expect(found.value.candidates.every((candidate) => candidate.label.startsWith("@"))).toBe(true);
    expect(found.value.candidates.every((candidate) => candidate.title.length > 0)).toBe(true);
  });

  it("offers the board's task and the node's artifacts for #, and artifacts alone for [[", async () => {
    const hashed = await backend.mentionCandidates({ canvasName: DEMO_CANVAS, from: asNodeId("quill"), trigger: "#" });
    const linked = await backend.mentionCandidates({ canvasName: DEMO_CANVAS, from: asNodeId("quill"), trigger: "[[" });
    expect(hashed.ok && linked.ok).toBe(true);
    if (!hashed.ok || !linked.ok) return;
    expect(hashed.value.candidates.some((candidate) => candidate.ref.kind === "task")).toBe(true);
    expect(hashed.value.candidates.some((candidate) => candidate.ref.kind === "artifact")).toBe(true);
    expect(linked.value.candidates.every((candidate) => candidate.ref.kind === "artifact")).toBe(true);
    expect(hashed.value.candidates.every((candidate) => candidate.label.startsWith("#"))).toBe(true);
  });

  it("narrows by the typed words, starts before contains", async () => {
    const found = await backend.mentionCandidates({ canvasName: DEMO_CANVAS, from: asNodeId("quill"), trigger: "[[", query: "pric" });
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value.candidates.length).toBeGreaterThan(0);
    expect(found.value.candidates[0]?.title.toLowerCase().startsWith("pric")).toBe(true);
  });

  it("answers not-found for a node the canvas does not hold", async () => {
    const found = await backend.mentionCandidates({ canvasName: DEMO_CANVAS, from: asNodeId("nobody"), trigger: "@" });
    expect(found.ok ? "ok" : found.error.code).toBe("not-found");
  });
});
