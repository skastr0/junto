import { describe, expect, it } from "vitest";
import type { CanvasDoc, TextNode } from "../src/shared/canvas";
import { mirrorBoardText } from "../src/shared/task";
import { boardNodeName } from "../src/shared/board-node-identity";
import { digestCanvas as digestCanvasWithActorRefs } from "../src/shared/digest";
import { renderCanvasSvg as renderCanvasSvgWithContext } from "../src/shared/svg";
import { deriveRegionRollups } from "../src/shared/region-rollup";
import { nodeTitle } from "../src/renderer/lib/presentation";
import { executionContextForDoc } from "./helpers/actor-ref-fixtures";

const renderCanvasSvg = (doc: CanvasDoc): string =>
  renderCanvasSvgWithContext(doc, executionContextForDoc(doc));

const digestCanvas = (doc: CanvasDoc): string =>
  digestCanvasWithActorRefs("fixture", doc, { bundles: [] }, {
    resolveActorRef: executionContextForDoc(doc, "fixture").resolveActorRef,
  });

const boardNode = (id: string, text: string): TextNode => ({
  id,
  type: "text",
  text,
  x: 10,
  y: 10,
  width: 220,
  height: 110,
  ether: {
    entity: { kind: "board" },
    board: {
      topics: [
        {
          topicId: "t1",
          title: "alpha",
          state: "open",
          postCount: 2,
          lastActivityAt: "2026-09-12T00:00:00.000Z",
        },
      ],
    },
  },
});

describe("boardNodeName", () => {
  it("is the mirror's authored first line — topic lines never leak", () => {
    const node = boardNode(
      "board-1",
      mirrorBoardText("Fleet announcements", [
        { title: "alpha" },
        { title: "beta" },
      ]),
    );
    expect(boardNodeName(node)).toBe("Fleet announcements");
  });

  it("is the kind name for absent, empty, or untitled nodes", () => {
    expect(boardNodeName(undefined)).toBe("board");
    expect(
      boardNodeName({
        ...boardNode("board-2", "board"),
        ether: { entity: { kind: "board" } },
      }),
    ).toBe("board");
    expect(
      boardNodeName(boardNode("board-3", mirrorBoardText("", [{ title: "alpha" }]))),
    ).toBe("board");
  });
});

describe("board node identity agreement across surfaces", () => {
  // The titled board's mirror as work writes it: authored first line, dash
  // topic lines beneath. Every surface must read the authored title, never a
  // dash line — and an untitled board must read the kind name everywhere.
  const node = boardNode(
    "board-1",
    mirrorBoardText("Fleet announcements", [{ title: "alpha" }, { title: "beta" }]),
  );
  const untitled = boardNode(
    "board-2",
    mirrorBoardText("", [{ title: "alpha" }]),
  );

  it("presentation.nodeTitle uses the authored title", () => {
    expect(nodeTitle(node)).toBe("Fleet announcements");
    expect(nodeTitle(untitled)).toBe("board");
  });

  it("svg node title uses the authored title", () => {
    const svg = renderCanvasSvg({ nodes: [node], edges: [] });
    expect(svg).toContain(">Fleet announcements</text>");
    expect(svg).not.toContain("- alpha");
    const untitledSvg = renderCanvasSvg({ nodes: [untitled], edges: [] });
    expect(untitledSvg).toContain(">board</text>");
  });

  it("digest entities name the board by its authored title", () => {
    const digest = digestCanvas({ nodes: [node], edges: [] });
    expect(digest).toContain("Fleet announcements :: board");
    expect(digest).not.toContain("- alpha");
    const untitledDigest = digestCanvas({ nodes: [untitled], edges: [] });
    expect(untitledDigest).toContain("board :: board");
  });

  it("region rollup member labels use the authored title", () => {
    const doc: CanvasDoc = {
      nodes: [
        {
          id: "grp",
          type: "group",
          label: "ops",
          x: 0,
          y: 0,
          width: 500,
          height: 500,
        },
        node,
      ],
      edges: [],
    };
    const context = executionContextForDoc(doc);
    const [rollup] = deriveRegionRollups({
      doc,
      canvasName: context.canvasName,
      resolveActorRef: context.resolveActorRef,
    });
    expect(rollup?.members.map((member) => member.label)).toEqual([
      "Fleet announcements",
    ]);
  });
});
