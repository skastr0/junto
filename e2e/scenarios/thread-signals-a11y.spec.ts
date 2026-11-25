/**
 * [fake-tui] Signals in a thread, through the accessibility tree (Chromium's, on
 * the Linux display; not a VoiceOver run): what the reply field is described
 * as with an open plain signal and with none, where the reply line's button
 * lands focus, what a signal that asks for work names its Hand in, and what the
 * thread says aloud when a signal is withdrawn while it is on screen.
 *
 * Each line is recorded pass or fail with its words in results.json under
 * JUNTO_E2E_FRAMES_DIR (default test-results/thread-signals-a11y).
 *   scripts/run-e2e.sh e2e/scenarios/thread-signals-a11y.spec.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { canvasReady, cameraSettled } from "../harness/canvas";
import { crewOccupySeat, crewPlayFactory, crewSeat, installCrewSeatHarness } from "../harness/crew-fixture";
import { mod } from "../harness/keys";
import { modelFixture, modelSeat } from "../harness/model";
import { expect, launchJunto, test } from "../harness/launch";

const CANVAS = "threadsignals";
const FRAMES = process.env.JUNTO_E2E_FRAMES_DIR ?? join("test-results", "thread-signals-a11y");
const ada = modelSeat({ id: "seat-ada", label: "Ada", x: 60, y: 120 });
const doc = modelFixture([ada]);

type Line = { readonly id: string; readonly pass: boolean; readonly note: string; readonly frames: string[] };
const PLAIN = "Which build do you want shipped?";
const ASKS = "Need the deploy token";

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const idOf = (result: unknown): string => /"signalId":"([0-9A-Z]{26})"/.exec(JSON.stringify(result))?.[1] ?? "";

test("[fake-tui] signals in a thread through the accessibility tree", async () => {
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
      lines.push({ id, pass: false, note: String(error instanceof Error ? error.message : error).slice(0, 1200), frames });
    }
    await writeFile(join(FRAMES, "results.json"), `${JSON.stringify(lines, null, 2)}\n`);
  };
  const pane = (): Locator => page.getByTestId("operator-threads-pane");
  const descriptionOf = (el: Locator): Promise<string> =>
    el.evaluate((node) => (node.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent?.trim() ?? "").join(" | "));

  try {
    await canvasReady(page, { timeout: 30_000 });
    await page.getByRole("button", { name: "Fit all nodes" }).click();
    await cameraSettled(page);
    await crewPlayFactory(page);
    const seat = crewSeat(junto.sandbox, CANVAS, ada.id);
    await crewOccupySeat(page, CANVAS, { id: ada.id }, seat);
    const started = await page.evaluate(async ([canvasName, id]) => window.junto!.seatThreadSend({ canvasName, nodeId: id, text: "Status of the build?" } as never), [CANVAS, ada.id] as const);
    if (!started.ok) throw new Error(`send refused ${JSON.stringify(started)}`);
    const threadId = started.threadId;
    await settle(800);
    const plain = await seat.op("signal.raise", { kind: "escalate", text: PLAIN, thread: threadId });
    if (!plain.ok) throw new Error(`plain signal refused ${JSON.stringify(plain)}`);
    const asks = await seat.op("signal.raise", { kind: "blocked", text: ASKS, thread: threadId, form: { kind: "proof" } });
    if (!asks.ok) throw new Error(`asking signal refused ${JSON.stringify(asks)}`);
    const plainId = idOf(plain);
    const askId = idOf(asks);
    await settle(1_000);

    await page.mouse.click(30, 300);
    await page.keyboard.press(mod("U"));
    await expect(page.locator(".operator-threads").first()).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("operator-threads-row").filter({ hasText: "Ada" }).first().click();
    await expect(pane().getByTestId("seat-threads-signal").first()).toBeVisible({ timeout: 15_000 });
    const composer = pane().getByTestId("thread-composer-input");

    await check("s1-reply-field-description", async (frames) => {
      await composer.focus();
      const description = await descriptionOf(composer);
      frames.push(await shot("s1-composer-focused"));
      // The description is the whole block above the field: what the reply answers, then what a signal that asks for work stays open for.
      if (!description.startsWith(`Your reply answers: ${PLAIN}`)) throw new Error(`described as "${description}"`);
      return `into the reply field: its description reads "${description}" (aria-describedby text of the block above the field; accessibility tree, not a VoiceOver run)`;
    });

    await check("s2-reply-line-button", async (frames) => {
      const button = pane().getByRole("button", { name: new RegExp(PLAIN.slice(0, 20)) }).first();
      const name = await button.evaluate((el) => el.getAttribute("aria-label") ?? el.textContent ?? "");
      await button.focus();
      await page.keyboard.press("Enter");
      await settle(500);
      const landed = await page.evaluate(() => {
        const a = document.activeElement;
        const article = a?.closest("[data-signal-id], article");
        return { tag: a?.tagName, role: a?.getAttribute("role"), label: a?.getAttribute("aria-label"), signalId: (a as HTMLElement | null)?.dataset?.signalId ?? article?.getAttribute("data-signal-id") ?? null, text: (article?.textContent ?? a?.textContent ?? "").trim().slice(0, 120) };
      });
      frames.push(await shot("s2-after-button"));
      return `the reply line's button is named "${name}"; Enter leaves focus on ${JSON.stringify(landed)}`;
    });

    await check("s3-hand-in-names", async () => {
      const handIn = pane().getByTestId("seat-threads-signal-hand-in");
      const names = await handIn.evaluateAll((all) => all.map((el) => el.getAttribute("aria-label")));
      if (names.length !== 1 || names[0] !== `Hand in: ${ASKS}`) throw new Error(`Hand in buttons named ${JSON.stringify(names)}`);
      const snapshot = await pane().getByTestId("seat-threads-signal").filter({ hasText: ASKS }).first().ariaSnapshot();
      return `Hand in is named ${JSON.stringify(names)} (one, on the signal that asks for work; the plain signal has none). Accessibility tree of that signal: ${snapshot.replace(/\s+/g, " ").slice(0, 400)}`;
    });

    await check("s4-withdrawal-said-once", async (frames) => {
      await page.evaluate(() => {
        const w = window as unknown as { __said: string[] };
        w.__said = [];
        new MutationObserver((records) => {
          for (const record of records)
            for (const node of record.addedNodes) {
              if (!(node instanceof Element)) continue;
              const live = node.closest('[role="status"], [aria-live]') ?? node.querySelector('[role="status"], [aria-live]');
              if (live !== null && (node.textContent ?? "").trim() !== "") w.__said.push((node.textContent ?? "").trim());
            }
        }).observe(document.body, { subtree: true, childList: true });
      });
      const cleared = await seat.op("signal.clear", { signalId: plainId });
      if (!cleared.ok) throw new Error(`withdraw refused ${JSON.stringify(cleared)}`);
      await settle(2_500);
      const said = await page.evaluate(() => (window as unknown as { __said: string[] }).__said);
      frames.push(await shot("s4-after-withdraw"));
      const withdrawn = said.filter((t) => /withdrew/.test(t));
      if (JSON.stringify(withdrawn) !== JSON.stringify([`Ada withdrew: ${PLAIN}`])) throw new Error(`said ${JSON.stringify(said)}`);
      return `withdrawn while the thread is on screen: said ${JSON.stringify(withdrawn)} once (every live-region saying that arrived: ${JSON.stringify(said)})`;
    });

    await check("s5-no-open-plain-signal-no-answers-line", async () => {
      await composer.focus();
      const description = await descriptionOf(composer);
      if (description.includes("Your reply answers")) throw new Error(`still described as "${description}"`);
      return `with no open plain signal left the reply field no longer says what it answers; what remains is the asking signal's block: "${description}"`;
    });
    await check("s6-no-open-signal-no-describedby", async () => {
      const cleared = await seat.op("signal.clear", { signalId: askId });
      if (!cleared.ok) throw new Error(`withdraw refused ${JSON.stringify(cleared)}`);
      await settle(1_500);
      await composer.focus();
      const describedby = await composer.getAttribute("aria-describedby");
      if (describedby !== null && describedby.trim() !== "") throw new Error(`aria-describedby is "${describedby}" with no open signal`);
      return "with no open signal left the reply field has no aria-describedby";
    });
  } finally {
    await writeFile(join(FRAMES, "results.json"), `${JSON.stringify(lines, null, 2)}\n`).catch(() => undefined);
    await junto.close();
  }
  const failed = lines.filter((l) => !l.pass);
  expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
});
