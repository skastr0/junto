/**
 * Real app, plan 0.11 04, the independent walk of the whole inventory, dark
 * and bright: arrange every row, quit Junto fully, relaunch on the same home,
 * and check each is back; then delete a node and see a new one with its id
 * start fresh.
 *
 * Rows: command groups 1 to 9 and one past nine; the Artifacts node's type,
 * picked labels, archived toggle, open artifact, sidebar collapsed and comments
 * rail; the Tasks node's state filter and open task; the Files node's open
 * file and expanded folders; the Automations node's open automation; the
 * image modal's resized size; the actor rail collapsed.
 *   JUNTO_SHOTS_DIR=<dir> bun run test:e2e:fast e2e/scenarios/view-state-verify.spec.ts
 */
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright-core";
import { Schema } from "effect";
import { contentObjectUrl } from "../../src/shared/content-url";
import { asNodeId, Node } from "../../src/shared/model";
import { mintItemId, mintOpId } from "../../src/shared/resource-command";
import { taskNodeId } from "../../src/shared/task-model";
import { expandInTree, filesNode, FILES_ID, openInTree, stageFiles, treeRow } from "../harness/files-scenario";
import { expect, launchJunto, test, type JuntoHandle } from "../harness/launch";
import { commandModel, modelFixture, modelNote, modelSeat, modelWire } from "../harness/model";

const CANVAS = "view-state-verify";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/view-state-verify";
const decode = (raw: unknown) => Schema.decodeUnknownSync(Node, { onExcessProperty: "error" })(raw);
const shelfRaw = { kind: "artifacts", id: "shelf", label: "Shelf", x: 40, y: 320, width: 280, height: 160, z: 0 };

const shoot = async (page: Page, name: string): Promise<void> => {
  for (const theme of ["dark", "bright"] as const) {
    mkdirSync(join(SHOTS, theme), { recursive: true });
    await page.evaluate((t) => window.junto!.settingsPatch({ appearance: { theme: t } }), theme);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, theme, `${name}.png`) });
  }
  await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
};

const closeModal = async (page: Page, name: string): Promise<void> => {
  const dialog = page.locator(`[role="dialog"][aria-label="${name}"]`);
  for (let i = 0; i < 4 && (await dialog.count()) > 0; i += 1) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
  }
  await expect(dialog).toHaveCount(0, { timeout: 10_000 });
};

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

const card = (page: Page, id: string): Locator => page.locator(`.react-flow__node[data-id="${id}"]`);
const bar = (page: Page): Locator => page.locator("header.station-bar").getByRole("toolbar", { name: "Command groups" });
const rail = (page: Page): Locator => page.getByTestId("actor-rail").first();
const typeRadio = (page: Page, name: string): Locator => page.locator(".artifacts-filter__type").filter({ hasText: new RegExp(`^${name}$`, "u") });
const labelToggle = (page: Page, label: string): Locator =>
  page.locator(".artifacts-filter__labels .artifacts-filter__label").filter({ has: page.locator(".artifacts-filter__label-word", { hasText: new RegExp(`^${label}$`, "u") }) });

type Result = { row: string; pass: boolean; detail?: string };

test("view state: every row of the inventory comes back after a full quit, and a deleted node's rows go", async () => {
  test.setTimeout(480_000);
  const stage = await stageFiles();
  const nodes = [
    modelSeat({ id: "lead", key: "local:vs-lead", label: "lead", x: 40, y: 40 }),
    modelSeat({ id: "ada", key: "local:vs-ada", label: "ada", x: 300, y: 40 }),
    ...Array.from({ length: 10 }, (_, i) => ({ ...modelNote(`n${i + 1}`, `note ${i + 1}`, 560 + (i % 5) * 200, i < 5 ? 40 : 180), width: 180, height: 80 })),
    decode(shelfRaw),
    decode({ kind: "task", id: "board", name: "Ship", x: 360, y: 320, width: 300, height: 200, z: 0 }),
    decode({ kind: "automations", id: "auto", label: "Automations", x: 700, y: 320, width: 260, height: 120, z: 0 }),
    { ...filesNode(stage.fixture.root), x: 1000, y: 320 },
  ];
  const first = await launchJunto({
    windowContentSize: { width: 1600, height: 960 },
    seedModels: { [CANVAS]: modelFixture(nodes, [modelWire("e-lead-ada", "lead", "ada", "messages", nodes)]) },
  });
  let second: ElectronApplication | undefined;
  const results: Result[] = [];
  const check = async (row: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
      results.push({ row, pass: true });
    } catch (error) {
      results.push({ row, pass: false, detail: String(error).split("\n").slice(0, 4).join(" ") });
    }
  };
  let imageSize = { width: 0, height: 0 };
  let resized = false;
  try {
    {
      const { page } = first;
      await expect(card(page, "shelf")).toBeVisible({ timeout: 30_000 });
      await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
      await page.getByRole("button", { name: "Fit all nodes" }).click();
      await page.waitForTimeout(600);
      const mod = process.platform === "darwin" ? "Meta" : "Control";

      // An image file node: the png goes to the content store, the node names it by its content URL.
      const put = await page.evaluate(
        (bytesBase64) => window.junto!.contentPutImage({ bytesBase64, mediaType: "image/png", displayName: "gradient.png" }),
        readFileSync(join(stage.fixture.root, stage.fixture.paths.png)).toString("base64"),
      );
      expect(put.ok, JSON.stringify(put)).toBe(true);
      const picPath = contentObjectUrl((put as { ok: true; ref: Parameters<typeof contentObjectUrl>[0] }).ref);
      await commandModel(page, { _tag: "Add", canvas: CANVAS, nodes: [decode({ kind: "file", id: "pic", path: picPath, x: 1300, y: 320, width: 240, height: 160, z: 0 })], wires: [] });
      await expect(card(page, "pic")).toBeVisible({ timeout: 10_000 });

      // Seed: artifacts with labels, one archived; a task; two automations.
      const art = async (title: string, labels: ReadonlyArray<string>) => {
        const artifactId = mintItemId();
        const applied = (await page.evaluate(
          ({ canvas, node, artifactId, opId, title, labels }) =>
            window.junto!.resource!.artifact!.apply(canvas, node, artifactId, opId, { op: "create", title, body: { type: "document", markdown: `# ${title}` }, labels }),
          { canvas: CANVAS, node: asNodeId("shelf"), artifactId, opId: mintOpId(), title, labels },
        )) as { kind: string };
        expect(applied.kind).toBe("applied");
        return artifactId;
      };
      await art("Roadmap", ["planning"]);
      const old = await art("Old plan", ["planning"]);
      await page.evaluate(
        ({ canvas, node, artifactId, opId }) => window.junto!.resource!.artifact!.apply(canvas, node, artifactId, opId, { op: "archive" }),
        { canvas: CANVAS, node: asNodeId("shelf"), artifactId: old, opId: mintOpId() },
      );
      const taskId = mintItemId();
      await page.evaluate(
        ({ canvas, nodeId, taskId, opId }) => window.junto!.resource!.task!.apply(canvas, nodeId, taskId, opId, { kind: "create", taskId, title: "Ship the wire spec" }),
        { canvas: CANVAS, nodeId: taskNodeId(asNodeId("board")), taskId, opId: mintOpId() },
      );

      // Command groups: notes 1 to 9 fixed in slots 1 to 9, notes 9 and 10 a group past nine.
      for (let slot = 1; slot <= 9; slot += 1) {
        await page.keyboard.press("Escape");
        await card(page, `n${slot}`).click();
        await page.keyboard.press(`${mod}+Digit${slot}`);
        await expect(bar(page).getByTestId(`hotbar-slot-${slot}`)).toHaveAttribute("data-tenure", "fixed");
      }
      await page.keyboard.press("Escape");
      await card(page, "n9").click({ modifiers: ["Shift"] });
      await card(page, "n10").click({ modifiers: ["Shift"] });
      await bar(page).getByRole("button", { name: "Save the selection as a new group" }).click();
      await expect(bar(page).getByTestId("command-group-extra-1")).toBeVisible();
      await page.keyboard.press("Escape");
      await shoot(page, "1-command-groups-arranged");

      // Artifacts: Document type, planning picked, archived on, Old plan open, comments rail open, sidebar collapsed.
      await card(page, "shelf").dblclick();
      await expect(page.getByRole("list", { name: "Artifacts" })).toBeVisible({ timeout: 20_000 });
      await typeRadio(page, "Document").click();
      await labelToggle(page, "planning").click();
      await page.locator(".artifacts-archived-toggle").click();
      await expect(page.locator(".artifacts-archived-toggle")).toHaveAttribute("aria-pressed", "true");
      await page.getByRole("list", { name: "Artifacts" }).locator("button").filter({ hasText: "Old plan" }).first().click();
      await expect(page.locator(".artifact-head__title")).toHaveValue("Old plan", { timeout: 15_000 });
      await page.keyboard.press("Meta+Shift+M");
      await expect(page.locator(".two-pane").first()).toHaveAttribute("data-rail", "true", { timeout: 10_000 });
      await page.locator("[data-sidebar-toggle]").first().click();
      await expect(page.locator(".two-pane").first()).toHaveAttribute("data-sidebar", "collapsed");
      await shoot(page, "2-artifacts-arranged");
      await closeModal(page, "Artifacts");

      // Tasks: Backlog, the task open.
      await card(page, "board").dblclick({ position: { x: 24, y: 12 } });
      await expect(page.getByRole("list", { name: "Tasks" })).toBeVisible({ timeout: 20_000 });
      await page.getByRole("radiogroup", { name: "Show" }).getByRole("radio", { name: "Backlog" }).click();
      await page.getByRole("list", { name: "Tasks" }).getByText("Ship the wire spec").click();
      await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue("Ship the wire spec", { timeout: 10_000 });
      await closeModal(page, "Tasks");

      // Automations: two saved, the first open.
      await card(page, "auto").dblclick();
      const pane = page.getByTestId("automations-node");
      await expect(pane).toBeVisible({ timeout: 20_000 });
      const editor = pane.getByTestId("automation-editor");
      for (const name of ["Morning", "Evening"]) {
        await pane.getByRole("button", { name: "New automation" }).first().click();
        await editor.getByLabel("Automation name").fill(name);
        const mailTo = editor.getByLabel("Mail to");
        await mailTo.click();
        await mailTo.pressSequentially("@lead");
        await page.getByRole("option", { name: /lead/u }).first().click();
        await editor.getByRole("textbox", { name: "Mail text", exact: true }).fill(`${name} check.`);
        await editor.getByRole("button", { name: "Save", exact: true }).click();
        await expect(pane.getByRole("button", { name: new RegExp(`^${name}`, "u") }).first()).toBeVisible({ timeout: 10_000 });
      }
      await pane.getByRole("button", { name: /^Morning/u }).first().click();
      await expect(editor.getByLabel("Automation name")).toHaveValue("Morning");
      await closeModal(page, "Automations");

      // Files: src expanded, src/big.ts open.
      await card(page, FILES_ID).dblclick();
      const files = page.getByRole("dialog", { name: "Files" });
      await expect(files).toBeVisible({ timeout: 20_000 });
      await expandInTree(files, "docs");
      await openInTree(files, stage.fixture.paths.bigTs);
      await page.waitForTimeout(800);
      await shoot(page, "3-files-arranged");
      await closeModal(page, "Files");

      // Image modal: resized by its grip.
      await card(page, "pic").getByRole("button", { name: /^Image/u }).dblclick();
      const image = page.locator('[role="dialog"][aria-label="Image"] .focus-surface__panel').first();
      await expect(image).toBeVisible({ timeout: 15_000 });
      const box = (await image.boundingBox())!;
      await page.mouse.move(box.x + box.width - 6, box.y + box.height - 6);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width - 206, box.y + box.height - 126, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(400);
      const after = (await image.boundingBox())!;
      imageSize = { width: Math.round(after.width), height: Math.round(after.height) };
      resized = Math.abs(after.width - box.width) > 100;
      if (!resized) results.push({ row: "image modal resize (arrange)", pass: false, detail: `a drag on the bottom-right grip left it ${String(Math.round(box.width))}x${String(Math.round(box.height))}` });
      await shoot(page, "4-image-resized");
      await closeModal(page, "Image");

      // Actor rail: collapsed from lead's modal.
      await card(page, "lead").dblclick();
      await expect(rail(page)).toBeVisible({ timeout: 20_000 });
      if ((await rail(page).getAttribute("data-rail")) !== "collapsed") await rail(page).getByTestId("actor-rail-toggle").click();
      await expect(rail(page)).toHaveAttribute("data-rail", "collapsed");
      await page.locator("button").filter({ hasText: /^close$/iu }).first().click({ force: true });
    }

    second = await quitAndRelaunch(first);
    const page = await second.firstWindow();
    await (await second.browserWindow(page)).evaluate((main) => main.setContentSize(1600, 960));
    await expect(card(page, "shelf")).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));

    await check("command groups 1 to 9", async () => {
      for (let slot = 1; slot <= 9; slot += 1) {
        await expect(bar(page).getByTestId(`hotbar-slot-${slot}`)).toHaveAttribute("data-tenure", "fixed", { timeout: 10_000 });
        await expect(bar(page).getByTestId(`hotbar-slot-${slot}`)).toContainText(`note ${slot}`);
      }
    });
    await check("command group past nine", async () => {
      const extra = bar(page).getByTestId("command-group-extra-1");
      await expect(extra).toBeVisible({ timeout: 10_000 });
      await expect(extra).toContainText("note 9");
    });
    await shoot(page, "5-command-groups-after-relaunch");

    await card(page, "shelf").dblclick();
    const two = page.locator(".two-pane").first();
    await expect(two).toBeVisible({ timeout: 20_000 });
    await check("artifacts open artifact", () => expect(page.locator(".artifact-head__title")).toHaveValue("Old plan", { timeout: 15_000 }));
    await check("artifacts sidebar collapsed", () => expect(two).toHaveAttribute("data-sidebar", "collapsed", { timeout: 10_000 }));
    await check("artifacts comments rail", () => expect(two).toHaveAttribute("data-rail", "true", { timeout: 10_000 }));
    await shoot(page, "6-artifacts-after-relaunch");
    const strip = page.locator(".two-pane__strip [data-sidebar-toggle]");
    if ((await strip.count()) > 0) await strip.click();
    await check("artifacts type filter", () => expect(typeRadio(page, "Document")).toHaveAttribute("aria-checked", "true", { timeout: 10_000 }));
    await check("artifacts picked labels", () => expect(labelToggle(page, "planning")).toHaveAttribute("aria-pressed", "true", { timeout: 10_000 }));
    await check("artifacts archived toggle", () => expect(page.locator(".artifacts-archived-toggle")).toHaveAttribute("aria-pressed", "true", { timeout: 10_000 }));
    await shoot(page, "7-artifacts-sidebar-reopened");
    await closeModal(page, "Artifacts");

    await card(page, "board").dblclick({ position: { x: 24, y: 12 } });
    await expect(page.getByRole("list", { name: "Tasks" })).toBeVisible({ timeout: 20_000 });
    await check("tasks state filter", () => expect(page.getByRole("radiogroup", { name: "Show" }).getByRole("radio", { name: "Backlog" })).toHaveAttribute("aria-checked", "true"));
    await check("tasks open task", () => expect(page.getByRole("textbox", { name: "Title" })).toHaveValue("Ship the wire spec", { timeout: 10_000 }));
    await shoot(page, "8-tasks-after-relaunch");
    await closeModal(page, "Tasks");

    await card(page, "auto").dblclick();
    await expect(page.getByTestId("automations-node")).toBeVisible({ timeout: 20_000 });
    await check("automations open automation", () => expect(page.getByTestId("automation-editor").getByLabel("Automation name")).toHaveValue("Morning", { timeout: 10_000 }));
    await shoot(page, "9-automations-after-relaunch");
    await closeModal(page, "Automations");

    await card(page, FILES_ID).dblclick();
    const files = page.getByRole("dialog", { name: "Files" });
    await expect(files).toBeVisible({ timeout: 20_000 });
    await check("files expanded folders", async () => {
      await expect(treeRow(files, "docs")).toHaveAttribute("aria-expanded", "true", { timeout: 10_000 });
      await expect(treeRow(files, "src")).toHaveAttribute("aria-expanded", "true");
    });
    await check("files open file", () => expect(files.getByText("big.ts", { exact: true }).last()).toBeVisible({ timeout: 10_000 }));
    await shoot(page, "10-files-after-relaunch");
    await closeModal(page, "Files");

    await card(page, "pic").getByRole("button", { name: /^Image/u }).dblclick();
    const image = page.locator('[role="dialog"][aria-label="Image"] .focus-surface__panel').first();
    await expect(image).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(400);
    if (resized) await check("image modal size", async () => {
      const box = (await image.boundingBox())!;
      expect(Math.abs(Math.round(box.width) - imageSize.width), `width ${String(box.width)} vs ${String(imageSize.width)}`).toBeLessThanOrEqual(2);
      expect(Math.abs(Math.round(box.height) - imageSize.height), `height ${String(box.height)} vs ${String(imageSize.height)}`).toBeLessThanOrEqual(2);
    });
    await shoot(page, "11-image-after-relaunch");
    await closeModal(page, "Image");

    await card(page, "lead").dblclick();
    await check("actor rail collapsed", () => expect(rail(page)).toHaveAttribute("data-rail", "collapsed", { timeout: 20_000 }));
    await shoot(page, "12-actor-rail-after-relaunch");
    await page.locator("button").filter({ hasText: /^close$/iu }).first().click({ force: true });
    await expect(rail(page)).toHaveCount(0, { timeout: 10_000 });

    // Delete the Artifacts node, add a new one with the same id: it starts fresh.
    await commandModel(page, { _tag: "Remove", canvas: CANVAS, nodes: ["shelf"], wires: [] });
    await expect(card(page, "shelf")).toHaveCount(0, { timeout: 10_000 });
    await commandModel(page, { _tag: "Add", canvas: CANVAS, nodes: [decode(shelfRaw)], wires: [] });
    await expect(card(page, "shelf")).toBeVisible({ timeout: 10_000 });
    await card(page, "shelf").dblclick();
    await expect(page.locator(".two-pane").first()).toBeVisible({ timeout: 20_000 });
    await check("deleted node: a new node starts fresh", async () => {
      await expect(page.locator(".two-pane").first()).not.toHaveAttribute("data-sidebar", "collapsed");
      await expect(typeRadio(page, "All")).toHaveAttribute("aria-checked", "true");
      await expect(page.locator(".two-pane").first()).not.toHaveAttribute("data-rail", "true");
    });
    await shoot(page, "13-new-node-fresh");
    await closeModal(page, "Artifacts");
    await check("deleted node: its group member leaves", async () => {
      await commandModel(page, { _tag: "Remove", canvas: CANVAS, nodes: ["n1"], wires: [] });
      await expect(bar(page).getByTestId("hotbar-slot-1")).not.toContainText("note 1", { timeout: 10_000 });
    });
  } finally {
    console.log("VIEWSTATE", JSON.stringify(results));
    if (second !== undefined) await second.close().catch(() => undefined);
    await first.close();
    await stage.cleanup();
  }
  for (const r of results) expect.soft(r.pass, `${r.row}: ${r.detail ?? ""}`).toBe(true);
});
