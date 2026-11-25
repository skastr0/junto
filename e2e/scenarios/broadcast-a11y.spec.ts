/**
 * [fake-tui] Quick thread Broadcast through the accessibility tree (Chromium's,
 * on the Linux display; not a VoiceOver run): the region token's name, the
 * Limits dialog (groups with headings, chips with a pressed state, the foot
 * count as a limit is toggled), the confirm (its group, its description, focus,
 * the names toggle and the region headings it opens) and the receipt (said
 * once, Done focused). Each line is recorded pass or fail with its words in
 * results.json under JUNTO_E2E_FRAMES_DIR.
 *   scripts/run-e2e.sh e2e/scenarios/broadcast-a11y.spec.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { canvasReady, cameraSettled } from "../harness/canvas";
import { mod } from "../harness/keys";
import { modelFixture, modelRegion, modelSeat } from "../harness/model";
import { expect, launchJunto, test } from "../harness/launch";

const CANVAS = "broadcasta11y";
const FRAMES = process.env.JUNTO_E2E_FRAMES_DIR ?? join("test-results", "broadcast-a11y");
const north = Array.from({ length: 5 }, (_, i) => modelSeat({ id: `seat-n${String(i)}`, label: `North ${String(i + 1)}`, x: 80 + i * 300, y: 120 }));
const south = Array.from({ length: 5 }, (_, i) => modelSeat({ id: `seat-s${String(i)}`, label: `South ${String(i + 1)}`, x: 80 + i * 300, y: 620 }));
const both = Array.from({ length: 2 }, (_, i) => modelSeat({ id: `seat-b${String(i)}`, label: `Hall ${String(i + 1)}`, x: 80 + i * 300, y: 1020 }));
const doc = modelFixture([
  modelRegion({ id: "region-big", label: "Big", x: 0, y: 0, width: 1700, height: 1300 }),
  modelRegion({ id: "region-north", label: "North", x: 40, y: 60, width: 1560, height: 360 }),
  modelRegion({ id: "region-south", label: "South", x: 40, y: 560, width: 1560, height: 360 }),
  ...north,
  ...south,
  ...both,
]);

type Line = { readonly id: string; readonly pass: boolean; readonly note: string; readonly frames: string[] };
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("[fake-tui] Quick thread Broadcast through the accessibility tree", async () => {
  test.setTimeout(240_000);
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
  const focusNow = (): Promise<string> =>
    page.evaluate(() => {
      const a = document.activeElement;
      return `${a?.tagName ?? "none"}${a?.getAttribute("data-testid") ? `[${a.getAttribute("data-testid")}]` : ""}${a?.getAttribute("aria-label") ? ` "${a.getAttribute("aria-label")}"` : ""}${a?.tagName === "BUTTON" ? ` "${(a.textContent ?? "").trim().slice(0, 40)}"` : ""}`;
    });
  const describedBy = (el: Locator): Promise<string> =>
    el.evaluate((node) => (node.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent?.trim() ?? "").join(" | "));
  const tree = async (el: Locator, n = 900): Promise<string> => (await el.ariaSnapshot()).replace(/\s+/g, " ").slice(0, n);

  try {
    await canvasReady(page, { timeout: 30_000 });
    await page.getByRole("button", { name: "Fit all nodes" }).click();
    await cameraSettled(page);
    await page.mouse.click(10, 500);
    await page.evaluate(() => {
      const w = window as unknown as { __said: Array<{ t: number; text: string; in: string }> };
      w.__said = [];
      new MutationObserver((records) => {
        for (const record of records)
          for (const node of record.addedNodes) {
            if (!(node instanceof Element) || node.closest('[aria-hidden="true"]') !== null) continue;
            const live = node.closest('[role="status"], [aria-live], [role="alert"]') ?? node.querySelector('[role="status"], [aria-live], [role="alert"]');
            if (live === null || (node.textContent ?? "").trim() === "") continue;
            w.__said.push({ t: performance.now(), text: (node.textContent ?? "").trim(), in: live.getAttribute("data-testid") ?? live.getAttribute("role") ?? live.tagName });
          }
      }).observe(document.body, { subtree: true, childList: true });
    });
    await page.keyboard.press(mod("Shift+U"));
    await expect(frame()).toBeVisible({ timeout: 10_000 });
    await field().fill("Big");
    await settle(300);
    const optionName = await frame().getByTestId("quick-thread-option").first().evaluate((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim());
    await page.keyboard.press("Enter");
    await expect(message()).toBeFocused({ timeout: 10_000 });

    await check("a1-region-token-name", async (frames) => {
      const press = frame().getByTestId("quick-thread-region-press");
      const name = await press.getAttribute("aria-label");
      frames.push(await shot("a1-token"));
      if (!/Change the limits/.test(name ?? "")) throw new Error(`token named "${String(name)}"`);
      return `the picker option read "${optionName}"; the chosen token is a button named "${String(name)}"; its tree: ${await tree(frame().getByTestId("quick-thread-region"), 300)}`;
    });

    await check("a2-limits-dialog", async (frames) => {
      await frame().getByTestId("quick-thread-region-press").click();
      const dialog = page.getByRole("dialog", { name: "Limits for Big" });
      await expect(dialog).toBeVisible({ timeout: 5_000 });
      await settle(300);
      const focus = await focusNow();
      const groups = await dialog.getByRole("group").evaluateAll((all) => all.map((g) => (document.getElementById(g.getAttribute("aria-labelledby") ?? "")?.textContent ?? "").trim()));
      const chips = await dialog.getByTestId("quick-thread-limit").evaluateAll((all) => all.map((c) => `${c.getAttribute("aria-label")} pressed=${c.getAttribute("aria-pressed")}`));
      const foot0 = ((await dialog.getByTestId("quick-thread-limit-foot").textContent().catch(() => "")) ?? "").trim();
      frames.push(await shot("a2-limits"));
      let foot1 = "";
      if (chips.length > 0) {
        await dialog.getByTestId("quick-thread-limit").first().click();
        await settle(400);
        foot1 = ((await dialog.getByTestId("quick-thread-limit-foot").textContent().catch(() => "")) ?? "").trim();
        const pressed = await dialog.getByTestId("quick-thread-limit").first().getAttribute("aria-pressed");
        foot1 += ` (first chip pressed=${String(pressed)})`;
        await dialog.getByTestId("quick-thread-limit").first().click();
        await settle(300);
      }
      const treeText = await tree(dialog, 900);
      await page.keyboard.press("Escape");
      await settle(300);
      if (groups.length === 0 || chips.length === 0) throw new Error(`groups ${JSON.stringify(groups)}, chips ${JSON.stringify(chips)}; tree ${treeText}`);
      return `dialog "Limits for Big", focus ${focus}; groups with headings ${JSON.stringify(groups)}; chips ${JSON.stringify(chips)}; foot at open "${foot0}", after toggling the first chip "${foot1}"; Escape closes it, focus then ${await focusNow()}; tree: ${treeText}`;
    });

    await check("a3-confirm-group-description-and-names", async (frames) => {
      await message().fill("Everyone: the release is out.");
      await frame().getByTestId("thread-composer-send").click();
      const confirm = page.getByTestId("quick-thread-confirm");
      await expect(confirm).toBeVisible({ timeout: 10_000 });
      await settle(400);
      const focus = await focusNow();
      const role = await confirm.getAttribute("role");
      const labelledBy = await confirm.evaluate((el) => document.getElementById(el.getAttribute("aria-labelledby") ?? "")?.textContent?.trim() ?? "");
      const description = await describedBy(confirm).catch(() => "");
      const sayings = await page.evaluate(() => (window as unknown as { __said: Array<{ text: string; in: string }> }).__said.map((s) => `${s.text} [${s.in}]`));
      const toggle = page.getByTestId("quick-thread-confirm-names").getByRole("button").first();
      const toggleName = await toggle.getAttribute("aria-label");
      const before = await toggle.getAttribute("aria-expanded");
      await toggle.click();
      await settle(400);
      const after = await toggle.getAttribute("aria-expanded");
      const namesRegion = page.getByRole("region", { name: /seats that get it/ });
      const regionName = (await namesRegion.count()) > 0 ? await namesRegion.first().getAttribute("aria-label") : null;
      const headings = (await namesRegion.count()) > 0 ? await namesRegion.first().evaluate((el) => [...el.querySelectorAll("ul")].map((u) => (document.getElementById(u.getAttribute("aria-labelledby") ?? "")?.textContent ?? "(no heading)").trim())) : [];
      const rows = await page.getByTestId("quick-thread-name").count();
      frames.push(await shot("a3-confirm-names-open"));
      await toggle.click();
      if (role !== "group") throw new Error(`confirm role ${String(role)}; focus ${focus}`);
      return `confirm is role=${role}, named by "${labelledBy}", described by "${description}"; focus on open ${focus}; live regions that spoke on opening ${JSON.stringify(sayings.slice(-4))}; the names toggle is named "${String(toggleName)}" expanded ${String(before)} then ${String(after)}; it opens a region named "${String(regionName)}" with ${rows} name rows under list headings ${JSON.stringify(headings)}`;
    });

    await check("a4-receipt-said-once-and-done-focused", async (frames) => {
      // Sample every live region's text every 50 ms from before the Send press: a saying is a change of a region's text to something non-empty.
      await page.evaluate(() => {
        const w = window as unknown as { __heard: Array<{ t: number; region: string; text: string }>; __poll?: number };
        w.__heard = [];
        const last = new Map<Element, string>();
        for (const el of document.querySelectorAll('[role="status"], [aria-live], [role="alert"]')) last.set(el, (el.textContent ?? "").trim());
        if (w.__poll !== undefined) clearInterval(w.__poll);
        w.__poll = window.setInterval(() => {
          for (const el of document.querySelectorAll('[role="status"], [aria-live], [role="alert"]')) {
            if (el.closest('[aria-hidden="true"]') !== null) continue;
            const now = (el.textContent ?? "").trim();
            if (now !== (last.get(el) ?? "") && now !== "") w.__heard.push({ t: performance.now(), region: el.getAttribute("data-testid") ?? el.getAttribute("role") ?? el.tagName, text: now });
            last.set(el, now);
          }
        }, 50);
      });
      await page.getByTestId("quick-thread-confirm-send").click();
      const receipt = frame().getByTestId("quick-thread-broadcast-receipt");
      await expect(receipt).toBeVisible({ timeout: 20_000 });
      await settle(3_000);
      const heard = (await page.evaluate(() => (window as unknown as { __heard: Array<{ region: string; text: string }> }).__heard)).map((s) => `${s.text} [${s.region}]`);
      const focus = await focusNow();
      const receiptText = ((await receipt.textContent()) ?? "").replace(/\s+/g, " ").trim();
      frames.push(await shot("a4-receipt"));
      const done = frame().getByTestId("quick-thread-done");
      const doneDescription = await describedBy(done).catch(() => "");
      await done.click().catch(() => undefined);
      const receiptSayings = heard.filter((t) => /get it|have it|Sent/.test(t));
      if (receiptSayings.length !== 1) throw new Error(`the receipt was said ${receiptSayings.length} times; every change heard ${JSON.stringify(heard)}; focus ${focus}; receipt "${receiptText}"`);
      return `receipt text "${receiptText}"; said once: ${JSON.stringify(receiptSayings)} (every region change heard: ${JSON.stringify(heard)}); focus after Send ${focus}; Done is described by "${doneDescription}"`;
    });
  } finally {
    await writeFile(join(FRAMES, "results.json"), `${JSON.stringify(lines, null, 2)}\n`).catch(() => undefined);
    await junto.close();
  }
  const failed = lines.filter((l) => !l.pass);
  expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
});
