/**
 * Guard (formerly a scratch measurement): the top bar's drag region must leave
 * while an overlay that crosses it is open, and must come back when it closes.
 *
 * History, because the numbers are the reason the rule exists: the first
 * version keyed on `html:has([role=dialog], [role=menu], …) .station-bar`, and
 * that invalidated the style of the whole document at every open and close.
 * On a 2x factory board (904 nodes) a dialog open plus close went from 39.8 ms
 * of layout-tree update to 838 ms, with 37,162 elements recalculated instead of
 * 1,644 (measured with the app's own recorder and scripts/zz-style-recalc.ts).
 * The replacement is one counted attribute on the root, `data-junto-overlay`,
 * held by the modal stack and the floating menus (lib/overlay-open.ts); a
 * stylesheet test forbids `:has()` on html, body or the root.
 *
 * This spec proves the cascade on a real app: the attribute appears while a
 * bar-crossing overlay is open and is gone after it closes, with the darwin
 * marker set (the rule is darwin-only; the Linux display computes the same
 * cascade, see top-bar-drag.spec.ts).
 *
 * It never signals the app. A spec may only use process.kill as an existence
 * probe (tests/tooling-process-safety-architecture.test.ts).
 *
 * usage: JUNTO_SCALE=2 scripts/run-e2e.sh e2e/scenarios/zz-style-recalc.spec.ts
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cardIds } from "../harness/canvas";
import { buildProofBoard, loadFactoryFixture } from "../harness/gpu-proof";
import { expect, test } from "../harness/launch";
import { writeFixtureModel } from "../harness/sandbox";

const ARM = process.env.JUNTO_ARM ?? "unlabelled";
const SCALE = Number(process.env.JUNTO_SCALE ?? "2");
const FIXTURE = process.env.JUNTO_FACTORY_JSON ?? "/tmp/factory-board.json";
const CACHE = `${tmpdir()}/zz-style-${String(SCALE)}x.db`;

const board = buildProofBoard(loadFactoryFixture(FIXTURE), SCALE as 1 | 2 | 10 | 100);
console.log(`arm ${ARM}: ${String(SCALE)}x board, ${String(board.model.nodes.length)} nodes, ${String(board.model.wires.length)} wires`);

test.use({
  juntoOptions: {
    afterSeed: async (sandbox) => {
      const db = join(sandbox.homeDir, ".junto", "state", "junto.db");
      mkdirSync(join(sandbox.homeDir, ".junto", "state"), { recursive: true });
      if (existsSync(CACHE)) {
        copyFileSync(CACHE, db);
        return;
      }
      await writeFixtureModel(sandbox, "factory", board.model);
      copyFileSync(db, CACHE);
    },
  },
});

test("a bar-crossing overlay takes the bar out of the drag region and gives it back", async ({ junto }) => {
  test.setTimeout(900_000);
  const { page } = junto;

  await expect.poll(async () => (await cardIds(page)).length, { timeout: 240_000 }).toBeGreaterThan(0);
  // The rule is darwin-only and the operator runs darwin; the Linux display
  // computes the same cascade when the marker says so (top-bar-drag.spec.ts).
  const marker = process.env.JUNTO_PLATFORM_MARKER ?? "darwin";
  await page.evaluate((platform: string) => {
    document.documentElement.dataset.juntoPlatform = platform;
  }, marker);
  await page.waitForTimeout(4_000);

  const attribute = (): Promise<string | null> =>
    page.evaluate(() => document.documentElement.getAttribute("data-junto-overlay"));

  expect(await attribute()).toBeNull();

  // The command bar is a bar-crossing modal (CommandBar.tsx passes no
  // belowBar), so the bar must stop being a drag region while it is open.
  await page.locator(".station-command-trigger").first().click();
  const dialog = page.locator('[role="dialog"]').first();
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  expect(await attribute()).toBe("open");

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await expect.poll(attribute, { timeout: 30_000 }).toBeNull();
  console.log(`arm ${ARM}: data-junto-overlay open and back to null, as the bar needs`);
});
