/**
 * Scratch probe (untracked, measurement only): what the top bar's
 * `html:has([role=dialog], [role=menu], …) .station-bar` rule costs in style
 * recalculation when an overlay opens and closes on a 100x factory board.
 *
 * One arm per build: run it at 853f9044d~1 (no rule) and at 853f9044d (the
 * rule), several runs each, and compare UpdateLayoutTree ms and elementCount
 * from the app's own trace (SIGUSR2, 30 s, src/app/observability/perf-trace.ts).
 *
 * The 100x board is the factory shape tiled 100 times: ~45k nodes, ~101k wires,
 * seeded once into a cached SQLite file under /tmp and copied in per launch.
 *
 * usage on a VM: JUNTO_ARM=before scripts/run-e2e.sh e2e/scenarios/zz-style-recalc.spec.ts
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { cardIds } from "../harness/canvas";
import { buildProofBoard, loadFactoryFixture, type ProofBoard } from "../harness/gpu-proof";
import { expect, test } from "../harness/launch";
import { writeFixtureModel } from "../harness/sandbox";

const ARM = process.env.JUNTO_ARM ?? "unlabelled";
const SCALE = Number(process.env.JUNTO_SCALE ?? "100");
const OUT = `${homedir()}/grid-attrib`;
const FIXTURE = process.env.JUNTO_FACTORY_JSON ?? "/tmp/factory-board.json";
const CACHE = `${tmpdir()}/zz-style-${String(SCALE)}x.db`;

const board: ProofBoard = buildProofBoard(loadFactoryFixture(FIXTURE), SCALE as 1 | 2 | 10 | 100);
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

test("style recalculation around an overlay on a large board", async ({ junto }) => {
  test.setTimeout(900_000);
  const { page, sandbox, app } = junto;
  mkdirSync(OUT, { recursive: true });

  // The canvas is up when it lists cards; 45k nodes take a while to arrive.
  await expect.poll(async () => (await cardIds(page)).length, { timeout: 240_000 }).toBeGreaterThan(0);
  // The rule is darwin-only, and the operator runs darwin; the Linux display
  // computes the same cascade when the marker says so (top-bar-drag.spec.ts).
  // JUNTO_PLATFORM_MARKER=linux is the control: same build, rule present but
  // its leftmost compound does not match, so it must not recalc the document.
  const marker = process.env.JUNTO_PLATFORM_MARKER ?? "darwin";
  await page.evaluate((platform: string) => {
    document.documentElement.dataset.juntoPlatform = platform;
  }, marker);
  await page.waitForTimeout(8_000);

  process.kill(app.process().pid ?? 0, "SIGUSR2");
  await page.waitForTimeout(1_500);

  const trigger = page.locator(".station-command-trigger").first();
  await trigger.click();
  const dialog = page.locator('[role="dialog"]').first();
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(3_000);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await page.waitForTimeout(4_000);

  const dir = `${sandbox.homeDir}/.junto/traces`;
  const deadline = Date.now() + 90_000;
  let trace = "";
  while (Date.now() < deadline) {
    const names = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".json")) : [];
    const newest = names
      .map((name) => ({ name, at: statSync(`${dir}/${name}`).mtimeMs, size: statSync(`${dir}/${name}`).size }))
      .sort((a, b) => b.at - a.at)[0];
    if (newest && newest.size > 1_000_000 && Date.now() - newest.at > 2_000) {
      trace = `${dir}/${newest.name}`;
      break;
    }
    await page.waitForTimeout(2_000);
  }
  if (trace === "") throw new Error(`no finished trace under ${dir}`);
  const target = `${OUT}/style-${ARM}.json`;
  writeFileSync(target, readFileSync(trace));
  console.log(`arm ${ARM}: trace -> ${target}`);
});
