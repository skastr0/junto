import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearSelection,
  replaceSelection,
  selectEdge,
  selectNode,
  state$,
} from "../src/renderer/lib/state";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stateBoundary = join(root, "src", "renderer", "lib", "state.ts");

const sourceFiles = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return [".ts", ".tsx"].includes(extname(path)) ? [path] : [];
  });

describe("renderer selection boundary", () => {
  afterEach(() => clearSelection());

  it("keeps mirrored selection writes inside the state boundary", () => {
    const directWrite = /state\$\.selected(?:NodeId|NodeIds|EdgeId)\.set\(/u;
    const violations = sourceFiles(join(root, "src", "renderer"))
      .filter((path) => path !== stateBoundary)
      .filter((path) => directWrite.test(readFileSync(path, "utf8")))
      .map((path) => relative(root, path));

    expect(violations).toEqual([]);
  });

  it("publishes a coherent single-node replacement to Legend observers", () => {
    replaceSelection({ nodeIds: ["a", "b"] });
    const observed: Array<{ readonly nodeId: string; readonly nodeIds: ReadonlyArray<string> }> = [];
    const dispose = state$.selectedNodeId.onChange(() => {
      observed.push({
        nodeId: state$.selectedNodeId.peek(),
        nodeIds: state$.selectedNodeIds.peek(),
      });
    });

    selectNode("a");
    dispose();

    expect(observed).toEqual([{ nodeId: "a", nodeIds: ["a"] }]);
  });

  it("makes edge selection mutually exclusive with node selection", () => {
    replaceSelection({ nodeIds: ["a", "b"] });

    selectEdge("edge-a");

    expect(state$.selectedNodeId.peek()).toBe("");
    expect(state$.selectedNodeIds.peek()).toEqual([]);
    expect(state$.selectedEdgeId.peek()).toBe("edge-a");
  });
});
