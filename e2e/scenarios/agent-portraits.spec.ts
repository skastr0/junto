/**
 * Agent portraits — captures seeded agent seats on the canvas and the agent
 * focus modal (header portrait + connection cards) in dark and bright, for
 * art review. Frames land in test-results/agent-portraits/.
 *   bun run test:e2e:fast e2e/scenarios/agent-portraits.spec.ts
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessId } from "../../src/shared/managed-terminal-templates";
import { agentTextNode, canvasDoc, verbEdge } from "../harness/sandbox";
import { expect, launchJunto, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "agent-portraits");

const seats: ReadonlyArray<readonly [id: string, label: string, harness: HarnessId]> = [
  ["planner", "planner", "claude"],
  ["builder", "builder", "codex"],
  ["reviewer", "reviewer", "claude"],
  ["scout", "scout", "grok"],
  ["docs", "docs writer", "pi"],
  ["tester", "tester", "amp"],
  ["fixer", "fixer", "cursor"],
  ["ops", "ops", "hermes"],
];

const nodes = seats.map(([id, label, harness], index) =>
  agentTextNode({
    id,
    key: `local:e2e-portrait-${id}`,
    label,
    harness,
    x: 40 + (index % 4) * 290,
    y: 40 + Math.floor(index / 4) * 160,
  }),
);

const fixture = canvasDoc(nodes, [
  verbEdge("e-planner-builder", "planner", "builder", "messages", nodes),
  verbEdge("e-reviewer-planner", "reviewer", "planner", "reviews", nodes),
  verbEdge("e-planner-scout", "planner", "scout", "messages", nodes),
]);

test("agent portraits render on seats and in the focus modal", async () => {
  await mkdir(SHOTS, { recursive: true });
  const junto = await launchJunto({ seedCanvases: { "agent-portraits": fixture } });
  try {
    const { page } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    for (const mode of ["dark", "bright"] as const) {
      // Pick each mode through the real settings path; the default follows
      // the OS, so neither mode can be assumed.
      await page.getByRole("button", { name: "Open settings" }).click();
      await page.locator(".settings-nav__item", { hasText: "Appearance" }).click();
      const choice = page
        .getByRole("radiogroup", { name: "Theme", exact: true })
        .getByRole("radio", { name: mode === "bright" ? "Bright" : "Dark", exact: true });
      await choice.click();
      await expect(choice).toHaveAttribute("aria-checked", "true");
      await page.locator(".settings-panel__close").click();
      await page.waitForTimeout(400);
      const planner = page.locator('.react-flow__node[data-id="planner"]');
      await expect(planner).toBeVisible({ timeout: 30_000 });
      await expect(planner.locator(".agent-portrait img")).toBeVisible();
      await expect(planner.locator(".agent-portrait__badge")).toBeVisible();
      await page.waitForTimeout(600);
      await page.locator(".react-flow").screenshot({ path: join(SHOTS, `${mode}-canvas.png`) });
      await planner.screenshot({ path: join(SHOTS, `${mode}-node.png`) });

      await planner.dblclick();
      const focus = page.locator('[data-focus-surface="1"]');
      await expect(focus).toBeVisible({ timeout: 20_000 });
      await expect(focus.locator("header .agent-portrait").first()).toBeVisible();
      const glance = focus.getByTestId("actor-edges-glance");
      await expect(glance.locator(".agent-portrait").first()).toBeVisible({ timeout: 10_000 });
      await page.waitForTimeout(600);
      await focus.screenshot({ path: join(SHOTS, `${mode}-focus.png`) });
      await glance.screenshot({ path: join(SHOTS, `${mode}-connections.png`) });
      await focus.locator("header").getByRole("button", { name: "Close view", exact: true }).first().click();
      await expect(focus).toBeHidden({ timeout: 10_000 });
    }
  } finally {
    await junto.close();
  }
});
