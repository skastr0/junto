import { describe, expect, it } from "vitest";
import type { CanvasNode } from "../src/shared/canvas";
import {
  agentKeysFromNodes,
  classifyMultiSelection,
  multiSelectionLabel,
  multiSurfaceKey,
  surfaceLabel,
} from "../src/renderer/lib/multi-selection";

const base = { id: "n", x: 0, y: 0, width: 200, height: 80 } as const;

const text = (over: Partial<CanvasNode> & { id?: string } = {}): CanvasNode =>
  ({
    ...base,
    type: "text",
    text: "x",
    ...over,
  }) as CanvasNode;

describe("multiSurfaceKey", () => {
  it("maps region, entity kind, herdr legacy, and type", () => {
    expect(multiSurfaceKey({ ...base, type: "group", label: "ops" })).toBe("region");
    expect(multiSurfaceKey(text({ ether: { entity: { kind: "agent", name: "h:p" } } }))).toBe(
      "kind:agent",
    );
    expect(multiSurfaceKey(text({ ether: { herdr: { host: "local" } } }))).toBe("kind:herdr");
    expect(multiSurfaceKey(text())).toBe("type:text");
    expect(multiSurfaceKey({ ...base, type: "link", url: "https://x.com" })).toBe("type:link");
  });
});

describe("classifyMultiSelection", () => {
  it("empty / single / homogeneous / heterogeneous", () => {
    expect(classifyMultiSelection([])).toEqual({ mode: "empty" });

    const one = text({ id: "a", ether: { entity: { kind: "agent", name: "a:1" } } });
    expect(classifyMultiSelection([one])).toEqual({ mode: "single", node: one });

    const agents = [
      text({ id: "a", ether: { entity: { kind: "agent", name: "h:a" } } }),
      text({ id: "b", ether: { entity: { kind: "agent", name: "h:b" } } }),
    ];
    expect(classifyMultiSelection(agents)).toEqual({
      mode: "homogeneous",
      surface: "kind:agent",
      nodes: agents,
    });

    const mixed = [
      text({ id: "a", ether: { entity: { kind: "agent", name: "h:a" } } }),
      text({ id: "n", text: "note" }),
    ];
    const classified = classifyMultiSelection(mixed);
    expect(classified.mode).toBe("heterogeneous");
    if (classified.mode === "heterogeneous") {
      expect(classified.surfaces).toContain("kind:agent");
      expect(classified.surfaces).toContain("type:text");
    }
  });
});

describe("agentKeysFromNodes", () => {
  it("collects agent entity names only", () => {
    const nodes = [
      text({ id: "a", ether: { entity: { kind: "agent", name: "local:alpha" } } }),
      text({ id: "b", ether: { entity: { kind: "agent", name: "local:beta" } } }),
      text({ id: "c", text: "note" }),
      text({ id: "d", ether: { entity: { kind: "task", name: "t1" } } }),
    ];
    expect(agentKeysFromNodes(nodes)).toEqual([
      { nodeId: "a", agentKey: "local:alpha" },
      { nodeId: "b", agentKey: "local:beta" },
    ]);
  });
});

describe("labels", () => {
  it("multiSelectionLabel and surfaceLabel", () => {
    expect(surfaceLabel("kind:agent")).toBe("agents");
    expect(surfaceLabel("region")).toBe("regions");
    expect(multiSelectionLabel({ mode: "empty" })).toBe("no selection");
    expect(
      multiSelectionLabel({
        mode: "homogeneous",
        surface: "kind:agent",
        nodes: [text(), text()],
      }),
    ).toBe("2 - agents");
    expect(
      multiSelectionLabel({
        mode: "heterogeneous",
        nodes: [text(), text()],
        surfaces: ["kind:agent", "type:text"],
      }),
    ).toBe("2 - mixed");
  });
});
