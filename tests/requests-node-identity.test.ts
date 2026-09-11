import { describe, expect, it } from "vitest";
import type { CanvasDoc, TextNode } from "../src/shared/canvas";
import { mirrorRequestsText } from "../src/shared/task";
import { requestsNodeName } from "../src/shared/requests-node-identity";
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

const requestItem = (
  id: string,
  state: "input-required" | "auth-required" | "completed" | "submitted",
) => ({
  id,
  state,
  history: [
    {
      messageId: `${id}-m0`,
      role: "user" as const,
      parts: [{ kind: "text" as const, text: `Brief for ${id}` }],
      taskId: id,
    },
  ],
});

const requestsNode = (
  id: string,
  text: string,
  name?: string,
  items: ReturnType<typeof requestItem>[] = [],
): TextNode => ({
  id,
  type: "text",
  text,
  x: 10,
  y: 10,
  width: 220,
  height: 110,
  ether: {
    entity: { kind: "requests" },
    requests: { items, ...(name ? { name } : {}) },
  },
});

describe("requestsNodeName", () => {
  it("reads the authored name", () => {
    expect(requestsNodeName(requestsNode("r", "whatever", "Vendor keys"))).toBe(
      "Vendor keys",
    );
  });

  it("falls back to the kind name for absent, blank, or generic names", () => {
    expect(requestsNodeName(requestsNode("r", "3 pending"))).toBe("requests");
    expect(requestsNodeName(requestsNode("r", "3 pending", ""))).toBe("requests");
    expect(requestsNodeName(requestsNode("r", "3 pending", "   "))).toBe("requests");
    expect(requestsNodeName(requestsNode("r", "3 pending", "requests"))).toBe(
      "requests",
    );
    expect(requestsNodeName(requestsNode("r", "3 pending", "Request"))).toBe(
      "requests",
    );
    expect(requestsNodeName(undefined)).toBe("requests");
  });

  it("never reads the mirror's count line as identity", () => {
    // The pre-identity mirror put the count first; an old document must not
    // surface "3 pending" as a title.
    expect(requestsNodeName(requestsNode("r", "3 pending"))).not.toMatch(/pending/);
  });
});

describe("mirrorRequestsText", () => {
  it("renders identity line, attention count, then briefs in bag order", () => {
    const text = mirrorRequestsText(
      [requestItem("01B", "completed"), requestItem("01A", "input-required")],
      "Vendor keys",
    );
    expect(text).toBe(
      "Vendor keys\n1 pending\nBrief for 01B\nBrief for 01A",
    );
  });

  it("counts auth-required as attention", () => {
    const text = mirrorRequestsText(
      [requestItem("01A", "auth-required")],
      "Vendor keys",
    );
    expect(text).toBe("Vendor keys\n1 pending\nBrief for 01A");
  });

  it("keeps kind identity when unnamed and empty", () => {
    expect(mirrorRequestsText([])).toBe("requests\n0 pending");
    expect(mirrorRequestsText([], "Vendor keys")).toBe("Vendor keys\n0 pending");
  });
});

describe("requests node identity agreement across surfaces", () => {
  // Stale pre-identity mirror as node.text: every surface must read the
  // authored name, never the mirror's first line.
  const node = requestsNode("req-1", "3 pending", "Vendor keys", [
    requestItem("01A", "input-required"),
  ]);

  it("presentation.nodeTitle uses the authored name", () => {
    expect(nodeTitle(node)).toBe("Vendor keys");
  });

  it("svg node title uses the authored name", () => {
    const svg = renderCanvasSvg({ nodes: [node], edges: [] });
    expect(svg).toContain("Vendor keys");
    expect(svg).not.toContain("3 pending");
  });

  it("digest entities name and stats use the authored identity", () => {
    const digest = digestCanvas({ nodes: [node], edges: [] });
    expect(digest).toContain("Vendor keys :: requests");
    expect(digest).toContain("requests: 1/1 need attention");
    expect(digest).not.toContain("3 pending");
  });

  it("region rollup member labels use the authored name", () => {
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
      "Vendor keys",
    ]);
  });
});
