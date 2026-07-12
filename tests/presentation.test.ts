import { describe, expect, it } from "vitest";
import { nodeDetail, nodeTitle, searchText } from "../src/renderer/lib/presentation";
import type { CanvasNode } from "../src/shared/canvas";

const base = { id: "node", x: 0, y: 0, width: 200, height: 80 } as const;

describe("canvas presentation", () => {
  it("uses bindings when a signal has no body detail", () => {
    const node: CanvasNode = {
      ...base,
      type: "text",
      text: "PRISM",
      ether: {
        entity: { kind: "project" },
        bindings: [
          { source: "tower", ref: { type: "project", key: "prism" } },
          { source: "quasar", ref: { type: "project", key: "git:github.com/skastr0/prism" } },
        ],
      },
    };

    expect(nodeTitle(node)).toBe("PRISM");
    expect(nodeDetail(node)).toBe("tower / prism · quasar / git:github.com/skastr0/prism");
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

  it("indexes Ether flags for field search", () => {
    const node: CanvasNode = { ...base, type: "text", text: "Signal", ether: { flags: ["attention", "parked"] } };

    expect(searchText(node)).toContain("attention");
    expect(searchText(node)).toContain("parked");
  });
});
