/**
 * Real app, 0.11.1, the fixes that only had unit tests:
 *   - c76e1dfe2: Delete and Backspace pressed inside the Files modal never
 *     reach the canvas behind it, and the Escape that closes the modal does
 *     not also clear the canvas selection.
 *   - 324c1e77f, 4a831354f, 125c3e4d7: a terminal view closed while its shell
 *     keeps printing parks its stream; shown again it catches up, every line
 *     in order. A quick switch back (under the 2 s grace) shows the same.
 *   - e64a843cb: with a dialog over a browser surface, Escape closes the
 *     dialog and the browser stays attached; on the bare browser shell,
 *     Escape warm-detaches it.
 * Dark and bright frames; each check is reported on its own.
 *   bun run test:e2e:fast e2e/scenarios/keys-terminal-verify.spec.ts
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelNode, modelTerminal } from "../harness/model";
import { FILES_ID, filesNode, openFilesModal, stageFiles } from "../harness/files-scenario";
import { terminalRows } from "../harness/term-ready";

const CANVAS = "keys-terminal-verify";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/keys-terminal-verify";
const BINDING = "local:keys-terminal-verify";

const shoot = async (page: Page, name: string): Promise<void> => {
  for (const theme of ["dark", "bright"] as const) {
    mkdirSync(join(SHOTS, theme), { recursive: true });
    await page.evaluate((t) => window.junto!.settingsPatch({ appearance: { theme: t } }), theme);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, theme, `${name}.png`) });
  }
  await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
};

type Result = { row: string; pass: boolean; detail?: string };

test("keys under a modal stand down, and a hidden terminal parks and catches up", async () => {
  test.setTimeout(240_000);
  const stage = await stageFiles();
  const junto = await launchJunto({
    windowContentSize: { width: 1500, height: 900 },
    seedModels: { [CANVAS]: modelFixture([filesNode(stage.fixture.root), modelTerminal({ id: "term", bindingId: BINDING, label: "Shell", x: 520, y: 60 })]) },
  });
  const results: Result[] = [];
  const check = async (row: string, run: () => void | Promise<void>): Promise<void> => {
    try {
      await run();
      results.push({ row, pass: true });
    } catch (error) {
      results.push({ row, pass: false, detail: String(error).replace(/\u001b\[[0-9;]*m/gu, "").split("\n").slice(0, 5).join(" ") });
    }
  };
  try {
    const { page } = junto;
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
    const filesCard = page.locator(`.react-flow__node[data-id="${FILES_ID}"]`);
    const selected = page.locator(".react-flow__node.selected");

    // Delete and Backspace under the Files modal. A native confirm here is the canvas asking to delete behind it.
    const nativeDialogs: string[] = [];
    page.on("dialog", (dialog) => {
      nativeDialogs.push(`${dialog.type()}: ${dialog.message()}`);
      void dialog.dismiss().catch(() => undefined);
    });
    const modal = await openFilesModal(page);
    // Focus the panel itself, a non-text spot: the dialog root's corner is the backdrop, which closes it.
    await modal.locator(".focus-surface__panel").first().focus();
    await expect(modal).toBeVisible();
    const before = await selected.count();
    await page.keyboard.press("Delete");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(600);
    await check("the Files modal stays open through Delete and Backspace", () => expect(modal).toBeVisible());
    console.log("KT-NATIVE", JSON.stringify(nativeDialogs));
    await check("Delete and Backspace in the Files modal ask nothing of the canvas", async () => {
      expect(nativeDialogs, "native confirm from the canvas").toEqual([]);
      await expect(page.getByRole("alertdialog")).toHaveCount(0);
    });
    await shoot(page, "1-delete-under-modal");
    await page.keyboard.press("Escape");
    await check("Escape closes the Files modal", () => expect(modal).toBeHidden({ timeout: 5_000 }));
    await check("the Files node is still on the canvas", () => expect(filesCard).toHaveCount(1));
    await check("the Escape that closed the modal kept the canvas selection", async () => {
      console.log("KT-SELECTION", JSON.stringify({ before, after: await selected.count() }));
      expect(before, "something was selected behind the modal").toBeGreaterThan(0);
      await expect(selected).toHaveCount(before);
    });

    // A terminal view closed while its shell prints, then shown again.
    const termCard = page.locator('.react-flow__node[data-id="term"]');
    const surface = page.locator(".workbench-pane:not(.workbench-pane--parked) .native-terminal-surface");
    const open = async (): Promise<void> => {
      await termCard.dblclick();
      await expect(surface).toBeVisible({ timeout: 30_000 });
    };
    const close = async (): Promise<void> => {
      await page.getByRole("button", { name: "Close view" }).first().click();
      await expect(page.locator(".native-terminal-surface:visible")).toHaveCount(0, { timeout: 10_000 });
    };
    const run = async (tag: string, lines: number, pause: string): Promise<void> => {
      await surface.locator(".xterm-screen").click();
      await page.keyboard.type(`clear; for i in $(seq 1 ${String(lines)}); do echo ${tag}-$i; sleep ${pause}; done; echo ${tag}-done`);
      await page.keyboard.press("Enter");
      await expect.poll(async () => (await terminalRows(page, BINDING)).some((r) => r.trim() === `${tag}-2`), { timeout: 15_000 }).toBe(true);
    };
    const inOrder = async (tag: string, lines: number): Promise<void> => {
      await expect.poll(async () => (await terminalRows(page, BINDING)).some((r) => r.trim() === `${tag}-done`), { timeout: 30_000 }).toBe(true);
      const shown = (await terminalRows(page, BINDING)).map((r) => r.trim()).filter((r) => r.startsWith(`${tag}-`) && r !== `${tag}-done`);
      const numbers = shown.map((r) => Number(r.slice(tag.length + 1)));
      expect(numbers.at(-1), JSON.stringify(shown.slice(-6))).toBe(lines);
      for (let at = 1; at < numbers.length; at += 1) expect(numbers[at], JSON.stringify(shown)).toBe(numbers[at - 1]! + 1);
    };
    await open();
    await expect.poll(async () => (await terminalRows(page, BINDING)).some((r) => r.trim() !== ""), { timeout: 30_000 }).toBe(true);
    await run("park", 60, "0.1");
    await close();
    await page.waitForTimeout(4_500);
    await open();
    await check("a view hidden past the grace catches up, every line in order", () => inOrder("park", 60));
    await shoot(page, "2-terminal-caught-up");
    await run("quick", 30, "0.1");
    await close();
    await page.waitForTimeout(800);
    await open();
    await check("a quick switch back keeps the stream, every line in order", () => inOrder("quick", 30));
    await check("typing still reaches the shell after both", async () => {
      await surface.locator(".xterm-screen").click();
      await page.keyboard.type("echo still-live-$((6*7))");
      await page.keyboard.press("Enter");
      await expect.poll(async () => (await terminalRows(page, BINDING)).some((r) => r.trim() === "still-live-42"), { timeout: 10_000 }).toBe(true);
    });
    await shoot(page, "3-terminal-live");
  } finally {
    console.log("KT", JSON.stringify(results));
    await junto.close();
    await stage.cleanup();
  }
  for (const r of results) expect.soft(r.pass, `${r.row}: ${r.detail ?? ""}`).toBe(true);
});

test("Escape over a browser: a dialog above keeps it attached, the bare shell detaches it", async () => {
  test.setTimeout(180_000);
  const canvas = "keys-browser-verify";
  const ref = `junto://canvas/${canvas}?node=p1`;
  const pageNode = modelNode({ kind: "page", id: "p1", url: "https://example.com/", profile: "personal", onRemove: "kill-session", x: 60, y: 60, width: 240, height: 80, z: 0 });
  const junto = await launchJunto({ windowContentSize: { width: 1500, height: 900 }, seedModels: { [canvas]: modelFixture([pageNode], []) } });
  const results: Result[] = [];
  const check = async (row: string, run: () => void | Promise<void>): Promise<void> => {
    try {
      await run();
      results.push({ row, pass: true });
    } catch (error) {
      results.push({ row, pass: false, detail: String(error).replace(/\u001b\[[0-9;]*m/gu, "").split("\n").slice(0, 5).join(" ") });
    }
  };
  const attached = (page: Page): Promise<number> =>
    page.evaluate(async (r) => {
      const listed = await window.junto!.browserSessionList!();
      return listed.ok && listed.data ? listed.data.filter((s) => s.ref === r && s.attached).length : -1;
    }, ref);
  try {
    const { page } = junto;
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
    const card = page.locator('.react-flow__node[data-id="p1"]');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.dblclick();
    const chrome = page.getByTestId("browser-chrome");
    await expect(chrome).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => attached(page), { timeout: 20_000 }).toBe(1);

    // A dialog above the browser: the command palette.
    await page.keyboard.press("ControlOrMeta+K");
    const dialog = page.getByRole("dialog").filter({ hasNot: chrome }).last();
    await check("a dialog opens over the browser", () => expect(dialog).toBeVisible({ timeout: 5_000 }));
    console.log("KB-DIALOG", (await dialog.getAttribute("aria-label").catch(() => null)) ?? "(unnamed)");
    await shoot(page, "4-dialog-over-browser");
    await page.keyboard.press("Escape");
    await check("Escape closes the dialog", () => expect(page.getByRole("dialog").filter({ hasNot: chrome })).toHaveCount(0, { timeout: 5_000 }));
    await page.waitForTimeout(600);
    await check("the browser stays attached behind it", async () => {
      expect(await attached(page)).toBe(1);
      await expect(chrome).toBeVisible();
    });

    // The bare browser shell: Escape warm-detaches it.
    await chrome.click({ position: { x: 10, y: 10 } }).catch(() => undefined);
    await page.keyboard.press("Escape");
    await check("Escape on the bare browser shell detaches it", async () => {
      await expect.poll(() => attached(page), { timeout: 10_000 }).toBe(0);
      await expect(chrome).toBeHidden({ timeout: 5_000 });
    });
    await shoot(page, "5-browser-detached");
  } finally {
    console.log("KB", JSON.stringify(results));
    await junto.close();
  }
  for (const r of results) expect.soft(r.pass, `${r.row}: ${r.detail ?? ""}`).toBe(true);
});
