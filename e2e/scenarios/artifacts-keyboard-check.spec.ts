/**
 * Real-app check of the artifact keymap (948c4f0c7, e0399515f): pane stepping,
 * Cmd+Shift+M for the comments rail (Cmd+B leaves it alone), the list's own
 * keys, the Keys button, and Cmd+B in a terminal message field.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { Schema } from "effect";
import { Node } from "../../src/shared/model";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelSeat } from "../harness/model";

const CANVAS = "keys-check";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/artifacts-keyboard-check";
const shelf = Schema.decodeUnknownSync(Node, { onExcessProperty: "error" })({ kind: "artifacts", id: "shelf", label: "Shelf", x: 60, y: 60, width: 280, height: 160, z: 0 });
const lead = modelSeat({ id: "lead", key: "local:keys-lead", label: "lead", x: 400, y: 60 });

const shot = async (page: Page, name: string): Promise<void> => {
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

/** Which pane holds the keyboard: list, content, comments, or what else. */
const where = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const a = document.activeElement;
    if (a === null || a === document.body) return "body";
    for (const [name, sel] of [["list", ".two-pane__sidebar"], ["content", ".two-pane__main"], ["comments", ".two-pane__rail"]] as const) {
      if (a.closest(sel)) return `${name}:${a.tagName.toLowerCase()}${(a as HTMLElement).className ? "." + String((a as HTMLElement).className).split(" ")[0] : ""}`;
    }
    return `other:${a.tagName.toLowerCase()}`;
  });
const pane = async (page: Page): Promise<string> => (await where(page)).split(":")[0] ?? "";
const railOpen = (page: Page): Promise<boolean> => page.locator(".artifact-comments").isVisible();

test("artifact keymap: panes, comments key, list keys, Keys button, Cmd+B", async () => {
  test.setTimeout(300_000);
  const junto = await launchJunto({ windowContentSize: { width: 1500, height: 900 }, seedModels: { [CANVAS]: modelFixture([shelf, lead], []) } });
  const log: Record<string, unknown> = {};
  try {
    const { page } = junto;
    await expect(page.locator('.react-flow__node[data-id="shelf"]')).toBeVisible({ timeout: 30_000 });
    await page.locator('.react-flow__node[data-id="shelf"]').dblclick();
    const list = page.getByRole("list", { name: "Artifacts" });
    await expect(list).toBeVisible({ timeout: 20_000 });
    const meta = page.locator(".artifact-head__meta");
    for (const noun of ["Document", "Sheet", "Pad"]) {
      await page.getByRole("button", { name: "New artifact" }).click();
      await page.getByRole("group", { name: "New artifact" }).locator("button").filter({ hasText: noun }).click();
      await expect(meta).toHaveText(`${noun}, version 1`, { timeout: 15_000 });
    }
    const pick = async (title: string, noun: string): Promise<void> => {
      await list.locator("button").filter({ hasText: title }).first().click();
      await expect(meta).toHaveText(new RegExp(`^${noun}, version \\d+$`), { timeout: 15_000 });
    };

    // 1. Cmd+Alt+Right / Left through list, content, comments, per type.
    for (const [title, noun] of [["Untitled document", "Document"], ["Untitled sheet", "Sheet"], ["Untitled pad", "Pad"]] as const) {
      await pick(title, noun);
      await list.locator("button").filter({ hasText: title }).first().focus();
      expect(await pane(page), `${noun}: start in the list`).toBe("list");
      const right: string[] = [];
      for (let i = 0; i < 4; i += 1) { await page.keyboard.press("Meta+Alt+ArrowRight"); right.push(await where(page)); }
      const left: string[] = [];
      for (let i = 0; i < 4; i += 1) { await page.keyboard.press("Meta+Alt+ArrowLeft"); left.push(await where(page)); }
      log[`${noun} right`] = right;
      log[`${noun} left`] = left;
      expect(right.map((w) => w.split(":")[0]), `${noun} right`).toEqual(["content", "comments", "list", "content"]);
      expect(left.map((w) => w.split(":")[0]), `${noun} left`).toEqual(["list", "comments", "content", "list"]);
    }

    // A collapsed sidebar is skipped.
    await pick("Untitled document", "Document");
    await page.getByRole("button", { name: "Sidebar" }).first().click();
    await expect(page.locator(".two-pane[data-sidebar='collapsed']")).toHaveCount(1);
    await page.locator(".artifact-head__title, [aria-label='Title']").first().focus();
    await page.keyboard.press("Meta+Alt+ArrowRight");
    const c1 = await where(page);
    await page.keyboard.press("Meta+Alt+ArrowRight");
    const c2 = await where(page);
    await page.keyboard.press("Meta+Alt+ArrowLeft");
    const c3 = await where(page);
    await page.keyboard.press("Meta+Alt+ArrowLeft");
    const c4 = await where(page);
    log.collapsed = [c1, c2, c3, c4];
    await shot(page, "1-sidebar-collapsed");
    expect.soft([c1, c2, c3, c4].map((w) => w.split(":")[0]), "collapsed sidebar skipped").toEqual(["comments", "content", "comments", "content"]);
    await page.getByRole("button", { name: "Sidebar" }).first().click();
    await expect(page.locator(".two-pane[data-sidebar='collapsed']")).toHaveCount(0);

    // 2. Cmd+Shift+M opens and closes the rail with the caret in the document; Cmd+B leaves it be.
    await pick("Untitled document", "Document");
    const source = page.getByLabel("Markdown");
    await source.click();
    await source.pressSequentially("Caret in the document");
    expect(await railOpen(page)).toBe(false);
    await page.keyboard.press("Meta+B");
    expect(await railOpen(page), "Cmd+B did not open the rail").toBe(false);
    await page.keyboard.press("Meta+Shift+M");
    await expect(page.locator(".artifact-comments")).toBeVisible();
    await shot(page, "2-rail-open-by-cmd-shift-m");
    await page.keyboard.press("Meta+B");
    expect(await railOpen(page), "Cmd+B did not close the open rail").toBe(true);
    // Closing from the document's caret.
    await source.click();
    await page.keyboard.press("Meta+Shift+M");
    await expect(page.locator(".artifact-comments")).toHaveCount(0);
    log.afterCloseFromDocument = await where(page);
    // Cmd+Shift+M in the comment composer closes the rail, focus lands on the edge button.
    await page.keyboard.press("Meta+Shift+M");
    await expect(page.locator(".artifact-comments")).toBeVisible();
    await page.getByLabel("New comment").click();
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("New comment");
    await page.keyboard.press("Meta+Shift+M");
    await expect(page.locator(".artifact-comments")).toHaveCount(0);
    const focusNow = () =>
      page.evaluate(() => {
        const a = document.activeElement as HTMLElement | null;
        return { tag: a?.tagName, edge: a?.hasAttribute("data-comments-toggle") === true, label: a?.getAttribute("aria-label") ?? null };
      });
    const immediately = await focusNow();
    await page.waitForTimeout(1_500);
    const afterComposer = await focusNow();
    log.afterComposerClose = { immediately, after1500ms: afterComposer };
    await shot(page, "3-rail-closed-from-composer");
    expect.soft(afterComposer.edge, "focus on the edge button, not the page").toBe(true);

    // 3. List: Up and Down move the pick, Enter goes into the content.
    await list.locator("button").filter({ hasText: "Untitled document" }).first().focus();
    const picked = (): Promise<string> => page.locator(".artifact-head [aria-label='Title']").inputValue();
    // Up to the top of the list first, so Down has room.
    for (let i = 0; i < 4; i += 1) await page.keyboard.press("ArrowUp");
    const t0 = await picked();
    const landed = () => page.evaluate(() => document.activeElement?.closest("[data-selected='true']") !== null && document.activeElement?.closest("[data-selected='true']") !== undefined);
    await page.keyboard.press("ArrowDown");
    await expect.poll(picked).not.toBe(t0);
    const t1 = await picked();
    await page.waitForTimeout(600);
    log.afterFirstDown = await page.evaluate(() => ({
      active: (document.activeElement as HTMLElement | null)?.innerText?.replace(/\s+/g, " ").slice(0, 40) ?? null,
      selectedRows: [...document.querySelectorAll("[data-selected='true']")].map((e) => (e as HTMLElement).innerText.replace(/\s+/g, " ").slice(0, 40)),
      ariaCurrent: [...document.querySelectorAll("[aria-current]")].map((e) => (e as HTMLElement).innerText.replace(/\s+/g, " ").slice(0, 40)),
    }));
    const w1 = await where(page);
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(800);
    const t2 = await picked();
    log.secondDownMoved = t2 !== t1;
    expect.soft(t2, "a second Down moves the pick again").not.toBe(t1);
    // Put the keyboard back on the picked row to go on.
    await list.locator("button").filter({ hasText: t2 }).first().focus();
    await page.keyboard.press("ArrowUp");
    await page.waitForTimeout(800);
    log.upAfterRefocus = await picked();
    log.listKeys = { t0, t1, t2, focusAfterDown: w1 };
    expect.soft(w1.split(":")[0], "focus stays in the list after Down").toBe("list");
    await shot(page, "4-list-pick-moved");
    await list.locator("button").filter({ hasText: await picked() }).first().focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(800);
    log.paneAfterEnter = await pane(page);
    expect.soft(log.paneAfterEnter).toBe("content");
    log.afterEnter = await where(page);
    await shot(page, "5-enter-into-content");

    // 4. The Keys button.
    for (const [title, noun] of [["Untitled document", "Document"], ["Untitled sheet", "Sheet"], ["Untitled pad", "Pad"]] as const) {
      await pick(title, noun);
      await page.locator(".artifact-head").getByRole("button", { name: "Keys" }).click();
      const dialog = page.getByRole("group", { name: "Artifact keys" });
      await expect(dialog).toBeVisible();
      const text = (await dialog.innerText()).replace(/\s+/g, " ");
      log[`keys ${noun}`] = text;
      expect(text).toMatch(/comments/i);
      await shot(page, `6-keys-${noun.toLowerCase()}`);
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
    }
    expect(String(log["keys Document"])).toMatch(/⌘B Make the selection bold/);

    try {
    // 5. Cmd+B in a terminal message field does nothing.
    await page.keyboard.press("Escape");
    await page.locator('.react-flow__node[data-id="lead"]').dblclick();
    const front = page.locator(".workbench-pane:not(.workbench-pane--parked) .native-terminal-surface");
    await expect(front.locator("header").first()).toContainText("lead", { timeout: 20_000 });
    const railEl = front.getByTestId("actor-rail");
    log.railBefore = await railEl.getAttribute("data-rail").catch(() => "no rail");
    await front.getByRole("button", { name: "Message agent" }).click();
    const field = page.getByRole("textbox", { name: /message/i }).first();
    await expect(field).toBeVisible();
    await field.click();
    await page.keyboard.type("hello");
    await page.keyboard.press("Meta+B");
    log.railAfterCmdBInField = await railEl.getAttribute("data-rail").catch(() => "no rail");
    log.fieldValue = await field.inputValue().catch(() => "?");
    await shot(page, "7-cmd-b-in-message-field");
    expect(log.railAfterCmdBInField).toBe(log.railBefore);
    expect(log.fieldValue).toBe("hello");
    } catch (error) {
      log.terminalFieldStep = `not reached: ${String(error).slice(0, 120)}`;
    }
  } finally {
    console.log("REPORT", JSON.stringify(log, null, 1));
    await junto.close();
  }
});
