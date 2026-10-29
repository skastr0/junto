/**
 * The mentions beside a briefing's text (docs/plans/0.11/08 B2): one entry
 * per distinct link, in order of first appearance, parsed by
 * parseMentionHref; a gone thing is missing, never dropped.
 */
import { Effect, Layer, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { briefingLinksOf, briefingMentionOf, BriefingMentions } from "../src/shared/briefing-mentions";
import { briefingMentionsOn } from "../src/main/junto/references/briefing-mentions";
import { ArtifactRepository } from "../src/main/junto/work/artifact-repository";
import { TaskRepository } from "../src/main/junto/work/task-repository";
import type { Canvas } from "../src/shared/model";
import { artifacts, files, page, region, seat, taskBoard, wire } from "./support/model-nodes";
import { asNodeId } from "../src/shared/model/base";

const TASK = "01M5ESMQ2ZT55QZ073EWPH10SG";
const ARTIFACT = "01M5ESMQ2ZT55QZ073EWPH10SH";
const GONE = "01M5ESMQ2ZT55QZ073EWPH10SJ";
const MOVED = "01M5ESMQ2ZT55QZ073EWPH10SK";
const link = (label: string, node: string, item?: string, canvas = "factory") =>
  `[${label}](junto://canvas/${canvas}?node=${node}${item === undefined ? "" : `&item=${item}`})`;

describe("briefingLinksOf", () => {
  it("keeps one entry per thing linked, in first-appearance order, with its label and ref as first written", () => {
    const text = [
      `Ask ${link("@pty-lead", "agent-pty")} first.`,
      `The plan: ${link("Plan", "shelf", ARTIFACT)}.`,
      `Again ${link("@pty again", "agent-pty", undefined, "renamed")}, and ${link("Plan", "shelf", ARTIFACT)}.`,
      "Not a mention: [docs](https://example.com) or [x](junto://canvas?node=Shelf).",
    ].join("\n");
    expect(briefingLinksOf(text)).toEqual([
      { target: { nodeId: "agent-pty" }, label: "@pty-lead", ref: "junto://canvas/factory?node=agent-pty" },
      { target: { nodeId: "shelf", item: ARTIFACT }, label: "Plan", ref: `junto://canvas/factory?node=shelf&item=${ARTIFACT}` },
    ]);
  });

  it("finds nothing in a text with no links", () => {
    expect(briefingLinksOf("# House rules\n\nCommit by explicit path.")).toEqual([]);
  });
});

describe("briefingMentionOf", () => {
  const [one] = briefingLinksOf(link("x", "n"));
  const [withItem] = briefingLinksOf(link("x", "n", TASK));
  const node = (kind: Canvas["nodes"] extends ReadonlyMap<unknown, infer N> ? N extends { kind: infer K } ? K : never : never) =>
    ({ kind, title: "Title", reachable: true }) as const;

  it("names a seat, a page and any other node by the node's id and title", () => {
    expect(briefingMentionOf(one!, { node: node("agent") })).toEqual({ label: "x", ref: "junto://canvas/factory?node=n", kind: "seat", id: "n", title: "Title", reachable: true });
    expect(briefingMentionOf(one!, { node: node("page") })).toMatchObject({ kind: "page", id: "n" });
    expect(briefingMentionOf(one!, { node: node("files") })).toMatchObject({ kind: "node", id: "n" });
    // A board or a shelf linked without an item is the node itself.
    expect(briefingMentionOf(one!, { node: node("task") })).toMatchObject({ kind: "node", id: "n" });
  });

  it("names a task or an artifact by the item's id and current title", () => {
    expect(briefingMentionOf(withItem!, { node: node("task"), item: { title: "Fix tabs" } })).toEqual({
      label: "x", ref: `junto://canvas/factory?node=n&item=${TASK}`, kind: "task", id: TASK, title: "Fix tabs", reachable: true,
    });
    expect(briefingMentionOf(withItem!, { node: node("artifacts"), item: { title: "Plan" } })).toMatchObject({ kind: "artifact", id: TASK, title: "Plan" });
  });

  it("calls a gone node, a gone item, or an item on a node that holds none missing, unreachable and untitled", () => {
    const gone = { label: "x", kind: "missing", reachable: false };
    expect(briefingMentionOf(one!, { node: undefined })).toEqual({ ...gone, ref: "junto://canvas/factory?node=n", id: "n" });
    expect(briefingMentionOf(withItem!, { node: node("task"), item: undefined })).toEqual({ ...gone, ref: `junto://canvas/factory?node=n&item=${TASK}`, id: TASK });
    expect(briefingMentionOf(withItem!, { node: node("agent") })).toMatchObject({ kind: "missing", id: TASK });
  });
});

describe("briefingMentionsOn", () => {
  // The reader is wired to "peer", and sits in a region with "board" and "shelf"; "far" is in a sibling region.
  const nodes = [
    region("cli", { x: -100, y: -100, width: 1000, height: 600 }, { label: "CLI" }),
    region("product", { x: 4000, y: 4000, width: 2000, height: 2000 }, { label: "Product" }),
    seat("reader", { x: 0, y: 0, width: 100, height: 40 }),
    seat("peer", { x: 2000, y: 0, width: 100, height: 40 }),
    seat("stranger", { x: 3000, y: 0, width: 100, height: 40 }),
    taskBoard("board", { x: 200, y: 0, width: 100, height: 40 }),
    artifacts("shelf", { x: 400, y: 0, width: 100, height: 40 }),
    files("far", { x: 5000, y: 5000, width: 100, height: 40 }),
    artifacts("far-shelf", { x: 5200, y: 5000, width: 100, height: 40 }),
    page("docs", { x: 200, y: 200, width: 100, height: 40, label: "Docs" }),
  ];
  const canvas = {
    nodes: new Map(nodes.map((n) => [n.id, n])),
    wires: new Map([[asNodeId("w"), wire("w", "reader", "peer", "messages")]]),
  } as unknown as Canvas;

  const stores = Layer.mergeAll(
    Layer.succeed(TaskRepository, {
      get: (_canvas: string, id: string) => Effect.succeed(id === TASK ? Option.some({ title: "Fix tabs", current: { node: "board" } }) : Option.none()),
    } as never),
    Layer.succeed(ArtifactRepository, {
      head: (_canvas: string, id: string) =>
        Effect.succeed(
          id === ARTIFACT ? Option.some({ artifact: { title: "Plan", nodeId: "shelf" } })
            : id === MOVED ? Option.some({ artifact: { title: "Far plan", nodeId: "far-shelf" } })
              : Option.none(),
        ),
    } as never),
  );
  const read = (text: string, provide = true) =>
    Effect.runPromise(
      provide
        ? briefingMentionsOn(canvas, { canvasName: "factory", nodeId: "reader" }, text).pipe(Effect.provide(stores))
        : briefingMentionsOn(canvas, { canvasName: "factory", nodeId: "reader" }, text),
    );

  it("resolves every kind against the canvas and the stores, reach included, and keeps the gone ones", async () => {
    const text = [
      link("@peer", "peer"), link("@stranger", "stranger"), link("#1", "board", TASK), link("Plan", "shelf", ARTIFACT),
      link("Old", "shelf", GONE), link("Far", "far"), link("Docs", "docs"), link("Gone", "deleted-node"),
    ].join(" ");
    const mentions = await read(text);
    expect(Schema.decodeUnknownSync(BriefingMentions)(mentions)).toEqual(mentions);
    expect(mentions!.map(({ kind, id, title, reachable }) => ({ kind, id, title, reachable }))).toEqual([
      { kind: "seat", id: "peer", title: "peer", reachable: true },
      { kind: "seat", id: "stranger", title: "stranger", reachable: false },
      { kind: "task", id: TASK, title: "Fix tabs", reachable: true },
      { kind: "artifact", id: ARTIFACT, title: "Plan", reachable: true },
      { kind: "missing", id: GONE, title: undefined, reachable: false },
      { kind: "node", id: "far", title: expect.any(String), reachable: false },
      { kind: "page", id: "docs", title: "Docs", reachable: true },
      { kind: "missing", id: "deleted-node", title: undefined, reachable: false },
    ]);
  });

  it("judges an item's reach on the node it lives on, not the node a hand-written link names", async () => {
    // MOVED lives on far-shelf, in a sibling region; the link puts it on shelf, which the reader reaches.
    expect(await read(link("Plan", "shelf", MOVED))).toMatchObject([{ kind: "artifact", id: MOVED, title: "Far plan", reachable: false }]);
    expect(await read(link("Plan", "far-shelf", ARTIFACT))).toMatchObject([{ kind: "artifact", id: ARTIFACT, reachable: true }]);
  });

  it("leaves the field out for a text with no links, and when an item cannot be read here", async () => {
    expect(await read("No links.")).toBeUndefined();
    expect(await read(link("#1", "board", TASK), false)).toBeUndefined();
    // A node-only text needs no store.
    expect(await read(link("@peer", "peer"), false)).toMatchObject([{ kind: "seat", reachable: true }]);
  });
});
