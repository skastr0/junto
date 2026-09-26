import { describe, expect, it } from "vitest";
import { nodeDetail, nodeTitle, nodeTypeLabel, searchText } from "../src/renderer/lib/presentation";
import type { CanvasNode } from "../src/shared/canvas";

const base = { id: "node", x: 0, y: 0, width: 200, height: 80 } as const;

describe("canvas presentation", () => {
  it("uses the identity when a project node has no body detail", () => {
    const node: CanvasNode = {
      ...base,
      type: "text",
      text: "PRISM",
      ether: {
        entity: { kind: "project", name: "prism" },
      },
    };

    expect(nodeTitle(node)).toBe("PRISM");
    expect(nodeDetail(node)).toBe("project - prism");
    expect(nodeTypeLabel(node)).toBe("project");
  });

  it("labels nodes by their true type — never 'signal'", () => {
    expect(nodeTypeLabel({ ...base, type: "text", text: "a note" })).toBe("note");
    expect(nodeTypeLabel({ ...base, type: "file", file: "docs/x.md" })).toBe("file");
    expect(nodeTypeLabel({ ...base, type: "link", url: "https://x.com" })).toBe("link");
    expect(nodeTypeLabel({ ...base, type: "group", label: "Ops" })).toBe("region");
    expect(nodeTypeLabel({ ...base, type: "text", text: "Vega", ether: { entity: { kind: "agent" } } })).toBe("agent");
  });

  it("keeps type-specific details for files, links, and regions", () => {
    const file: CanvasNode = { ...base, type: "file", file: "docs/untitled.md", subpath: "#install" };
    const link: CanvasNode = { ...base, type: "link", url: "https://example.com/path" };
    const group: CanvasNode = { ...base, type: "group", label: "Operations" };

    expect(nodeTitle(file)).toBe("untitled.md");
    expect(nodeDetail(file)).toBe("docs/untitled.md #install");
    expect(searchText(file)).toContain("#install");
    expect(nodeTitle(link)).toBe("example.com");
    expect(nodeDetail(link)).toBe("https://example.com/path");
    expect(nodeTitle(group)).toBe("Operations");
    expect(nodeDetail(group)).toBe("Spatial region");
  });

  it("keeps the artifacts shelf title stable while node.text mirrors artifact names", () => {
    // The shelf has no authorial name: node.text mirrors the first artifact
    // name and shifts on rename/archive/delete. Title stays the kind label.
    const node: CanvasNode = {
      ...base,
      type: "text",
      text: "release proof",
      ether: {
        entity: { kind: "artifacts" },
        artifacts: { items: [] },
      },
    };

    expect(nodeTitle(node)).toBe("artifacts");
  });
});
