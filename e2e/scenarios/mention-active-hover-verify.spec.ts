/**
 * Real app, 5dc873616: the mention combobox's active option is the mark at a
 * 10% tint with no left edge. With the pointer on one option and the keyboard
 * on another, dark and bright, the frame and both options' boxes and computed
 * fills are kept so the two can be compared by eye and by pixel.
 *   JUNTO_SHOTS_DIR=<dir> bun run test:e2e:fast e2e/scenarios/mention-active-hover-verify.spec.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator } from "@playwright/test";
import { Schema } from "effect";
import { asNodeId, Node } from "../../src/shared/model";
import { mintItemId, mintOpId } from "../../src/shared/resource-command";
import { taskNodeId } from "../../src/shared/task-model";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelRegion, modelSeat } from "../harness/model";

const CANVAS = "mention-active";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/mention-active-hover-verify";

const seats = ["Atlas", "Beacon", "Cobalt", "Delta"].map((label, i) =>
  modelSeat({ id: label.toLowerCase(), key: `local:ma-${label.toLowerCase()}`, label, harness: "claude", x: 40, y: 40 + i * 120 }));
const board = Schema.decodeUnknownSync(Node, { onExcessProperty: "error" })({ kind: "task", id: "board", name: "Ship", x: 400, y: 60, width: 320, height: 220, z: 0 });
const ops = modelRegion({ id: "ops", label: "Ops", x: 0, y: 0, width: 800, height: 600 });

const read = (option: Locator) =>
  option.evaluate((el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { text: el.textContent?.trim().slice(0, 30), active: el.getAttribute("data-active"), background: s.backgroundColor, shadow: s.boxShadow, borderLeft: s.borderLeftWidth, box: { x: r.x, y: r.y, width: r.width, height: r.height } };
  });

test("mention combobox: the keyboard's active option against the pointer's hovered one", async () => {
  test.setTimeout(240_000);
  const junto = await launchJunto({ windowContentSize: { width: 1500, height: 900 }, seedModels: { [CANVAS]: modelFixture([ops, ...seats, board], []) } });
  const out: Record<string, unknown> = {};
  try {
    const { page } = junto;
    const taskId = mintItemId();
    await page.evaluate(
      ({ canvas, node, taskId, opId }) => window.junto!.resource!.task!.apply(canvas, node, taskId, opId, { kind: "create", taskId, title: "Ship the wire spec" }),
      { canvas: CANVAS, node: taskNodeId(asNodeId("board")), taskId, opId: mintOpId() },
    );
    const card = page.locator('.react-flow__node[data-id="board"]');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.dblclick();
    await page.getByRole("list", { name: "Tasks" }).locator("button").filter({ hasText: "Ship the wire spec" }).first().click();
    const field = page.getByTestId("task-thread").getByLabel("Comment on this task");
    await field.click();
    await field.pressSequentially("over to @");
    const options = page.getByTestId("mention-option");
    await expect(options.nth(2)).toBeVisible({ timeout: 10_000 });
    // The keyboard on the second option, the pointer on the third.
    await field.press("ArrowDown");
    await options.nth(2).hover();
    await page.waitForTimeout(300);
    for (const theme of ["dark", "bright"] as const) {
      mkdirSync(join(SHOTS, theme), { recursive: true });
      await page.evaluate((t) => window.junto!.settingsPatch({ appearance: { theme: t } }), theme);
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(SHOTS, theme, "mention-frame.png") });
      await page.locator(".mention-combobox__popup").first().screenshot({ path: join(SHOTS, theme, "mention-popup.png") });
      const all = await Promise.all([0, 1, 2, 3].map(async (i) => ((await options.nth(i).count()) ? read(options.nth(i)) : null)));
      const hovered = await options.nth(2).evaluate((el) => el.matches(":hover"));
      out[theme] = { options: all, thirdHovered: hovered };
    }
  } finally {
    mkdirSync(SHOTS, { recursive: true });
    writeFileSync(join(SHOTS, "options.json"), JSON.stringify(out, null, 2));
    await junto.close();
  }
  console.log("MENTION", JSON.stringify(out));
});
