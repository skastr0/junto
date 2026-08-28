/**
 * Actor edges on focus — floating right-rail edge inventory on the agent terminal.
 *   bun run test:e2e:fast e2e/scenarios/actor-edges-focus.spec.ts
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  agentTextNode,
  canvasDoc,
  requestsNode,
  verbEdge,
  tasksNode,
} from "../harness/sandbox";
import { expect, launchVellum, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "design-audit");
const CANVAS = "actor-edges-focus";
const AGENT_LABEL = "edge focus worker";

// Two legal wires, one each way: the seat takes work from the queue, and it
// escalates into the requests sink. A terminal peer is not an option here —
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
  requestsNode({ id: "asks", x: 360, y: 220 }),
];

const fixture = canvasDoc(fixtureNodes, [
  verbEdge("e-tasks-worker", "tasks", "worker", "works", fixtureNodes),
  verbEdge("e-worker-asks", "worker", "asks", "escalates", fixtureNodes, {
    fromSide: "bottom",
    toSide: "top",
  }),
]);

test("actor terminal focus shows read-only edge inventory", async () => {
  await mkdir(SHOTS, { recursive: true });
  const vellumCommand = await launchVellum({
    seedCanvases: { [CANVAS]: fixture },
  });

  try {
    const { page } = vellumCommand;
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

    // Tasks work-lane (inbound) + requests sink (outbound). No authored edge
    // nature exists any more — stoppage is derived, so the only phase an
    // idle wire may carry is "relates", never "blocks".
    const tasksRow = glance.locator('[data-peer-kind="task"]');
    await expect(tasksRow).toBeVisible();
    await expect(tasksRow).not.toHaveAttribute("data-live-phase", "blocks");
    await expect(tasksRow).toContainText(/tasks/i);

    const asksRow = glance.locator('[data-peer-kind="requests"]');
    await expect(asksRow).toBeVisible();
    await expect(asksRow).not.toHaveAttribute("data-live-phase", "blocks");
    await expect(asksRow).toContainText(/pending/i);

    // Ports on both reaches should surface (tasks list/claim/update family,
    // requests escalate family).
    await expect(tasksRow.locator(".actor-edges-glance__ports")).toBeVisible();
    await expect(asksRow.locator(".actor-edges-glance__ports")).toBeVisible();

    await focus.screenshot({
      path: join(SHOTS, "actor-edges-focus.png"),
    });
    await page.screenshot({
      path: join(SHOTS, "actor-edges-focus-board.png"),
      fullPage: false,
    });
  } finally {
    await vellumCommand.close();
  }
});
