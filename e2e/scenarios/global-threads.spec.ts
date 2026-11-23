/**
 * [fake-tui] Global threads, the operator's threads across every seat, in the
 * real app with live seats: its key from anywhere, only threads with the
 * operator, the region picker, the unread filter and search, both orders, a
 * thread opened and answered, unread cleared only for a thread shown, the
 * waiting line under a reply to a stopped seat (in Global threads and in the
 * seat's Threads view), and, last, the time from the key to the first list
 * paint on a canvas with thousands of mails (only with JUNTO_E2E_TIMING=1, since
 * a run that measures time waits for a one-minute load under 40).
 *
 * Each line is checked on its own and recorded pass or fail with its frame;
 * the test fails if any line failed. Frames, results.json and timing.json land
 * in JUNTO_E2E_FRAMES_DIR (default test-results/global-threads).
 *   bun run test:e2e:fast e2e/scenarios/global-threads.spec.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { card, canvasReady, cameraSettled } from "../harness/canvas";
import { crewOccupySeat, crewPlayFactory, crewSeat, installCrewSeatHarness } from "../harness/crew-fixture";
import { modelFixture, modelMessagesWire, modelRegion, modelSeat } from "../harness/model";
import { readSeatMailbox } from "../harness/work-mail";
import { expect, launchJunto, test } from "../harness/launch";

const CANVAS = "globalthreads";
const FRAMES = process.env.JUNTO_E2E_FRAMES_DIR ?? join("test-results", "global-threads");
const PERF_SEATS = 10;
const PERF_THREADS_PER_SEAT = 200;

const s = {
  ada: modelSeat({ id: "seat-ada", label: "Ada", x: 60, y: 120 }),
  bea: modelSeat({ id: "seat-bea", label: "Bea", x: 400, y: 120 }),
  dov: modelSeat({ id: "seat-dov", label: "Dov", x: 900, y: 120 }),
  eve: modelSeat({ id: "seat-eve", label: "Eve", x: 1240, y: 120 }),
};
const perfSeats = Array.from({ length: PERF_SEATS }, (_, i) => modelSeat({ id: `seat-p${String(i)}`, label: `Pace ${String(i)}`, x: 860 + (i % 5) * 300, y: 520 + Math.floor(i / 5) * 160 }));
const doc = modelFixture(
  [
    modelRegion({ id: "region-north", label: "North", x: 0, y: 0, width: 760, height: 400 }),
    modelRegion({ id: "region-south", label: "South", x: 840, y: 0, width: 1600, height: 900 }),
    ...Object.values(s),
    ...perfSeats,
  ],
  [modelMessagesWire("e-ab", s.ada.id, s.bea.id, [s.ada, s.bea])],
);

type Line = { readonly id: string; readonly pass: boolean; readonly note: string; readonly frames: string[] };

const modal = (page: Page): Locator => page.locator(".operator-threads").first();
const rows = (page: Page): Locator => page.getByTestId("operator-threads-row");
const rowTexts = (page: Page): Promise<string[]> => rows(page).evaluateAll((all) => all.map((r) => (r.textContent ?? "").replace(/\s+/g, " ").trim()));
const unreadChip = (page: Page): Locator => page.getByTestId("threads-unread-chip");
const unreadTotal = async (page: Page): Promise<number> => Number(((await unreadChip(page).getAttribute("aria-label")) ?? "").replace(/\D+/g, "") || "0");
const pane = (page: Page): Locator => page.getByTestId("operator-threads-pane");
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Ears = { said: Array<{ text: string; t: number }>; marks: Array<{ text: string; t: number }> };
/** Records each saying added to a thread's live region and each waiting mark drawn, with its time. */
const installEars = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __ears: Ears };
    w.__ears = { said: [], marks: [] };
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.parentElement?.matches('[data-testid="seat-threads-said"]')) w.__ears.said.push({ text: node.textContent ?? "", t: performance.now() });
          const marks = node.matches('[data-testid="seat-threads-waiting"]') ? [node] : [...node.querySelectorAll('[data-testid="seat-threads-waiting"]')];
          for (const mark of marks) w.__ears.marks.push({ text: mark.textContent ?? "", t: performance.now() });
        }
    }).observe(document.body, { subtree: true, childList: true });
  });
const ears = (page: Page): Promise<Ears> => page.evaluate(() => (window as unknown as { __ears: Ears }).__ears);
const clearEars = (page: Page) => page.evaluate(() => {
  const w = window as unknown as { __ears: Ears };
  w.__ears.said.length = 0;
  w.__ears.marks.length = 0;
});

const openThreads = async (page: Page): Promise<void> => {
  await page.keyboard.press("Meta+U");
  await expect(modal(page)).toBeVisible({ timeout: 10_000 });
};
const closeThreads = async (page: Page): Promise<void> => {
  for (let i = 0; i < 3 && (await modal(page).count()) > 0; i += 1) await page.keyboard.press("Escape");
  await expect(modal(page)).toHaveCount(0, { timeout: 5_000 });
};

test("[fake-tui] Global threads", async () => {
  test.setTimeout(900_000);
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
      await closeThreads(page).catch(() => undefined);
    }
    await writeFile(join(FRAMES, "results.json"), `${JSON.stringify(lines, null, 2)}\n`);
  };
  const send = (nodeId: string, text: string) =>
    page.evaluate(async ([canvasName, id, body]) => window.junto!.seatThreadSend({ canvasName, nodeId: id, text: body } as never), [CANVAS, nodeId, text] as const);

  try {
    await canvasReady(page, { timeout: 30_000 });
    await page.getByRole("button", { name: "Fit all nodes" }).click();
    await cameraSettled(page);
    await crewPlayFactory(page);
    await installEars(page);
    const seat = {
      ada: crewSeat(junto.sandbox, CANVAS, s.ada.id),
      bea: crewSeat(junto.sandbox, CANVAS, s.bea.id),
      dov: crewSeat(junto.sandbox, CANVAS, s.dov.id),
      eve: crewSeat(junto.sandbox, CANVAS, s.eve.id),
    };
    for (const [id, c] of [[s.ada.id, seat.ada], [s.bea.id, seat.bea], [s.dov.id, seat.dov]] as const) await crewOccupySeat(page, CANVAS, { id }, c);

    // Threads with the operator: Ada and Dov answer (unread), Bea does not; Eve is stopped.
    const toAda = await send(s.ada.id, "Alpha status for the release");
    await settle(300);
    const toDov = await send(s.dov.id, "Delta deploy window tonight");
    await settle(300);
    const toBea = await send(s.bea.id, "Bravo review of the copy");
    await settle(300);
    const toEve = await send(s.eve.id, "Echo, check the logs when you are back");
    for (const sent of [toAda, toDov, toBea, toEve]) if (!sent.ok) throw new Error(`send refused ${JSON.stringify(sent)}`);
    await settle(300);
    for (const [c, sent, text] of [
      [seat.ada, toAda, "Alpha is ready to ship."],
      [seat.dov, toDov, "Delta window confirmed."],
    ] as const) {
      const reply = await c.op("msg.reply", { target: "operator", inReplyTo: sent.ok ? sent.messageId : "", text });
      if (!reply.ok) throw new Error(`reply refused ${JSON.stringify(reply)}`);
      await settle(300);
    }
    // A thread between two seats, which the operator is not in.
    const between = await seat.ada.op("msg.send", { target: s.bea.id, text: "Between seats only, not for the operator" });
    if (!between.ok) throw new Error(`seat to seat send refused ${JSON.stringify(between)}`);

    // 1. Opens from anywhere by its key: the canvas, a focused terminal, Settings.
    await check("g1-key-opens", async (frames) => {
      await page.mouse.click(30, 300);
      await openThreads(page);
      frames.push(await shot("g1a-from-canvas"));
      await page.keyboard.press("Meta+U");
      await expect(modal(page)).toHaveCount(0, { timeout: 5_000 });
      await card(page, s.bea.id).dblclick();
      const surface = page.locator('[data-testid="native-terminal-surface"]:has(#seat-stage-seat-bea)');
      await expect(surface).toBeVisible({ timeout: 20_000 });
      await surface.locator(".xterm").first().click();
      await openThreads(page);
      frames.push(await shot("g1b-over-terminal"));
      await closeThreads(page);
      await surface.getByRole("button", { name: "Close view" }).first().click();
      await page.getByRole("button", { name: "Open settings" }).click();
      await openThreads(page);
      frames.push(await shot("g1c-over-settings"));
      await closeThreads(page);
      await page.keyboard.press("Escape");
      return "Cmd+U opens it from the canvas, over a focused terminal and over Settings; Cmd+U again closes it";
    });

    // 2. Only threads with the operator, across seats.
    await check("g2-only-operator-threads", async (frames) => {
      await openThreads(page);
      await expect(rows(page)).toHaveCount(4, { timeout: 15_000 });
      const texts = await rowTexts(page);
      frames.push(await shot("g2-list"));
      if (texts.some((t) => t.includes("Between seats only"))) throw new Error("a seat to seat thread is listed");
      for (const name of ["Ada", "Bea", "Dov", "Eve"]) if (!texts.some((t) => t.includes(name))) throw new Error(`${name} missing: ${JSON.stringify(texts)}`);
      return `4 rows, one per seat thread with the operator; the seat to seat thread is not listed: ${JSON.stringify(texts)}`;
    });

    // 3. Unread clears only for a thread shown (read before anything is clicked).
    let unreadAtOpen = 0;
    await check("g3-unread-only-shown", async (frames) => {
      unreadAtOpen = await unreadTotal(page);
      const unreadRows = await page.getByTestId("operator-threads-row-unread").count();
      const shownAtOpen = await pane(page).textContent().catch(() => "");
      await rows(page).filter({ hasText: "Dov" }).first().click();
      await expect(pane(page)).toContainText("Delta window confirmed.", { timeout: 10_000 });
      await settle(800);
      const after = await unreadTotal(page);
      const adaStillUnread = (await rows(page).filter({ hasText: "Ada" }).first().getByTestId("operator-threads-row-unread").count()) === 1;
      frames.push(await shot("g3-dov-shown"));
      if (after !== unreadAtOpen - 1 || !adaStillUnread)
        throw new Error(`unread ${unreadAtOpen} -> ${after}; Ada still unread: ${adaStillUnread}; ${unreadRows} unread rows at open; pane at open: ${String(shownAtOpen).slice(0, 80)}`);
      return `unread ${unreadAtOpen} at open (${unreadRows} rows), ${after} after showing Dov's thread; Ada's row still unread`;
    });

    // 4. A reply sends from the pane.
    await check("g4-reply-sends", async (frames) => {
      const text = "Thanks, go ahead with Delta.";
      const input = pane(page).getByTestId("thread-composer-input");
      await input.click();
      await input.fill(text);
      await clearEars(page);
      await pane(page).getByTestId("thread-composer-send").click();
      await expect(pane(page).getByTestId("seat-threads-message").filter({ hasText: text })).toBeVisible({ timeout: 15_000 });
      await expect.poll(async () => (await readSeatMailbox(page, CANVAS, s.dov.id)).some((m) => JSON.stringify(m).includes(text)), { timeout: 15_000 }).toBe(true);
      await settle(1500);
      frames.push(await shot("g4-replied"));
      const heard = await ears(page);
      if (heard.marks.length > 0 || heard.said.length > 0) throw new Error(`reply to a running seat: waiting marks ${JSON.stringify(heard.marks)}, said ${JSON.stringify(heard.said)}`);
      return "reply drawn in Dov's thread and stored in Dov's mailbox; no waiting mark flashed under it (DOM watched from send to 1.5 s after delivery) and nothing said";
    });

    // 5. Region picker, unread filter and search narrow the list; Clear restores it.
    await check("g5-narrowing", async (frames) => {
      const notes: string[] = [];
      await page.getByTestId("feed-region-chip").filter({ hasText: "North" }).first().click();
      await expect.poll(async () => (await rowTexts(page)).length, { timeout: 5_000 }).toBe(2);
      const north = await rowTexts(page);
      frames.push(await shot("g5a-region-north"));
      notes.push(`North: ${JSON.stringify(north.map((t) => t.slice(0, 12)))}`);
      if (north.some((t) => t.includes("Dov") || t.includes("Eve"))) throw new Error(`North lists South seats: ${JSON.stringify(north)}`);
      await unreadChip(page).click();
      await expect.poll(async () => (await rowTexts(page)).length, { timeout: 5_000 }).toBe(1);
      const northUnread = await rowTexts(page);
      frames.push(await shot("g5b-north-unread"));
      notes.push(`North + Unread: ${JSON.stringify(northUnread.map((t) => t.slice(0, 12)))}`);
      await page.getByTestId("threads-clear-filters").click();
      await expect(rows(page)).toHaveCount(4, { timeout: 5_000 });
      await page.getByRole("searchbox", { name: "Search threads" }).fill("Echo");
      await expect.poll(async () => (await rowTexts(page)).length, { timeout: 5_000 }).toBe(1);
      const searched = await rowTexts(page);
      frames.push(await shot("g5c-search-echo"));
      notes.push(`search "Echo": ${JSON.stringify(searched.map((t) => t.slice(0, 12)))}`);
      if (!searched[0]?.includes("Eve")) throw new Error(`search found ${JSON.stringify(searched)}`);
      await page.getByRole("searchbox", { name: "Search threads" }).fill("zzz-nothing");
      await expect(page.getByTestId("threads-no-matches")).toBeVisible();
      frames.push(await shot("g5d-no-matches"));
      await page.getByTestId("threads-clear-filters").click();
      await expect(rows(page)).toHaveCount(4, { timeout: 5_000 });
      return `${notes.join("; ")}; no matches shown for nonsense; Clear restores 4`;
    });

    // 6. Both orders.
    await check("g6-orders", async (frames) => {
      const newest = (await rowTexts(page)).map((t) => t.match(/Ada|Bea|Dov|Eve/)?.[0]);
      frames.push(await shot("g6a-newest"));
      await page.locator('button[aria-label="Order threads"]').click();
      await page.getByRole("listbox", { name: "Order threads" }).getByRole("option", { name: "Most urgent first" }).click();
      await settle(600);
      const urgent = (await rowTexts(page)).map((t) => t.match(/Ada|Bea|Dov|Eve/)?.[0]);
      frames.push(await shot("g6b-most-urgent"));
      await page.locator('button[aria-label="Order threads"]').click();
      await page.getByRole("listbox", { name: "Order threads" }).getByRole("option", { name: "Newest first" }).click();
      await settle(400);
      // Dov was answered last (line 4), then Ada's reply, then Eve, then Bea.
      if (newest[0] !== "Dov") throw new Error(`newest first starts with ${String(newest[0])}: ${JSON.stringify(newest)}`);
      return `newest first ${JSON.stringify(newest)}; most urgent first ${JSON.stringify(urgent)} (urgency rank not asserted, only that the order applies)`;
    });
    await closeThreads(page).catch(() => undefined);

    // 7. Waiting line in Global threads: a reply to a stopped seat, then the seat starts.
    await check("g7-waiting-line-global", async (frames) => {
      await openThreads(page);
      await rows(page).filter({ hasText: "Eve" }).first().click();
      const text = "Eve, one more thing when you are back.";
      const input = pane(page).getByTestId("thread-composer-input");
      await input.click();
      await input.fill(text);
      await clearEars(page);
      await pane(page).getByTestId("thread-composer-send").click();
      const waiting = pane(page).getByTestId("seat-threads-waiting");
      await expect(waiting.first()).toBeVisible({ timeout: 15_000 });
      const markText = (await waiting.first().textContent())?.trim();
      const align = await waiting.first().evaluate((el) => { const st = getComputedStyle(el); return `${st.textAlign}/${st.justifyContent}/${st.alignSelf}`; });
      const clock = await waiting.first().locator("svg").count();
      await settle(1200);
      frames.push(await shot("g7a-waiting-for-eve"));
      const before = await ears(page);
      await crewOccupySeat(page, CANVAS, { id: s.eve.id }, seat.eve);
      await expect(waiting).toHaveCount(0, { timeout: 30_000 });
      await settle(800);
      frames.push(await shot("g7b-eve-started-line-gone"));
      const after = await ears(page);
      const said = after.said.map((x) => x.text);
      const want = ["Sent. Waiting for Eve. It arrives when the seat is back.", "Eve has it."];
      if (markText !== "Waiting for Eve. It arrives when the seat is back." || JSON.stringify(said) !== JSON.stringify(want))
        throw new Error(`mark "${String(markText)}"; said ${JSON.stringify(said)} (before start ${JSON.stringify(before.said.map((x) => x.text))})`);
      return `mark "${markText}" under the reply, ${clock} svg (clock), align ${align}; said in order ${JSON.stringify(said)}, each once; Eve started and the mark went without a reload`;
    });
    await closeThreads(page).catch(() => undefined);

    // 8. Waiting line in the seat's Threads view: stop Dov, reply, start Dov.
    await check("g8-waiting-line-seat-view", async (frames) => {
      await page.evaluate(async ([canvas, id]) => window.junto!.modelStop({ canvas, id }), [CANVAS, s.dov.id] as const);
      await settle(1500);
      await card(page, s.dov.id).dblclick();
      const surface = page.locator('[data-testid="native-terminal-surface"]:has(#seat-stage-seat-dov)');
      await expect(surface).toBeVisible({ timeout: 20_000 });
      await surface.getByTestId("seat-view-threads").click();
      await surface.getByTestId("seat-threads-row").first().click();
      const text = "Dov, after the restart please confirm.";
      const input = surface.getByTestId("thread-composer-input");
      await input.click();
      await input.fill(text);
      await clearEars(page);
      await surface.getByTestId("thread-composer-send").click();
      const waiting = surface.getByTestId("seat-threads-waiting");
      await expect(waiting.first()).toBeVisible({ timeout: 15_000 });
      const markText = (await waiting.first().textContent())?.trim();
      await settle(1200);
      frames.push(await shot("g8a-waiting-for-dov"));
      const sentSaid = (await ears(page)).said.map((x) => x.text);
      // Reopen the seat on Threads with the waiting mail still in the thread: nothing is said.
      await surface.getByRole("button", { name: "Close view" }).first().click();
      await expect(surface).toHaveCount(0, { timeout: 10_000 });
      await clearEars(page);
      await card(page, s.dov.id).dblclick();
      await expect(surface).toBeVisible({ timeout: 20_000 });
      await surface.getByTestId("seat-view-threads").click();
      await surface.getByTestId("seat-threads-row").first().click();
      await expect(waiting.first()).toBeVisible({ timeout: 15_000 });
      await settle(1500);
      frames.push(await shot("g8b-reopened-holding-waiting"));
      const reopenSaid = (await ears(page)).said.map((x) => x.text);
      await crewOccupySeat(page, CANVAS, { id: s.dov.id }, seat.dov);
      await expect(waiting).toHaveCount(0, { timeout: 30_000 });
      frames.push(await shot("g8c-dov-started-line-gone"));
      await surface.getByRole("button", { name: "Close view" }).first().click();
      const problems: string[] = [];
      if (markText !== "Waiting for Dov. It arrives when the seat is back.") problems.push(`mark "${String(markText)}"`);
      if (JSON.stringify(sentSaid) !== JSON.stringify(["Sent. Waiting for Dov. It arrives when the seat is back."])) problems.push(`said on send ${JSON.stringify(sentSaid)}`);
      if (reopenSaid.length > 0) problems.push(`said on reopen ${JSON.stringify(reopenSaid)}`);
      if (problems.length > 0) throw new Error(problems.join("; "));
      return `seat view: mark "${markText}" under the reply; said once on send ${JSON.stringify(sentSaid)}; reopening the thread that holds it said nothing; Dov started and the mark went without a reload`;
    });

    // 10. Opened with the Unread filter on, nothing touched: every unread thread stays unread and listed; one pick reads only it (4b62ed661).
    await check("g10-unread-filter-at-open", async (frames) => {
      for (const [c, sent, text] of [
        [seat.ada, toAda, "Alpha, one more note."],
        [seat.bea, toBea, "Bravo copy reviewed."],
        [seat.eve, toEve, "Echo, logs checked."],
      ] as const) {
        const reply = await c.op("msg.reply", { target: "operator", inReplyTo: sent.ok ? sent.messageId : "", text });
        if (!reply.ok) throw new Error(`reply refused ${JSON.stringify(reply)}`);
        await settle(300);
      }
      await openThreads(page);
      if ((await unreadChip(page).getAttribute("aria-pressed")) !== "true") await unreadChip(page).click();
      await closeThreads(page);
      await openThreads(page);
      await expect(unreadChip(page)).toHaveAttribute("aria-pressed", "true");
      await settle(2_000);
      const total = await unreadTotal(page);
      const listed = await rowTexts(page);
      const unreadRows = await page.getByTestId("operator-threads-row-unread").count();
      frames.push(await shot("g10a-opened-unread-on-untouched"));
      if (total < 3 || listed.length !== total || unreadRows !== total)
        throw new Error(`opened with Unread on, untouched 2 s: total ${total}, rows ${listed.length}, unread rows ${unreadRows}: ${JSON.stringify(listed)}`);
      await rows(page).filter({ hasText: "Bea" }).first().click();
      await expect(pane(page)).toContainText("Bravo copy reviewed.", { timeout: 10_000 });
      await settle(1_000);
      const after = await unreadTotal(page);
      const afterRows = await rowTexts(page);
      const afterUnread = await page.getByTestId("operator-threads-row-unread").count();
      frames.push(await shot("g10b-one-pick"));
      await unreadChip(page).click();
      await closeThreads(page);
      if (after !== total - 1 || afterUnread !== total - 1) throw new Error(`after one pick: total ${total} -> ${after}, unread rows ${afterUnread}, rows ${JSON.stringify(afterRows)}`);
      return `opened with Unread on, untouched 2 s: ${total} unread, ${listed.length} rows listed, all unread; one pick (Bea): ${after} unread, ${afterRows.length} rows still listed`;
    });

    // 11. Opens Most urgent first in the urgent order, not newest first (4b62ed661).
    await check("g11-urgent-order-at-open", async (frames) => {
      const names = async () => (await rowTexts(page)).map((t) => t.match(/Ada|Bea|Dov|Eve/)?.[0] ?? "?");
      const pickOrder = async (label: string) => {
        await page.locator('button[aria-label="Order threads"]').click();
        await page.getByRole("listbox", { name: "Order threads" }).getByRole("option", { name: label }).click();
        await settle(600);
      };
      await openThreads(page);
      await pickOrder("Newest first");
      const newest = await names();
      await pickOrder("Most urgent first");
      const urgentPicked = await names();
      await closeThreads(page);
      await openThreads(page);
      await expect(page.locator('button[aria-label="Order threads"]')).toHaveText(/Most urgent first/);
      const urgentAtOpen = await names();
      frames.push(await shot("g11-opened-most-urgent"));
      await pickOrder("Newest first");
      await closeThreads(page);
      if (JSON.stringify(urgentAtOpen) !== JSON.stringify(urgentPicked))
        throw new Error(`at open ${JSON.stringify(urgentAtOpen)}; picked ${JSON.stringify(urgentPicked)}; newest ${JSON.stringify(newest)}`);
      const differs = JSON.stringify(urgentPicked) !== JSON.stringify(newest);
      return `opened on Most urgent first: ${JSON.stringify(urgentAtOpen)}, the same as picking it ${JSON.stringify(urgentPicked)}; newest first ${JSON.stringify(newest)}${differs ? "" : " (the two orders coincide on this data, so this line cannot tell them apart)"}`;
    });

    // 9. Thousands of mails: time from the key to the first list paint.
    // Measures time: run only when the one-minute load is under 40 (JUNTO_E2E_TIMING=1).
    if (process.env.JUNTO_E2E_TIMING === "1") await check("g9-first-paint-at-scale", async (frames) => {
      const started = Date.now();
      const sent = await page.evaluate(
        async ([canvasName, ids, perSeat]) => {
          let ok = 0;
          const jobs: Array<() => Promise<void>> = [];
          for (const id of ids) for (let i = 0; i < perSeat; i += 1) jobs.push(async () => {
            const r = await window.junto!.seatThreadSend({ canvasName, nodeId: id, text: `Scale thread ${String(i)} for ${id}` } as never);
            if ((r as { ok: boolean }).ok) ok += 1;
          });
          for (let i = 0; i < jobs.length; i += 40) await Promise.all(jobs.slice(i, i + 40).map((job) => job()));
          return ok;
        },
        [CANVAS, perfSeats.map((p) => p.id), PERF_THREADS_PER_SEAT] as const,
      );
      const seedMs = Date.now() - started;
      await page.evaluate(() => {
        const w = window as unknown as { __gt: { key?: number; row?: number; paint?: number } };
        w.__gt = {};
        addEventListener("keydown", (e: KeyboardEvent) => {
          if (e.metaKey && !e.shiftKey && e.key.toLowerCase() === "u" && w.__gt.key === undefined) w.__gt.key = performance.now();
        }, { capture: true });
        new MutationObserver(() => {
          if (w.__gt.key !== undefined && w.__gt.row === undefined && document.querySelector('[data-testid="operator-threads-row"]')) {
            w.__gt.row = performance.now();
            requestAnimationFrame(() => requestAnimationFrame(() => (w.__gt.paint = performance.now())));
          }
        }).observe(document.body, { subtree: true, childList: true });
      });
      const runs: Array<{ row: number; paint: number }> = [];
      for (let i = 0; i < 6; i += 1) {
        await page.mouse.click(30, 300);
        await page.evaluate(() => ((window as unknown as { __gt: object }).__gt = {}));
        await page.keyboard.press("Meta+U");
        await expect.poll(() => page.evaluate(() => (window as unknown as { __gt: { paint?: number } }).__gt.paint !== undefined), { timeout: 30_000 }).toBe(true);
        const t = await page.evaluate(() => (window as unknown as { __gt: { key: number; row: number; paint: number } }).__gt);
        runs.push({ row: Math.round(t.row - t.key), paint: Math.round(t.paint - t.key) });
        if (i === 0) frames.push(await shot("g9-first-open-at-scale"));
        await closeThreads(page);
      }
      const shown = runs.map((r) => r.paint);
      const sorted = [...shown].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)]!;
      await writeFile(join(FRAMES, "timing.json"), `${JSON.stringify({ mails: sent + 6, seedMs, runs, firstOpenMs: shown[0], medianMs: median }, null, 2)}\n`);
      return `${sent} scale mails seeded in ${seedMs}ms (plus the 6 from the earlier lines); key to first row painted: first open ${shown[0]}ms, median of 6 ${median}ms, all ${JSON.stringify(shown)}`;
    });
  } finally {
    await writeFile(join(FRAMES, "results.json"), `${JSON.stringify(lines, null, 2)}\n`).catch(() => undefined);
    await junto.close();
  }
  const failed = lines.filter((l) => !l.pass);
  expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
});
