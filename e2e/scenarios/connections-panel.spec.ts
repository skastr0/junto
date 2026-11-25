/**
 * [fake-tui] A seat's Connections list from the RTS bar (e516b2a69): it lists
 * the seat's wires, the search filters them, X removes one with no dialog and
 * the undo key brings it back, two chosen ask before Remove 2, a seat with no
 * wires opens on Add and Escape closes only the pop, and the arrows walk the
 * checkboxes. Names, status line and focus targets are read from the page's
 * accessibility tree, not from a VoiceOver run. Each line is recorded pass or
 * fail in results.json under JUNTO_E2E_FRAMES_DIR.
 *   scripts/run-e2e.sh e2e/scenarios/connections-panel.spec.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { card, canvasReady, cameraSettled } from "../harness/canvas";
import { mod } from "../harness/keys";
import { modelFixture, modelMessagesWire, modelRegion, modelSeat } from "../harness/model";
import { expect, launchJunto, test } from "../harness/launch";

const CANVAS = "connectionspanel";
const FRAMES = process.env.JUNTO_E2E_FRAMES_DIR ?? join("test-results", "connections-panel");
const s = {
  ada: modelSeat({ id: "seat-ada", label: "Ada", x: 60, y: 120 }),
  bea: modelSeat({ id: "seat-bea", label: "Bea", x: 420, y: 120 }),
  dov: modelSeat({ id: "seat-dov", label: "Dov", x: 900, y: 120 }),
  cyd: modelSeat({ id: "seat-cyd", label: "Cyd", x: 1260, y: 120 }),
};
const doc = modelFixture(
  [modelRegion({ id: "region-core", label: "Core", x: 0, y: 0, width: 740, height: 420 }), ...Object.values(s)],
  [modelMessagesWire("e-ada-bea", s.ada.id, s.bea.id, [s.ada, s.bea]), modelMessagesWire("e-ada-dov", s.ada.id, s.dov.id, [s.ada, s.dov])],
);

type Line = { readonly id: string; readonly pass: boolean; readonly note: string; readonly frames: string[] };
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("[fake-tui] a seat's Connections list", async () => {
  test.setTimeout(240_000);
  await mkdir(FRAMES, { recursive: true });
  const lines: Line[] = [];
  const junto = await launchJunto({ seedModels: { [CANVAS]: doc } });
  const page = junto.page;
  const shot = async (name: string): Promise<string> => {
    const path = join(FRAMES, `${name}.png`);
    await page.screenshot({ path });
    return path;
  };
  const panel = (): Locator => page.getByTestId("connections-panel");
  const rows = (): Locator => page.getByTestId("connections-row");
  const status = async (): Promise<string> => ((await page.getByTestId("connections-status").textContent().catch(() => "")) ?? "").trim();
  const focusNow = (): Promise<string> =>
    page.evaluate(() => {
      const a = document.activeElement;
      return `${a?.tagName ?? "none"}${a?.getAttribute("data-testid") ? `[${a.getAttribute("data-testid")}]` : ""}${a?.getAttribute("aria-label") ? ` "${a.getAttribute("aria-label")}"` : ""}${(a?.textContent ?? "").trim() !== "" && a?.tagName === "BUTTON" ? ` "${(a.textContent ?? "").trim().slice(0, 40)}"` : ""}`;
    });
  const bar = (name: RegExp): Locator => page.getByRole("button", { name });
  const openFor = async (seatId: string): Promise<void> => {
    await page.mouse.click(30, 700);
    await settle(200);
    await card(page, seatId).click();
    const key = bar(/^Connections$/);
    await expect(key).toBeVisible({ timeout: 10_000 });
    await key.click();
    await expect(panel()).toBeVisible({ timeout: 10_000 });
    await settle(400);
  };
  /** The panel for Ada, open: a failed line leaves nothing the next one depends on. */
  const ensureAda = async (): Promise<void> => {
    if ((await panel().count()) > 0 && (await panel().getAttribute("aria-label")) === "Connections, Ada") return;
    await page.keyboard.press("Escape");
    await settle(300);
    await openFor(s.ada.id);
  };
  const check = async (id: string, run: (frames: string[]) => Promise<string>): Promise<void> => {
    const frames: string[] = [];
    try {
      lines.push({ id, pass: true, note: await run(frames), frames });
    } catch (error) {
      frames.push(await shot(`${id}-FAIL`).catch(() => "no frame"));
      lines.push({ id, pass: false, note: String(error instanceof Error ? error.message : error).slice(0, 1000), frames });
    }
    await writeFile(join(FRAMES, "results.json"), `${JSON.stringify(lines, null, 2)}\n`);
  };

  try {
    await canvasReady(page, { timeout: 30_000 });
    await page.getByRole("button", { name: "Fit all nodes" }).click();
    await cameraSettled(page);

    await check("c1-lists-wires-grouped-and-bar-key-state", async (frames) => {
      await page.mouse.click(30, 700);
      await card(page, s.ada.id).click();
      const key = bar(/^Connections$/);
      await expect(key).toBeVisible({ timeout: 10_000 });
      const closed = { expanded: await key.getAttribute("aria-expanded"), popup: await key.getAttribute("aria-haspopup") };
      await key.click();
      await expect(panel()).toBeVisible({ timeout: 10_000 });
      await settle(400);
      const open = { name: await bar(/^Close connections$/).count(), expanded: await bar(/^Close connections$/).getAttribute("aria-expanded"), popup: await bar(/^Close connections$/).getAttribute("aria-haspopup") };
      const count = await rows().count();
      const groups = await panel().getByRole("list").evaluateAll((all) => all.map((l) => l.getAttribute("aria-label")));
      const sentences = await rows().evaluateAll((all) => all.map((r) => (r.querySelector(".connections-panel__name")?.textContent ?? "") + ": " + (r.querySelector(".connections-panel__sentence-text")?.textContent ?? "")));
      frames.push(await shot("c1-panel"));
      const tree = (await panel().ariaSnapshot()).replace(/\s+/g, " ").slice(0, 600);
      if (count !== 2) throw new Error(`${count} rows: ${JSON.stringify(sentences)}`);
      if (closed.expanded !== "false" || closed.popup !== "dialog" || open.expanded !== "true") throw new Error(`bar key closed ${JSON.stringify(closed)}, open ${JSON.stringify(open)}`);
      return `the bar key reads "Connections" expanded=${closed.expanded} haspopup=${closed.popup}, then "Close connections" expanded=${open.expanded}; dialog "${await panel().getAttribute("aria-label")}" lists ${count} wires ${JSON.stringify(sentences)} in groups ${JSON.stringify(groups)}; tree: ${tree}`;
    });

    await check("c2-walk-with-arrows-and-jk", async (frames) => {
      await ensureAda();
      const boxes = panel().getByRole("checkbox");
      await boxes.first().focus();
      const first = await focusNow();
      await page.keyboard.press("ArrowDown");
      await settle(250);
      const afterDown = await focusNow();
      await page.keyboard.press("ArrowUp");
      await settle(250);
      const afterUp = await focusNow();
      await page.keyboard.press("j");
      await settle(250);
      const afterJ = await focusNow();
      await page.keyboard.press("k");
      await settle(250);
      const afterK = await focusNow();
      frames.push(await shot("c2-walk"));
      if (afterDown === first || afterUp !== first || afterJ === first || afterK !== first) throw new Error(`focus: first ${first}; down ${afterDown}; up ${afterUp}; j ${afterJ}; k ${afterK}`);
      return `first checkbox ${first}; ArrowDown to ${afterDown}; ArrowUp back; J to ${afterJ}; K back`;
    });

    await check("c3-search-filters", async () => {
      await ensureAda();
      const search = panel().getByTestId("connections-search");
      await search.fill("Bea");
      await settle(400);
      const n = await rows().count();
      const said = await status();
      await search.fill("");
      await settle(300);
      if (n !== 1) throw new Error(`${n} rows for "Bea"`);
      return `search "Bea" leaves ${n} row; status line "${said}"; cleared it returns ${await rows().count()}`;
    });

    await check("c4-x-removes-without-dialog-and-undo-brings-it-back", async (frames) => {
      await ensureAda();
      const before = await rows().count();
      await rows().first().getByRole("button", { name: /^Remove:/ }).click();
      await settle(500);
      const afterRemove = await rows().count();
      const dialogs = await page.getByRole("alertdialog").count();
      const said = await status();
      const focusAfter = await focusNow();
      frames.push(await shot("c4-after-remove"));
      await page.keyboard.press(mod("Z"));
      await settle(800);
      const afterUndo = await rows().count();
      if (afterRemove !== before - 1 || dialogs !== 0 || afterUndo !== before) throw new Error(`rows ${before} -> ${afterRemove} -> ${afterUndo}, dialogs ${dialogs}`);
      return `X removed one wire (${before} to ${afterRemove}) with no dialog; status line "${said}"; focus after it ${focusAfter}; ${mod("Z")} brought it back (${afterUndo})`;
    });

    await check("c5-two-chosen-ask-then-remove", async (frames) => {
      await ensureAda();
      const boxes = panel().getByRole("checkbox");
      await boxes.nth(0).check();
      await boxes.nth(1).check();
      const foot = await panel().getByTestId("connections-foot").textContent();
      await panel().getByTestId("connections-remove-chosen").click();
      await settle(300);
      const ask = (await panel().getByRole("alert").textContent())?.trim();
      const focusAsk = await focusNow();
      frames.push(await shot("c5-asking"));
      await panel().getByRole("button", { name: "Cancel" }).click();
      await settle(300);
      const keptAfterCancel = await rows().count();
      const focusCancel = await focusNow();
      await panel().getByTestId("connections-remove-chosen").click();
      await panel().getByTestId("connections-remove-confirm").click();
      await settle(800);
      const left = await rows().count();
      const said = await status();
      const focusEnd = await focusNow();
      frames.push(await shot("c5-removed"));
      if (keptAfterCancel !== 2 || left !== 0) throw new Error(`after Cancel ${keptAfterCancel} rows, after confirm ${left}`);
      return `two chosen: foot "${(foot ?? "").trim()}"; Remove 2 asks "${ask}" with focus on ${focusAsk}; Cancel keeps both (focus ${focusCancel}); confirm removes both (${left} left), status line "${said}", focus ${focusEnd}`;
    });

    await check("c6-seat-with-no-wires-opens-on-add-and-escape-closes-only-the-pop", async (frames) => {
      await page.keyboard.press("Escape");
      await openFor(s.cyd.id);
      const focus = await focusNow();
      const empty = await rows().count();
      frames.push(await shot("c6-empty-seat"));
      await page.keyboard.press("Escape");
      await settle(400);
      const gone = (await panel().count()) === 0;
      const selected = await card(page, s.cyd.id).count();
      if (empty !== 0 || !focus.includes("connections-add") && !focus.includes("Add") || !gone) throw new Error(`rows ${empty}, focus ${focus}, panel gone ${gone}`);
      return `Cyd has no wires: the panel opens with focus on ${focus}; Escape closes the pop only (panel gone ${gone}, the seat card is still on the canvas: ${selected})`;
    });
  } finally {
    await writeFile(join(FRAMES, "results.json"), `${JSON.stringify(lines, null, 2)}\n`).catch(() => undefined);
    await junto.close();
  }
  const failed = lines.filter((l) => !l.pass);
  expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
});
