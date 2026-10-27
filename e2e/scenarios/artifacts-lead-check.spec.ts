/**
 * Real-app check, dark and bright, of 784b608b6 (one 36px (44px in 784b608b6, narrowed by 1d6b85fdc) artifact header, tasks
 * inline, the picker floats under it), a6510c1bb (narrow artifacts sidebar) and
 * 6b2ece975 (live-rendered document: click a line to edit, save, comment on a
 * selection). Frames land in test-results/artifacts-lead-check/<theme>/.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { Schema } from "effect";
import { asNodeId, Node } from "../../src/shared/model";
import { mintItemId, mintOpId, type ItemId } from "../../src/shared/resource-command";
import { taskNodeId, type TaskCommand } from "../../src/shared/task-model";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture } from "../harness/model";

const CANVAS = "lead-check";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/artifacts-lead-check";
const decode = (value: unknown) => Schema.decodeUnknownSync(Node, { onExcessProperty: "error" })(value);
const shelf = decode({ kind: "artifacts", id: "shelf", label: "Shelf", x: 60, y: 60, width: 280, height: 160, z: 0 });
const board = decode({ kind: "task", id: "board", name: "Board", x: 400, y: 60, width: 320, height: 220, z: 0 });
const TITLE = "Junto monetization plan with a title long enough to need the room";

const MARKDOWN = [
  "# Junto monetization",
  "",
  "## The model",
  "",
  "| Layer | Price | Why |",
  "|---|---|---|",
  "| Junto | free, Apache-2.0 | Never paywalled. |",
  "| Junto Plus | $29 one-time | Patronage and `delight`. |",
  "",
  "One entitlement covers **the desktop app** and the phone, see [pricing](https://example.com/pricing).",
  "",
  "- Free alone fails.",
  "- [ ] Check the pricing pages",
  "",
  "> Plan on it covering nothing.",
].join("\n");

const shot = async (page: Page, theme: string, name: string): Promise<void> => {
  const dir = join(SHOTS, theme);
  mkdirSync(dir, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(dir, `${name}.png`) });
};

const rect = (page: Page, selector: string) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), height: Math.round(r.height) };
  }, selector);

/** The header's children all sit inside its one 36px (44px in 784b608b6, narrowed by 1d6b85fdc) row. */
const headerFacts = (page: Page) =>
  page.evaluate(() => {
    const head = document.querySelector(".artifact-head") as HTMLElement;
    const h = head.getBoundingClientRect();
    const kids = [...head.children].map((c) => {
      const r = c.getBoundingClientRect();
      return { cls: (c as HTMLElement).className.toString().slice(0, 40) || c.tagName, top: Math.round(r.top - h.top), bottom: Math.round(r.bottom - h.top), right: Math.round(h.right - r.right) };
    });
    const tasksOutside = [...document.querySelectorAll(".artifact-tasks")].filter((t) => !head.contains(t)).length;
    return { height: Math.round(h.height), scroll: { client: head.clientWidth, scroll: head.scrollWidth }, kids, tasksOutside };
  });

test("artifacts, dark and bright: header row, narrow sidebar, live document", async () => {
  test.setTimeout(420_000);
  const junto = await launchJunto({ windowContentSize: { width: 1500, height: 900 }, seedModels: { [CANVAS]: modelFixture([shelf, board], []) } });
  try {
    const { page } = junto;
    await expect(page.locator('.react-flow__node[data-id="shelf"]')).toBeVisible({ timeout: 30_000 });
    const tasks: ItemId[] = [];
    for (const title of ["Ship the pricing page", "Write the migration guide for the new entitlement"]) {
      const taskId = mintItemId();
      tasks.push(taskId);
      const ruling = await page.evaluate(
        ({ canvas, node, taskId, opId, command }) => window.junto!.resource!.task!.apply(canvas, node, taskId, opId, command),
        { canvas: CANVAS, node: taskNodeId(asNodeId("board")), taskId, opId: mintOpId(), command: { kind: "create", taskId, title } as TaskCommand },
      );
      expect(ruling.kind).toBe("applied");
    }
    const docId = mintItemId();
    for (const [artifactId, title, markdown] of [[docId, TITLE, MARKDOWN], [mintItemId(), "Short one", "Seed."]] as const) {
      await page.evaluate(
        ({ canvas, node, artifactId, opId, title, markdown }) =>
          window.junto!.resource!.artifact!.apply(canvas, node, artifactId, opId, { op: "create", title, body: { type: "document", markdown } }),
        { canvas: CANVAS, node: asNodeId("shelf"), artifactId, opId: mintOpId(), title, markdown },
      );
    }
    await page.locator('.react-flow__node[data-id="shelf"]').dblclick();
    const list = page.getByRole("list", { name: "Artifacts" });
    await expect(list).toBeVisible({ timeout: 20_000 });
    await list.locator("button").filter({ hasText: "Junto monetization" }).first().click();
    const meta = page.locator(".artifact-head__meta");
    await expect(meta).toHaveText("Document, version 1", { timeout: 15_000 });
    const source = page.getByLabel("Markdown");
    const report: Record<string, unknown> = {};

    for (const theme of ["bright", "dark"] as const) {
      await page.evaluate((t) => window.junto!.settingsPatch({ appearance: { theme: t } }), theme);
      await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe(theme === "bright" ? "bright" : null);
      const facts: Record<string, unknown> = {};
      report[theme] = facts;

      // --- 784b608b6: one 36px (44px in 784b608b6, narrowed by 1d6b85fdc) header row, tasks inline, picker floats.
      const bodyTopBefore = (await rect(page, ".artifact-head"))!.bottom;
      let head = await headerFacts(page);
      facts.headerNoTasks = head;
      await shot(page, theme, "1-header-no-tasks");
      expect(head.height).toBe(36);
      await page.getByRole("button", { name: "Name a task" }).click();
      const picker = page.locator(".artifact-tasks__picker");
      await expect(picker).toBeVisible();
      const pk = (await rect(page, ".artifact-tasks__picker"))!;
      const hd = (await rect(page, ".artifact-head"))!;
      facts.picker = { ...pk, headerBottom: hd.bottom, positioned: await picker.evaluate((e) => getComputedStyle(e).position) };
      expect(pk.top).toBeGreaterThanOrEqual(hd.bottom);
      expect((await rect(page, ".artifact-head"))!.height).toBe(36);
      expect((await rect(page, ".artifact-head"))!.bottom).toBe(bodyTopBefore);
      await shot(page, theme, "2-picker-floats");
      await page.getByRole("option").first().click();
      await expect(page.locator(".artifact-head .artifact-tasks__chip")).toHaveCount(1);
      await page.getByRole("button", { name: "Name a task" }).click();
      await page.getByRole("option").first().click();
      await expect(page.locator(".artifact-head .artifact-tasks__chip")).toHaveCount(2);
      head = await headerFacts(page);
      facts.headerTwoTasks = head;
      await shot(page, theme, "3-header-two-tasks");
      expect(head.height).toBe(36);
      expect(head.tasksOutside).toBe(0);
      expect(head.scroll.scroll).toBeLessThanOrEqual(head.scroll.client);
      for (const kid of head.kids) {
        expect(kid.top, kid.cls).toBeGreaterThanOrEqual(0);
        expect(kid.bottom, kid.cls).toBeLessThanOrEqual(36);
        expect(kid.right, kid.cls).toBeGreaterThanOrEqual(0);
      }
      // Unlink both so the next theme starts as this one did.
      for (const _ of [0, 1]) await page.getByRole("button", { name: /^Unlink / }).first().click();
      await expect(page.locator(".artifact-head .artifact-tasks__chip")).toHaveCount(0);
      // Keep the chips for the screenshot of the real state: name one back.
      await page.getByRole("button", { name: "Name a task" }).click();
      await page.getByRole("option").first().click();

      // --- a6510c1bb: narrow sidebar.
      const side = (await rect(page, ".two-pane__sidebar"))!;
      const chips = await page.evaluate(() => [...document.querySelectorAll(".artifacts-filter__type")].map((c) => { const r = c.getBoundingClientRect(); return { t: c.textContent, l: Math.round(r.left), r: Math.round(r.right) }; }));
      const titleBox = await page.evaluate(() => {
        const t = [...document.querySelectorAll('[aria-label="Artifacts"][role="list"] span.truncate')].find((e) => e.textContent?.startsWith("Junto monetization")) as HTMLElement;
        return { client: t.clientWidth, scroll: t.scrollWidth, overflow: getComputedStyle(t).textOverflow };
      });
      facts.sidebar = { width: side.width, chips, titleBox, rail: await rect(page, ".two-pane__rail") };
      expect(side.width).toBeGreaterThanOrEqual(176);
      expect(side.width).toBeLessThanOrEqual(208);
      expect(chips).toHaveLength(6);
      for (const chip of chips) { expect(chip.l).toBeGreaterThanOrEqual(side.left); expect(chip.r).toBeLessThanOrEqual(side.right); }
      expect(titleBox.overflow).toBe("ellipsis");
      expect(titleBox.scroll).toBeGreaterThan(titleBox.client);
      await shot(page, theme, "4-sidebar-and-header");
      await page.getByRole("button", { name: "Sidebar" }).first().click();
      await expect(page.locator(".two-pane[data-sidebar='collapsed']")).toHaveCount(1);
      facts.collapsedSidebarWidth = (await rect(page, ".two-pane__sidebar"))!.width;
      await shot(page, theme, "5-sidebar-collapsed");
      await page.getByRole("button", { name: "Sidebar" }).first().click();
      await expect(page.locator(".two-pane[data-sidebar='collapsed']")).toHaveCount(0);
      expect((await rect(page, ".two-pane__sidebar"))!.width).toBe(side.width);

      // --- 6b2ece975: live-rendered document.
      await expect(page.getByRole("button", { name: "Split" })).toHaveCount(0);
      await expect(page.locator(".cm-md-table table")).toBeVisible();
      await expect(source).not.toContainText("**the desktop app**");
      await shot(page, theme, "6-document-rendered");
      await page.waitForTimeout(1_500);
      await expect(async () => {
        await page.locator(".cm-md-strong").click();
        await expect(source).toContainText("**the desktop app**", { timeout: 1_500 });
      }).toPass({ timeout: 15_000 });
      await expect(source).not.toContainText("# Junto");
      await shot(page, theme, "7-line-open");
      await page.keyboard.press("End");
      await page.keyboard.type(` Edited in ${theme}.`);
      await page.locator(".cm-md-h1").click();
      await expect(source).not.toContainText("**the desktop app**");
      await expect(source).toContainText(`Edited in ${theme}.`);
      const before = (await meta.innerText()).trim();
      await expect(meta).toHaveText(/Document, version [2-9]/, { timeout: 15_000 });
      facts.saved = { before, after: (await meta.innerText()).trim() };
      await shot(page, theme, "8-saved-rendered-again");

      // Comment on a selection: select the tail of the closing quote line with the keyboard.
      await page.locator(".cm-md-quote, blockquote").first().click();
      await page.keyboard.press("End");
      for (let i = 0; i < 10; i += 1) await page.keyboard.press("Shift+ArrowLeft");
      const commentOn = page.getByRole("button", { name: "Comment on selection" });
      await expect(commentOn).toBeVisible();
      await shot(page, theme, "9-selection");
      await commentOn.click();
      const composer = page.getByLabel("New comment");
      await expect(composer).toBeVisible();
      await composer.fill(`A comment in ${theme}`);
      await shot(page, theme, "10-comment-composing");
      await page.locator(".artifact-comments").getByRole("button", { name: "Comment", exact: true }).click();
      const posts = page.getByRole("list", { name: "Threads" }).locator(".artifact-thread__post");
      await expect(posts.filter({ hasText: `A comment in ${theme}` })).toHaveCount(1, { timeout: 20_000 });
      facts.commentPosted = true;
      facts.anchorMarks = await page.locator(".cm-md-anchor, [class*='cm-md-comment'], [class*='anchor']").count();
      await shot(page, theme, "11-comment-posted");
      // Reset for the next theme: unlink the task chip.
      await page.getByRole("button", { name: /^Unlink / }).first().click();
    }
    console.log("REPORT", JSON.stringify(report, null, 1));
  } finally {
    await junto.close();
  }
});
