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
      lines.push({ id, pass: false, note: String(error instanceof Error ? error.message : error).slice(0, 5000), frames });
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
    // Everything a live region says, and every bubble (node-preamble) element that appears, from before the raises on.
    await page.evaluate(() => {
      const w = window as unknown as { __watch: { said: Array<Record<string, unknown>>; created: Array<Record<string, unknown>> } };
      w.__watch = { said: [], created: [] };
      const preambleOf = (el: Element | null) => el?.closest('[data-testid="node-preamble"]') ?? el?.querySelector?.('[data-testid="node-preamble"]') ?? null;
      new MutationObserver((records) => {
        for (const record of records)
          for (const node of record.addedNodes) {
            if (!(node instanceof Element)) continue;
            // The faded previous line of a bubble swap is aria-hidden: it is not spoken, but it is recorded so it can be told apart.
            const hiddenEl = node.closest('[aria-hidden="true"]');
            const hidden = hiddenEl !== null;
            const hiddenBy = hiddenEl === null ? null : `${hiddenEl.tagName}${hiddenEl.getAttribute("data-testid") ? `[${hiddenEl.getAttribute("data-testid")}]` : ""}.${(hiddenEl.className?.toString() ?? "").slice(0, 50)}${hiddenEl === (node.closest('[data-testid="node-preamble"]') ?? null) ? " (the bubble itself)" : hiddenEl.contains(document.querySelector('[data-testid="node-preamble"]')) ? " (an ancestor of the bubble)" : ""}`;
            const made = node.matches('[data-testid="node-preamble"]') ? node : node.querySelector('[data-testid="node-preamble"]');
            if (made !== null) w.__watch.created.push({ t: performance.now(), id: made.getAttribute("data-preamble-id"), marked: made.hasAttribute("data-pa-mark") });
            const live = node.closest('[role="status"], [aria-live]') ?? node.querySelector('[role="status"], [aria-live]');
            if (live === null || (node.textContent ?? "").trim() === "") continue;
            const host = (node.closest('[role="status"], [aria-live]') ?? live) as Element;
            const pre = preambleOf(host) ?? (host.getAttribute("data-testid") === "node-preamble" ? host : null);
            w.__watch.said.push({
              t: performance.now(),
              hidden,
              hiddenBy,
              text: (node.textContent ?? "").trim(),
              in: host.getAttribute("data-testid") ?? host.className?.toString().slice(0, 40) ?? host.tagName,
              preambleId: pre?.getAttribute("data-preamble-id") ?? null,
              elementWasMarked: pre === null ? null : pre.hasAttribute("data-pa-mark"),
            });
          }
      }).observe(document.body, { subtree: true, childList: true });
    });
    const now = () => page.evaluate(() => performance.now());
    const raiseAt: Record<string, number> = {};
    raiseAt.plain = await now();
    const plain = await seat.op("signal.raise", { kind: "escalate", text: PLAIN, thread: threadId });
    if (!plain.ok) throw new Error(`plain signal refused ${JSON.stringify(plain)}`);
    raiseAt.asks = await now();
    const asks = await seat.op("signal.raise", { kind: "blocked", text: ASKS, thread: threadId, form: { kind: "proof" } });
    if (!asks.ok) throw new Error(`asking signal refused ${JSON.stringify(asks)}`);
    const plainId = idOf(plain);
    const askId = idOf(asks);
    const openAsks: string[] = [askId];
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
      const lead = await pane().getByTestId("seat-threads-signal").filter({ hasText: ASKS }).first().locator("p").first().evaluate((el) => (el.textContent ?? "").trim());
      if (lead !== "Blocked, Open") throw new Error(`the signal line reads "${lead}"`);
      return `Hand in is named ${JSON.stringify(names)} (one, on the signal that asks for work; the plain signal has none). Accessibility tree of that signal: ${snapshot.replace(/\s+/g, " ").slice(0, 400)}`;
    });

    await check("s4-withdrawal-said-once", async (frames) => {
      // Mark every bubble element now and read what each says, so the withdrawal's window can tell a new element from a changed one.
      const before = await page.evaluate(() => {
        const out: Array<{ id: string | null; text: string }> = [];
        for (const el of document.querySelectorAll('[data-testid="node-preamble"]')) {
          el.setAttribute("data-pa-mark", "1");
          out.push({ id: el.getAttribute("data-preamble-id"), text: (el.textContent ?? "").trim() });
        }
        return out;
      });
      await page.evaluate(() => {
        const w = window as unknown as { __watch: { said: unknown[]; created: unknown[]; mark: number } };
        w.__watch.mark = w.__watch.said.length;
      });
      // Withdraw at raiseP + 4 s, after the first note's 2.5 s dwell, so the second raise note is said on its own time before it.
      const early = 4_000 - ((await now()) - raiseAt.plain!);
      if (early > 0) await settle(early);
      const withdrawAt = await now();
      const cleared = await seat.op("signal.clear", { signalId: plainId });
      if (!cleared.ok) throw new Error(`withdraw refused ${JSON.stringify(cleared)}`);
      await settle(5_000);
      const watch = await page.evaluate(() => (window as unknown as { __watch: { said: Array<Record<string, unknown>>; created: Array<Record<string, unknown>> } }).__watch);
      frames.push(await shot("s4-after-withdraw"));
      const ms = (t: unknown, ref: number) => Math.round(Number(t) - ref);
      const detail = watch.said.map((x) => `${x.hidden === true ? `[aria-hidden by ${String(x.hiddenBy)}, not spoken] ` : ""}"${String(x.text)}" in ${String(x.in)} preambleId=${String(x.preambleId)} elementWasMarked=${String(x.elementWasMarked)} sinceRaisePlain=${ms(x.t, raiseAt.plain!)}ms sinceRaiseAsks=${ms(x.t, raiseAt.asks!)}ms sinceWithdraw=${ms(x.t, withdrawAt)}ms`);
      const createdAfter = watch.created.filter((c) => Number(c.t) >= withdrawAt).map((c) => `id=${String(c.id)} marked=${String(c.marked)} +${ms(c.t, withdrawAt)}ms`);
      const note = `bubble text just before the withdraw: ${JSON.stringify(before)}; every saying from before the raises on: ${JSON.stringify(detail)}; bubble elements created after the withdraw: ${JSON.stringify(createdAfter)}; all bubble creations: ${watch.created.length}`;
      const afterWithdraw = watch.said.filter((x) => Number(x.t) >= withdrawAt && x.hidden !== true);
      const ok = afterWithdraw.length === 1 && String(afterWithdraw[0]!.text).startsWith(`Ada withdrew: ${PLAIN}`);
      if (!ok) throw new Error(`after the withdraw ${JSON.stringify(afterWithdraw.map((x) => x.text))}. ${note}`);
      return `withdrawn while the thread is on screen: one saying, "${String(afterWithdraw[0]!.text)}". ${note}`;
    });

    // One case: raise a plain and an asking signal, withdraw the plain one `withdrawAfterMs` after its raise, and return every saying since the raise with its timings.
    const runCase = async (plainText: string, asksText: string, withdrawAfterMs: number) => {
      const mark = await page.evaluate(() => (window as unknown as { __watch: { said: unknown[] } }).__watch.said.length);
      const t0 = await now();
      const p = await seat.op("signal.raise", { kind: "escalate", text: plainText, thread: threadId });
      if (!p.ok) throw new Error(`plain signal refused ${JSON.stringify(p)}`);
      const a = await seat.op("signal.raise", { kind: "blocked", text: asksText, thread: threadId, form: { kind: "proof" } });
      if (!a.ok) throw new Error(`asking signal refused ${JSON.stringify(a)}`);
      openAsks.push(idOf(a));
      const wait = withdrawAfterMs - ((await now()) - t0);
      if (wait > 0) await settle(wait);
      const w = await now();
      const cleared = await seat.op("signal.clear", { signalId: idOf(p) });
      if (!cleared.ok) throw new Error(`withdraw refused ${JSON.stringify(cleared)}`);
      await settle(5_000);
      const said = (await page.evaluate(() => (window as unknown as { __watch: { said: Array<Record<string, unknown>> } }).__watch.said)).slice(mark);
      const detail = said.map((x) => `${x.hidden === true ? `[aria-hidden by ${String(x.hiddenBy)}, not spoken] ` : ""}"${String(x.text)}" in ${String(x.in)} raise+${Math.round(Number(x.t) - t0)}ms (W${Math.round(Number(x.t) - w) >= 0 ? "+" : ""}${Math.round(Number(x.t) - w)}ms)`);
      return { said, spoken: said.filter((x) => x.hidden !== true), detail, w, t0, note: `withdrawn at raise+${Math.round(w - t0)}ms; sayings since the raise: ${JSON.stringify(detail)}` };
    };

    // The thread is on screen in Global threads, which hides the canvas (and the bubble on it) from the accessibility tree: the thread says the withdrawal once and nothing of the bubble is spoken.
    await check("s4b-withdrawal-inside-the-dwell-thread-on-screen", async (frames) => {
      const c = await runCase("Which region should it go to?", "Need the staging key", 1_000);
      frames.push(await shot("s4b-after-withdraw"));
      const texts = c.spoken.map((x) => String(x.text));
      if (texts.length !== 1 || !texts[0]!.startsWith("Ada withdrew: Which region should it go to?")) throw new Error(`spoken ${JSON.stringify(texts)}. ${c.note}`);
      return `inside the dwell with the thread on screen: spoken once, "${texts[0]}"; the bubble's lines are all inside aria-hidden (the hidden canvas or the faded old line). ${c.note}`;
    });

    // The thread is not on screen: the canvas is in the tree, so the bubble is what speaks.
    await page.keyboard.press("Escape");
    await expect(page.locator(".operator-threads")).toHaveCount(0, { timeout: 5_000 });
    await settle(2_000);
    // With no thread on screen the bubble is the only voice: each raise note once in order, then exactly one "cleared:" for the withdrawn signal (told after the dwell queue), nothing else of it, nothing for the other signal.
    const oneEventOneSaying = (c: Awaited<ReturnType<typeof runCase>>, plainText: string, asksText: string, insideDwell: boolean): string => {
      const timed = c.spoken.map((x) => ({ text: String(x.text), t: Number(x.t) }));
      const count = (needle: string) => timed.filter((x) => x.text === needle).length;
      const order = timed.map((x) => x.text);
      const afterW = timed.filter((x) => x.t >= c.w).map((x) => x.text);
      const allowedAfterW = insideDwell ? [`blocked: ${asksText}`, `cleared: ${plainText}`] : [`cleared: ${plainText}`];
      const problems: string[] = [];
      if (count(`wants you: ${plainText}`) !== 1) problems.push(`"wants you" said ${count(`wants you: ${plainText}`)} times`);
      if (count(`blocked: ${asksText}`) !== 1) problems.push(`"blocked" said ${count(`blocked: ${asksText}`)} times`);
      if (count(`cleared: ${plainText}`) !== 1) problems.push(`"cleared" for the withdrawn said ${count(`cleared: ${plainText}`)} times`);
      if (timed.some((x) => x.text.includes(`cleared: ${asksText}`))) problems.push("a cleared note for the other signal");
      if (afterW.some((t) => !allowedAfterW.includes(t))) problems.push(`after the withdrawal ${JSON.stringify(afterW)}`);
      const idx = (needle: string) => order.indexOf(needle);
      if (!(idx(`wants you: ${plainText}`) < idx(`blocked: ${asksText}`) && idx(`blocked: ${asksText}`) < idx(`cleared: ${plainText}`))) problems.push(`order ${JSON.stringify(order)}`);
      if (problems.length > 0) throw new Error(`${problems.join("; ")}. ${c.note}`);
      return `spoken in order ${JSON.stringify(order)}`;
    };
    await check("s8-bubble-after-the-dwell-canvas-visible", async (frames) => {
      const c = await runCase("Which tag should it carry?", "Need the signing key", 4_000);
      frames.push(await shot("s8-after-withdraw"));
      return `after the dwell: ${oneEventOneSaying(c, "Which tag should it carry?", "Need the signing key", false)}. ${c.note}`;
    });
    await check("s9-bubble-inside-the-dwell-canvas-visible", async (frames) => {
      const c = await runCase("Which cluster should it use?", "Need the vault key", 1_000);
      frames.push(await shot("s9-after-withdraw"));
      return `inside the dwell: ${oneEventOneSaying(c, "Which cluster should it use?", "Need the vault key", true)}. ${c.note}`;
    });

    // The thread back on screen for the lines about the reply field.
    await page.keyboard.press(mod("U"));
    await expect(page.locator(".operator-threads").first()).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("operator-threads-row").filter({ hasText: "Ada" }).first().click();
    await expect(pane().getByTestId("thread-composer-input")).toBeVisible({ timeout: 15_000 });
    await check("s5-no-open-plain-signal-no-answers-line", async () => {
      await composer.focus();
      const description = await descriptionOf(composer);
      if (description.includes("Your reply answers")) throw new Error(`still described as "${description}"`);
      return `with no open plain signal left the reply field no longer says what it answers; what remains is the asking signal's block: "${description}"`;
    });
    await check("s6-no-open-signal-no-describedby", async () => {
      for (const id of openAsks) {
        const cleared = await seat.op("signal.clear", { signalId: id });
        if (!cleared.ok) throw new Error(`withdraw refused ${JSON.stringify(cleared)}`);
      }
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
