/**
 * [fake-tui] The top bar's Threads button (913a79307): its count is the threads
 * with unread mail, the rows Global threads lists under its Unread filter. It
 * moves when a seat replies and when the operator reads a thread, opens Global
 * threads when pressed and closes it when pressed again. Each line is recorded
 * pass or fail in results.json under JUNTO_E2E_FRAMES_DIR.
 *   scripts/run-e2e.sh e2e/scenarios/threads-button.spec.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { canvasReady, cameraSettled } from "../harness/canvas";
import { crewOccupySeat, crewPlayFactory, crewSeat, installCrewSeatHarness } from "../harness/crew-fixture";
import { mod } from "../harness/keys";
import { modelFixture, modelSeat } from "../harness/model";
import { expect, launchJunto, test } from "../harness/launch";

const CANVAS = "threadsbutton";
const FRAMES = process.env.JUNTO_E2E_FRAMES_DIR ?? join("test-results", "threads-button");
const s = {
  ada: modelSeat({ id: "seat-ada", label: "Ada", x: 60, y: 120 }),
  bea: modelSeat({ id: "seat-bea", label: "Bea", x: 400, y: 120 }),
  dov: modelSeat({ id: "seat-dov", label: "Dov", x: 740, y: 120 }),
};
const doc = modelFixture(Object.values(s));

type Line = { readonly id: string; readonly pass: boolean; readonly note: string; readonly frames: string[] };
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("[fake-tui] the Threads button count", async () => {
  test.setTimeout(240_000);
  await mkdir(FRAMES, { recursive: true });
  const lines: Line[] = [];
  const junto = await launchJunto({ seedModels: { [CANVAS]: doc }, afterSeed: installCrewSeatHarness });
  const page = junto.page;
  const shot = async (name: string): Promise<string> => {
    const path = join(FRAMES, `${name}.png`);
    await page.screenshot({ path });
    return path;
  };
  const check = async (id: string, run: (frames: string[]) => Promise<string>): Promise<void> => {
    const frames: string[] = [];
    try {
      lines.push({ id, pass: true, note: await run(frames), frames });
    } catch (error) {
      frames.push(await shot(`${id}-FAIL`).catch(() => "no frame"));
      lines.push({ id, pass: false, note: String(error instanceof Error ? error.message : error).slice(0, 900), frames });
      for (let i = 0; i < 3 && (await modal().count()) > 0; i += 1) await page.keyboard.press("Escape");
    }
    await writeFile(join(FRAMES, "results.json"), `${JSON.stringify(lines, null, 2)}\n`);
  };
  const button = (): Locator => page.getByTestId("threads-trigger");
  const modal = (): Locator => page.locator(".operator-threads").first();
  const label = async (): Promise<string> => (await button().getAttribute("aria-label")) ?? "";
  const pill = async (): Promise<string> => ((await button().locator(".operator-feed-trigger__count").textContent().catch(() => null)) ?? "").trim();
  const unreadRows = async (): Promise<number> => {
    const opened = (await modal().count()) > 0;
    if (!opened) await page.keyboard.press(mod("U"));
    await expect(modal()).toBeVisible({ timeout: 10_000 });
    const chip = page.getByTestId("threads-unread-chip");
    if ((await chip.getAttribute("aria-pressed")) !== "true") await chip.click();
    await settle(600);
    const n = await page.getByTestId("operator-threads-row").count();
    const chipLabel = (await chip.getAttribute("aria-label")) ?? "";
    await chip.click();
    if (!opened) await page.keyboard.press("Escape");
    await expect(modal()).toHaveCount(opened ? 1 : 0, { timeout: 5_000 });
    lastChip = chipLabel;
    return n;
  };
  let lastChip = "";
  const send = (nodeId: string, text: string) =>
    page.evaluate(async ([canvasName, id, body]) => window.junto!.seatThreadSend({ canvasName, nodeId: id, text: body } as never), [CANVAS, nodeId, text] as const);

  try {
    await canvasReady(page, { timeout: 30_000 });
    await page.getByRole("button", { name: "Fit all nodes" }).click();
    await cameraSettled(page);
    await crewPlayFactory(page);
    const seat = { ada: crewSeat(junto.sandbox, CANVAS, s.ada.id), bea: crewSeat(junto.sandbox, CANVAS, s.bea.id), dov: crewSeat(junto.sandbox, CANVAS, s.dov.id) };
    for (const [id, c] of [[s.ada.id, seat.ada], [s.bea.id, seat.bea], [s.dov.id, seat.dov]] as const) await crewOccupySeat(page, CANVAS, { id }, c);
    const sent = { ada: await send(s.ada.id, "Alpha?"), bea: await send(s.bea.id, "Bravo?"), dov: await send(s.dov.id, "Delta?") };
    for (const r of Object.values(sent)) if (!r.ok) throw new Error(`send refused ${JSON.stringify(r)}`);
    await settle(500);

    await check("b1-nothing-unread", async (frames) => {
      const l = await label();
      frames.push(await shot("b1-top-bar"));
      if (l !== "Threads, nothing unread" || (await pill()) !== "") throw new Error(`label "${l}", pill "${await pill()}"`);
      return `label "${l}", no pill, before any seat answers (accessible name; accessibility tree)`;
    });

    const reply = async (c: ReturnType<typeof crewSeat>, to: { ok: boolean; messageId?: string }, text: string) => {
      const r = await c.op("msg.reply", { target: "operator", inReplyTo: to.ok ? to.messageId : "", text });
      if (!r.ok) throw new Error(`reply refused ${JSON.stringify(r)}`);
      await settle(600);
    };
    await check("b2-moves-when-seats-reply", async (frames) => {
      await reply(seat.ada, sent.ada as never, "Alpha, yes.");
      await expect.poll(label, { timeout: 10_000 }).toBe("Threads, 1 unread");
      await reply(seat.dov, sent.dov as never, "Delta, yes.");
      await expect.poll(label, { timeout: 10_000 }).toBe("Threads, 2 unread");
      frames.push(await shot("b2-two-unread"));
      return `two seats answered: label "${await label()}", pill "${await pill()}"`;
    });

    await check("b3-matches-unread-filter", async (frames) => {
      const rowsListed = await unreadRows();
      const l = await label();
      frames.push(await shot("b3-after-filter"));
      const n = Number(/\d+/.exec(l)?.[0] ?? "0");
      const chipN = Number(/\d+/.exec(lastChip)?.[0] ?? "-1");
      if (n !== rowsListed || chipN !== n) throw new Error(`button "${l}", the Unread filter lists ${rowsListed} rows, its chip reads "${lastChip}"`);
      return `button "${l}" equals the ${rowsListed} rows Global threads lists under Unread (the chip itself reads "${lastChip}")`;
    });

    await check("b4-a-second-mail-in-one-thread", async () => {
      await reply(seat.ada, sent.ada as never, "Alpha, one more thing.");
      await settle(600);
      const l = await label();
      const rowsListed = await unreadRows();
      if (l !== "Threads, 2 unread" || rowsListed !== 2 || Number(/\d+/.exec(lastChip)?.[0] ?? "-1") !== 2) throw new Error(`button "${l}", rows ${rowsListed}, chip "${lastChip}"`);
      return `Ada answers a second time in the same thread: button stays "${l}" (threads, not mails), rows ${rowsListed}, chip "${lastChip}": all three read threads (536e0383e)`;
    });

    await check("b5-moves-when-the-operator-reads", async (frames) => {
      await button().click();
      await expect(modal()).toBeVisible({ timeout: 10_000 });
      await page.getByTestId("operator-threads-row").filter({ hasText: "Dov" }).first().click();
      await expect(page.getByTestId("operator-threads-pane")).toContainText("Delta, yes.", { timeout: 10_000 });
      await expect.poll(label, { timeout: 10_000 }).toBe("Threads, 1 unread");
      frames.push(await shot("b5-after-read"));
      return `reading Dov's thread: button "${await label()}", pill "${await pill()}", while Global threads is open`;
    });

    await check("b6-toggles-global-threads", async () => {
      if ((await modal().count()) === 0) await button().click();
      await expect(button()).toHaveAttribute("aria-expanded", "true");
      // Pressed from the keyboard: a pointer cannot reach it while Global threads is open (line b7).
      await button().evaluate((el) => (el as HTMLButtonElement).click());
      await expect(modal()).toHaveCount(0, { timeout: 5_000 });
      await expect(button()).toHaveAttribute("aria-expanded", "false");
      await button().click();
      await expect(modal()).toBeVisible({ timeout: 5_000 });
      await page.keyboard.press(mod("U"));
      await expect(modal()).toHaveCount(0, { timeout: 5_000 });
      return "the button opens Global threads and a second press closes it (aria-expanded true then false); the key closes it too";
    });

    // 494cc8712, 707e6dd14: a wide operator panel opens under the top bar (its top clears the bar), the dim still covers the bar, and a press on the bar's button lands on the dim and closes the panel.
    const underBar = async (id: string, trigger: Locator, openIt: () => Promise<void>, panelSel: string, frames: string[]): Promise<string> => {
      await openIt();
      const panel = page.locator(panelSel).first();
      await expect(panel).toBeVisible({ timeout: 10_000 });
      const geo = await panel.evaluate((el) => {
        const frame = el.closest('[role="dialog"]') ?? el;
        return { top: Math.round(frame.getBoundingClientRect().top), viewport: `${window.innerWidth}x${window.innerHeight}`, bar: Math.round(document.querySelector("header")?.getBoundingClientRect().bottom ?? 0) };
      });
      frames.push(await shot(`${id}-open`));
      const box = await trigger.boundingBox();
      if (box === null) throw new Error("no box for the bar button");
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await expect(panel).toHaveCount(0, { timeout: 5_000 });
      if (geo.top < 64) throw new Error(`the panel's top is ${geo.top}px at ${geo.viewport}, not under the 64px bar`);
      return `at ${geo.viewport} the panel's top is ${geo.top}px (the bar ends at ${geo.bar}px); a pointer press on the bar button closes it`;
    };
    await check("b7-threads-opens-under-the-bar-and-a-bar-press-closes", async (frames) => underBar("b7", button(), async () => { await button().click(); }, ".operator-threads", frames));
    await check("b8-needs-you-opens-under-the-bar-and-a-bar-press-closes", async (frames) =>
      underBar("b8", page.getByTestId("operator-feed-trigger"), async () => { await page.getByTestId("operator-feed-trigger").click(); }, ".operator-feed, [data-testid='operator-feed']", frames));
    // f184af92e: the bar is live under a wide panel: one press on Threads switches Needs you to Threads, and the open panel's own button closes it.
    await check("b9-needs-you-to-threads-in-one-press", async (frames) => {
      const needs = page.getByTestId("operator-feed-trigger");
      await needs.click();
      await expect(page.locator(".operator-feed, [data-testid='operator-feed']").first()).toBeVisible({ timeout: 10_000 });
      await button().click();
      await expect(modal()).toBeVisible({ timeout: 5_000 });
      const feedGone = (await page.locator(".operator-feed, [data-testid='operator-feed']").count()) === 0;
      frames.push(await shot("b9-threads-after-one-press"));
      await button().click();
      await expect(modal()).toHaveCount(0, { timeout: 5_000 });
      if (!feedGone) throw new Error("Needs you stayed open under Threads");
      return "with Needs you open, one press on the bar's Threads button opened Threads and closed Needs you; a press on the open Threads button closed it";
    });
    await check("b10-needs-you-at-600-high", async (frames) => {
      const original = await junto.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getSize());
      await junto.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1320, 600));
      await settle(800);
      try {
        await page.getByTestId("operator-feed-trigger").click();
        const panel = page.locator(".operator-feed, [data-testid='operator-feed']").first();
        await expect(panel).toBeVisible({ timeout: 10_000 });
        await settle(500);
        const geo = await panel.evaluate((el) => {
          const frame = el.closest('[role="dialog"]') ?? el;
          const r = frame.getBoundingClientRect();
          return { top: Math.round(r.top), bottom: Math.round(r.bottom), viewport: `${window.innerWidth}x${window.innerHeight}`, rows: document.querySelectorAll("[data-testid='feed-card'], [data-testid='operator-feed-card'], [data-feed-card]").length };
        });
        frames.push(await shot("b10-needs-you-600"));
        await page.keyboard.press("Escape");
        return `viewport ${geo.viewport}: Needs you's panel runs ${geo.top} to ${geo.bottom}px (the bar ends at 64); cards in the DOM ${geo.rows} (this canvas has no signal raised, so the list is empty: a layout check only)`;
      } finally {
        await junto.app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0]!.setSize(w!, h!), original as [number, number]);
      }
    });
  } finally {
    await writeFile(join(FRAMES, "results.json"), `${JSON.stringify(lines, null, 2)}\n`).catch(() => undefined);
    await junto.close();
  }
  const failed = lines.filter((l) => !l.pass);
  expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
});
