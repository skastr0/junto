/**
 * Actor edges on focus — floating right-rail edge inventory on the agent terminal.
 *   bun run test:e2e:fast e2e/scenarios/actor-edges-focus.spec.ts
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  agentTextNode,
  artifactsNode,
  canvasDoc,
  verbEdge,
  tasksNode,
} from "../harness/sandbox";
import { expect, launchJunto, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "design-audit");
const CANVAS = "actor-edges-focus";
const AGENT_LABEL = "edge focus worker";

// Two legal wires, one each way: the queue works the seat, and the seat
// publishes into the artifacts sink. A terminal peer is not an option here —
// terminal admits no verb, so that wire never reaches the rail.
const fixtureNodes = [
  tasksNode({ id: "tasks", x: 40, y: 40 }),
  agentTextNode({
    id: "worker",
    key: "local:e2e-edge-worker",
    label: AGENT_LABEL,
    x: 360,
    y: 40,
  }),
  artifactsNode({ id: "shelf", x: 360, y: 220 }),
];

const fixture = canvasDoc(fixtureNodes, [
  verbEdge("e-tasks-worker", "tasks", "worker", "works", fixtureNodes),
  verbEdge("e-worker-shelf", "worker", "shelf", "publishes", fixtureNodes, {
    fromSide: "bottom",
    toSide: "top",
  }),
]);

test("actor terminal focus shows read-only edge inventory", async () => {
  await mkdir(SHOTS, { recursive: true });
  const junto = await launchJunto({
    seedCanvases: { [CANVAS]: fixture },
  });

  try {
    const { page } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });

    const agentNode = page.locator('.react-flow__node[data-id="worker"]');
    await expect(agentNode).toBeVisible({ timeout: 30_000 });
    await agentNode.dblclick();

    const surface = page.locator(".native-terminal-surface");
    await expect(surface).toBeVisible({ timeout: 20_000 });

    // Rail is the agent context pane on the right of the xterm stage, inside
    // the same modal plate (not a FocusSurface aside).
    const focus = page.locator('[data-focus-surface="1"]');
    await expect(focus).toBeVisible();
    const contextPane = surface.getByTestId("actor-terminal-right-pane");
    await expect(contextPane).toBeVisible({ timeout: 10_000 });
    const glance = contextPane.getByTestId("actor-edges-glance");
    await expect(glance).toBeVisible({ timeout: 10_000 });
    await expect(glance).toHaveAttribute("aria-label", "Connections");

    // Tasks work-lane (inbound) + artifacts sink (outbound). No authored edge
    // nature exists any more — stoppage is derived, so the only phase an
    // idle wire may carry is "relates", never "blocks".
    const tasksRow = glance.locator('[data-peer-kind="task"]');
    await expect(tasksRow).toBeVisible();
    await expect(tasksRow).not.toHaveAttribute("data-live-phase", "blocks");
    await expect(tasksRow).toContainText(/tasks/i);

    const shelfRow = glance.locator('[data-peer-kind="artifacts"]');
    await expect(shelfRow).toBeVisible();
    await expect(shelfRow).not.toHaveAttribute("data-live-phase", "blocks");
    await expect(shelfRow).toContainText(/artifacts/i);

    // Connection cards name the peer only: no capability line.
    await expect(tasksRow).not.toContainText(/\b(?:list|claim|publish)\b/i);

    await focus.screenshot({
      path: join(SHOTS, "actor-edges-focus.png"),
    });
    await page.screenshot({
      path: join(SHOTS, "actor-edges-focus-board.png"),
      fullPage: false,
    });
  } finally {
    await junto.close();
  }
});
