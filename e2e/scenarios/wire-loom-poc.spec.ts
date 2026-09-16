/**
 * Wire loom PoC — hub and spoke rendered evidence.
 *
 * Seeds one hub seat fanning out to six agent seats, all six of which also
 * connect to two shared sink nodes (task queues), plus one blocks-phase
 * edge (a claimed input-required item on sink1 stops one agent's wire into
 * it). Captures the rendered canvas — a real render over real topology, not
 * a synthetic mock. The loom is always on; there is no toggle.
 *
 * Every wire carries the verb its ordered pair admits: the hub fan is
 * agent → agent `messages`, the sink fans are task → agent `works`. A plain
 * geography hub would hold no verb, and all six spokes would be dropped at
 * decode — the loom would have nothing to draw.
 *
 * Paint/geometry only: this scenario authors no new edge semantics. The
 * blocks-phase edge reuses the exact `tasksNode` + claimed input-required
 * item pattern already proven in factory-board-attention.spec.ts.
 */
import type { CanvasEdge, CanvasNode } from "../../src/shared/canvas";
import {
  agentTextNode,
  canvasDoc,
  claimByNodeId,
  taskItem,
  tasksNode,
  verbEdge,
} from "../harness/sandbox";
import { expect, launchJunto, test } from "../harness/launch";

const hub: CanvasNode = agentTextNode({
  id: "hub",
  key: "local:hub",
  label: "hub",
  x: 690,
  y: 20,
});

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

const loomNodes: CanvasNode[] = [hub, ...agents, sink1, sink2];

// Source fan of 6 at the hub's bottom handle.
const hubEdges: CanvasEdge[] = agents.map((agent) =>
  verbEdge(`hub-${agent.id}`, "hub", agent.id, "messages", loomNodes, {
    fromSide: "bottom",
    toSide: "top",
  }),
);

// Target fan of 6 at each sink's top handle (every agent connects to both).
// `works` is the task → agent verb, so the sink is the wire's source; the
// handles keep the same corridor the shot was composed around.
const sinkEdges = (sinkId: string): CanvasEdge[] =>
  agents.map((agent) =>
    verbEdge(`${agent.id}-${sinkId}`, sinkId, agent.id, "works", loomNodes, {
      fromSide: "top",
      toSide: "bottom",
    }),
  );

const edges: CanvasEdge[] = [...hubEdges, ...sinkEdges("sink1"), ...sinkEdges("sink2")];

test("wire loom PoC — hub and spoke rendered capture", async ({}, testInfo) => {
  const junto = await launchJunto({
    seedCanvases: {
      "wire-loom-poc": canvasDoc(loomNodes, edges),
    },
  });

  try {
    const { page } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.react-flow__node[data-id="hub"]')).toBeVisible({ timeout: 30_000 });

    const fitAll = async () => {
      const fit = page.getByRole("button", { name: /fit all/i });
      if (await fit.isVisible().catch(() => false)) await fit.click();
      await page.waitForTimeout(900);
    };

    await fitAll();
    await page.screenshot({
      path: testInfo.outputPath("loom_on.png"),
      fullPage: false,
    });
  } finally {
    await junto.close();
  }
});
