/**
 * The pad's input budget: what one tool change, one ink move, one stroke end
 * and one keystroke cost the app, at idle and under load, on the same build.
 * The canvas behind the modal holds 80 seats and keeps its motion.
 *
 *   PAD_PERF_LABEL=before PAD_PERF_LOAD=160 scripts/run-e2e.sh e2e/scenarios/pad-budget.spec.ts
 *
 * PAD_PERF_LOAD is the count of busy processes held during the loaded pass
 * (0 skips it). Writes test-results/pad-budget/<label>.json.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CDPSession, Page } from "@playwright/test";
import { Schema } from "effect";
import { Node } from "../../src/shared/model";
import { budgetOf, installCommitCounter, layersNow, measureInput, withLoad, type InputBudget } from "../harness/pad-budget";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelRegion, modelSeat } from "../harness/model";

const CANVAS = "pad-budget";
const OUT = "test-results/pad-budget";
const LABEL = process.env.PAD_PERF_LABEL ?? "run";
const SEATS = Number(process.env.PAD_PERF_SEATS ?? 80);
const LOAD = Number(process.env.PAD_PERF_LOAD ?? 160);

/** One pass over the inputs; the pad is open with the select tool. */
const pass = async (page: Page, cdp: CDPSession, tag: string) => {
  const svg = page.getByTestId("pad-svg");
  const box = (await svg.boundingBox())!;

  // The first input of each kind keeps its raw trace, for the Performance panel.
  mkdirSync(OUT, { recursive: true });
  const raw = (kind: string) => join(OUT, `${LABEL}-${tag}-${kind}.trace.json`);
  const tool: InputBudget[] = [];
  for (const name of ["box", "ellipse", "ink", "select", "label", "select"]) {
    tool.push(await measureInput(page, cdp, () => page.getByTestId(`pad-tool-${name}`).click(), tool.length === 0 ? raw("tool") : undefined));
  }

  const inkMove: InputBudget[] = [];
  const strokeEnd: InputBudget[] = [];
  await page.getByTestId("pad-tool-ink").click();
  for (let i = 0; i < 3; i += 1) {
    const y = box.y + 300 + i * 40;
    await page.mouse.move(box.x + 60, y);
    await page.mouse.down();
    for (let step = 1; step <= 24; step += 1) {
      const x = box.x + 60 + step * 10;
      const yy = y + Math.sin(step / 3) * 12;
      if (step % 4 === 0) inkMove.push(await measureInput(page, cdp, () => page.mouse.move(x, yy), inkMove.length === 0 ? raw("ink") : undefined));
      else await page.mouse.move(x, yy);
    }
    strokeEnd.push(await measureInput(page, cdp, () => page.mouse.up(), strokeEnd.length === 0 ? raw("stroke") : undefined));
  }

  // A label, then keystrokes into it.
  await page.getByTestId("pad-tool-label").click();
  await page.mouse.move(box.x + 420, box.y + 120);
  await page.mouse.down();
  await page.mouse.move(box.x + 560, box.y + 150, { steps: 3 });
  await page.mouse.up();
  const input = page.getByRole("textbox", { name: "Label text" });
  await expect(input).toBeFocused({ timeout: 10_000 });
  const keystroke: InputBudget[] = [];
  for (const key of "budgets") keystroke.push(await measureInput(page, cdp, () => page.keyboard.press(key), keystroke.length === 0 ? raw("key") : undefined));
  await page.keyboard.press("Enter");
  await page.getByTestId("pad-tool-select").click();

  return {
    layers: await layersNow(cdp),
    toolChange: budgetOf(tool),
    inkMove: budgetOf(inkMove),
    strokeEnd: budgetOf(strokeEnd),
    keystroke: budgetOf(keystroke),
  };
};

test("pad budget: one input's cost at idle and under load", async () => {
  test.setTimeout(600_000);
  const seats = Array.from({ length: SEATS }, (_, i) =>
    modelSeat({ id: `s${i}`, key: `local:pad-budget-${i}`, label: `Seat ${i}`, x: (i % 10) * 240, y: 300 + Math.floor(i / 10) * 140 }),
  );
  const shelf = Schema.decodeUnknownSync(Node, { onExcessProperty: "error" })({
    kind: "artifacts",
    id: "shelf",
    label: "Shelf",
    x: 40,
    y: 40,
    width: 280,
    height: 160,
    z: 0,
  });
  const region = modelRegion({ id: "ops", label: "Ops", x: 0, y: 0, width: 2500, height: 1500 });
  const junto = await launchJunto({ seedModels: { [CANVAS]: modelFixture([region, shelf, ...seats], []) } });
  try {
    const { page } = junto;
    await installCommitCounter(page);
    const card = page.locator('.react-flow__node[data-id="shelf"]');
    await expect(card).toBeVisible({ timeout: 60_000 });
    await card.dblclick();
    await expect(page.getByRole("list", { name: "Artifacts" })).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "New artifact" }).click();
    await page.getByRole("group", { name: "New artifact" }).locator("button").filter({ hasText: "Pad" }).click();
    await expect(page.getByTestId("pad-svg")).toBeVisible({ timeout: 15_000 });
    // An A/B probe: CSS added before measuring, to test a cut without a build.
    if (process.env.PAD_PERF_STYLE) await page.addStyleTag({ content: process.env.PAD_PERF_STYLE });
    const commits = await page.evaluate(() => (window as unknown as { __padCommits?: number }).__padCommits ?? -1);
    expect(commits, "the React commit counter is installed").toBeGreaterThan(0);

    const cdp = await page.context().newCDPSession(page);
    const idle = await withLoad(0, () => pass(page, cdp, "idle"));
    const loaded = LOAD > 0 ? await withLoad(LOAD, () => pass(page, cdp, "loaded")) : undefined;

    const report = {
      label: LABEL,
      seats: SEATS,
      idle: { load: idle.load, ...idle.value },
      ...(loaded ? { loaded: { busy: LOAD, load: loaded.load, ...loaded.value } } : {}),
    };
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, `${LABEL}.json`), JSON.stringify(report, null, 2));
    await page.screenshot({ path: join(OUT, `${LABEL}.png`) });
    console.log("PAD BUDGET", JSON.stringify(report));
  } finally {
    await junto.close();
  }
});
