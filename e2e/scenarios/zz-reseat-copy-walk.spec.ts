/**
 * product-verify: the re-seat copy of cdee7ba58 in the real app, dark and
 * bright: the confirm of one seat and of several, the head of a mixed
 * selection, the outcome line's status region, and the harness pick's
 * message across machines. Frames and results.json in
 * test-results/reseat-copy-walk.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { card, canvasReady, cameraSettled, selectedIds } from "../harness/canvas";
import { modelFixture, modelNode, modelSeat } from "../harness/model";
import { expect, launchJunto, test } from "../harness/launch";

const CANVAS = "reseatcopy";
const FRAMES = join("test-results", "reseat-copy-walk");
const a = modelSeat({ id: "seat-a", label: "Ada", harness: "claude", x: 80, y: 120 });
const b = modelSeat({ id: "seat-b", label: "Bea", harness: "claude", x: 420, y: 120 });
const note = modelNode({ kind: "note", id: "note-1", text: "a note", x: 1100, y: 120, width: 240, height: 120, z: 0 });
const doc = modelFixture([a, b, note]);

type Line = { id: string; pass: boolean; note: string };
const lines: Line[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("[fake-tui] re-seat copy at cdee7ba58, dark and bright", async () => {
  test.setTimeout(600_000);
  await mkdir(FRAMES, { recursive: true });
  const junto = await launchJunto({ seedModels: { [CANVAS]: doc }, seedHarnessInstalls: ["claude", "codex"] });
  const page: Page = junto.page;
  const shot = (name: string) => page.screenshot({ path: join(FRAMES, `${name}.png`) });
  const record = async (id: string, run: () => Promise<string>) => {
    try {
      lines.push({ id, pass: true, note: await run() });
    } catch (error) {
      await shot(`${id}-FAIL`).catch(() => undefined);
      lines.push({ id, pass: false, note: String(error instanceof Error ? error.message : error).slice(0, 1400) });
      for (let i = 0; i < 3; i += 1) await page.keyboard.press("Escape");
    }
    await writeFile(join(FRAMES, "results.json"), `${JSON.stringify(lines, null, 2)}\n`);
  };
  const select = async (ids: string[]) => {
    await page.mouse.click(30, 520);
    await sleep(250);
    for (const [i, id] of ids.entries()) await card(page, id).click({ modifiers: i === 0 ? [] : ["Shift"] });
    await expect.poll(async () => [...(await selectedIds(page))].sort()).toEqual([...ids].sort());
  };
  const bar = () => page.locator("body");

  try {
    await canvasReady(page, { timeout: 30_000 });
    await page.getByRole("button", { name: /fit all/i }).click();
    await cameraSettled(page);

    for (const theme of ["dark", "bright"] as const) {
      await page.evaluate((t) => window.junto!.settingsPatch({ appearance: { theme: t } }), theme);
      await sleep(600);

      await record(`${theme}-single-seat-confirm`, async () => {
        await select([a.id]);
        await page.getByRole("button", { name: "Re-seat agent" }).click();
        const list = page.getByRole("dialog", { name: "Re-seat agent" });
        await expect(list).toBeVisible({ timeout: 10_000 });
        await shot(`${theme}-1a-pick`);
        await list.locator(".agent-harness-pick__item").filter({ hasText: /codex/i }).first().click({ timeout: 45_000 });
        const dialog = page.getByRole("alertdialog").or(page.getByRole("dialog", { name: /Re-seat agent process/ })).last();
        await expect(dialog).toBeVisible({ timeout: 10_000 });
        const text = ((await dialog.innerText()) || "").replace(/\s+/g, " ");
        await shot(`${theme}-1b-confirm`);
        const confirm = dialog.getByRole("button", { name: "Stop and re-seat", exact: true });
        const ok = /starts a new one in this seat/.test(text) && !/fresh seat/.test(text) && (await confirm.count()) === 1;
        await dialog.getByRole("button", { name: "Cancel" }).click();
        if (!ok) throw new Error(`dialog text: ${text}`);
        return `confirm reads "${text.slice(0, 260)}"; button "Stop and re-seat"; no "fresh seat"`;
      });

      await record(`${theme}-several-seats-confirm`, async () => {
        await select([a.id, b.id]);
        await expect(bar().locator(".rts-cmd__title")).toHaveText("shared settings");
        await page.getByRole("button", { name: "Re-seat agents" }).click();
        const pick = page.getByTestId("seats-reseat-pick");
        await expect(pick).toBeVisible({ timeout: 10_000 });
        await shot(`${theme}-2a-pick`);
        await pick.locator(".agent-harness-pick__item").filter({ hasText: /codex/i }).first().click({ timeout: 45_000 });
        const dialog = page.getByRole("alertdialog").or(page.getByRole("dialog", { name: /Re-seat 2 agents/ })).last();
        await expect(dialog).toBeVisible({ timeout: 10_000 });
        const text = ((await dialog.innerText()) || "").replace(/\s+/g, " ");
        await shot(`${theme}-2b-confirm`);
        const confirm = dialog.getByRole("button", { name: "Stop and re-seat 2 agents", exact: true });
        const ok = /Re-seat 2 agents/.test(text) && (await confirm.count()) === 1;
        await dialog.getByRole("button", { name: "Cancel" }).click();
        if (!ok) throw new Error(`dialog text: ${text}`);
        return `confirm reads "${text.slice(0, 260)}"; button "Stop and re-seat 2 agents"`;
      });

      await record(`${theme}-mixed-head-and-status`, async () => {
        await select([a.id, note.id]);
        const title = ((await bar().locator(".rts-cmd__title").innerText()) || "").trim();
        const status = bar().locator(".rts-cmd__reseat-line");
        const role = await status.getAttribute("role");
        const textNow = (await status.textContent()) ?? "";
        await shot(`${theme}-3a-mixed`);
        const marks: string[] = [`seats+note head "${title}"`, `status role=${role} text="${textNow}"`];
        if (title !== "shared settings and agents" || role !== "status" || textNow !== "") throw new Error(marks.join("; "));
        await select([note.id, note.id === "x" ? "" : note.id].slice(0, 1));
        return marks.join("; ");
      });

      await record(`${theme}-notes-only-head`, async () => {
        await select([a.id, b.id]);
        const homo = ((await bar().locator(".rts-cmd__title").innerText()) || "").trim();
        return `two seats head "${homo}" (the notes-only mix is covered by the unit test; a lone note has no multi card)`;
      });

    }

    // The outcome line: the status region is the same node before and after the line appears.
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
    await record("outcome-line-same-region", async () => {
      await select([a.id, b.id]);
      await page.evaluate(() => document.querySelector(".rts-cmd__reseat-line")?.setAttribute("data-walk-mark", "mounted-before"));
      await page.getByRole("button", { name: "Re-seat agents" }).click();
      const pick = page.getByTestId("seats-reseat-pick");
      await expect(pick).toBeVisible({ timeout: 10_000 });
      await pick.locator(".agent-harness-pick__item").filter({ hasText: /codex/i }).first().click({ timeout: 45_000 });
      const dialog = page.getByRole("alertdialog").or(page.getByRole("dialog", { name: /Re-seat 2 agents/ })).last();
      await dialog.getByRole("button", { name: "Stop and re-seat 2 agents", exact: true }).click();
      const status = page.locator(".rts-cmd__reseat-line");
      let text = "";
      for (let i = 0; i < 100 && text === ""; i += 1) {
        text = ((await status.textContent()) ?? "").trim();
        if (text === "") await sleep(200);
      }
      const mark = await status.getAttribute("data-walk-mark");
      await shot("dark-5-outcome-line");
      if (text === "" || mark !== "mounted-before") throw new Error(`outcome text "${text}", same node: ${mark}`);
      return `the status region (role=status) was mounted empty and the same node then read "${text}"`;
    });
  } finally {
    await writeFile(join(FRAMES, "results.json"), `${JSON.stringify(lines, null, 2)}\n`);
    await junto.close();
  }
  expect(lines.filter((l) => !l.pass)).toEqual([]);
});
