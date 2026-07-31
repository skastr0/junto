import { beforeEach, describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import {
  __resetKernelMemoryForTest,
  __setDocsForTest,
  getRuntimeFlagOverrides,
  projectRuntimeFlags,
  setRuntimeFlag,
} from "../src/main/vellum/kernel/cycle";

const doc = (flags: ReadonlyArray<"blocker" | "parked" | "attention"> = []): CanvasDoc => ({
  nodes: [
    {
      id: "node",
      type: "text",
      text: "node",
      x: 0,
      y: 0,
      width: 100,
      height: 40,
      ether: {
        entity: { kind: "note" },
        ...(flags.length > 0 ? { flags } : {}),
      },
    },
  ],
  edges: [],
});

describe("kernel runtime flag projection", () => {
  beforeEach(() => {
    __resetKernelMemoryForTest();
  });

  it("projects scheduler flags without changing authorial intent", () => {
    const authored = doc(["attention"]);
    __setDocsForTest(new Map([["board", authored]]));

    expect(setRuntimeFlag("board", "node", "blocker", true)).toBe(true);
    expect(setRuntimeFlag("board", "node", "attention", false)).toBe(true);

    expect(authored.nodes[0]?.ether?.flags).toEqual(["attention"]);
    expect(projectRuntimeFlags("board", authored).nodes[0]?.ether?.flags).toEqual([
      "blocker",
    ]);
    expect(getRuntimeFlagOverrides("board")).toEqual({
      node: { blocker: true, attention: false },
    });
  });

  it("fails closed for missing targets and drops overrides with removed nodes", () => {
    __setDocsForTest(new Map([["board", doc()]]));
    expect(setRuntimeFlag("board", "missing", "blocker", true)).toBe(false);
    expect(setRuntimeFlag("missing", "node", "blocker", true)).toBe(false);

    expect(setRuntimeFlag("board", "node", "parked", true)).toBe(true);
    __setDocsForTest(new Map([["board", { nodes: [], edges: [] }]]));
    expect(getRuntimeFlagOverrides("board")).toEqual({});
  });
});
