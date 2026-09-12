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
  it("is the kind name — never the mirror's dash lines", () => {
    const node = boardNode(
      "board-1",
      mirrorBoardText([{ title: "alpha" }, { title: "beta" }]),
    );
    expect(boardNodeName(node)).toBe("board");
  });

  it("stays the kind name for absent or bare nodes", () => {
    expect(boardNodeName(undefined)).toBe("board");
    expect(
      boardNodeName({
        ...boardNode("board-2", "board"),
        ether: { entity: { kind: "board" } },
      }),
    ).toBe("board");
  });
});

describe("board node identity agreement across surfaces", () => {
  // Stale mechanical mirror as node.text (what the work plane writes): every
  // surface must read the kind name, never the mirror's first dash line.
  const node = boardNode("board-1", "- alpha\n- beta");

  it("presentation.nodeTitle uses the kind name", () => {
    expect(nodeTitle(node)).toBe("board");
  });

  it("svg node title uses the kind name", () => {
    const svg = renderCanvasSvg({ nodes: [node], edges: [] });
    expect(svg).toContain(">board</text>");
    expect(svg).not.toContain("- alpha");
  });

  it("digest entities name the board by kind", () => {
    const digest = digestCanvas({ nodes: [node], edges: [] });
    expect(digest).toContain("board :: board");
    expect(digest).not.toContain("- alpha");
  });

  it("region rollup member labels use the kind name", () => {
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
    expect(rollup?.members.map((member) => member.label)).toEqual(["board"]);
  });
});
