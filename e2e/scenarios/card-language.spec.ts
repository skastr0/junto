/**
 * The card language: agent seats beside the other enabled cards (terminal,
 * git, note, label) inside a region, in dark and bright, for design review.
 * Frames land in test-results/card-language/.
 *   bun run test:e2e:fast e2e/scenarios/card-language.spec.ts
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { CanvasNode, GroupNode, TextNode } from "../../src/shared/canvas";
import { agentTextNode, canvasDoc, terminalTextNode, verbEdge } from "../harness/sandbox";
import { expect, launchJunto, test } from "../harness/launch";

const SHOTS = join(process.cwd(), "test-results", "card-language");

const region: GroupNode = {
  id: "region-build",
  type: "group",
  label: "build lane",
  x: 0,
  y: 0,
  width: 900,
  height: 380,
};

const planner = agentTextNode({ id: "planner", key: "local:e2e-card-planner", label: "planner", harness: "claude", x: 40, y: 60 });
const builder = agentTextNode({ id: "builder", key: "local:e2e-card-builder", label: "builder", harness: "codex", x: 40, y: 200 });

const terminal = terminalTextNode({
  id: "dev-server",
  bindingId: "local:e2e-card-dev",
  label: "dev server",
  launch: { kind: "command", argv: ["npm", "run", "dev"] },
  x: 340,
  y: 60,
});

// Stored sizes as the old factories wrote them: existing canvases must load.
const git: TextNode = {
  id: "repo",
  type: "text",
  text: "junto",
  x: 340,
  y: 200,
  width: 280,
  height: 128,
  ether: { entity: { kind: "git" }, git: { cwd: process.cwd() } },
};

const note: TextNode = {
  id: "note",
  type: "text",
  text: "# Release notes\nShip the seat rings first, then the card pass.\n- rings move\n- crest for overseers",
  x: 1000,
  y: 60,
  width: 240,
  height: 100,
};

const label: TextNode = {
  id: "label",
  type: "text",
  text: "Staging",
  x: 1000,
  y: 260,
  width: 160,
  height: 40,
  ether: { entity: { kind: "label" } },
};

const nodes: CanvasNode[] = [region, planner, builder, terminal, git, note, label];
const fixture = canvasDoc(nodes, [verbEdge("e-planner-builder", "planner", "builder", "messages", nodes)]);

const seatEvents = (at: number) =>
  [
    ["planner", "working", 0],
    ["builder", "working", 0],
    ["builder", "idle", 1],
  ].map(([id, state, offset]) => ({
    bindingId: `local:e2e-card-${String(id)}`,
    epoch: "e2e",
    state,
    reason: state === "idle" ? "rule:empty_prompt_idle" : "rule:osc_title_working",
    confidence: "high",
    at: at + Number(offset),
  }));

test("cards speak the seat's language beside the seats, in both themes", async () => {
  await mkdir(SHOTS, { recursive: true });
  const junto = await launchJunto({ seedCanvases: { "card-language": fixture } });
  try {
    const { page } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: /fit all/i }).first().click();
    await expect(page.locator('.react-flow__node[data-id="planner"]')).toBeVisible({ timeout: 30_000 });
    await junto.app.evaluate(({ BrowserWindow }, events) => {
      for (const window of BrowserWindow.getAllWindows()) {
        for (const event of events) window.webContents.send("junto:agent-seat-state-changed", event);
      }
    }, seatEvents(Date.now()));
    for (const mode of ["dark", "bright"] as const) {
      await page.getByRole("button", { name: "Open settings" }).click();
      await page.locator(".settings-nav__item", { hasText: "Appearance" }).click();
      const choice = page
        .getByRole("radiogroup", { name: "Theme", exact: true })
        .getByRole("radio", { name: mode === "bright" ? "Bright" : "Dark", exact: true });
      await choice.click();
      await expect(choice).toHaveAttribute("aria-checked", "true");
      await page.locator(".settings-panel__close").click();
      await page.locator(".react-flow__pane").click({ position: { x: 20, y: 20 } });
      await page.getByRole("button", { name: /fit all/i }).first().click();
      await page.mouse.move(5, 5);
      await page.waitForTimeout(800);
      await page.locator(".react-flow").screenshot({ path: join(SHOTS, `${mode}-canvas.png`) });
      for (const id of ["dev-server", "repo", "note", "label", "planner"]) {
        const node = page.locator(`.react-flow__node[data-id="${id}"]`);
        await expect(node).toBeVisible();
        await node.screenshot({ path: join(SHOTS, `${mode}-${id}.png`) });
      }
      // Hover and selection bring up the surface.
      const repo = page.locator('.react-flow__node[data-id="repo"]');
      await repo.click();
      await page.waitForTimeout(300);
      await repo.screenshot({ path: join(SHOTS, `${mode}-repo-selected.png`) });
      await page.locator(".react-flow__pane").click({ position: { x: 20, y: 20 } });
    }
  } finally {
    await junto.close();
  }
});
