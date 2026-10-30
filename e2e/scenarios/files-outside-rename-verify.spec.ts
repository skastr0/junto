/**
 * Real app, b7d4a96ff and ae5ae14f2 (0.12 Files): an open file renamed
 * outside Junto, then its folder, follows its new name with the unsaved
 * draft kept and no deleted or stale bar; and a save followed by more typing
 * shows no stale bar 2 s on. The rename is fs.rename from the test, the same
 * event a Finder rename gives the watch. Framed dark at each step.
 *   JUNTO_SHOTS_DIR=<dir> scripts/run-e2e.sh e2e/scenarios/files-outside-rename-verify.spec.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import { filesNode, openFilesModal, openInTree, stageFiles } from "../harness/files-scenario";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture } from "../harness/model";

const CANVAS = "files-outside-rename";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/files-outside-rename-verify";
const DRAFT = "// unsaved draft line";

test("an open file follows an outside rename of itself and of its folder, and a save then typing shows no stale bar", async () => {
  test.setTimeout(300_000);
  const stage = await stageFiles();
  const junto = await launchJunto({ windowContentSize: { width: 1500, height: 900 }, seedModels: { [CANVAS]: modelFixture([filesNode(stage.fixture.root)]) } });
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
      if (v.staleBar) misses.push(`${key}: a stale or deleted bar shows: ${v.staleBar}`);
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
