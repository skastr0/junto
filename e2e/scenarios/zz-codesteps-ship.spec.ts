/**
 * [fake-tui] product-verify: line 11 of the 0.12 Code steps walk, on a SHIP
 * build (codeSteps off). It opens the scratch home the all-on walk left
 * (WALK_KEEP_STATE, with a stored automation that has a code step). Build
 * with JUNTO_FEATURE_PROFILE=ship (bundles and cli:build) before running it.
 */
import { cpSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { card, canvasReady, cameraSettled } from "../harness/canvas";
import { crewOccupySeat, crewPlayFactory, crewSeat, installCrewSeatHarness } from "../harness/crew-fixture";
import { readSeatMailbox } from "../harness/work-mail";
import { expect, launchJunto, test } from "../harness/launch";
import { createSandbox, destroySandbox } from "../harness/sandbox";

const CANVAS = "codewalk";
const NODE = "auto";
const FRAMES = join("test-results", "codesteps-ship");
const KEEP = process.env.WALK_KEEP_STATE ?? join("test-results", "codesteps-walk", "state");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("[fake-tui] Code steps walk line 11, ship build", async () => {
  test.setTimeout(300_000);
  await mkdir(FRAMES, { recursive: true });
  const notes: Array<{ part: string; pass: boolean; note: string }> = [];
  const sandbox = await createSandbox();
  // The scratch home from the all-on walk: rows and content only, no sockets, seat harness dirs or logs.
  const from = join(KEEP, ".junto");
  const to = join(sandbox.homeDir, ".junto");
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    if (!["state", "content"].includes(name)) continue;
    cpSync(join(from, name), join(to, name), { recursive: true, filter: (src) => !statSync(src).isSocket() });
  }
  const junto = await launchJunto({ sandbox, afterSeed: installCrewSeatHarness });
  const page = junto.page;
  const shot = (name: string) => page.screenshot({ path: join(FRAMES, `${name}.png`) });
  const part = async (name: string, run: () => Promise<string>) => {
    try {
      notes.push({ part: name, pass: true, note: await run() });
    } catch (error) {
      await shot(`${name}-FAIL`).catch(() => undefined);
      notes.push({ part: name, pass: false, note: String(error instanceof Error ? error.message : error).slice(0, 1500) });
    }
    await writeFile(join(FRAMES, "results.json"), `${JSON.stringify(notes, null, 2)}\n`);
  };
  const pane = page.getByTestId("automations-node");
  const editor = pane.getByTestId("automation-editor");
  const history = pane.getByRole("region", { name: "Firing history" });

  try {
    await canvasReady(page, { timeout: 30_000 });
    await page.getByRole("button", { name: /fit all/i }).click();
    await cameraSettled(page);
    await crewPlayFactory(page);
    for (const id of ["lead", "ovs", "plain"]) await crewOccupySeat(page, CANVAS, { id }, crewSeat(junto.sandbox, CANVAS, id));
    const profile = await page.evaluate(() => (window as unknown as { junto?: { buildProfile?: string } }).junto?.buildProfile ?? "n/a");

    await part("stored-listing", async () => {
      const listed = await page.evaluate(async ([canvas, node]) => {
        const l = await window.junto!.automationList(canvas!, { nodeId: node as never });
        return l.automations.map((a) => ({ name: a.name, kinds: a.then.map((t: { kind: string }) => t.kind) }));
      }, [CANVAS, NODE] as const);
      return `stored automations: ${JSON.stringify(listed)}; buildProfile hint: ${profile}`;
    });

    await part("11a-editor-offers-no-code-step", async () => {
      await card(page, NODE).dblclick();
      await expect(pane).toBeVisible({ timeout: 20_000 });
      await pane.getByRole("button", { name: "New automation" }).first().click();
      await expect(editor).toBeVisible();
      await editor.getByLabel("Automation name").fill("Ship try");
      await editor.getByRole("button", { name: "Action 1" }).or(editor.getByRole("combobox", { name: "Action 1" })).first().click();
      const options = (await page.getByRole("option").allInnerTexts()).map((t) => t.trim());
      await shot("l11a-action-kinds");
      await page.keyboard.press("Escape");
      if (options.some((o) => /code/i.test(o))) throw new Error(`the action kinds offer code: ${JSON.stringify(options)}`);
      return `the action kinds are ${JSON.stringify(options)}: no code step`;
    });

    await part("11b-save-with-code-step-refused", async () => {
      const result = await page.evaluate(async ([canvas, node]) => {
        const l = await window.junto!.automationList(canvas!, { nodeId: node as never });
        const stored = l.automations.find((a) => a.then.some((t: { kind: string }) => t.kind === "code"));
        if (!stored) return { ok: "no stored code automation" };
        const codeStep = stored.then.find((t: { kind: string }) => t.kind === "code")!;
        try {
          const r = await window.junto!.automationApply(canvas!, {
            nodeId: node as never,
            automationId: "01M8ZZZZZZZZZZZZZZZZZZZZZZ" as never,
            op: { kind: "create", automationId: "01M8ZZZZZZZZZZZZZZZZZZZZZZ", enabled: false, definition: { name: "Ship code try", trigger: stored.trigger, then: [codeStep], limits: stored.limits } },
          } as never);
          return { applied: r };
        } catch (e) {
          return { thrown: String(e instanceof Error ? e.message : e) };
        }
      }, [CANVAS, NODE] as const);
      const text = JSON.stringify(result);
      await writeFile(join(FRAMES, "l11b-apply.txt"), text);
      if (!/off in this build|not_available|not available|refus/i.test(text)) throw new Error(`not refused: ${text.slice(0, 600)}`);
      return `a save with a code step: ${text.slice(0, 500)}`;
    });

    await part("11c-cli-help-and-write", async () => {
      const ovs = crewSeat(sandbox, CANVAS, "ovs");
      const help = await ovs.cli(["overseer", "automation", "create", "--help"]);
      const text = `${help.stdout}\n${help.stderr}`;
      const mentionsCode = /code step|kind: code|language: typescript/i.test(text);
      const stepFile = join(sandbox.root, "step.ts");
      await writeFile(stepFile, 'import { cont } from "junto/automation"; cont({});\n');
      const attempt = await ovs.cli(["overseer", "automation", "create", JSON.stringify({
        target: NODE, name: "Ship cli try",
        trigger: { kind: "schedule", cron: "0 9 * * 1-5", timezone: "America/Sao_Paulo" },
        then: [{ kind: "code", language: "typescript", file: stepFile }],
      })]);
      await writeFile(join(FRAMES, "l11c-cli.txt"), JSON.stringify({ help, attempt }, null, 2));
      const detail = `help mentions a code step: ${mentionsCode}; a write with a code step: exit ${attempt.exitCode} ${String(attempt.stdout).slice(0, 300)} ${String(attempt.stderr).slice(0, 200)}`;
      if (mentionsCode || attempt.exitCode === 0) throw new Error(detail);
      return detail;
    });

    await part("11d-stored-code-step-not-available-and-does-not-run", async () => {
      const mailsBefore = (await readSeatMailbox(page, CANVAS, "lead")).length;
      await page.keyboard.press("Escape");
      await sleep(400);
      const discard = page.getByRole("alertdialog").getByRole("button", { name: "Discard" });
      if (await discard.isVisible().catch(() => false)) await discard.click();
      await sleep(300);
      if (!(await pane.isVisible().catch(() => false))) await card(page, NODE).dblclick();
      await expect(pane).toBeVisible({ timeout: 10_000 });
      await pane.getByRole("button", { name: /Code walk/ }).first().click();
      await shot("l11d-stored-open");
      const before = await history.getByRole("listitem").count();
      await pane.getByRole("button", { name: "Run now" }).click();
      await expect(history.getByRole("listitem")).toHaveCount(before + 1, { timeout: 60_000 });
      await sleep(1500);
      const row = (await history.getByRole("listitem").first().innerText()).replace(/\s+/g, " ").trim();
      const mailsAfter = (await readSeatMailbox(page, CANVAS, "lead")).length;
      await shot("l11d-ruled");
      const detail = `history row "${row}"; mails to lead ${mailsBefore} -> ${mailsAfter}`;
      if (!/not available/i.test(row) || mailsAfter !== mailsBefore) throw new Error(detail);
      return detail;
    });
  } finally {
    await writeFile(join(FRAMES, "results.json"), `${JSON.stringify(notes, null, 2)}\n`);
    await junto.close();
    await destroySandbox(sandbox);
  }
  expect(notes.filter((n) => !n.pass)).toEqual([]);
});
