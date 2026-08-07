/**
 * Wire loom PoC — hub and spoke rendered evidence.
 *
 * Seeds one hub node fanning out to six agent-like nodes, all six of which
 * also connect to two shared sink nodes (task queues), plus one blocks-phase
 * edge (a claimed input-required item on sink1 stops one agent's wire into
 * it). Captures the rendered canvas — a real render over real topology, not
 * a synthetic mock. The loom is always on; there is no toggle.
 *
 * Paint/geometry only: this scenario authors no new edge semantics. The
 * blocks-phase edge reuses the exact `tasksNode` + claimed input-required
 * item pattern already proven in factory-board-attention.spec.ts.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { CanvasEdge, CanvasNode } from "../../src/shared/canvas";
import {
  agentTextNode,
  canvasDoc,
  claimByNodeId,
  taskItem,
  tasksNode,
} from "../harness/sandbox";
import { expect, launchVellum, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "_design_screenshots", "loom_poc");

const hub: CanvasNode = {
  id: "hub",
  type: "text",
  text: "hub",
  x: 690,
  y: 20,
  width: 240,
  height: 96,
};

const AGENT_COUNT = 6;
const agents: CanvasNode[] = Array.from({ length: AGENT_COUNT }, (_, i) =>
  agentTextNode({
    id: `agent${i}`,
    key: `local:agent${i}`,
    label: `Agent ${i}`,
    x: 40 + i * 260,
    y: 260,
  }),
);

// Blocked claimant — agent3's wire into sink1 derives phase "blocks" live
// from this claimed input-required item (execution-graph.ts evalTasksStoppage).
const BLOCKED_AGENT_ID = "agent3";

const sink1 = {
  ...tasksNode({
    id: "sink1",
    x: 270,
    y: 560,
    items: [
      taskItem("s1-open", "queue item", "submitted"),
      { ...taskItem("s1-hot", "needs human", "input-required"), claimedBy: claimByNodeId(BLOCKED_AGENT_ID) },
    ],
  }),
  width: 300,
  height: 160,
};

const sink2 = {
  ...tasksNode({
    id: "sink2",
    x: 1050,
    y: 560,
    items: [taskItem("s2-open", "queue item", "submitted")],
  }),
  width: 300,
  height: 160,
};

// Source fan of 6 at the hub's bottom handle.
const hubEdges: CanvasEdge[] = agents.map((agent) => ({
  id: `hub-${agent.id}`,
  fromNode: "hub",
  toNode: agent.id,
  fromSide: "bottom",
  toSide: "top",
}));

// Target fan of 6 at each sink's top handle (every agent connects to both).
const sinkEdges = (sinkId: string): CanvasEdge[] =>
  agents.map((agent) => ({
    id: `${agent.id}-${sinkId}`,
    fromNode: agent.id,
    toNode: sinkId,
    fromSide: "bottom",
    toSide: "top",
    ether: { stops: { mode: "tasks" as const } },
  }));

const edges: CanvasEdge[] = [...hubEdges, ...sinkEdges("sink1"), ...sinkEdges("sink2")];

test("wire loom PoC — hub and spoke rendered capture", async () => {
  await mkdir(SHOTS, { recursive: true });
  const vellumCommand = await launchVellum({
    seedCanvases: {
      "wire-loom-poc": canvasDoc([hub, ...agents, sink1, sink2], edges),
    },
  });

  try {
    const { page } = vellumCommand;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.react-flow__node[data-id="hub"]')).toBeVisible({ timeout: 30_000 });

    const fitAll = async () => {
      const fit = page.getByRole("button", { name: /fit all/i });
      if (await fit.isVisible().catch(() => false)) await fit.click();
      await page.waitForTimeout(900);
    };

    await fitAll();
    await page.screenshot({ path: join(SHOTS, "loom_on.png"), fullPage: false });
  } finally {
    await vellumCommand.close();
  }
});
