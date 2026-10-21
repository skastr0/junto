import { Effect, Result } from "effect";
import { describe, expect, it } from "vitest";
import {
  mailMentionCandidates,
  mentionNodesAt,
  resolveWorkTarget,
  resourceMentionCandidates,
  type LinkedText,
  type MentionPlace,
} from "../src/main/junto/work/authz";
import { ArtifactRepository } from "../src/main/junto/work/artifact-repository";
import { linkMentionsAt } from "../src/main/junto/work/mention-links";
import { TaskRepository } from "../src/main/junto/work/task-repository";
import { resourceNodesInReach } from "../src/renderer/lib/mention-sources";
import type { Canvas } from "../src/shared/model";
import { mentionLink, type MentionRef } from "../src/shared/mention";
import { asNodeId } from "../src/shared/physics/schema";
import { titleOf } from "../src/shared/model/title";
import { resourcesInReach } from "../src/shared/region-reach";
import type { ItemId } from "../src/shared/work-ids";
import { artifacts, canvasOf, page, region, seat, taskBoard, wire } from "./support/model-nodes";

// Region A holds the caller, board-a and the shared artifacts; region B holds board-b.
const canvas = canvasOf(
  [
    region("a", { x: 0, y: 0, width: 1000, height: 400 }, { label: "A" }),
    region("b", { x: 0, y: 600, width: 1000, height: 400 }, { label: "B" }),
    seat("caller", { x: 20, y: 20, width: 100, height: 50 }),
    seat("peer", { x: 200, y: 20, width: 100, height: 50, label: "reviewer" }),
    taskBoard("board-a", { x: 400, y: 20, width: 100, height: 50, name: "Backlog" }),
    artifacts("docs", { x: 600, y: 20, width: 100, height: 50, label: "Docs" }),
    taskBoard("board-b", { x: 400, y: 620, width: 100, height: 50, name: "Other" }),
  ],
  [wire("caller-peer", "caller", "peer", "messages")],
);

// The resource nodes in the caller's region reach, as a resolver's candidates.
const reachTargetCandidates = (doc: typeof canvas, callerId: string) =>
  resourcesInReach(doc, asNodeId(callerId)).map((node) => ({ kind: node.kind, nodeId: node.id, name: titleOf(doc.nodes.get(node.id)!) }));

describe("resolveWorkTarget", () => {
  it("resolves a resource by name through reach, and mail by the wired seats", () => {
    const board = resolveWorkTarget(canvas, "caller", "backlog", "msg.send", reachTargetCandidates);
    expect(Result.isSuccess(board) && board.success).toEqual({ nodeId: "board-a" });
    const mail = resolveWorkTarget(canvas, "caller", "Reviewer", "msg.send");
    expect(Result.isSuccess(mail) && mail.success).toEqual({ nodeId: "peer" });
  });

  it("refuses a name outside reach with every candidate, typed", () => {
    const refused = resolveWorkTarget(canvas, "caller", "Other", "msg.send", reachTargetCandidates);
    expect(Result.isFailure(refused) && refused.failure).toMatchObject({
      type: "UnknownTarget",
      details: {
        target: "Other",
        candidates: [
          { kind: "task", nodeId: "board-a", name: "Backlog" },
          { kind: "artifacts", nodeId: "docs", name: "Docs" },
        ],
      },
    });
  });

  it("refuses a malformed ref without treating it as a name", () => {
    const refused = resolveWorkTarget(canvas, "caller", "junto://canvas/factory?node=", "msg.send", reachTargetCandidates);
    expect(Result.isFailure(refused) && refused.failure).toMatchObject({ type: "InputError", details: { path: "target" } });
  });
});

type Item = { readonly id: string; readonly node: string; readonly title: string; readonly number?: number; readonly archived?: true };

// The task and artifact stores, holding these items: `list` answers by node, and artifacts by archived too.
const withItems = (tasks: ReadonlyArray<Item>, docs: ReadonlyArray<Item>) =>
  <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
    effect.pipe(
      Effect.provideService(TaskRepository, {
        list: (_canvas: string, query: { readonly nodeIds?: ReadonlyArray<string> }) =>
          Effect.succeed({
            tasks: tasks
              .filter((task) => query.nodeIds?.includes(task.node) ?? true)
              .map((task) => ({ taskId: task.id, title: task.title, number: task.number, current: { node: task.node } })),
            more: false,
          }),
      } as never),
      Effect.provideService(ArtifactRepository, {
        list: (_canvas: string, query: { readonly nodeIds?: ReadonlyArray<string>; readonly archived?: boolean }) =>
          Effect.succeed({
            artifacts: docs
              .filter((doc) => (query.nodeIds?.includes(doc.node) ?? true) && (doc.archived === true) === (query.archived === true))
              .map((doc) => ({ artifactId: doc.id, nodeId: doc.node, title: doc.title })),
            more: false,
          }),
      } as never),
    );

const linked = (doc: Canvas, writer: string, text: string, place: MentionPlace, stores = withItems([], [])) =>
  Effect.runSync(Effect.result(stores(linkMentionsAt(doc, "factory", writer, text, place))));

const MAIL: MentionPlace = { kind: "mail" };

describe("linkMentionsAt: @seat", () => {
  const link = (id: string, name: string) => mentionLink({ kind: "seat", nodeId: asNodeId(id) }, `@${name}`, "factory");

  it("offers mail the wired seats, and a resource's comments the seats in its reach", () => {
    expect(mailMentionCandidates(canvas, "caller").map((c) => c.nodeId)).toEqual(["peer"]);
    expect(resourceMentionCandidates(canvas, "docs").map((c) => c.nodeId)).toEqual(["caller", "peer"]);
    expect(resourceMentionCandidates(canvas, "board-b")).toEqual([]);
  });

  it("rewrites each @name to its seat's link with the seat's own name, by name or by id", () => {
    expect(linked(canvas, "caller", "@REVIEWER and @peer, not ops@x.dev", MAIL))
      .toEqual(Result.succeed({ text: `${link("peer", "reviewer")} and ${link("peer", "reviewer")}, not ops@x.dev`, unlinked: [] }));
  });

  it("keeps a name that names nothing as plain text, listed with the names nearest it", () => {
    expect(linked(canvas, "caller", "hi @nobody, and @reviewr", MAIL)).toEqual(Result.succeed({
      text: "hi @nobody, and @reviewr",
      unlinked: [{ token: "@nobody", nearest: [] }, { token: "@reviewr", nearest: ["@reviewer"] }],
    }));
  });

  it("keeps the id of a node that is no seat or page it can mention as plain text", () => {
    expect(linked(canvas, "caller", "@board-a", { kind: "comments", nodeId: "docs" }))
      .toMatchObject(Result.succeed({ text: "@board-a", unlinked: [{ token: "@board-a" }] }));
  });

  it("keeps a self-mention as plain text, unlisted, in mail and in comments", () => {
    for (const place of [MAIL, { kind: "comments", nodeId: "docs" } as const]) {
      expect(linked(canvas, "caller", "ask @caller, or run task assign #1 @me", place))
        .toMatchObject(Result.succeed({ text: "ask @caller, or run task assign #1 @me", unlinked: [{ token: "#1" }] }));
    }
  });

  it("refuses a name two seats share, listing both", () => {
    const twins = canvasOf([
      region("a", { x: 0, y: 0, width: 1000, height: 400 }, { label: "A" }),
      seat("caller", { x: 20, y: 20, width: 100, height: 50 }),
      seat("one", { x: 200, y: 20, width: 100, height: 50, label: "twin" }),
      seat("two", { x: 400, y: 20, width: 100, height: 50, label: "twin" }),
      artifacts("docs", { x: 600, y: 20, width: 100, height: 50, label: "Docs" }),
    ]);
    const refused = linked(twins, "caller", "@twin", { kind: "comments", nodeId: "docs" });
    expect(Result.isFailure(refused) && refused.failure).toMatchObject({
      type: "InputError",
      details: { target: "@twin", candidates: [{ nodeId: "one" }, { nodeId: "two" }] },
    });
  });
});

// Outer holds the writer and its reviewer; inner-1 and inner-2 sit side by side
// inside it, so the writer reaches both and neither reaches the other. Far is
// a region of its own, holding a live overseer.
const nested = canvasOf(
  [
    region("outer", { x: 0, y: 0, width: 2000, height: 1000 }, { label: "Outer" }),
    region("inner-1", { x: 50, y: 50, width: 800, height: 400 }, { label: "One" }),
    region("inner-2", { x: 1000, y: 50, width: 800, height: 400 }, { label: "Two" }),
    region("far", { x: 0, y: 2000, width: 1000, height: 400 }, { label: "Far" }),
    seat("caller", { x: 50, y: 600 }),
    seat("peer", { x: 300, y: 600, label: "reviewer" }),
    taskBoard("board-1", { x: 100, y: 100, name: "Backlog" }),
    artifacts("docs-1", { x: 400, y: 100, label: "Docs" }),
    page("page-1", { x: 100, y: 300, url: "https://handbook.dev/" }),
    taskBoard("board-2", { x: 1100, y: 100, name: "Other" }),
    page("page-2", { x: 1100, y: 300, url: "https://elsewhere.dev/" }),
    taskBoard("board-far", { x: 100, y: 2100, name: "Far" }),
    page("page-far", { x: 400, y: 2250, url: "https://far.dev/" }),
    seat("boss", { x: 600, y: 2100, overseer: true }),
  ],
  [wire("caller-peer", "caller", "peer", "messages")],
);

const T42 = "01M5ESSJRFWT6RVS5HMWMGJX42";
const T43 = "01M5ESSJRFWT6RVS5HMWMGJX43";
const T7 = "01M5ESSJRFWT6RVS5HMWMGJXG7";
const T9 = "01M5ESSJRFWT6RVS5HMWMGJXG9";
const SPEC = "01M5ESSJRFWT6RVS5HMWMGJXSP";
const NOTES = "01M5ESSJRFWT6RVS5HMWMGJXNT";
const OLD = "01M5ESSJRFWT6RVS5HMWMGJXD0";

const stores = withItems(
  [
    { id: T42, node: "board-1", title: "fix tabs", number: 42 },
    { id: T43, node: "board-1", title: "spec", number: 43 },
    { id: T7, node: "board-2", title: "ship it", number: 7 },
    { id: T9, node: "board-far", title: "far task", number: 9 },
  ],
  [
    { id: SPEC, node: "docs-1", title: "spec" },
    { id: NOTES, node: "docs-1", title: "notes" },
    { id: OLD, node: "docs-1", title: "old", archived: true },
  ],
);

const linkOf = (ref: MentionRef, label: string) => mentionLink(ref, label, "factory");
const task42 = linkOf({ kind: "task", nodeId: asNodeId("board-1"), taskId: T42 as ItemId }, "#42 fix tabs");
const notes = linkOf({ kind: "artifact", nodeId: asNodeId("docs-1"), artifactId: NOTES as ItemId }, "#notes");
const handbook = linkOf({ kind: "page", nodeId: asNodeId("page-1") }, "@handbook.dev");
const refusal = (result: Result.Result<LinkedText, unknown>) => (Result.isFailure(result) ? result.failure : undefined);
/** The tokens a text kept as typed, or undefined when it was refused. */
const unlinked = (result: Result.Result<LinkedText, unknown>) => (Result.isSuccess(result) ? result.success.unlinked.map((at) => at.token) : undefined);
const succeeded = (text: string) => Result.succeed({ text, unlinked: [] });

describe("linkMentionsAt: tasks, artifacts and pages in mail, in the writer's reach", () => {
  it("resolves #42, #title and @page in reach to their links, beside @seat", () => {
    const peer = linkOf({ kind: "seat", nodeId: asNodeId("peer") }, "@reviewer");
    expect(linked(nested, "caller", "@reviewer take #42, see #Notes and @handbook.dev", MAIL, stores))
      .toEqual(succeeded(`${peer} take ${task42}, see ${notes} and ${handbook}`));
  });

  it("keeps a task, an artifact or a page out of reach as plain text, with the numbers or names nearest it", () => {
    expect(linked(nested, "caller", "#9", MAIL, stores)).toEqual(Result.succeed({ text: "#9", unlinked: [{ token: "#9", nearest: ["#7", "#42", "#43"] }] }));
    expect(unlinked(linked(nested, "caller", "#far and @far.dev", MAIL, stores))).toEqual(["#far", "@far.dev"]);
  });

  it("refuses a #title a task and an artifact share, listing both", () => {
    expect(refusal(linked(nested, "caller", "#spec", MAIL, stores))).toMatchObject({
      type: "InputError",
      details: { path: "text", target: "#spec", candidates: [{ kind: "task", itemId: T43 }, { kind: "artifacts", itemId: SPEC }] },
    });
  });

  it("does not offer an archived artifact", () => {
    expect(unlinked(linked(nested, "caller", "#old", MAIL, stores))).toEqual(["#old"]);
  });

  it("lets a live overseer name a task on any board, and artifacts and pages only in its reach", () => {
    expect(linked(nested, "boss", "#42", MAIL, stores)).toEqual(succeeded(task42));
    expect(unlinked(linked(nested, "boss", "#notes @handbook.dev", MAIL, stores))).toEqual(["#notes", "@handbook.dev"]);
  });
});

describe("linkMentionsAt: tasks, artifacts and pages in comments, in the resource's reach", () => {
  const onBoard: MentionPlace = { kind: "comments", nodeId: "board-1" };

  it("resolves what the resource reaches, itself included, whoever writes", () => {
    expect(linked(nested, "caller", "#42 and #notes", onBoard, stores)).toEqual(succeeded(`${task42} and ${notes}`));
    expect(linked(nested, "operator", "#42", { kind: "comments", nodeId: "docs-1" }, stores)).toEqual(succeeded(task42));
  });

  it("links only what the resource reaches, not what the writer reaches", () => {
    expect(unlinked(linked(nested, "caller", "#7 and @elsewhere.dev", onBoard, stores))).toEqual(["#7", "@elsewhere.dev"]);
    expect(unlinked(linked(nested, "caller", "#7 and @elsewhere.dev", MAIL, stores))).toEqual([]);
  });

  it("gives a live overseer no more than the resource reaches", () => {
    expect(unlinked(linked(nested, "boss", "#9", onBoard, stores))).toEqual(["#9"]);
  });
});

describe("mentionNodesAt: what main resolves is what the composer offers", () => {
  const ids = (nodes: ReadonlyArray<{ readonly id: string }>) => nodes.map((node) => node.id).sort();

  it("in mail, the writer's reach exactly as the composer's resourceNodesInReach", () => {
    for (const writer of ["caller", "peer"]) {
      expect(ids(mentionNodesAt(nested, writer, MAIL))).toEqual(ids(resourceNodesInReach(nested, asNodeId(writer))));
    }
  });

  it("in comments, the resource's reach and the resource itself, exactly as the composer's", () => {
    for (const nodeId of ["board-1", "docs-1", "page-1", "board-2", "board-far"]) {
      const offered = ids(resourceNodesInReach(nested, asNodeId(nodeId)));
      expect(offered).toContain(nodeId);
      expect(ids(mentionNodesAt(nested, "caller", { kind: "comments", nodeId }))).toEqual(offered);
    }
  });

  it("for a live overseer's mail, its reach and every task board, exactly as the composer's", () => {
    const offered = ids(resourceNodesInReach(nested, asNodeId("boss")));
    expect(offered).toEqual(expect.arrayContaining(["board-1", "board-2"]));
    expect(ids(mentionNodesAt(nested, "boss", MAIL))).toEqual(offered);
  });
});
