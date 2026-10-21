/**
 * Focus modals on darwin: every header control is out of the window drag
 * region and clicks without moving the window, the sidebar collapses and
 * expands in Tasks, Artifacts and Automations, and Maximize and Restore return
 * the panel to its size (961c1a053, 57e307ca2). The drag region is judged the
 * way Chromium builds it (the last box in document order with an app-region
 * wins) and checked against a control with the fix's rule removed.
 *   JUNTO_SHOTS_DIR=<dir> bun run test:e2e:fast e2e/scenarios/focus-modal-controls.spec.ts
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { Schema } from "effect";
import { asNodeId, Node } from "../../src/shared/model";
import { mintItemId, mintOpId } from "../../src/shared/resource-command";
import { taskNodeId } from "../../src/shared/task-model";
import { crewOccupySeat, crewPlayFactory, crewSeat, installCrewSeatHarness } from "../harness/crew-fixture";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelSeat } from "../harness/model";

const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/focus-modal-controls";
const CANVAS = "verify-focus";

const shot = async (page: Page, name: string): Promise<void> => {
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

const node = (input: unknown) => Schema.decodeUnknownSync(Node, { onExcessProperty: "error" })(input);

/**
 * Chromium builds the window's drag region from every box with an app-region,
 * in document order, later boxes winning and ignoring z-index. The effective
 * region at a point is therefore the last containing element that sets one.
 */
const regionAt = (page: Page, x: number, y: number): Promise<string> =>
  page.evaluate(
    ([px, py]) => {
      let region = "none";
      for (const el of document.querySelectorAll("*")) {
        const value = (getComputedStyle(el) as CSSStyleDeclaration & { webkitAppRegion?: string }).webkitAppRegion ?? "none";
        if (value !== "drag" && value !== "no-drag") continue;
        const r = el.getBoundingClientRect();
        if (px! >= r.left && px! <= r.right && py! >= r.top && py! <= r.bottom) region = value;
      }
      return region;
    },
    [x, y] as const,
  );

const windowPosition = (app: import("playwright-core").ElectronApplication): Promise<number[]> =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getPosition());

const topEdge = async (loc: import("@playwright/test").Locator): Promise<[number, number]> => {
  const box = (await loc.boundingBox())!;
  return [box.x + box.width / 2, box.y + 2];
};

const centre = async (loc: import("@playwright/test").Locator): Promise<[number, number]> => {
  const box = (await loc.boundingBox())!;
  return [box.x + box.width / 2, box.y + box.height / 2];
};

test("961c1a053: every focus modal control clicks, sidebars collapse, Maximize and Restore", async () => {
  test.setTimeout(420_000);
  const ids = ["one", "two"];
  const seats = ids.map((id, i) => modelSeat({ id, x: 40 + i * 320, y: 40 }));
  const tasks = node({ kind: "task", id: "board", name: "Ship", x: 40, y: 300, width: 320, height: 220, z: 0 });
  const shelf = node({ kind: "artifacts", id: "shelf", label: "Shelf", x: 440, y: 300, width: 280, height: 160, z: 0 });
  const autos = node({ kind: "automations", id: "autos", label: "Autos", x: 760, y: 300, width: 280, height: 160, z: 0 });
  const junto = await launchJunto({ windowContentSize: { width: 1700, height: 900 }, seedModels: { [CANVAS]: modelFixture([...seats, tasks, shelf, autos]) }, afterSeed: installCrewSeatHarness });
  try {
    const { app, page, sandbox } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    expect(await page.evaluate(() => document.documentElement.dataset.juntoPlatform)).toBe("darwin");
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
    await crewPlayFactory(page);
    const crew = ids.map((id) => crewSeat(sandbox, CANVAS, id));
    for (const [i, n] of seats.entries()) await crewOccupySeat(page, CANVAS, n, crew[i]!);

    const taskId = mintItemId();
    await page.evaluate(
      ({ canvas, nodeId, taskId, opId }) => window.junto!.resource!.task!.apply(canvas, nodeId, taskId, opId, { kind: "create", taskId, title: "Ship the wire spec" }),
      { canvas: CANVAS, nodeId: taskNodeId(asNodeId("board")), taskId, opId: mintOpId() },
    );

    const panel = page.locator(".focus-surface__panel").last();
    const report: string[] = [];

    /** Every button in the open modal's header, at its centre: not a drag region, and a click does not move the window. */
    const headerClicks = async (surface: string, skip: RegExp): Promise<void> => {
      const buttons = panel.locator("header button, header [role='radio']");
      const count = await buttons.count();
      expect(count, `${surface}: header has controls`).toBeGreaterThan(0);
      for (let i = 0; i < count; i += 1) {
        const b = buttons.nth(i);
        if (!(await b.isVisible())) continue;
        const name = (await b.getAttribute("aria-label")) ?? (await b.innerText()) ?? `#${i}`;
        const [x, y] = await centre(b);
        const region = await regionAt(page, x, y);
        report.push(`${surface} | ${name} | y=${Math.round(y)} | region=${region}`);
        const [tx, ty] = await topEdge(b);
        const topRegion = await regionAt(page, tx, ty);
        report.push(`${surface} | ${name} | top edge y=${Math.round(ty)} | region=${topRegion}`);
        expect(region, `${surface}: "${name}" must not sit in a window drag region`).not.toBe("drag");
        expect(topRegion, `${surface}: top edge of "${name}" must not sit in a window drag region`).not.toBe("drag");
        if (skip.test(name)) continue;
        const before = await windowPosition(app);
        await b.click();
        await page.waitForTimeout(150);
        expect(await windowPosition(app), `${surface}: clicking "${name}" does not move the window`).toEqual(before);
        await page.keyboard.press("Escape").catch(() => undefined);
      }
    };

    /** Collapse then expand the sidebar; Maximize then Restore the panel. */
    const sidebarAndMaximize = async (surface: string, hasSidebar: boolean): Promise<void> => {
      await page.waitForTimeout(800); // the enter animation scales the panel; measure it at rest
      if (hasSidebar) {
        const aside = panel.getByRole("complementary").first();
        const toggle = panel.locator("[data-sidebar-toggle]").first();
        await expect(toggle, `${surface}: sidebar toggle offered, expanded`).toHaveAttribute("aria-expanded", "true");
        const wide = (await aside.boundingBox())?.width ?? 0;
        await toggle.click();
        const strip = panel.locator("[data-sidebar-toggle]").filter({ visible: true }).first();
        await expect(strip, `${surface}: strip toggle says collapsed`).toHaveAttribute("aria-expanded", "false");
        await shot(page, `${surface}-sidebar-collapsed`);
        const narrow = (await aside.boundingBox())?.width ?? 0;
        report.push(`${surface} | sidebar width ${Math.round(wide)} -> ${Math.round(narrow)}`);
        expect(narrow, `${surface}: sidebar collapsed to a strip`).toBeLessThan(wide / 2);
        const [sx, sy] = await centre(strip);
        expect(await regionAt(page, sx, sy), `${surface}: strip toggle is not a drag region`).not.toBe("drag");
        await strip.click();
        await expect(panel.locator("[data-sidebar-toggle]").filter({ visible: true }).first()).toHaveAttribute("aria-expanded", "true");
        await expect
          .poll(async () => Math.abs(((await aside.boundingBox())?.width ?? 0) - wide), { message: `${surface}: sidebar returns to its width`, timeout: 5000 })
          .toBeLessThanOrEqual(1);
        const back = (await aside.boundingBox())?.width ?? 0;
        report.push(`${surface} | sidebar expanded back to ${Math.round(back)}`);
      }
      const before = (await panel.boundingBox())!;
      const root = page.locator(".focus-surface").last();
      const frame = (await root.boundingBox())!;
      const maximize = panel.getByRole("button", { name: "Maximize" }).first();
      await expect(maximize, `${surface}: Maximize offered`).toBeVisible();
      const [mx, my] = await centre(maximize);
      expect(await regionAt(page, mx, my), `${surface}: Maximize is not a drag region`).not.toBe("drag");
      const pos = await windowPosition(app);
      await maximize.click();
      await expect(root).toHaveAttribute("data-maximized", "true");
      await page.waitForTimeout(250);
      const big = (await panel.boundingBox())!;
      const pad = await root.evaluate((el) => {
        const cs = getComputedStyle(el);
        return parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      });
      await shot(page, `${surface}-maximized`);
      report.push(`${surface} | panel ${Math.round(before.width)}x${Math.round(before.height)} -> maximized ${Math.round(big.width)}x${Math.round(big.height)}; frame ${Math.round(frame.width)} pad ${pad}`);
      if (before.width < frame.width - pad - 2) expect(big.width, `${surface}: maximized is wider`).toBeGreaterThan(before.width + 1);
      else report.push(`${surface} | panel was already at frame width less padding`);
      expect(big.width, `${surface}: fills the frame less its padding`).toBeGreaterThanOrEqual(frame.width - pad - 2);
      expect(big.width).toBeLessThanOrEqual(frame.width);
      expect(await windowPosition(app)).toEqual(pos);
      const restore = panel.getByRole("button", { name: "Maximize" }).first();
      await expect(restore, `${surface}: toggle reads pressed while maximized`).toHaveAttribute("aria-pressed", "true");
      await expect(restore).toHaveAttribute("data-junto-tooltip", "Restore size");
      await restore.click();
      await expect(root).not.toHaveAttribute("data-maximized", "true");
      await page.waitForTimeout(250);
      const after = (await panel.boundingBox())!;
      report.push(`${surface} | restored ${Math.round(after.width)}x${Math.round(after.height)}`);
      expect(Math.abs(after.width - before.width), `${surface}: Restore returns the old width`).toBeLessThanOrEqual(1.5);
      expect(Math.abs(after.height - before.height), `${surface}: Restore returns the old height`).toBeLessThanOrEqual(1.5);
    };

    // Tasks
    await page.locator('.react-flow__node[data-id="board"]').dblclick();
    await expect(page.getByRole("list", { name: "Tasks" })).toBeVisible({ timeout: 20_000 });
    await shot(page, "tasks-open");
    {
      const filter = page.getByRole("radiogroup", { name: "Show" });
      const pos = await windowPosition(app);
      for (const name of ["Open", "Backlog", "Closed", "All"]) {
        const radio = filter.getByRole("radio", { name });
        const [fx, fy] = await centre(radio);
        expect(await regionAt(page, fx, fy), `tasks filter "${name}" not a drag region`).not.toBe("drag");
        await radio.click();
        await expect(radio).toBeChecked();
      }
      expect(await windowPosition(app)).toEqual(pos);
      report.push("tasks | filter All/Open/Backlog/Closed radios each clicked and checked, window did not move");
    }
    await headerClicks("tasks", /^Sidebar$|^Maximize$|^Board settings$/);
    // Header clicks may have closed or opened things; reopen cleanly.
    if (!(await page.getByRole("list", { name: "Tasks" }).isVisible())) {
      await page.locator('.react-flow__node[data-id="board"]').dblclick();
      await expect(page.getByRole("list", { name: "Tasks" })).toBeVisible();
    }
    await sidebarAndMaximize("tasks", true);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("list", { name: "Tasks" })).toHaveCount(0);

    // Artifacts
    await page.locator('.react-flow__node[data-id="shelf"]').dblclick();
    await expect(page.getByRole("list", { name: "Artifacts" })).toBeVisible({ timeout: 20_000 });
    await shot(page, "artifacts-open");
    await headerClicks("artifacts", /^Sidebar$|^Maximize$/);
    if (!(await page.getByRole("list", { name: "Artifacts" }).isVisible())) {
      await page.locator('.react-flow__node[data-id="shelf"]').dblclick();
      await expect(page.getByRole("list", { name: "Artifacts" })).toBeVisible();
    }
    await sidebarAndMaximize("artifacts", true);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("list", { name: "Artifacts" })).toHaveCount(0);

    // Automations
    await page.locator('.react-flow__node[data-id="autos"]').dblclick();
    await expect(page.locator(".focus-surface__panel").last().locator("[data-sidebar-toggle]").first()).toBeVisible({ timeout: 20_000 });
    await shot(page, "automations-open");
    await sidebarAndMaximize("automations", true);
    await page.keyboard.press("Escape");
    await expect(page.locator(".focus-surface")).toHaveCount(0);

    // Terminal grid
    await page.locator(".react-flow__pane").click({ position: { x: 20, y: 600 } });
    for (const id of ids) await page.locator(`.react-flow__node[data-id="${id}"]`).click({ modifiers: ["Shift"] });
    await page.locator('.react-flow__node[data-id="two"]').click({ button: "right" });
    await page.getByRole("button", { name: "Open 2 agents in a grid" }).click();
    const grid = page.getByTestId("terminal-grid-focus");
    await expect(grid.locator(".terminal-grid__cell")).toHaveCount(2, { timeout: 15_000 });
    await shot(page, "grid-open");
    // Layout picker and Close grid: click the picker, then Close for real.
    const picker = panel.getByLabel("Grid shape");
    const [px, py] = await centre(picker);
    report.push(`grid | Grid shape | y=${Math.round(py)} | region=${await regionAt(page, px, py)}`);
    expect(await regionAt(page, px, py)).not.toBe("drag");
    const pos = await windowPosition(app);
    await picker.click();
    await page.waitForTimeout(200);
    await shot(page, "grid-shape-picker-open");
    expect(await windowPosition(app)).toEqual(pos);
    await page.keyboard.press("Escape");
    await sidebarAndMaximize("grid", false);
    const close = panel.getByRole("button", { name: "Close grid" });
    const [cx, cy] = await centre(close);
    report.push(`grid | Close grid | y=${Math.round(cy)} | region=${await regionAt(page, cx, cy)}`);
    expect(await regionAt(page, cx, cy)).not.toBe("drag");
    await close.click();
    await expect(grid).toHaveCount(0);
    expect(await windowPosition(app)).toEqual(pos);
    report.push("grid | Close grid closed the grid, window did not move");

    // Negative control: without the fix's rule the same header reads as a drag region.
    await page.locator('.react-flow__node[data-id="board"]').dblclick();
    await expect(page.getByRole("list", { name: "Tasks" })).toBeVisible();
    await page.waitForTimeout(800);
    // Scan the panel's top 10px, left to right: which points read drag with the fix's rule, and without it.
    const scan = async (): Promise<{ drag: number; noDrag: number; total: number; y: number }> => {
      const box = (await panel.boundingBox())!;
      const y = box.y + 10;
      let drag = 0;
      let noDrag = 0;
      let total = 0;
      for (let x = box.x + 6; x < box.x + box.width - 6; x += 8) {
        total += 1;
        const region = await regionAt(page, x, y);
        if (region === "drag") drag += 1;
        if (region === "no-drag") noDrag += 1;
      }
      return { drag, noDrag, total, y: Math.round(y) };
    };
    const withRule = await scan();
    await page.addStyleTag({ content: `html[data-junto-platform="darwin"] .focus-surface__panel, html[data-junto-platform="darwin"] .focus-surface__aside { -webkit-app-region: initial !important; }` });
    const withoutRule = await scan();
    report.push(`control | panel top row y=${withRule.y}: with the rule drag=${withRule.drag} no-drag=${withRule.noDrag} of ${withRule.total}; without it drag=${withoutRule.drag} no-drag=${withoutRule.noDrag}`);
    console.log("REPORT\n" + report.join("\n"));
    expect(withRule.drag, "with the rule no point of the panel top is a drag region").toBe(0);
    expect(withoutRule.drag, "negative control: without the rule the bar's drag region reaches the panel").toBeGreaterThan(0);
  } finally {
    await junto.close();
  }
});
