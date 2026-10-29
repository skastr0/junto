/**
 * Real app, plan 0.11 05, A1 to A3 (53408c987, fa7409ef3, e21f950a4,
 * a1f9c475e), the walk product-lead asked for, dark and bright.
 *
 * (1) The operator's example: "When a task in Release becomes done", prompt
 * a seat "{{task.title}} is done, check it ({{task.link}})"; finishing a task
 * gives the seat the real title and a link that opens the task. (2) The
 * one-task picker lists the board's tasks; scope names the boards and
 * Artifacts nodes; a watch on a whole Artifacts node fires on an edit, and the
 * list row reads "any task on Release". (3) Insert value offers only what the
 * trigger carries; {{artifact.title}} on a task trigger is refused with the
 * names it does carry. (4) A multi-line prompt keeps its lines.
 *
 * Labels are matched old or new: product-accessibility renames them
 * (Which tasks to Watch scope, one task to named, Becomes to State it becomes).
 *   JUNTO_SHOTS_DIR=<dir> bun run test:e2e:fast e2e/scenarios/automations-a1-verify.spec.ts
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { asNodeId } from "../../src/shared/model";
import { mintItemId, mintOpId } from "../../src/shared/resource-command";
import { taskNodeId } from "../../src/shared/task-model";
import { crewOccupySeat, crewPlayFactory, crewSeat, installCrewSeatHarness } from "../harness/crew-fixture";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelNode, modelRegion, modelSeat } from "../harness/model";

const CANVAS = "automations-a1";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/automations-a1-verify";

// A Select is named "<label>, <value>" once a value is chosen (bcbca4801): each label is the prefix.
const SCOPE_TASKS = /^(Which tasks|Watch scope)(,|$)/u;
const SCOPE_ARTIFACTS = /^(Which artifacts|Watch scope)(,|$)/u;
const BECOMES = /^(Becomes|State it becomes)(,|$)/u;
const TASK_PICKER = /^(Task|Task to watch)(,|$)/u;

const shoot = async (page: Page, name: string): Promise<void> => {
  for (const theme of ["dark", "bright"] as const) {
    mkdirSync(join(SHOTS, theme), { recursive: true });
    await page.evaluate((t) => window.junto!.settingsPatch({ appearance: { theme: t } }), theme);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, theme, `${name}.png`) });
  }
  await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
};

/** A design-system Select: open its trigger by name, pick the option. */
const choose = async (page: Page, scope: Locator, label: string | RegExp, option: string | RegExp): Promise<void> => {
  // A Select is named "<label>, <value>" once a value is chosen (bcbca4801): match the label as the prefix.
  const name = typeof label === "string" ? new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(,|$)`, "u") : label;
  const trigger = scope.getByRole("button", { name });
  await trigger.click();
  await page.getByRole("option", { name: option, exact: typeof option === "string" ? true : undefined }).first().click();
};

/** A sentence as a reader hears it: the hidden label words a Select carries (sr-only, bcbca4801) are left out. */
const spokenSentence = (sentence: Locator): Promise<string> =>
  sentence.evaluate((element) => {
    const copy = element.cloneNode(true) as HTMLElement;
    copy.querySelectorAll(".sr-only").forEach((node) => node.remove());
    return copy.textContent ?? "";
  });

const pickSeat = async (page: Page, field: Locator, name: string): Promise<void> => {
  await field.click();
  await field.pressSequentially(`@${name}`);
  await page.getByRole("option", { name: new RegExp(name, "u") }).first().click();
};

test("automations A1 to A3: the operator's example fires, pickers, an artifact watch, values, multi-line text", async () => {
  test.setTimeout(300_000);
  const folder = mkdtempSync(join(tmpdir(), "junto-a1-seat-"));
  const lead = modelSeat({ id: "lead", key: "local:a1-lead", label: "lead", harness: "codex", cwd: folder, x: 40, y: 40 });
  const fixture = modelFixture([
    modelRegion({ id: "ops", label: "Ops", x: 0, y: 0, width: 1100, height: 440 }),
    lead,
    modelNode({ kind: "automations", id: "auto", label: "Automations", x: 360, y: 40, width: 260, height: 120, z: 0 }),
    modelNode({ kind: "task", id: "release", name: "Release", x: 660, y: 40, width: 260, height: 160, z: 0 }),
    modelNode({ kind: "artifacts", id: "shelf", label: "Shelf", x: 660, y: 240, width: 260, height: 140, z: 0 }),
  ]);
  const junto = await launchJunto({
    windowContentSize: { width: 1500, height: 900 },
    seedModels: { [CANVAS]: fixture },
    afterSeed: installCrewSeatHarness,
  });
  try {
    const { page, sandbox, app } = junto;
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
    await expect(page.locator('.react-flow__node[data-id="auto"]')).toBeVisible({ timeout: 30_000 });
    const seat = crewSeat(sandbox, CANVAS, "lead");
    await crewPlayFactory(page);
    await crewOccupySeat(page, CANVAS, lead, seat);

    const board = taskNodeId(asNodeId("release"));
    const taskCommand = (taskId: ReturnType<typeof mintItemId>, command: unknown) =>
      page.evaluate(
        ({ canvas, board, taskId, opId, command }) => window.junto!.resource!.task!.apply(canvas, board, taskId, opId, command as never),
        { canvas: CANVAS, board, taskId, opId: mintOpId(), command },
      );
    const tasks: Record<string, ReturnType<typeof mintItemId>> = {};
    for (const title of ["Ship the wire spec", "Cut the release notes"]) {
      const taskId = mintItemId();
      tasks[title] = taskId;
      expect(JSON.stringify(await taskCommand(taskId, { kind: "create", taskId, title }))).not.toContain("refused");
    }
    const artifactId = mintItemId();
    const made = await page.evaluate(
      ({ canvas, artifactId, opId }) =>
        window.junto!.resource!.artifact!.apply(canvas, "shelf" as never, artifactId, opId, { op: "create", title: "Release plan", body: { type: "document", markdown: "# Release plan" } }),
      { canvas: CANVAS, artifactId, opId: mintOpId() },
    );
    expect((made as { kind: string }).kind).toBe("applied");

    await page.locator('.react-flow__node[data-id="auto"]').dblclick();
    const pane = page.getByTestId("automations-node");
    await expect(pane).toBeVisible({ timeout: 20_000 });
    const editor = pane.getByTestId("automation-editor");
    const trigger = editor.getByRole("region", { name: "Trigger" });
    const action1 = editor.getByRole("group", { name: "Action 1" });
    /** A new automation saves off; it fires only once it is on. */
    const switchOn = async (): Promise<void> => {
      const on = editor.getByRole("switch", { name: "Automation on" });
      if ((await on.getAttribute("aria-checked")) !== "true") await on.click();
      await expect(on).toHaveAttribute("aria-checked", "true");
    };

    // (1) The operator's example, built in the form.
    await pane.getByRole("button", { name: "New automation" }).first().click();
    await expect(editor).toBeVisible();
    await editor.getByLabel("Automation name").fill("Release done");
    await switchOn();
    await choose(page, editor, "Trigger", "When something changes");
    await choose(page, trigger, "What it watches", "a task");
    await expect(trigger.getByRole("button", { name: SCOPE_TASKS })).toContainText("Release");
    await choose(page, trigger, BECOMES, "done");
    await expect.poll(() => spokenSentence(trigger.locator(".automation-editor__sentence"))).toMatch(/When\s*a task\s*in\s*Release\s*becomes\s*done/u);

    // (2a) One task: a #task picker that lists the board's tasks.
    await choose(page, trigger, SCOPE_TASKS, /^(one task|named)$/u);
    const taskField = trigger.getByLabel(TASK_PICKER);
    await expect(taskField).toBeVisible();
    await taskField.click();
    await taskField.pressSequentially("#");
    await expect(page.getByRole("option").filter({ hasText: "Ship the wire spec" })).toHaveCount(1, { timeout: 10_000 });
    await expect(page.getByRole("option").filter({ hasText: "Cut the release notes" })).toHaveCount(1);
    await shoot(page, "2a-one-task-picker-lists");
    await page.keyboard.press("Escape");
    await choose(page, trigger, SCOPE_TASKS, /^(in )?Release$/u);
    // (2b) Scope names the boards; artifacts scope names the Artifacts nodes (checked below).
    await trigger.getByRole("button", { name: SCOPE_TASKS }).click();
    await expect(page.getByRole("option", { name: /^(in )?Release$/u })).toHaveCount(1);
    await page.keyboard.press("Escape");

    await choose(page, action1, "Action 1", "Prompt a seat");
    await pickSeat(page, action1.getByLabel("Prompt to"), "lead");
    const promptText = action1.getByRole("textbox", { name: "Prompt text", exact: true });
    await promptText.fill("");
    // (3a) Insert value offers only the task trigger's values.
    await action1.getByRole("button", { name: /^Insert value into the prompt(,|$)/u }).click();
    const offered = (await page.getByRole("option").allTextContents()).map((t) => t.trim());
    const names = offered.map((t) => /\{\{([^}]+)\}\}/u.exec(t)?.[1]).filter((n): n is string => n !== undefined);
    expect(names.sort(), `Insert value offered ${JSON.stringify(offered)}`).toEqual(["board.title", "fired.at", "task.assignee", "task.link", "task.state", "task.title"].sort());
    await shoot(page, "3a-insert-value-task-trigger");
    await page.getByRole("option", { name: /\{\{task\.title\}\}/u }).click();
    await expect(promptText).toHaveValue("{{task.title}}");
    // (4) Multi-line text: the rest typed with a line break.
    await promptText.press("End");
    await promptText.pressSequentially(" is done, check it ({{task.link}})");
    await promptText.press("Shift+Enter");
    await promptText.pressSequentially("Second line.");
    const typed = await promptText.inputValue();
    expect(typed, "the field holds two lines").toBe("{{task.title}} is done, check it ({{task.link}})\nSecond line.");

    // (3b) A value the trigger does not carry is refused, naming the ones it does.
    await promptText.fill(`${typed}\n{{artifact.title}}`);
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    const refusal = editor.locator('[role="alert"], .automation-editor__problem, [id$="-action-0"]').filter({ hasText: /artifact\.title/u });
    await expect(refusal.first()).toBeVisible({ timeout: 10_000 });
    const refusalText = (await refusal.first().textContent()) ?? "";
    for (const name of ["task.title", "task.link"]) expect.soft(refusalText, "the refusal names what the trigger carries").toContain(name);
    await shoot(page, "3b-refused-artifact-title-on-task");
    await promptText.fill(typed);
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(pane.getByRole("button", { name: /Release done/u }).first()).toBeVisible({ timeout: 10_000 });
    await expect(pane).toContainText("any task on Release", { timeout: 10_000 });
    await shoot(page, "1a-release-done-saved");

    // (1) Fire: finish a task; the seat gets the real title and the link.
    const target = tasks["Ship the wire spec"]!;
    expect(JSON.stringify(await taskCommand(target, { kind: "assign", seat: "lead" })), "assign it to lead").not.toContain("refused");
    expect((await seat.op("onboard", {})).ok, "lead onboards").toBe(true);
    const started = await seat.cli(["task", "start", target]);
    expect(started.exitCode, `${started.stdout.slice(0, 300)} ${started.stderr.slice(0, 300)}`).toBe(0);
    const finished = await seat.cli(["task", "finish", target]);
    expect(finished.exitCode, `the seat finishes it: ${finished.stdout.slice(0, 300)} ${finished.stderr.slice(0, 300)}`).toBe(0);
    await expect
      .poll(async () => (await seat.stdinLog()).includes("Ship the wire spec is done, check it ("), { timeout: 30_000 })
      .toBe(true);
    const log = await seat.stdinLog();
    const link = /Ship the wire spec is done, check it \((?:\[[^\]]*\]\()?(junto:\/\/[^)\s]+)\)/u.exec(log)?.[1];
    expect(link, `the prompt carries a junto:// link: ${log.slice(-400)}`).toBeTruthy();
    expect(link).toContain(target);
    expect(log, "the second line arrives").toContain("Second line.");
    expect(log).not.toContain("{{task.");
    // The link opens the task.
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await app.evaluate(({ app: electronApp }, uri) => electronApp.emit("open-url", { preventDefault: () => undefined }, uri), link!);
    await expect(page.locator('.react-flow__node[data-id="release"]'), "the link reaches its board").toHaveClass(/selected/u, { timeout: 15_000 });
    await page.waitForTimeout(1500);
    await shoot(page, "1b-link-opens-task");
    await expect.soft(page.getByText("Ship the wire spec").first(), "the link opens the task").toBeVisible({ timeout: 5_000 });

    // (2c) An artifact watch on the whole Artifacts node fires on an edit.
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.locator('.react-flow__node[data-id="auto"]').dblclick();
    await expect(pane).toBeVisible({ timeout: 20_000 });
    await pane.getByRole("button", { name: "New automation" }).first().click();
    await expect(editor).toBeVisible();
    await editor.getByLabel("Automation name").fill("Shelf edited");
    await switchOn();
    await choose(page, editor, "Trigger", "When something changes");
    await choose(page, trigger, "What it watches", "an artifact");
    await expect(trigger.getByRole("button", { name: SCOPE_ARTIFACTS })).toContainText("Shelf");
    await choose(page, trigger, "Is", "edited");
    await choose(page, action1, "Action 1", "Prompt a seat");
    await pickSeat(page, action1.getByLabel("Prompt to"), "lead");
    await action1.getByRole("textbox", { name: "Prompt text", exact: true }).fill("Edited: {{artifact.title}}");
    await shoot(page, "2c-artifact-in-shelf-is-edited");
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(pane.getByRole("button", { name: /Shelf edited/u }).first()).toBeVisible({ timeout: 10_000 });
    await expect(pane).toContainText("any artifact in Shelf", { timeout: 10_000 });
    const edited = await page.evaluate(
      ({ canvas, artifactId, opId }) =>
        window.junto!.resource!.artifact!.apply(canvas, "shelf" as never, artifactId, opId, {
          op: "edit",
          edit: { kind: "replace", baseVersion: 1, body: { type: "document", markdown: "# Release plan\n\nNow with dates." } },
        } as never),
      { canvas: CANVAS, artifactId, opId: mintOpId() },
    );
    expect(JSON.stringify(edited), "the edit applies").toContain("applied");
    await expect.poll(async () => (await seat.stdinLog()).includes("Edited: Release plan"), { timeout: 30_000 }).toBe(true);
    await shoot(page, "2d-artifact-watch-fired");
  } finally {
    await junto.close();
  }
});
