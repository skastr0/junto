/**
 * [fake-tui] The needs-you feed with a chain of signals raised in order
 * (a2f535b68 768f347cb 9b2baffaf d6e392d37 and the withdrawn-draft note
 * 0cb0ebfef): it opens on In order to act with three rows, a quick reply (a
 * digit) answers the selected card and the next one is on top and selected
 * with no scrolling, the Depends on link and W go to what a card waits on and
 * keep the keyboard in the feed, and a signal withdrawn while a draft is half
 * typed leaves the card with its note and a locked reply. Names and live text
 * come from the page's accessibility tree, not from a VoiceOver run. Each line
 * is recorded pass or fail in results.json under JUNTO_E2E_FRAMES_DIR.
 *   scripts/run-e2e.sh e2e/scenarios/feed-signal-order.spec.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { canvasReady, cameraSettled } from "../harness/canvas";
import { crewOccupySeat, crewPlayFactory, crewSeat, installCrewSeatHarness } from "../harness/crew-fixture";
import { modelFixture, modelSeat } from "../harness/model";
import { expect, launchJunto, test } from "../harness/launch";

const CANVAS = "feedorder";
const FRAMES = process.env.JUNTO_E2E_FRAMES_DIR ?? join("test-results", "feed-signal-order");
const ada = modelSeat({ id: "seat-ada", label: "Ada", x: 60, y: 120 });
const bea = modelSeat({ id: "seat-bea", label: "Bea", x: 400, y: 120 });
const doc = modelFixture([ada, bea]);

type Line = { readonly id: string; readonly pass: boolean; readonly note: string; readonly frames: string[] };
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const idOf = (result: unknown): string => /"signalId":"([0-9A-Z]{26})"/.exec(JSON.stringify(result))?.[1] ?? "";

test("[fake-tui] the feed with a chain of signals", async () => {
  test.setTimeout(300_000);
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
      lines.push({ id, pass: false, note: String(error instanceof Error ? error.message : error).slice(0, 2500), frames });
    }
    await writeFile(join(FRAMES, "results.json"), `${JSON.stringify(lines, null, 2)}\n`);
  };
  const cards = (): Locator => page.getByTestId("operator-feed-card");
  const cardTexts = (): Promise<string[]> => cards().evaluateAll((all) => all.map((c) => (c.getAttribute("aria-label") ?? "") + " || " + (c.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120)));
  const selectedHeadline = (): Promise<string> =>
    page.evaluate(() => {
      const d = document.querySelector('[data-testid="operator-feed-detail"]');
      return (d?.querySelector(".operator-feed__body")?.textContent ?? d?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 100);
    });
  const announce = (): Promise<string> => page.evaluate(() => (document.querySelector(".operator-feed__announce")?.textContent ?? "").trim());
  const focusNow = (): Promise<string> =>
    page.evaluate(() => {
      const a = document.activeElement;
      return `${a?.tagName ?? "none"}${a?.getAttribute("data-testid") ? `[${a.getAttribute("data-testid")}]` : ""}${a?.getAttribute("aria-label") ? ` "${a.getAttribute("aria-label")}"` : ""}`;
    });
  const feedOpen = async (): Promise<void> => {
    if ((await page.getByTestId("operator-feed").count()) === 0) await page.getByTestId("operator-feed-trigger").click();
    await expect(page.getByTestId("operator-feed").first()).toBeVisible({ timeout: 10_000 });
  };

  try {
    await canvasReady(page, { timeout: 30_000 });
    await page.getByRole("button", { name: "Fit all nodes" }).click();
    await cameraSettled(page);
    await crewPlayFactory(page);
    const a = crewSeat(junto.sandbox, CANVAS, ada.id);
    const b = crewSeat(junto.sandbox, CANVAS, bea.id);
    await crewOccupySeat(page, CANVAS, { id: ada.id }, a);
    await crewOccupySeat(page, CANVAS, { id: bea.id }, b);
    // Ten signals from Ada in order (each depends on the last), and one from Bea.
    const ids: string[] = [];
    for (let i = 1; i <= 10; i += 1) {
      const r = await a.op("signal.raise", { kind: "escalate", text: `Step ${String(i)}: go on?`, suggest: ["Yes", "No"], ...(i > 1 ? { dependsOnLast: true } : {}) });
      if (!r.ok) throw new Error(`raise ${String(i)} refused ${JSON.stringify(r)}`);
      ids.push(idOf(r));
      await settle(150);
    }
    const other = await b.op("signal.raise", { kind: "escalate", text: "Bea asks: ship it?", suggest: ["Yes", "No"] });
    if (!other.ok) throw new Error(`Bea's raise refused ${JSON.stringify(other)}`);
    await settle(1_000);

    await check("f1-opens-on-in-order-with-three-rows-of-the-chain", async (frames) => {
      await page.getByTestId("operator-feed-trigger").click();
      await expect(cards().first()).toBeVisible({ timeout: 15_000 });
      await settle(600);
      const order = ((await page.locator('button[aria-label="Order"], [aria-label^="Order"]').first().textContent().catch(() => "")) ?? "").trim();
      const texts = await cardTexts();
      const fold = await page.getByTestId("feed-chain-fold").allTextContents();
      frames.push(await shot("f1-feed"));
      return `order control "${order}"; ${texts.length} cards: ${JSON.stringify(texts)}; fold ${JSON.stringify(fold.map((t) => t.replace(/\s+/g, " ").trim()))}`;
    });

    await check("f2-answer-with-1-the-next-is-on-top-and-selected", async (frames) => {
      await feedOpen();
      const seen: string[] = [];
      for (let i = 1; i <= 3; i += 1) {
        const head = await selectedHeadline();
        const top = (await cardTexts())[0] ?? "";
        const scroll = await page.getByTestId("operator-feed").first().evaluate((el) => el.scrollTop);
        seen.push(`selected "${head.slice(0, 40)}"; first card "${top.slice(0, 70)}"; scrollTop ${scroll}`);
        await page.keyboard.press("1");
        await settle(900);
      }
      frames.push(await shot("f2-after-three"));
      const said = await announce();
      return `three answers with the key 1: ${JSON.stringify(seen)}; live line now "${said}"; focus ${await focusNow()}`;
    });

    await check("f3-depends-link-and-w-keep-the-keyboard-in-the-feed", async (frames) => {
      await feedOpen();
      // A card that waits on another: the second row of the chain.
      const waiting = cards().filter({ hasText: "Not ready, depends on another signal" });
      const n = await waiting.count();
      if (n === 0) throw new Error(`no waiting card among ${JSON.stringify(await cardTexts())}`);
      await waiting.first().click();
      await settle(500);
      const before = await selectedHeadline();
      const link = page.getByTestId("feed-depends-link").first();
      const linkName = (await link.count()) > 0 ? await link.getAttribute("aria-label") : null;
      await page.keyboard.press("w");
      await settle(700);
      const afterW = { selected: await selectedHeadline(), said: await announce(), focus: await focusNow() };
      frames.push(await shot("f3-after-w"));
      // The link, on a waiting card again.
      await waiting.first().click().catch(() => undefined);
      await settle(400);
      let afterLink: unknown = "no link";
      if ((await link.count()) > 0) {
        await link.focus();
        await page.keyboard.press("Enter");
        await settle(700);
        afterLink = { selected: await selectedHeadline(), said: await announce(), focus: await focusNow() };
      }
      await page.keyboard.press("ArrowDown");
      await settle(300);
      const arrows = await selectedHeadline();
      return `waiting cards ${n}; on "${before}" the Depends on link is named "${String(linkName)}"; W: ${JSON.stringify(afterW)}; Enter on the link: ${JSON.stringify(afterLink)}; an arrow right after moves the selection to "${arrows}"`;
    });

    await check("f4-ready-chip", async (frames) => {
      await feedOpen();
      const chip = page.getByTestId("feed-ready-chip");
      const before = { pressed: await chip.getAttribute("aria-pressed"), name: await chip.getAttribute("aria-label"), cards: await cards().count() };
      await chip.click();
      await settle(500);
      const after = { pressed: await chip.getAttribute("aria-pressed"), cards: await cards().count(), texts: await cardTexts() };
      frames.push(await shot("f4-ready-on"));
      await chip.click();
      return `Ready chip ${JSON.stringify(before)} then ${JSON.stringify(after)}`;
    });

    await check("f4b-j-k-step-line", async (frames) => {
      await feedOpen();
      const says: string[] = [];
      // The keys act in the list: put the keyboard on a card first (the last line left it on the Ready chip).
      await cards().first().click();
      await settle(500);
      const first = await selectedHeadline();
      for (const key of ["j", "j", "k"]) {
        await page.keyboard.press(key);
        await settle(600);
        says.push(`${key}: "${await announce()}" (selected ${(await selectedHeadline()).slice(0, 60)})`);
      }
      frames.push(await shot("f4b-after-jk"));
      return `from "${first.slice(0, 60)}": ${JSON.stringify(says)}; focus ${await focusNow()}`;
    });

    await check("f4c-the-fold-name-and-enter", async (frames) => {
      await feedOpen();
      const fold = page.getByTestId("feed-chain-fold");
      if ((await fold.count()) === 0) throw new Error(`no fold; cards ${JSON.stringify(await cardTexts())}`);
      const button = fold.getByRole("button").or(fold).first();
      const name = (await button.getAttribute("aria-label")) ?? (await button.textContent());
      const cardsBefore = await cards().count();
      await button.focus();
      const focusOn = await focusNow();
      await page.keyboard.press("Enter");
      await settle(700);
      const said = await announce();
      const cardsAfter = await cards().count();
      frames.push(await shot("f4c-fold-opened"));
      return `the fold is named "${String(name).trim()}"; focus ${focusOn}; Enter: live line "${said}", cards ${cardsBefore} to ${cardsAfter}; focus then ${await focusNow()}`;
    });

    await check("f5-withdrawn-before-the-answer-with-a-half-typed-draft", async (frames) => {
      await feedOpen();
      const bea = cards().filter({ hasText: "Bea" }).first();
      await bea.click();
      await settle(500);
      await page.keyboard.press("Enter");
      await settle(400);
      const box = page.getByTestId("operator-feed-detail").locator("textarea").first();
      await expect(box).toBeVisible({ timeout: 5_000 });
      await box.fill("A half-typed answer");
      const cleared = await b.op("signal.clear", { signalId: idOf(other) });
      if (!cleared.ok) throw new Error(`withdraw refused ${JSON.stringify(cleared)}`);
      await settle(1_500);
      const note = page.getByTestId("feed-crossed");
      const noteText = ((await note.textContent().catch(() => "")) ?? "").trim();
      const readOnly = await page.getByTestId("operator-feed-detail").locator("textarea").first().evaluate((el) => (el as HTMLTextAreaElement).readOnly).catch(() => null);
      const draft = await page.getByTestId("operator-feed-detail").locator("textarea").first().inputValue().catch(() => null);
      const focus = await focusNow();
      const said = await announce();
      const sendDisabled = await page.getByTestId("operator-feed-detail").getByRole("button", { name: /^Send/ }).first().isDisabled().catch(() => null);
      frames.push(await shot("f5-withdrawn-with-draft"));
      if (!noteText.includes("withdrew") || readOnly !== true || draft !== "A half-typed answer" || sendDisabled !== true)
        throw new Error(`the card should stay with its note, the draft locked and Send off: note "${noteText}"; reply read-only ${String(readOnly)}, draft "${String(draft)}", Send disabled ${String(sendDisabled)}; focus ${focus}; live line "${said}"; the selected card is now "${await selectedHeadline()}"`);
      return `note "${noteText}"; reply read-only ${String(readOnly)}, draft "${String(draft)}", Send disabled ${String(sendDisabled)}; focus ${focus}; live line "${said}"`;
    });
  } finally {
    await writeFile(join(FRAMES, "results.json"), `${JSON.stringify(lines, null, 2)}\n`).catch(() => undefined);
    await junto.close();
  }
  const failed = lines.filter((l) => !l.pass);
  expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
});
