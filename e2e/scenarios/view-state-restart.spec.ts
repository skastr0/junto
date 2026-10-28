/**
 * Real app, plan 0.11 04, V3: what the operator arranges in a node comes back
 * after Junto quits fully and relaunches on the same rows.
 *
 * Arranged: the Artifacts node's Document type filter, its open artifact, its
 * sidebar collapsed and the comments rail open; the Tasks node's Backlog state
 * filter and its open task. Then the app quits, relaunches on the same
 * sandbox, and every one of them is back. Frames before and after.
 *   JUNTO_SHOTS_DIR=<dir> scripts/with-app-run-lock.sh bun run test:e2e:fast e2e/scenarios/view-state-restart.spec.ts
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright-core";
import { Schema } from "effect";
import { asNodeId, Node } from "../../src/shared/model";
import { mintItemId, mintOpId } from "../../src/shared/resource-command";
import { taskNodeId } from "../../src/shared/task-model";
import { expect, launchJunto, test, type JuntoHandle } from "../harness/launch";
import { modelFixture } from "../harness/model";

const CANVAS = "view-state-restart";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/view-state-restart";
const node = (raw: unknown) => Schema.decodeUnknownSync(Node, { onExcessProperty: "error" })(raw);
const shelf = node({ kind: "artifacts", id: "shelf", label: "Shelf", x: 40, y: 60, width: 280, height: 160, z: 0 });
const board = node({ kind: "task", id: "board", name: "Ship", x: 400, y: 60, width: 320, height: 220, z: 0 });

const shoot = async (page: Page, name: string): Promise<void> => {
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

/** The modal by its dialog: a collapsed sidebar hides the list, not the modal. */
const closeModal = async (page: Page, name: string): Promise<void> => {
  const dialog = page.locator(`[role="dialog"][aria-label="${name}"]`);
  for (let i = 0; i < 4 && (await dialog.count()) > 0; i += 1) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
  }
  await expect(dialog).toHaveCount(0, { timeout: 10_000 });
};

/** Quit the app fully and start a second one on the same home (as artifact-links-verify.spec.ts does). */
const quitAndRelaunch = async (junto: JuntoHandle): Promise<ElectronApplication> => {
  const env = await junto.app.evaluate(() => {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (typeof value === "string") out[key] = value;
    return out;
  });
  const child = junto.app.process();
  const gone = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  });
  await junto.app.close();
  await gone;
  const app = await electron.launch({
    executablePath: createRequire(import.meta.url)("electron") as string,
    args: [process.cwd(), `--user-data-dir=${junto.sandbox.userDataDir}`, "--mute-audio"],
    env,
    timeout: 60_000,
  });
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox;
  });
  return app;
};

test("view state: an arranged Artifacts and Tasks node come back after a full quit and relaunch", async () => {
  test.setTimeout(360_000);
  const first = await launchJunto({ windowContentSize: { width: 1500, height: 900 }, seedModels: { [CANVAS]: modelFixture([shelf, board], []) } });
  let second: ElectronApplication | undefined;
  try {
    {
      const { page } = first;
      await expect(page.locator('.react-flow__node[data-id="shelf"]')).toBeVisible({ timeout: 30_000 });
      await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
      for (const [title, type] of [["Roadmap", "document"], ["Launch plan", "document"]] as const) {
        const applied = (await page.evaluate(
          ({ canvas, node, artifactId, opId, title, type }) =>
            window.junto!.resource!.artifact!.apply(canvas, node, artifactId, opId, { op: "create", title, body: { type, markdown: `# ${title}` }, labels: [] }),
          { canvas: CANVAS, node: asNodeId("shelf"), artifactId: mintItemId(), opId: mintOpId(), title, type },
        )) as { kind: string };
        expect(applied.kind).toBe("applied");
      }
      const taskId = mintItemId();
      const made = await page.evaluate(
        ({ canvas, nodeId, taskId, opId }) => window.junto!.resource!.task!.apply(canvas, nodeId, taskId, opId, { kind: "create", taskId, title: "Ship the wire spec" }),
        { canvas: CANVAS, nodeId: taskNodeId(asNodeId("board")), taskId, opId: mintOpId() },
      );
      expect(made, JSON.stringify(made)).toMatchObject({ kind: "applied" });

      // Artifacts: Document type, Roadmap open, the comments rail open, the sidebar collapsed last.
      await page.locator('.react-flow__node[data-id="shelf"]').dblclick();
      await expect(page.getByRole("list", { name: "Artifacts" })).toBeVisible({ timeout: 20_000 });
      await page.locator(".artifacts-filter__type").filter({ hasText: /^Document$/u }).click();
      await page.getByRole("list", { name: "Artifacts" }).locator("button").filter({ hasText: "Roadmap" }).first().click();
      await expect(page.locator(".artifact-head__title")).toHaveValue("Roadmap", { timeout: 15_000 });
      await page.keyboard.press("Meta+Shift+M");
      await expect(page.locator(".two-pane").first()).not.toHaveAttribute("data-rail", "collapsed", { timeout: 10_000 });
      await page.locator("[data-sidebar-toggle]").first().click();
      await expect(page.locator(".two-pane").first()).toHaveAttribute("data-sidebar", "collapsed");
      await shoot(page, "1-artifacts-arranged");
      await closeModal(page, "Artifacts");

      // Tasks: the Backlog filter (a new task is backlog), the task open.
      await page.locator('.react-flow__node[data-id="board"]').dblclick({ position: { x: 24, y: 12 } });
      await expect(page.getByRole("list", { name: "Tasks" })).toBeVisible({ timeout: 20_000 });
      await page.getByRole("radiogroup", { name: "Show" }).getByRole("radio", { name: "Backlog" }).click();
      await page.getByRole("list", { name: "Tasks" }).getByText("Ship the wire spec").click();
      await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue("Ship the wire spec", { timeout: 10_000 });
      await shoot(page, "2-tasks-arranged");
      await closeModal(page, "Tasks");
    }

    // A full quit: the app process ends; the home and its rows stay.
    second = await quitAndRelaunch(first);
    {
      const page = await second.firstWindow();
      await (await second.browserWindow(page)).evaluate((main) => main.setContentSize(1500, 900));
      await expect(page.locator('.react-flow__node[data-id="shelf"]')).toBeVisible({ timeout: 30_000 });

      await page.locator('.react-flow__node[data-id="shelf"]').dblclick();
      const pane = page.locator(".two-pane").first();
      await expect(pane).toHaveAttribute("data-sidebar", "collapsed", { timeout: 20_000 });
      await expect(page.locator(".artifact-head__title")).toHaveValue("Roadmap", { timeout: 15_000 });
      await expect(pane).toHaveAttribute("data-rail", "true");
      await shoot(page, "3-artifacts-after-relaunch");
      await page.locator(".two-pane__strip [data-sidebar-toggle]").click();
      await expect(page.locator(".artifacts-filter__type").filter({ hasText: /^Document$/u })).toHaveAttribute("aria-checked", "true");
      await shoot(page, "4-artifacts-sidebar-reopened");
      await closeModal(page, "Artifacts");

      await page.locator('.react-flow__node[data-id="board"]').dblclick({ position: { x: 24, y: 12 } });
      await expect(page.getByRole("list", { name: "Tasks" })).toBeVisible({ timeout: 20_000 });
      await expect(page.getByRole("radiogroup", { name: "Show" }).getByRole("radio", { name: "Backlog" })).toHaveAttribute("aria-checked", "true");
      await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue("Ship the wire spec");
      await shoot(page, "5-tasks-after-relaunch");
    }
  } finally {
    if (second !== undefined) await second.close().catch(() => undefined);
    await first.close();
  }
});
