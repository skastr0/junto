/**
 * [fake-tui] product-verify: the 0.12 "Code steps" walk (artifact
 * 01M891EX9NVN959VMV0ZFC4DN3), all-on build, scratch data dir. One receipt
 * line per pass line in results.json (frames beside it), and the scratch home
 * it leaves goes to WALK_KEEP_STATE for zz-codesteps-ship.spec.ts (line 11,
 * a ship build). Passed at 3f2975bc8. Rerun it when the shipped TypeScript
 * runtime lands:
 *   JUNTO_FEATURE_PROFILE=all-on bun run build:bundles && bun run cli:build
 *   scripts/run-e2e.sh e2e/scenarios/zz-codesteps-walk.spec.ts
 */
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { card, canvasReady, cameraSettled } from "../harness/canvas";
import { crewOccupySeat, crewPlayFactory, crewSeat, installCrewSeatHarness } from "../harness/crew-fixture";
import { grantOverseer, modelFixture, modelNode, modelRegion, modelSeat } from "../harness/model";
import { readSeatMailbox } from "../harness/work-mail";
import { expect, launchJunto, test } from "../harness/launch";
import { createSandbox, destroySandbox } from "../harness/sandbox";

const CANVAS = "codewalk";
const NODE = "auto";
const FRAMES = process.env.JUNTO_E2E_FRAMES_DIR ?? join("test-results", "codesteps-walk");
const KEEP = process.env.WALK_KEEP_STATE ?? join(FRAMES, "state");
const SECRET_ID = "11111111-2222-4333-8444-555555555555";
const SECRET = "s3cr3t-walk-VALUE-4417";

const lead = modelSeat({ id: "lead", key: "local:walk-lead", label: "lead", x: 40, y: 60 });
const ovs = modelSeat({ id: "ovs", key: "local:walk-ovs", label: "ovs", x: 40, y: 240 });
const plain = modelSeat({ id: "plain", key: "local:walk-plain", label: "plain", x: 40, y: 420 });
const fixture = modelFixture([
  modelRegion({
    id: "region-walk", label: "Walk", x: 0, y: 0, width: 900, height: 620,
    environment: { sources: [{ id: "src-secret", kind: "secret", name: "WALK_SECRET", secretId: SECRET_ID }] },
  } as never),
  lead, ovs, plain,
  modelNode({ kind: "automations", id: NODE, label: "Automations", x: 460, y: 60, width: 260, height: 120, z: 0 }),
]);

type Line = { id: string; pass: boolean; note: string };
const lines: Line[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const psLines = (): string[] =>
  execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" }).split("\n").filter((l) => /sleep 31|no-env-file|bunfig\.toml|\/step\.(ts|sh)|junto-code|code-launcher/.test(l) && !/playwright|grep/.test(l));
const logScan = (home: string, needle: string): string[] => {
  const dir = join(home, ".junto", "logs");
  const hits: string[] = [];
  for (const name of readdirSync(dir)) {
    const text = readFileSync(join(dir, name), "utf8");
    if (text.includes(needle)) hits.push(name);
  }
  return hits;
};

test("[fake-tui] Code steps walk, 0.12 (all-on)", async () => {
  test.setTimeout(1_500_000);
  await mkdir(FRAMES, { recursive: true });
  const sandbox = await createSandbox();
  const junto = await launchJunto({ sandbox, seedModels: { [CANVAS]: fixture }, afterSeed: installCrewSeatHarness });
  const page = junto.page;
  const shot = (name: string) => page.screenshot({ path: join(FRAMES, `${name}.png`) });
  const record = async (id: string, run: () => Promise<string>) => {
    try {
      lines.push({ id, pass: true, note: await run() });
    } catch (error) {
      await shot(`${id}-FAIL`).catch(() => undefined);
      lines.push({ id, pass: false, note: String(error instanceof Error ? error.message : error).slice(0, 1500) });
    }
    await writeFile(join(FRAMES, "results.json"), `${JSON.stringify(lines, null, 2)}\n`);
  };
  const pane = page.getByTestId("automations-node");
  const editor = pane.getByTestId("automation-editor");
  const history = pane.getByRole("region", { name: "Firing history" });
  const codeView = page.getByTestId("automation-code");
  const firings = () => history.getByRole("listitem");

  const writeCode = async (code: string) => {
    const cm = page.getByRole("textbox", { name: "Step code" });
    await cm.click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.insertText(code);
    const held = (await cm.innerText()).replace(/ /g, " ");
    if (held.replace(/\s+/g, " ").trim() !== code.replace(/\s+/g, " ").trim()) throw new Error(`editor holds ${JSON.stringify(held)}`);
  };
  const saveCode = async () => {
    const save = codeView.getByRole("button", { name: "Save", exact: true });
    await save.click();
    await expect(save).toHaveAttribute("aria-disabled", "true", { timeout: 15_000 });
  };
  const openCode = async () => {
    await editor.getByRole("button", { name: /Write code|Edit code/ }).click();
    await expect(codeView).toBeVisible();
  };
  const backFromCode = async () => {
    await codeView.getByRole("button", { name: "Back" }).click();
    await expect(codeView).toHaveCount(0);
  };
  const setCode = async (code: string) => {
    await openCode();
    await writeCode(code);
    await saveCode();
    await backFromCode();
  };
  const saveAutomation = async () => {
    const save = editor.getByRole("button", { name: "Save", exact: true });
    if ((await save.getAttribute("aria-disabled")) !== "true" && (await save.isEnabled())) await save.click();
    await sleep(600);
  };
  /** Fire it with Run now; the newest history row's text. */
  const fire = async (): Promise<string> => {
    await saveAutomation();
    const before = await firings().count();
    await pane.getByRole("button", { name: "Run now" }).click();
    await expect(firings()).toHaveCount(before + 1, { timeout: 90_000 });
    await sleep(500);
    return (await firings().first().innerText()).replace(/\s+/g, " ").trim();
  };
  const lastResult = async (): Promise<string> => {
    await openCode();
    const region = codeView.getByRole("region", { name: "Result from the last firing" });
    const text = (await region.innerText().catch(() => "no result block")).replace(/\s+/g, " ").trim();
    await shot(`result-${lines.length}`);
    await backFromCode();
    return text;
  };
  const mailTexts = async (): Promise<string[]> => (await readSeatMailbox(page, CANVAS, lead.id)).map((m) => JSON.stringify(m.parts));
  const mailCount = async (needle: string): Promise<number> => (await mailTexts()).filter((t) => t.includes(needle)).length;
  const setMailText = async (text: string) => {
    await editor.getByLabel("Mail text").fill(text);
  };
  const chooseKind = async (label: string, name: string) => {
    await editor.getByRole("button", { name }).or(editor.getByRole("combobox", { name })).first().click();
    await page.getByRole("option", { name: label, exact: true }).click();
  };

  try {
    await canvasReady(page, { timeout: 30_000 });
    await page.getByRole("button", { name: /fit all/i }).click();
    await cameraSettled(page);
    await crewPlayFactory(page);
    for (const seat of [lead, ovs, plain]) await crewOccupySeat(page, CANVAS, { id: seat.id }, crewSeat(junto.sandbox, CANVAS, seat.id));
    await grantOverseer(page, CANVAS, ovs.id);
    await card(page, NODE).dblclick();
    await expect(pane).toBeVisible({ timeout: 20_000 });
    await pane.getByRole("button", { name: "New automation" }).first().click();
    await expect(editor).toBeVisible();

    await record("1-editor-typescript", async () => {
      await editor.getByLabel("Automation name").fill("Code walk");
      await editor.getByRole("button", { name: "Action", exact: true }).click();
      await chooseKind("Run code", "Action 1");
      await expect(editor.getByLabel("Code language")).toBeVisible();
      const mailTo = editor.getByLabel("Mail to");
      await mailTo.click();
      await mailTo.pressSequentially("@lead");
      await page.getByRole("option", { name: /lead/ }).first().click();
      await setMailText("ran {{code.who}}");
      // The walk fires many times: no quiet time between firings, and room per hour.
      await editor.getByLabel("Quiet time between firings, minutes").fill("0");
      await editor.getByLabel("At most, per hour").fill("60");
      await openCode();
      const cmCount = await page.locator(".cm-editor").count();
      await writeCode('import { input, cont } from "junto/automation"; cont({ who: input().trigger.kind });');
      await shot("l1d-code-typed");
      await saveCode();
      await shot("l1e-code-saved");
      await backFromCode();
      await editor.getByRole("switch", { name: "Automation on" }).click();
      await saveAutomation();
      await shot("l1f-enabled");
      return `a code step (TypeScript) opened in the Files code editor (${cmCount} CodeMirror editor), the program written and saved; mail "ran {{code.who}}"; automation on`;
    });

    await record("2-escape-and-revert", async () => {
      await openCode();
      await writeCode('import { input, cont } from "junto/automation"; cont({ who: input().trigger.kind + "-edited" });');
      await page.keyboard.press("Escape");
      await sleep(500);
      await shot("l2a-after-escape");
      const stillOpen = await pane.isVisible().catch(() => false);
      if (!stillOpen) await card(page, NODE).dblclick();
      await expect(pane).toBeVisible({ timeout: 10_000 });
      let notes = `Escape ${stillOpen ? "left the node open" : "closed the node"}; `;
      if ((await codeView.count()) === 0) {
        await pane.getByRole("button", { name: /Code walk/ }).first().click();
        notes += "reselected the automation; ";
        await openCode();
      }
      const held = (await page.getByRole("textbox", { name: "Step code" }).innerText()).replace(/ /g, " ");
      await shot("l2b-reopened");
      if (!held.includes("-edited")) throw new Error(`${notes}the edit is gone: ${JSON.stringify(held)}`);
      notes += "the edit is still there; ";
      await codeView.getByRole("button", { name: "Revert" }).click();
      const dialog = page.getByRole("alertdialog", { name: /Discard this code/ }).or(page.getByRole("dialog", { name: /Discard this code/ }));
      await expect(dialog).toBeVisible({ timeout: 5_000 });
      await shot("l2c-revert-asks");
      await dialog.getByRole("button", { name: "Cancel" }).click();
      const afterCancel = (await page.getByRole("textbox", { name: "Step code" }).innerText()).includes("-edited");
      await codeView.getByRole("button", { name: "Revert" }).click();
      await dialog.getByRole("button", { name: "Discard" }).click();
      await sleep(400);
      const afterDiscard = (await page.getByRole("textbox", { name: "Step code" }).innerText()).includes("-edited");
      await shot("l2d-reverted");
      if (!afterCancel || afterDiscard) throw new Error(`${notes}cancel kept edit: ${afterCancel}; discard dropped edit: ${!afterDiscard}`);
      await backFromCode();
      return `${notes}Revert asked "Discard this code?"; Cancel kept the edit, Discard dropped it`;
    });

    await record("3-it-runs", async () => {
      const row = await fire();
      await shot("l3-history");
      const mails = await mailCount("ran schedule");
      const result = await lastResult();
      if (mails !== 1) throw new Error(`mail "ran schedule" count ${mails}; history: ${row}; result: ${result}`);
      return `mail "ran schedule" arrived (1); history row: "${row}"; code result: "${result}"`;
    });

    await record("4-stop", async () => {
      await setCode('import { stop } from "junto/automation"; stop("nothing to do");');
      const mailsBefore = (await mailTexts()).length;
      const row = await fire();
      const result = await lastResult();
      const mailsAfter = (await mailTexts()).length;
      await shot("l4-history");
      if (!/stopped: nothing to do/.test(result)) throw new Error(`result: ${result}; row: ${row}`);
      if (mailsAfter !== mailsBefore) throw new Error(`a mail went: ${mailsBefore} -> ${mailsAfter}`);
      if (/failed/i.test(row)) throw new Error(`the firing reads failed: ${row}`);
      return `step reads "${result}"; no mail (${mailsBefore} -> ${mailsAfter}); history row (not failed): "${row}"`;
    });

    await record("5-fail", async () => {
      const notes: string[] = [];
      for (const [code, expectIt] of [
        ['import { fail } from "junto/automation"; fail("boom");', /failed: boom/],
        ["process.exit(3);", /exit 3/],
      ] as const) {
        await setCode(code);
        const mailsBefore = (await mailTexts()).length;
        const row = await fire();
        const result = await lastResult();
        const mailsAfter = (await mailTexts()).length;
        await shot(`l5-${notes.length}`);
        if (!expectIt.test(result)) throw new Error(`${code}: result ${result}; row ${row}`);
        if (mailsAfter !== mailsBefore) throw new Error(`${code}: a mail went`);
        if (!/fail/i.test(row)) throw new Error(`${code}: the firing does not read failed: ${row}`);
        notes.push(`${code} -> "${result}"; no mail; row "${row}"`);
      }
      return notes.join(" | ");
    });

    await record("6-timeout", async () => {
      const notes: string[] = [];
      await editor.getByLabel("Timeout, in seconds").fill("1");
      let timeoutSeen = false;
      for (const code of ["await new Promise(() => {});", "setInterval(() => {}, 1000); await new Promise(() => {});"]) {
        await setCode(code);
        await saveAutomation();
        const psBefore = psLines().length;
        const started = Date.now();
        const first = await fire();
        let rowNow = first;
        let ruledAfter = -1;
        for (let i = 0; i < 80 && ruledAfter < 0; i += 1) {
          rowNow = (await firings().first().innerText()).replace(/\s+/g, " ").trim();
          if (/Step 1 (failed|answered|stopped)/.test(rowNow)) ruledAfter = Date.now() - started;
          else await sleep(250);
        }
        await sleep(2500);
        const left = psLines();
        const result = await lastResult();
        await shot(`l6-${notes.length}`);
        if (/timeout/.test(result)) timeoutSeen = true;
        notes.push(`${JSON.stringify(code)}: first row "${first}", then "${rowNow}" (${ruledAfter} ms after Run now); result "${result}"; ps before ${psBefore}, after ${left.length}${left.length ? ` LEFT: ${left.join(" // ")}` : ""}`);
        if (left.length > 0) throw new Error(notes.join(" | "));
      }
      if (!timeoutSeen) throw new Error(`no variant failed on the timeout: ${notes.join(" | ")}`);
      return notes.join(" | ");
    });

    await record("7-shell", async () => {
      await chooseKind("Shell", "Code language");
      await setMailText("n is {{code.n}}");
      await setCode('printf %s "{\\"kind\\":\\"continue\\",\\"output\\":{\\"n\\":1}}" >&3');
      const row1 = await fire();
      const got = await mailCount("n is 1");
      const r1 = await lastResult();
      await setCode("exit 0");
      const mails0 = (await mailTexts()).length;
      const row2 = await fire();
      const r2 = await lastResult();
      await setCode("exit 1");
      const row3 = await fire();
      const r3 = await lastResult();
      await shot("l7-end");
      if (got !== 1) throw new Error(`mail "n is 1" count ${got}; r1 ${r1}; row ${row1}`);
      if (!/answered no values|answered/.test(r2) && !/continued/.test(row2)) throw new Error(`exit 0: ${r2} / ${row2}`);
      if (!/failed/.test(r3)) throw new Error(`exit 1: ${r3} / ${row3}`);
      return `fd 3 answer: mail "n is 1" arrived, result "${r1}"; exit 0: "${r2}" (mails ${mails0} -> ${(await mailTexts()).length}, row "${row2}"); exit 1: "${r3}"`;
    });

    await record("6b-timeout-shell", async () => {
      await editor.getByLabel("Timeout, in seconds").fill("1");
      const lang = ((await editor.getByLabel("Code language").innerText().catch(() => "")) || "").trim();
      await setCode("sleep 31");
      const psBefore = psLines().length;
      const started = Date.now();
      const first = await fire();
      let ruledAfter = -1;
      let rowNow = first;
      for (let i = 0; i < 60 && ruledAfter < 0; i += 1) {
        rowNow = (await firings().first().innerText()).replace(/\s+/g, " ").trim();
        if (/Step 1 failed: timeout/.test(rowNow)) ruledAfter = Date.now() - started;
        else await sleep(250);
      }
      await sleep(2500);
      const left = psLines();
      const result = await lastResult();
      await shot("l6b");
      const note = `language "${lang}", timeout 1 s, sleep 31: first row "${first}", then "${rowNow}" ${ruledAfter} ms after Run now; result "${result}"; ps before ${psBefore}, after ${left.length}${left.length ? ` LEFT: ${left.join(" // ")}` : ""}`;
      if (ruledAfter < 0 || ruledAfter > 15_000 || left.length > 0 || !/timeout/.test(result)) throw new Error(note);
      return note;
    });

    await record("8-secrets-out-of-logs", async () => {
      await chooseKind("Shell", "Code language");
      await setMailText("leak {{code.leak}}");
      const saved = await page.evaluate(
        (input) => window.junto!.regionEnvSaveSecret!(input),
        { regionId: "region-walk", name: "WALK_SECRET", value: SECRET, secretId: SECRET_ID },
      );
      const notes: string[] = [`secret save: ${JSON.stringify(saved)}`];
      await setCode(`echo "out:$WALK_SECRET"; echo "err:$WALK_SECRET" >&2; exit 4`);
      const row = await fire();
      const result = await lastResult();
      const logHits = logScan(sandbox.homeDir, SECRET);
      const tailHasValue = result.includes(SECRET);
      await shot("l8a");
      notes.push(`print then fail: result "${result}"; value in the tail: ${tailHasValue}; log files holding the value: ${JSON.stringify(logHits)}; row "${row}"`);
      if (!/failed/.test(result)) throw new Error(notes.join(" | "));
      if (!result.includes("out:") && !result.includes("err:")) notes.push("(the tail shows neither print line)");
      await setCode('printf %s "{\\"kind\\":\\"continue\\",\\"output\\":{\\"leak\\":\\"$WALK_SECRET\\"}}" >&3');
      const row2 = await fire();
      const result2 = await lastResult();
      const mailLeak = (await mailTexts()).filter((t) => t.includes(SECRET)).length;
      await shot("l8b");
      notes.push(`secret in output: result "${result2}"; row "${row2}"; mails holding the value ${mailLeak}; log files holding it now: ${JSON.stringify(logScan(sandbox.homeDir, SECRET))}`);
      if (tailHasValue || logHits.length > 0 || !/failed/.test(result2) || mailLeak > 0 || logScan(sandbox.homeDir, SECRET).length > 0) throw new Error(notes.join(" | "));
      return notes.join(" | ");
    });

    await record("8b-secrets-typescript", async () => {
      await chooseKind("TypeScript", "Code language");
      await setMailText("leak {{code.leak}}");
      await setCode('console.log("out:" + process.env.WALK_SECRET); console.error("err:" + process.env.WALK_SECRET); process.exit(4);');
      const row = await fire();
      const result = await lastResult();
      const hits = logScan(sandbox.homeDir, SECRET);
      await setCode('import { cont } from "junto/automation"; cont({ leak: process.env.WALK_SECRET ?? "none" });');
      const row2 = await fire();
      const result2 = await lastResult();
      const mailLeak = (await mailTexts()).filter((t) => t.includes(SECRET)).length;
      const hits2 = logScan(sandbox.homeDir, SECRET);
      const note = `TS print then exit 4: result "${result}"; value in the tail: ${result.includes(SECRET)}; log files holding it: ${JSON.stringify(hits)}; TS secret in output: result "${result2}"; mails holding it ${mailLeak}; log files holding it: ${JSON.stringify(hits2)}`;
      if (result.includes(SECRET) || hits.length > 0 || hits2.length > 0 || mailLeak > 0 || !/failed/.test(result) || !/failed/.test(result2) || !/output_carries_secret/.test(result2)) throw new Error(`${note}; rows "${row}" / "${row2}"`);
      return note;
    });

    await record("9-allowed-imports", async () => {
      await chooseKind("TypeScript", "Code language");
      await setCode('import "lodash";');
      const row = await fire();
      const result = await lastResult();
      await shot("l9");
      if (!/failed/.test(result) || !/lodash/.test(result)) throw new Error(`result "${result}"; row "${row}"`);
      return `refused at run time, not a crash: "${result}"; row "${row}"`;
    });

    await record("12-enum-does-not-build", async () => {
      await chooseKind("TypeScript", "Code language");
      await setCode("enum Color { Red, Green } console.log(Color.Red);");
      const row = await fire();
      const result = await lastResult();
      await shot("l12");
      if (!/does not build/.test(result)) throw new Error(`result "${result}"; row "${row}"`);
      return `an enum step is refused: "${result}"; row "${row}"`;
    });

    await record("10-cli-k4", async () => {
      const stepFile = join(sandbox.root, "step.ts");
      writeFileSync(stepFile, 'import { cont } from "junto/automation"; cont({ who: "cli" });\n');
      const input = JSON.stringify({
        target: NODE, name: "CLI walk",
        trigger: { kind: "schedule", cron: "0 9 * * 1-5", timezone: "America/Sao_Paulo" },
        then: [{ kind: "code", language: "typescript", file: stepFile }, { kind: "mail", to: "@lead", text: "cli {{code.who}}" }],
      });
      const okRun = await crewSeat(sandbox, CANVAS, ovs.id).cli(["overseer", "automation", "create", input]);
      const refused = await crewSeat(sandbox, CANVAS, plain.id).cli(["overseer", "automation", "create", input]);
      await writeFile(join(FRAMES, "l10-overseer-cli.txt"), JSON.stringify({ okRun, refused }, null, 2));
      const detail = `overseer: exit ${okRun.exitCode} ${String(okRun.stdout).slice(0, 300)} ${String(okRun.stderr).slice(0, 300)} | plain seat: exit ${refused.exitCode} ${String(refused.stdout).slice(0, 300)} ${String(refused.stderr).slice(0, 300)}`;
      if (okRun.exitCode !== 0) throw new Error(detail);
      if (refused.exitCode === 0) throw new Error(`the ordinary seat was not refused: ${detail}`);
      await page.keyboard.press("Escape");
      await sleep(300);
      if (!(await pane.isVisible().catch(() => false))) await card(page, NODE).dblclick();
      await pane.getByRole("button", { name: /CLI walk/ }).first().click();
      await openCode();
      const held = (await page.getByRole("textbox", { name: "Step code" }).innerText()).replace(/ /g, " ");
      await shot("l10-cli-code-in-modal");
      await backFromCode();
      if (!held.includes('who: "cli"')) throw new Error(`code in the modal: ${JSON.stringify(held)}; ${detail}`);
      return `${detail}; the code is in the modal: ${JSON.stringify(held.trim())}`;
    });
  } finally {
    await writeFile(join(FRAMES, "results.json"), `${JSON.stringify(lines, null, 2)}\n`);
    await junto.close();
    rmSync(KEEP, { recursive: true, force: true });
    mkdirSync(KEEP, { recursive: true });
    cpSync(join(sandbox.homeDir, ".junto"), join(KEEP, ".junto"), { recursive: true });
    await destroySandbox(sandbox);
  }
  expect(lines.filter((l) => !l.pass)).toEqual([]);
});
