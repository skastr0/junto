/**
 * Links from one artifact to another (0.11 L1): what a body holds, read as
 * links by id, with the text around each one, one per target.
 */
import { describe, expect, it } from "vitest";
import { bodyLinksOf, type BodyLinkAt } from "../src/shared/artifact-links";
import { decodeArtifactBody } from "../src/shared/artifact";
import { asNodeId } from "../src/shared/physics/schema";
import { ItemId } from "../src/shared/work-ids";
import { mentionHref } from "../src/shared/mention";

const SHELF = asNodeId("artifacts-shelf");
const OTHER = asNodeId("artifacts-other");
const BUDGET = ItemId.make("01M5EVKRB1X4P80GXRGDK8V5AS");
const PLAN = ItemId.make("01M5EVKRB1X4P80GXRGDK8V5AT");
const SEAT = asNodeId("agent-a");

const link = (ref: Parameters<typeof mentionHref>[0], label: string): string => `[${label}](${mentionHref(ref, "factory")})`;
const artifact = (nodeId: typeof SHELF, artifactId: ItemId, label: string): string =>
  link({ kind: "artifact", nodeId, artifactId }, label);

/** A link the extractor keeps: an artifact's own place. */
const target = (nodeId: typeof SHELF, artifactId: ItemId): { nodeId: typeof SHELF; artifactId: ItemId } => ({ nodeId, artifactId });

const lines = (links: ReadonlyArray<BodyLinkAt>): ReadonlyArray<string> => links.map((one) => one.line);

describe("the links in an artifact's body", () => {
  it("reads a document's markdown by line, one row per target, in first-named order", () => {
    const markdown = [
      "# Budget",
      "",
      `The ${artifact(SHELF, BUDGET, "Budget")} is fixed; the ${artifact(SHELF, PLAN, "Plan")} depends on it.`,
      `Again ${artifact(SHELF, BUDGET, "Budget")}, and ${artifact(OTHER, PLAN, "Plan elsewhere")}.`,
    ].join("\n");
    const body = decodeArtifactBody({ type: "document", markdown });
    if (body._tag === "Failure") throw new Error("body");
    expect(bodyLinksOf(body.success).map((one) => one.target)).toEqual([
      target(SHELF, BUDGET),
      target(SHELF, PLAN),
      target(OTHER, PLAN),
    ]);
    // The line as the body holds it: the mention link is the stored form, the label what a reader sees.
    expect(lines(bodyLinksOf(body.success))).toEqual([
      `The ${artifact(SHELF, BUDGET, "Budget")} is fixed; the ${artifact(SHELF, PLAN, "Plan")} depends on it.`,
      `The ${artifact(SHELF, BUDGET, "Budget")} is fixed; the ${artifact(SHELF, PLAN, "Plan")} depends on it.`,
      `Again ${artifact(SHELF, BUDGET, "Budget")}, and ${artifact(OTHER, PLAN, "Plan elsewhere")}.`,
    ]);
  });

  it("keeps no link that names no item, and none that is not a mention link", () => {
    const markdown = `A seat ${link({ kind: "seat", nodeId: SEAT }, "@a")}, a page [p](https://x.example/), and ${artifact(SHELF, BUDGET, "Budget")}.`;
    const body = decodeArtifactBody({ type: "document", markdown });
    if (body._tag === "Failure") throw new Error("body");
    expect(bodyLinksOf(body.success).map((one) => one.target)).toEqual([target(SHELF, BUDGET)]);
  });

  it("reads a sheet's cells in column then row order", () => {
    const body = decodeArtifactBody({
      type: "sheet",
      grid: {
        columns: [
          { id: "c1", name: "Item" },
          { id: "c2", name: "Note" },
        ],
        rows: [
          { id: "r1", cells: { c1: "Cost", c2: artifact(SHELF, BUDGET, "Budget") } },
          { id: "r2", cells: { c1: artifact(SHELF, PLAN, "Plan") } },
        ],
      },
    });
    if (body._tag === "Failure") throw new Error("body");
    expect(bodyLinksOf(body.success).map((one) => one.target.artifactId)).toEqual([BUDGET, PLAN]);
    expect(bodyLinksOf(body.success)[0]?.line).toBe(artifact(SHELF, BUDGET, "Budget"));
    expect(bodyLinksOf(body.success)[1]?.line).toBe(artifact(SHELF, PLAN, "Plan"));
  });

  it("reads a pad's shape text and a card's own href", () => {
    const body = decodeArtifactBody({
      type: "pad",
      pad: {
        revision: 0,
        images: [],
        edges: [],
        inks: [],
        shapes: [
          { id: "s2", type: "card", x: 0, y: 0, w: 10, h: 10, z: 2, href: mentionHref({ kind: "artifact", nodeId: SHELF, artifactId: PLAN }, "factory"), label: "Plan" },
          { id: "s1", type: "box", x: 0, y: 0, w: 10, h: 10, z: 1, text: `Ship it: ${artifact(SHELF, BUDGET, "Budget")}` },
        ],
      },
    });
    if (body._tag === "Failure") throw new Error("body");
    // Lower z first, so the card drawn above reads after the box it covers.
    const found = bodyLinksOf(body.success);
    expect(found.map((one) => one.target.artifactId)).toEqual([BUDGET, PLAN]);
    expect(found[0]?.line).toBe(`Ship it: ${artifact(SHELF, BUDGET, "Budget")}`);
    // A card's line is its name: its own href is the link, its label what a reader sees.
    expect(found[1]?.line).toBe("Plan");
  });

  it("holds no links in a file or a link body, and cuts a long line", () => {
    const file = decodeArtifactBody({ type: "file", content: { sha256: "a".repeat(64), byteLength: 1, mediaType: "image/png" } });
    const url = decodeArtifactBody({ type: "link", target: { kind: "url", url: "https://x.example/" } });
    if (file._tag === "Failure" || url._tag === "Failure") throw new Error("body");
    expect(bodyLinksOf(file.success)).toEqual([]);
    expect(bodyLinksOf(url.success)).toEqual([]);

    const long = `${"x".repeat(400)} ${artifact(SHELF, BUDGET, "Budget")}`;
    const cut = decodeArtifactBody({ type: "document", markdown: long });
    if (cut._tag === "Failure") throw new Error("body");
    expect(bodyLinksOf(cut.success)[0]?.line.length).toBeLessThanOrEqual(240);
  });

  it("windows a long line around its own link, never cutting the link", () => {
    const before = "y".repeat(300);
    const markdown = `${before} ${artifact(SHELF, BUDGET, "Budget")} then the tail ${"z".repeat(300)}`;
    const body = decodeArtifactBody({ type: "document", markdown });
    if (body._tag === "Failure") throw new Error("body");
    const line = bodyLinksOf(body.success)[0]!.line;
    expect(line.length).toBeLessThanOrEqual(240);
    // The link is whole in the window, so a reader can still find it, and both cut sides say so.
    expect(line).toContain(artifact(SHELF, BUDGET, "Budget"));
    expect(line.startsWith("…")).toBe(true);
    expect(line.endsWith("…")).toBe(true);
    // A window, not the line: most of the 300 y's before it are gone.
    expect(line.indexOf("y")).toBe(1);
  });

  it("keeps a second link on the same line as its own row, each windowed on itself", () => {
    const markdown = `${"a".repeat(200)} ${artifact(SHELF, BUDGET, "Budget")} ${"b".repeat(200)} ${artifact(SHELF, PLAN, "Plan")} ${"c".repeat(200)}`;
    const body = decodeArtifactBody({ type: "document", markdown });
    if (body._tag === "Failure") throw new Error("body");
    const found = bodyLinksOf(body.success);
    expect(found.map((one) => one.target.artifactId)).toEqual([BUDGET, PLAN]);
    expect(found[0]?.line).toContain(artifact(SHELF, BUDGET, "Budget"));
    expect(found[0]?.line).not.toContain(artifact(SHELF, PLAN, "Plan"));
    expect(found[1]?.line).toContain(artifact(SHELF, PLAN, "Plan"));
  });
});
