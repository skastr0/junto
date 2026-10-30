/**
 * Real app, b7d4a96ff and ae5ae14f2 (0.12 Files): an open file renamed
 * outside Junto, then its folder, follows its new name with the unsaved
 * draft kept and no deleted or stale bar; and a save followed by more typing
 * shows no stale bar 2 s on. Two Files nodes on the same folder (product-pad's
 * twin case): a save in A is what B opens, and a draft left in B meets A's
 * save with the changed-on-disk bar when B reopens. The rename is fs.rename from the test, the same
 * event a Finder rename gives the watch. Framed dark at each step.
 *   JUNTO_SHOTS_DIR=<dir> scripts/run-e2e.sh e2e/scenarios/files-outside-rename-verify.spec.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import { filesNode, openFilesModal, openInTree, stageFiles } from "../harness/files-scenario";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelNode } from "../harness/model";
import { THIS_MACHINE } from "../../tests/support/machines";

const CANVAS = "files-outside-rename";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/files-outside-rename-verify";
const DRAFT = "// unsaved draft line";

test("an open file follows an outside rename of itself and of its folder, and a save then typing shows no stale bar", async () => {
  test.setTimeout(300_000);
  const stage = await stageFiles();
  const junto = await launchJunto({ windowContentSize: { width: 1500, height: 900 }, seedModels: { [CANVAS]: modelFixture([filesNode(stage.fixture.root), modelNode({ kind: "files", id: "files-b", label: "Files B", x: 420, y: 60, width: 280, height: 160, z: 0, host: THIS_MACHINE, root: stage.fixture.root })]) } });
  const { page } = junto;
  const read: Record<string, unknown> = {};
  const misses: string[] = [];
  mkdirSync(SHOTS, { recursive: true });
  const step = async (name: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      misses.push(`${name}: ${String(error).replace(/\u001b\[[0-9;]*m/gu, "").split("\n").slice(0, 3).join(" ")}`);
    }
  };
  try {
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
    const close = async () => {
      for (let i = 0; i < 4 && (await page.getByRole("dialog").first().isVisible()); i += 1) await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 5_000 });
    };
    const openNode = async (id: string) => {
      await page.locator(`.react-flow__node[data-id="${id}"]`).dblclick();
      const dialog = page.getByRole("dialog").first();
      await expect(dialog).toBeVisible({ timeout: 20_000 });
      await openInTree(dialog, "README.md");
      const pane = dialog.getByRole("textbox", { name: "README.md", exact: true });
      await expect(pane).toBeVisible({ timeout: 10_000 });
      return { dialog, pane };
    };
    const typeAtEnd = async (pane: import("@playwright/test").Locator, text: string) => {
      await pane.click();
      await page.keyboard.press("Meta+ArrowDown");
      await page.keyboard.press("Enter");
      await page.keyboard.type(text);
    };

    await step("4 twin: a save in A is what B opens", async () => {
      const a1 = await openNode("files");
      await typeAtEnd(a1.pane, "Saved from A.");
      await page.keyboard.press("Meta+s");
      await page.waitForTimeout(800);
      await close();
      const b1 = await openNode("files-b");
      await page.waitForTimeout(1500);
      read["4a-b-after-a-save"] = { hasText: ((await b1.pane.textContent()) ?? "").includes("Saved from A."), staleBar: (await b1.dialog.locator(".files-stale").isVisible()) ? await b1.dialog.locator(".files-stale").innerText() : null };
      await page.screenshot({ path: join(SHOTS, "4a-b-opens-a-save.png") });
      if (!(read["4a-b-after-a-save"] as { hasText: boolean }).hasText) misses.push("4a: B does not show A's saved text");
      await typeAtEnd(b1.pane, "Draft left in B.");
      await close();
      const a2 = await openNode("files");
      await typeAtEnd(a2.pane, "Second save from A.");
      await page.keyboard.press("Meta+s");
      await page.waitForTimeout(800);
      await close();
      const b2 = await openNode("files-b");
      const bar = b2.dialog.locator(".files-stale");
      await expect(bar).toBeVisible({ timeout: 10_000 }).catch(() => undefined);
      read["4b-b-reopened-with-draft"] = { staleBar: (await bar.isVisible()) ? await bar.innerText() : null, draftKept: ((await b2.pane.textContent()) ?? "").includes("Draft left in B.") };
      await page.screenshot({ path: join(SHOTS, "4b-b-reopens-changed-bar.png") });
      if ((read["4b-b-reopened-with-draft"] as { staleBar: string | null }).staleBar === null) misses.push("4b: B reopened over its draft without the changed-on-disk bar");
      await close();
    });

    const modal = await openFilesModal(page);
    const stale = modal.locator(".files-stale");
    const pane = (path: string) => modal.getByRole("textbox", { name: path, exact: true });
    const state = async (path: string) => ({
      paneOpen: await pane(path).isVisible(),
      draftKept: ((await pane(path).textContent().catch(() => "")) ?? "").includes(DRAFT),
      staleBar: (await stale.isVisible()) ? await stale.innerText() : null,
    });

    await step("1 file renamed", async () => {
      await openInTree(modal, "src/big.ts");
      await pane("src/big.ts").click();
      await page.keyboard.press("Meta+ArrowDown");
      await page.keyboard.press("Enter");
      await page.keyboard.type(DRAFT);
      await page.screenshot({ path: join(SHOTS, "1a-draft-before-rename.png") });
      await rename(join(stage.fixture.root, "src/big.ts"), join(stage.fixture.root, "src/large.ts"));
      await expect(pane("src/large.ts")).toBeVisible({ timeout: 10_000 });
      await page.waitForTimeout(2000);
      read["1-after-file-rename"] = await state("src/large.ts");
      await page.screenshot({ path: join(SHOTS, "1b-after-file-rename.png") });
    });

    await step("2 folder renamed", async () => {
      await rename(join(stage.fixture.root, "src"), join(stage.fixture.root, "source"));
      await expect(pane("source/large.ts")).toBeVisible({ timeout: 10_000 });
      await page.waitForTimeout(2000);
      read["2-after-folder-rename"] = await state("source/large.ts");
      await page.screenshot({ path: join(SHOTS, "2-after-folder-rename.png") });
    });

    await step("3 save then keep typing", async () => {
      const path = (await pane("source/large.ts").isVisible()) ? "source/large.ts" : "src/big.ts";
      await pane(path).click();
      await page.keyboard.press("Meta+s");
      await page.waitForTimeout(150);
      await page.keyboard.type(" and more after the save");
      await page.waitForTimeout(2000);
      read["3-save-then-typing"] = { path, staleBar: (await stale.isVisible()) ? await stale.innerText() : null, saveHint: await modal.getByText(/^Save$/iu).first().isVisible().catch(() => null) };
      await page.screenshot({ path: join(SHOTS, "3-save-then-typing-2s.png") });
    });

    for (const [key, value] of Object.entries(read)) {
      const v = value as { paneOpen?: boolean; draftKept?: boolean; staleBar?: string | null };
      if (v.staleBar && !key.startsWith("4b")) misses.push(`${key}: a stale or deleted bar shows: ${v.staleBar}`);
      if (v.draftKept === false) misses.push(`${key}: the draft is gone`);
    }
  } finally {
    writeFileSync(join(SHOTS, "read.json"), JSON.stringify({ read, misses }, null, 2));
    await junto.close();
    await stage.cleanup();
  }
  console.log("RENAME", JSON.stringify(read));
  console.log("RENAME-MISSES", JSON.stringify(misses));
  expect(misses).toEqual([]);
});
