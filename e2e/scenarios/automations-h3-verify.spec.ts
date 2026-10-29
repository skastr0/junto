/**
 * Real app, 0.11/09 H3 (automations answer back, editor), the walk product-automations asked for, dark and bright.
 *
 * An escalate step shows "Where the answer goes" and "When answered…". Pressing "When answered…" saves
 * the automation with the step's id and opens a new automation whose trigger reads from it, the step
 * "<title>", is answered. Once the answering automation is saved, the step lists it and each opens the
 * other. Format value writes |date:YYYY-MM-DD onto the value at the caret. A notice shows none of it.
 *   JUNTO_SHOTS_DIR=<dir> bun run test:e2e:fast e2e/scenarios/automations-h3-verify.spec.ts
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelNode } from "../harness/model";

const CANVAS = "automations-h3";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/automations-h3-verify";
const RAISER = "Review gate";
const STEP = "Review the draft";
const ANSWERING = `When "${STEP}" is answered`;

const shoot = async (page: Page, name: string): Promise<void> => {
  for (const theme of ["dark", "bright"] as const) {
    mkdirSync(join(SHOTS, theme), { recursive: true });
    await page.evaluate((t) => window.junto!.settingsPatch({ appearance: { theme: t } }), theme);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, theme, `${name}.png`) });
  }
  await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
};

/** A design-system Select: open its trigger by name, then pick the option. */
const choose = async (page: Page, scope: Locator, label: string, option: string | RegExp): Promise<void> => {
  // A Select is named "<label>, <value>" once a value is chosen (bcbca4801): match the label as the prefix.
  const name = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(,|$)`, "u");
  await scope.getByRole("button", { name }).click();
  await page.getByRole("option", { name: option, exact: typeof option === "string" }).first().click();
};

/** A Dropdown (Insert value, Format value): its menu is a listbox named as its trigger. */
const pick = async (page: Page, scope: Locator, label: string, option: RegExp): Promise<void> => {
  await scope.getByRole("button", { name: label, exact: true }).click();
  await page.getByRole("listbox", { name: label, exact: true }).getByRole("option", { name: option }).first().click();
};

/** A pane list button starts with its automation's name; the name is escaped so quotes and dots match as written. */
const startsWith = (text: string): RegExp => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u");

type Result = { row: string; pass: boolean; detail?: string };
type Stored = {
  automationId: string;
  name: string;
  trigger: { kind: string; on?: { kind?: string; step?: string; automation?: { automationId?: string } } };
  then?: ReadonlyArray<{ kind: string; id?: string; title?: string }>;
};

test("automations H3: an escalate step answers back, When answered… saves and opens the answering automation, each opens the other, formats write at the caret, a notice shows none of it", async () => {
  test.setTimeout(300_000);
  const junto = await launchJunto({
    windowContentSize: { width: 1500, height: 900 },
    seedModels: {
      [CANVAS]: modelFixture([modelNode({ kind: "automations", id: "auto", label: "Automations", x: 40, y: 40, width: 260, height: 120, z: 0 })]),
    },
  });
  const results: Result[] = [];
  const check = async (row: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
      results.push({ row, pass: true });
    } catch (error) {
      results.push({ row, pass: false, detail: String(error).replace(/\u001b\[[0-9;]*m/gu, "").split("\n").slice(0, 4).join(" ") });
    }
  };
  try {
    const { page } = junto;
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
    await expect(page.locator('.react-flow__node[data-id="auto"]')).toBeVisible({ timeout: 30_000 });
    await page.locator('.react-flow__node[data-id="auto"]').dblclick();
    const pane = page.getByTestId("automations-node");
    await expect(pane).toBeVisible({ timeout: 20_000 });
    const editor = pane.getByTestId("automation-editor");
    const trigger = editor.getByRole("region", { name: "Trigger" });
    const sentence = trigger.locator(".automation-editor__sentence");
    const action = (n: number) => editor.getByRole("group", { name: `Action ${String(n)}` });
    const name = editor.getByLabel("Automation name");
    const listed = async (): Promise<ReadonlyArray<Stored>> =>
      ((await page.evaluate((canvas) => window.junto!.automationList(canvas, { nodeId: "auto" as never }), CANVAS)) as {
        automations: ReadonlyArray<Stored>;
      }).automations;

    // The raising automation: an escalate step with a title, on the default schedule trigger.
    await pane.getByRole("button", { name: "New automation" }).first().click();
    await name.fill(RAISER);
    await choose(page, action(1), "Action 1", "Raise a signal");
    await choose(page, action(1), "What the signal asks", "Escalate, a question for you");
    await action(1).getByRole("textbox", { name: "Signal title", exact: true }).fill(STEP);

    await check("an escalate step shows Where the answer goes and When answered…", async () => {
      await expect(action(1).getByLabel(/^Where the answer goes(,|$)/u)).toBeVisible({ timeout: 5_000 });
      await expect(action(1).getByRole("button", { name: "When answered…", exact: true })).toBeVisible({ timeout: 5_000 });
    });
    await shoot(page, "1-escalate-shows-answer-controls");

    // Format value: Insert value writes a value at the caret, then Format value puts the format on it.
    const detail = action(1).getByRole("textbox", { name: "Signal detail, optional", exact: true });
    await check("Format value puts |date:YYYY-MM-DD on the value at the caret", async () => {
      await pick(page, action(1), "Insert value into the detail", /^\{\{fired\.at\}\}/u);
      await expect(detail).toHaveValue("{{fired.at}}", { timeout: 5_000 });
      await pick(page, action(1), "Format value in the detail", /^\|date:YYYY-MM-DD(?!\s+HH)/u);
      await expect(detail).toHaveValue("{{fired.at|date:YYYY-MM-DD}}", { timeout: 5_000 });
    });
    await shoot(page, "2-format-value");

    await check("a notice shows neither Where the answer goes nor When answered…", async () => {
      await choose(page, action(1), "What the signal asks", "Notice, only to read");
      await expect(action(1).getByLabel(/^Where the answer goes(,|$)/u)).toHaveCount(0, { timeout: 5_000 });
      await expect(action(1).getByRole("button", { name: "When answered…", exact: true })).toHaveCount(0, { timeout: 5_000 });
      await expect(action(1).getByRole("group", { name: "When answered", exact: true })).toHaveCount(0, { timeout: 5_000 });
    });
    await shoot(page, "3-notice-shows-none");
    await choose(page, action(1), "What the signal asks", "Escalate, a question for you");

    // "When answered…" saves the raising automation with the step's id, then opens the answering draft.
    await action(1).getByRole("button", { name: "When answered…", exact: true }).click();
    await check("When answered… opens a new automation named for the step", () => expect(name).toHaveValue(ANSWERING, { timeout: 20_000 }));
    await check("the new automation's trigger reads from the raiser, the step, is answered", async () => {
      await expect(sentence.first()).toContainText("from");
      await expect(trigger.getByRole("button", { name: /^Automation that raises it(,|$)/u })).toContainText(RAISER);
      await expect(trigger.getByRole("button", { name: /^Which of its signals(,|$)/u })).toContainText(`the step "${STEP}"`);
      await expect(trigger.getByText("is answered", { exact: true })).toBeVisible();
    });
    await shoot(page, "4-answering-draft");

    // The answering automation is a draft until its first save; a notice gives it a valid action.
    await choose(page, action(1), "Action 1", "Raise a signal");
    await choose(page, action(1), "What the signal asks", "Notice, only to read");
    await action(1).getByRole("textbox", { name: "Signal title", exact: true }).fill("Answer received");
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await check("the answering automation saves and is listed", () =>
      expect(pane.getByRole("button", { name: startsWith(ANSWERING) }).first()).toBeVisible({ timeout: 15_000 }),
    );
    await check("the saved raiser carries the step's id, and the answering trigger names that id", async () => {
      const all = await listed();
      const raiser = all.find((automation) => automation.name === RAISER);
      const answering = all.find((automation) => automation.name === ANSWERING);
      const step = raiser?.then?.find((item) => item.kind === "signal" && item.title === STEP);
      expect(step?.id, JSON.stringify(raiser)).toBeTruthy();
      expect(answering?.trigger.on?.step, JSON.stringify(answering)).toBe(step?.id);
      expect(answering?.trigger.on?.automation?.automationId, JSON.stringify(answering)).toBe(raiser?.automationId);
    });

    // Each opens the other: the raiser's step lists the saved answering automation, and both open from there.
    await pane.getByRole("button", { name: startsWith(RAISER) }).first().click();
    await check("the raiser's step lists the answering automation, and its button opens it", async () => {
      await expect(name).toHaveValue(RAISER, { timeout: 15_000 });
      // The list names each button as a verb: "Open <name>" (aria-label, for the controls list).
      const linked = action(1).getByRole("group", { name: "When answered", exact: true }).getByRole("button", { name: `Open ${ANSWERING}`, exact: true });
      await expect(linked).toBeVisible({ timeout: 10_000 });
      await shoot(page, "5-step-lists-the-answering-automation");
      await linked.click();
      await expect(name).toHaveValue(ANSWERING, { timeout: 10_000 });
    });
    await check("the answering automation's Open button opens the raiser", async () => {
      await trigger.getByRole("button", { name: `Open ${RAISER}`, exact: true }).click();
      await expect(name).toHaveValue(RAISER, { timeout: 10_000 });
    });
    await shoot(page, "6-each-opens-the-other");
  } finally {
    console.log("H3", JSON.stringify(results));
    await junto.close();
  }
  for (const r of results) expect.soft(r.pass, `${r.row}: ${r.detail ?? ""}`).toBe(true);
});
