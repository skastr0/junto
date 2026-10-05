/**
 * A region with no name reads "unnamed region" wherever the operator sees
 * it, never its raw node id. Lines an agent or the overseer also reads keep
 * the id beside the placeholder, since a node is addressed by id.
 */
import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import { digestCanvas } from "../src/shared/digest";
import { TASKS_ENABLED } from "../src/shared/features";
import { formatWaitingOnLines } from "../src/shared/impact";
import { regionAddress, rulesInForce } from "../src/shared/rules";
import { executionContextForDoc } from "./helpers/actor-ref-fixtures";

const doc = {
  nodes: [
    {
      id: "g-unnamed",
      type: "group",
      label: "  ",
      x: 0,
      y: 0,
      width: 600,
      height: 400,
      ether: { region: { contract: { rules: [{ id: "r1", text: "Tests pass before review." }] } } },
    },
    { id: "g-named", type: "group", label: " Build ", x: 1000, y: 0, width: 300, height: 300 },
    {
      id: "board",
      type: "text",
      text: "tasks",
      x: 40,
      y: 40,
      width: 240,
      height: 120,
      ether: { entity: { kind: "task" }, host: "local", tasks: { items: [] } },
    },
    { id: "note", type: "text", text: "Note", x: 2000, y: 0, width: 100, height: 60 },
  ],
  edges: [{ id: "e1", fromNode: "note", toNode: "g-unnamed" }],
} as unknown as CanvasDoc;

describe("an unnamed region on the operator's screen", () => {
  it.runIf(TASKS_ENABLED)("task rules name it, and the agent's line keeps its id", () => {
    const [rule] = rulesInForce(doc, "board");
    expect(rule?.provenance).toMatchObject({ kind: "region", regionId: "g-unnamed", label: "unnamed region" });
  });

  it("an agent is told the id only when the region has no name", () => {
    expect(regionAddress({ regionId: "g-unnamed", label: "unnamed region" })).toBe("unnamed region (id g-unnamed)");
    expect(regionAddress({ regionId: "g-named", label: "Build" })).toBe("Build");
  });

  it("the Waiting on section names it", () => {
    const lines = formatWaitingOnLines(
      {
        nodeId: "note",
        seedNodeId: "g-named",
        hops: [
          { nodeId: "g-unnamed", role: "blocked", reasons: [] },
          { nodeId: "g-named", role: "apex", reasons: [] },
        ],
      },
      doc,
    );
    expect(lines).toEqual(["unnamed region", "Build"]);
  });

  it("the digest names it and keeps its id on the line for the overseer", () => {
    const text = digestCanvas("main", doc, { bundles: [] } as never, {
      resolveActorRef: executionContextForDoc(doc, "main").resolveActorRef,
    });
    expect(text).toContain("unnamed region (g-unnamed)");
    // Never the bare id standing in for a name.
    expect(text.split("\n").some((line) => /(^|\s)g-unnamed(\s|$)/.test(line.replace("unnamed region (g-unnamed)", "")))).toBe(false);
  });
});
