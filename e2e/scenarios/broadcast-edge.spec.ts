/**
 * [fake-tui] A Broadcast to a region with seats straddling its edge (c2b5600ed):
 * the confirm says "15 seats cross the edge of Big and are not included." in its
 * description and in the live line it opens with, lists them under its own
 * disclosure, and the send reaches only the seats inside. Seats are packed 170
 * px apart in a 1760x700 region, so 15 of the 60 sit on the edge. Names and live
 * text come from the accessibility tree, not from a VoiceOver run. Each line is
 * recorded pass or fail in results.json under JUNTO_E2E_FRAMES_DIR.
 *   scripts/run-e2e.sh e2e/scenarios/broadcast-edge.spec.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { canvasReady, cameraSettled } from "../harness/canvas";
import { mod } from "../harness/keys";
import { modelFixture, modelRegion, modelSeat } from "../harness/model";
import { readSeatMailbox } from "../harness/work-mail";
import { expect, launchJunto, test } from "../harness/launch";

const CANVAS = "broadcastedge";
const FRAMES = process.env.JUNTO_E2E_FRAMES_DIR ?? join("test-results", "broadcast-edge");
const seats = Array.from({ length: 60 }, (_, i) => modelSeat({ id: `seat-s${String(i)}`, label: `Seat ${String(i).padStart(2, "0")}`, x: 40 + (i % 10) * 170, y: 80 + Math.floor(i / 10) * 110 }));
const doc = modelFixture([modelRegion({ id: "region-big", label: "Big", x: 0, y: 0, width: 1760, height: 700 }), ...seats]);

type Line = { readonly id: string; readonly pass: boolean; readonly note: string; readonly frames: string[] };
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("[fake-tui] Broadcast to a region with seats on its edge", async () => {
  test.setTimeout(300_000);
  await mkdir(FRAMES, { recursive: true });
  const lines: Line[] = [];
  const junto = await launchJunto({ seedModels: { [CANVAS]: doc } });
  const page: Page = junto.page;
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
      lines.push({ id, pass: false, note: String(error instanceof Error ? error.message : error).slice(0, 3000), frames });
    }
    await writeFile(join(FRAMES, "results.json"), `${JSON.stringify(lines, null, 2)}\n`);
  };
  const frame = (): Locator => page.getByTestId("quick-thread");
  const field = (): Locator => frame().getByRole("combobox", { name: "Seat or region" });
  const message = (): Locator => frame().getByTestId("thread-composer-input");
  const describedBy = (el: Locator): Promise<string> =>
    el.evaluate((node) => (node.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent?.trim() ?? "").join(" | "));
  const text = "The release is out for the seats inside Big.";

  try {
    await canvasReady(page, { timeout: 30_000 });
    await page.getByRole("button", { name: "Fit all nodes" }).click();
    await cameraSettled(page);
    await page.mouse.click(10, 500);
    // Every live region's text, sampled every 50 ms: a saying is a change to something non-empty.
    await page.evaluate(() => {
      const w = window as unknown as { __said: string[]; __poll?: number };
      w.__said = [];
      const last = new Map<Element, string>();
      w.__poll = window.setInterval(() => {
        for (const el of document.querySelectorAll('[role="status"], [aria-live], [role="alert"]')) {
          if (el.closest('[aria-hidden="true"]') !== null) continue;
          const now = (el.textContent ?? "").trim();
          if (now !== (last.get(el) ?? "") && now !== "") w.__said.push(`${now} [${el.getAttribute("data-testid") ?? el.getAttribute("role") ?? el.tagName}]`);
          last.set(el, now);
        }
      }, 50);
    });
    await page.keyboard.press(mod("Shift+U"));
    await expect(frame()).toBeVisible({ timeout: 10_000 });
    await field().fill("Big");
    await page.keyboard.press("Enter");
    await expect(message()).toBeFocused({ timeout: 15_000 });
    await message().fill(text);

    let crossingNames: string[] = [];
    await check("e1-confirm-says-the-edge-in-description-and-live-line", async (frames) => {
      const mark = await page.evaluate(() => (window as unknown as { __said: string[] }).__said.length);
      await frame().getByTestId("thread-composer-send").click();
      const confirm = page.getByTestId("quick-thread-confirm");
      await expect(confirm).toBeVisible({ timeout: 15_000 });
      await settle(800);
      const title = await confirm.evaluate((el) => document.getElementById(el.getAttribute("aria-labelledby") ?? "")?.textContent?.trim() ?? "");
      const description = await describedBy(confirm);
      const said = (await page.evaluate(() => (window as unknown as { __said: string[] }).__said)).slice(mark);
      const line = page.getByTestId("quick-thread-crossing");
      const lineText = ((await line.first().textContent().catch(() => "")) ?? "").trim();
      frames.push(await shot("e1-confirm"));
      const m = /^(\d+) seats are partly inside Big and are not included\.$/.exec(lineText);
      if (m === null || !description.includes(lineText) || !said.some((s) => s.includes(lineText))) throw new Error(`edge line "${lineText}"; description "${description}"; spoken ${JSON.stringify(said)}`);
      return `confirm named "${title}", described by "${description}"; the line "${lineText}" is a paragraph on the confirm and in its live line ${JSON.stringify(said)}`;
    });

    await check("e2-crossing-seats-listed-under-their-own-heading", async (frames) => {
      const toggle = page.getByTestId("quick-thread-crossing-names").getByRole("button").first();
      if ((await toggle.count()) === 0) throw new Error(`no crossing toggle; test ids in the confirm: ${JSON.stringify(await page.getByTestId("quick-thread-confirm").locator("[data-testid]").evaluateAll((all) => all.map((e) => e.getAttribute("data-testid"))))}; buttons: ${JSON.stringify(await page.getByTestId("quick-thread-confirm").getByRole("button").evaluateAll((all) => all.map((e) => e.getAttribute("aria-label") ?? e.textContent)))}`);
      const name = await toggle.getAttribute("aria-label");
      const before = await toggle.getAttribute("aria-expanded");
      await toggle.click();
      await settle(500);
      const region = page.getByRole("region", { name: /partly inside Big, not included/ });
      const regionName = await region.first().getAttribute("aria-label");
      crossingNames = await region.first().getByTestId("quick-thread-name").evaluateAll((all) => all.map((e) => e.getAttribute("data-seat") ?? ""));
      frames.push(await shot("e2-crossing-names"));
      await toggle.click();
      if (crossingNames.length === 0) throw new Error(`no names under "${String(regionName)}"`);
      if (name !== "Show the 15 seats partly inside Big" || regionName !== "The 15 seats partly inside Big, not included") throw new Error(`toggle "${String(name)}", list "${String(regionName)}"`);
      return `the toggle reads "${String(await toggle.textContent())}" and is named "${String(name)}" (expanded ${String(before)} then true); it opens a region named "${String(regionName)}" listing ${crossingNames.length} seats, apart from "The 45 seats that get it"`;
    });

    await check("e3-the-send-reaches-only-the-seats-inside", async (frames) => {
      const confirmSend = page.getByTestId("quick-thread-confirm-send");
      const label = ((await confirmSend.textContent()) ?? "").trim();
      await confirmSend.click();
      await expect(frame().getByTestId("quick-thread-broadcast-receipt")).toBeVisible({ timeout: 30_000 });
      await settle(3_000);
      const have: string[] = [];
      for (const seat of seats) {
        const mails = (await readSeatMailbox(page, CANVAS, seat.id)).filter((m) => JSON.stringify(m.parts).includes(text));
        if (mails.length > 0) have.push(seat.id);
      }
      frames.push(await shot("e3-receipt"));
      const receipt = ((await frame().getByTestId("quick-thread-broadcast-receipt").textContent()) ?? "").replace(/\s+/g, " ").trim();
      const crossingGot = crossingNames.filter((id) => have.includes(id));
      if (have.length !== 45 || crossingGot.length > 0) throw new Error(`${have.length} seats got it, ${crossingGot.length} of the edge seats got it; button "${label}"; receipt "${receipt}"`);
      return `Send button "${label}"; ${have.length} seats got one mail each, none of the ${crossingNames.length} edge seats did; receipt "${receipt}"`;
    });
  } finally {
    await writeFile(join(FRAMES, "results.json"), `${JSON.stringify(lines, null, 2)}\n`).catch(() => undefined);
    await junto.close();
  }
  const failed = lines.filter((l) => !l.pass);
  expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
});
