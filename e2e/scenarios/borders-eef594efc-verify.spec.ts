/**
 * Real app, eef594efc, dark: no one-sided accent on the threads, files and
 * task surfaces. Four real states, each framed and read for its borders and
 * fill: (1) a task error the ruler really refuses (a title past 200
 * characters), (2) a task notice if an assignment's mail does not go, (3)
 * the seat Threads modal with a row selected, (4) a file comment row hovered
 * in the Files rail. A state the app does not reach here is reported, not
 * faked.
 *   JUNTO_SHOTS_DIR=<dir> bun run test:e2e:fast e2e/scenarios/borders-eef594efc-verify.spec.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator } from "@playwright/test";
import { Schema } from "effect";
import { asNodeId, Node } from "../../src/shared/model";
import { mintItemId, mintOpId } from "../../src/shared/resource-command";
import { taskNodeId } from "../../src/shared/task-model";
import { filesNode, openFilesModal, openInTree, stageFiles } from "../harness/files-scenario";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelMessagesWire, modelRegion, modelSeat } from "../harness/model";

const CANVAS = "borders-eef";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/borders-eef594efc-verify";

const edges = (target: Locator) =>
  target.evaluate((el) => {
    const s = getComputedStyle(el);
    const side = (k: "Top" | "Right" | "Bottom" | "Left") => `${s[`border${k}Width`]} ${s[`border${k}Style`]} ${s[`border${k}Color`]}`;
    return { top: side("Top"), right: side("Right"), bottom: side("Bottom"), left: side("Left"), radius: s.borderRadius, background: s.backgroundColor, shadow: s.boxShadow, before: getComputedStyle(el, "::before").content };
  });

test("eef594efc borders, dark: task error, task notice, threads selected row, file comment row hovered", async () => {
  test.setTimeout(400_000);
  const stage = await stageFiles();
  const atlas = modelSeat({ id: "atlas", key: "local:be-atlas", label: "Atlas", harness: "claude", x: 40, y: 60 });
  const bravo = modelSeat({ id: "bravo", key: "local:be-bravo", label: "Bravo", harness: "claude", x: 40, y: 260 });
  const board = Schema.decodeUnknownSync(Node, { onExcessProperty: "error" })({ kind: "task", id: "board", name: "Ship", x: 400, y: 60, width: 320, height: 220, z: 0 });
  const files = { ...filesNode(stage.fixture.root), x: 800, y: 60 } as Node;
  const ops = modelRegion({ id: "ops", label: "Ops", x: 0, y: 0, width: 1200, height: 560 });
  const nodes = [ops, atlas, bravo, board, files];
  const junto = await launchJunto({
    windowContentSize: { width: 1500, height: 900 },
    seedModels: { [CANVAS]: modelFixture(nodes, [modelMessagesWire("w1", "atlas", "bravo", nodes)]) },
  });
  const read: Record<string, unknown> = {};
  const misses: string[] = [];
  const step = async (name: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      misses.push(`${name}: ${String(error).replace(/\u001b\[[0-9;]*m/gu, "").split("\n").slice(0, 3).join(" ")}`);
    }
  };
  const { page } = junto;
  const shoot = async (name: string, target: Locator): Promise<void> => {
    mkdirSync(SHOTS, { recursive: true });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(SHOTS, `${name}.png`) });
    await target.screenshot({ path: join(SHOTS, `${name}-crop.png`) }).catch(() => undefined);
    read[name] = await edges(target);
  };
  const escapeAll = async (): Promise<void> => {
    for (let i = 0; i < 3; i += 1) await page.keyboard.press("Escape");
    for (const close of await page.getByRole("button", { name: /^Close( view)?$/u }).all()) await close.click({ timeout: 2_000 }).catch(() => undefined);
    await page.waitForTimeout(300);
  };
  try {
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
    await expect(page.locator('.react-flow__node[data-id="board"]')).toBeVisible({ timeout: 30_000 });
    const taskId = mintItemId();
    const created = await page.evaluate(
      ({ canvas, node, taskId, opId }) => window.junto!.resource!.task!.apply(canvas, node, taskId, opId, { kind: "create", taskId, title: "Ship the wire spec" }),
      { canvas: CANVAS, node: taskNodeId(asNodeId("board")), taskId, opId: mintOpId() },
    );
    expect(created.kind).toBe("applied");

    await step("1 task error", async () => {
      // A ruler refusal (product-feed): the first task depends on a second still in backlog, so Finish is refused deps-unmet.
      const apply = (id: string, command: Record<string, unknown>) =>
        page.evaluate(
          ({ canvas, node, taskId, opId, command }) => window.junto!.resource!.task!.apply(canvas, node, taskId as never, opId, command as never),
          { canvas: CANVAS, node: taskNodeId(asNodeId("board")), taskId: id, opId: mintOpId(), command },
        );
      const holder = mintItemId();
      expect((await apply(holder, { kind: "create", taskId: holder, title: "Write the migration" })).kind).toBe("applied");
      read["1-depend"] = await apply(taskId, { kind: "depend", on: holder });
      read["1-assign"] = await apply(taskId, { kind: "assign", seat: asNodeId("atlas") });
      await page.keyboard.press("Escape");
      await page.locator('.react-flow__node[data-id="board"]').dblclick({ position: { x: 16, y: 16 } });
      await page.getByRole("list", { name: "Tasks" }).locator("button").filter({ hasText: "Ship the wire spec" }).first().click({ timeout: 20_000 });
      const verbs = page.getByTestId("task-verbs");
      read["1-verbs-before"] = await verbs.innerText().catch(() => null);
      for (const name of ["Start", "Finish"]) {
        const verb = verbs.getByRole("button", { name: new RegExp(`^${name}`, "u") }).first();
        if (await verb.isVisible().catch(() => false)) {
          await verb.click();
          await page.waitForTimeout(800);
          if (await page.locator(".task-error").isVisible()) break;
        }
      }
      read["1-verbs-after"] = await verbs.innerText().catch(() => null);
      const error = page.locator(".task-error").first();
      await expect(error).toBeVisible({ timeout: 10_000 });
      read["1-task-error-text"] = await error.innerText();
      read["1-beside"] = await page.locator(".task-facts__meta, .task-facts__none").first().evaluate((el) => ({ text: el.textContent, color: getComputedStyle(el).color }));
      await shoot("1-task-error", error);
    });

    await step("2 task notice", async () => {
      const assign = page.getByRole("combobox", { name: "Assign to" }).or(page.getByLabel("Assign to")).first();
      await assign.click({ timeout: 10_000 });
      await page.getByRole("option").filter({ hasText: "Atlas" }).first().click({ timeout: 10_000 });
      const notice = page.locator(".task-notice").first();
      const queued = page.getByTestId("task-queued");
      await expect(notice.or(queued).or(page.locator(".task-error"))).toBeVisible({ timeout: 10_000 }).catch(() => undefined);
      read["2-after-assign"] = {
        notice: await notice.isVisible(),
        queued: await queued.isVisible(),
        error: (await page.locator(".task-error").isVisible()) ? await page.locator(".task-error").first().innerText() : null,
      };
      if (!(await notice.isVisible())) throw new Error(`assigning Atlas left no .task-notice: ${JSON.stringify(read["2-after-assign"])}`);
      await shoot("2-task-notice", notice);
    });
    await page.screenshot({ path: join(SHOTS, "2x-after-assign.png") }).catch(() => undefined);
    await escapeAll();

    await step("3 threads selected row", async () => {
      await page.locator('.react-flow__node[data-id="atlas"]').dblclick({ position: { x: 16, y: 16 } });
      await page.getByTestId("seat-threads-button").click({ timeout: 20_000 });
      await expect(page.getByTestId("seat-threads")).toBeVisible({ timeout: 20_000 });
      for (const text of ["First thread, about the onboarding copy.", "Second thread, about the release notes."]) {
        await page.getByTestId("seat-threads-new").click();
        const input = page.getByTestId("thread-composer-input");
        await input.click();
        await input.fill(text);
        await input.press("Enter");
        await page.waitForTimeout(800);
      }
      const rows = page.locator(".seat-threads__row");
      await expect(rows.nth(1)).toBeVisible({ timeout: 20_000 });
      await rows.nth(1).click();
      const selected = page.locator('.seat-threads__row[data-selected="true"]').first();
      await expect(selected).toBeVisible({ timeout: 5_000 });
      await page.mouse.move(5, 5);
      await shoot("3-threads-row-selected", selected);
    });
    await escapeAll();

    await escapeAll();
    await step("4 file comment row hovered", async () => {
      const modal = await openFilesModal(page);
      // A line thread draws its row after the line; a whole-file thread does not.
      await openInTree(modal, "src/big.ts");
      const editor = modal.getByRole("textbox", { name: "src/big.ts", exact: true });
      await editor.click();
      await page.keyboard.press("Meta+ArrowUp");
      for (let line = 1; line < 3; line += 1) await page.keyboard.press("ArrowDown");
      await modal.getByRole("button", { name: "Comment on line 3", exact: true }).click({ timeout: 10_000 });
      const composer = modal.getByLabel("New comment");
      if (!(await composer.isVisible())) await modal.locator(".artifact-comments-edge").click({ timeout: 10_000 });
      await expect(composer).toBeVisible({ timeout: 10_000 });
      await composer.fill("This line reads the old row label.");
      await composer.press("Meta+Enter");
      const row = modal.getByTestId("file-comment-row").first();
      await expect(row).toBeVisible({ timeout: 15_000 });
      await row.hover();
      await shoot("4-file-comment-row-hovered", row);
    });
  } finally {
    mkdirSync(SHOTS, { recursive: true });
    writeFileSync(join(SHOTS, "read.json"), JSON.stringify({ read, misses }, null, 2));
    await junto.close();
    await stage.cleanup();
  }
  console.log("BORDERS", JSON.stringify(read));
  console.log("BORDERS-MISSES", JSON.stringify(misses));
  expect(misses).toEqual([]);
});
