/**
 * Actor edges on focus — floating right-rail edge inventory on the agent terminal.
 *   bun run test:e2e:fast e2e/scenarios/actor-edges-focus.spec.ts
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  agentTextNode,
  canvasDoc,
  worksEdge,
  tasksNode,
  terminalTextNode,
} from "../harness/sandbox";
import { expect, launchVellum, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "design-audit");
const CANVAS = "actor-edges-focus";
const AGENT_LABEL = "edge focus worker";

const fixture = canvasDoc(
  [
    tasksNode({ id: "tasks", x: 40, y: 40 }),
    agentTextNode({
      id: "worker",
      key: "local:e2e-edge-worker",
      label: AGENT_LABEL,
      x: 360,
      y: 40,
    }),
    terminalTextNode({
      id: "shell",
      bindingId: "e2e-shell-edge-1",
      label: "shell neighbor",
      x: 360,
      y: 220,
    }),
  ],
  [
    worksEdge("e-tasks-worker", "tasks", "worker"),
    {
      id: "e-soft-shell",
      fromNode: "worker",
      toNode: "shell",
      fromSide: "bottom",
      toSide: "top",
    },
  ],
);

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

    // Rail lives outside the modal plate (FocusSurface aside), not over the TUI.
    const focus = page.locator('[data-focus-surface="1"]');
    await expect(focus).toHaveClass(/focus-surface--has-aside/);
    const glance = focus.locator(".focus-surface__aside").getByTestId("actor-edges-glance");
    await expect(glance).toBeVisible({ timeout: 10_000 });
    await expect(glance).toHaveAttribute("aria-label", "Connected edges");
    await expect(surface.getByTestId("actor-edges-glance")).toHaveCount(0);

    // Tasks work-lane (inbound) + shell peer (outbound) — no soft/tasks nature chips.
    const tasksRow = glance.locator('[data-peer-kind="task"]');
    await expect(tasksRow).toBeVisible();
    await expect(tasksRow).not.toHaveAttribute("data-edge-nature");
    await expect(tasksRow).toContainText(/tasks/i);

    const shellRow = glance.locator('[data-peer-kind="terminal"]');
    await expect(shellRow).toBeVisible();
    await expect(shellRow).not.toHaveAttribute("data-edge-nature");
    await expect(shellRow).toContainText(/shell/i);

    // Ports on tasks reach should surface (list/claim/update family).
    await expect(tasksRow.locator(".actor-edges-glance__ports")).toBeVisible();

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
