/**
 * Real app, 8c1159019 (dark crimson-fg is #f78481): a real refusal in a
 * modal, read for whether it still reads as an error. In the Files node, New
 * file named as a file that is already there: main refuses the name and the
 * dialog says so in a role=alert line. Framed dark and bright, with the
 * alert's colour and the dialog's quieter lines read beside it.
 *   JUNTO_SHOTS_DIR=<dir> bun run test:e2e:fast e2e/scenarios/crimson-fg-refusal-verify.spec.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { filesNode, openFilesModal, stageFiles } from "../harness/files-scenario";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture } from "../harness/model";

const CANVAS = "crimson-refusal";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/crimson-fg-refusal-verify";

test("a refused New file name reads as an error in dark and bright", async () => {
  test.setTimeout(240_000);
  const stage = await stageFiles();
  const junto = await launchJunto({ windowContentSize: { width: 1500, height: 900 }, seedModels: { [CANVAS]: modelFixture([filesNode(stage.fixture.root)]) } });
  const { page } = junto;
  const out: Record<string, unknown> = {};
  try {
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
    const modal = await openFilesModal(page);
    await expect(modal.locator('[role="treeitem"][data-item-path="README.md"]')).toBeVisible({ timeout: 15_000 });
    await modal.getByRole("button", { name: "New file", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "New file" });
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await dialog.getByLabel("Name of the new file").fill("README.md");
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    const alert = dialog.getByRole("alert");
    await expect(alert).toBeVisible({ timeout: 10_000 });
    for (const theme of ["dark", "bright"] as const) {
      mkdirSync(join(SHOTS, theme), { recursive: true });
      await page.evaluate((t) => window.junto!.settingsPatch({ appearance: { theme: t } }), theme);
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(SHOTS, theme, "refused-new-file.png") });
      await dialog.screenshot({ path: join(SHOTS, theme, "refused-new-file-dialog.png") });
      out[theme] = await dialog.evaluate((root) =>
        [...root.querySelectorAll("*")]
          .filter((el) => [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim()) && el.getBoundingClientRect().width > 0)
          .map((el) => ({ text: (el.textContent ?? "").trim().slice(0, 60), role: el.getAttribute("role"), color: getComputedStyle(el).color, size: getComputedStyle(el).fontSize })),
      );
    }
  } finally {
    mkdirSync(SHOTS, { recursive: true });
    writeFileSync(join(SHOTS, "lines.json"), JSON.stringify(out, null, 2));
    await junto.close();
    await stage.cleanup();
  }
  console.log("CRIMSON", JSON.stringify(out));
});
