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
import { MAC, mod } from "../harness/keys";
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

type Ears = { said: Array<{ text: string; t: number }>; marks: Array<{ text: string; t: number }>; gone: Array<{ t: number }> };
/** Records each saying added to a thread's live region and each waiting mark drawn, with its time. */
const installEars = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __ears: Ears };
    w.__ears = { said: [], marks: [], gone: [] };
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) {
          if (!(node instanceof Element)) continue;
          const dropSel = '[data-testid="seat-threads-waiting"], [data-testid="operator-threads-row-waiting"]';
          const dropped = node.matches(dropSel) ? [node] : [...node.querySelectorAll(dropSel)];
          for (const _mark of dropped) w.__ears.gone.push({ t: performance.now() });
        }
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.parentElement?.matches('[data-testid="seat-threads-said"]')) w.__ears.said.push({ text: node.textContent ?? "", t: performance.now() });
          const waitingSel = '[data-testid="seat-threads-waiting"], [data-testid="operator-threads-row-waiting"]';
          const marks = node.matches(waitingSel) ? [node] : [...node.querySelectorAll(waitingSel)];
          for (const mark of marks) w.__ears.marks.push({ text: mark.textContent ?? "", t: performance.now() });
        }
      }
    }).observe(document.body, { subtree: true, childList: true });
  });
const ears = (page: Page): Promise<Ears> => page.evaluate(() => (window as unknown as { __ears: Ears }).__ears);
const clearEars = (page: Page) => page.evaluate(() => {
  const w = window as unknown as { __ears: Ears };
  w.__ears.said.length = 0;
  w.__ears.marks.length = 0;
  w.__ears.gone.length = 0;
});

const openThreads = async (page: Page): Promise<void> => {
  await page.keyboard.press(mod("U"));
  await expect(modal(page)).toBeVisible({ timeout: 10_000 });
};
const ensureThreads = async (page: Page): Promise<void> => {
  if ((await modal(page).count()) === 0) await openThreads(page);
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
      // A failed line leaves no seat open over the next one.
      for (let i = 0; i < 4 && (await page.getByRole("button", { name: "Close view" }).count()) > 0; i += 1) await page.getByRole("button", { name: "Close view" }).first().click().catch(() => undefined);
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
      await page.keyboard.press(mod("U"));
      await expect(modal(page)).toHaveCount(0, { timeout: 5_000 });
      // Off macOS the key is Ctrl+U, a shell key: the key table leaves the terminal out of it, so there is no chord over a focused terminal there.
      if (MAC) {
        await card(page, s.bea.id).dblclick();
        const surface = page.locator('[data-testid="native-terminal-surface"]:has(#seat-stage-seat-bea)');
        await expect(surface).toBeVisible({ timeout: 20_000 });
        await surface.locator(".xterm").first().click();
        await openThreads(page);
        frames.push(await shot("g1b-over-terminal"));
        await closeThreads(page);
        await surface.getByRole("button", { name: "Close view" }).first().click();
      }
      await page.getByRole("button", { name: "Open settings" }).click();
      await openThreads(page);
      frames.push(await shot("g1c-over-settings"));
      await closeThreads(page);
      await page.keyboard.press("Escape");
      return MAC ? "Cmd+U opens it from the canvas, over a focused terminal and over Settings; Cmd+U again closes it" : "Ctrl+U opens it from the canvas and over Settings, and again closes it; over a focused terminal there is no chord off macOS (a shell key), so that step is not run";
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
      await ensureThreads(page);
      const text = "Thanks, go ahead with Delta.";
      const input = pane(page).getByTestId("thread-composer-input");
      await input.click();
      await input.fill(text);
      await clearEars(page);
      const sentAt = await page.evaluate(() => performance.now());
      await pane(page).getByTestId("thread-composer-send").click();
      await expect(pane(page).getByTestId("seat-threads-message").filter({ hasText: text })).toBeVisible({ timeout: 15_000 });
      await expect.poll(async () => (await readSeatMailbox(page, CANVAS, s.dov.id)).some((m) => JSON.stringify(m).includes(text)), { timeout: 15_000 }).toBe(true);
      await settle(1500);
      frames.push(await shot("g4-replied"));
      const heard = await ears(page);
      const said4 = heard.said.map((x) => x.text);
      const lived4 = heard.marks.map((m, i) => `"${m.text}" drawn ${Math.round(m.t - sentAt)} ms after the press, gone ${heard.gone[i] ? `${Math.round(heard.gone[i]!.t - m.t)} ms later` : "never"}`);
      if (heard.marks.length > 0 || JSON.stringify(said4) !== JSON.stringify(["Dov has it."]))
        throw new Error(`reply to a running seat: waiting mark ${lived4.join("; ")}, said ${JSON.stringify(said4)}, saidAt ${JSON.stringify(heard.said.map((x) => Math.round(x.t - sentAt)))} ms; wanted no mark and "Dov has it." once`);
      return "reply drawn in Dov's thread and stored in Dov's mailbox; no waiting mark drawn at any point (DOM watched from the press to 1.5 s after delivery); the chat said \"Dov has it.\" once";
    });

    // 5. Region picker, unread filter and search narrow the list; Clear restores it.
    await check("g5-narrowing", async (frames) => {
      await ensureThreads(page);
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
      await ensureThreads(page);
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

    // 7. A reply to a stopped seat that the send wakes (message-delivery.ts: waiting mail starts its seat): the seat has it inside a second, so no waiting mark and no waiting line is ever drawn, and the chat says "Eve has it." once (9a684b2d5, 1fbdfd954).
    await check("g7-reply-to-stopped-seat-global", async (frames) => {
      await openThreads(page);
      await rows(page).filter({ hasText: "Eve" }).first().click();
      const text = "Eve, one more thing when you are back.";
      const input = pane(page).getByTestId("thread-composer-input");
      await input.click();
      await input.fill(text);
      await clearEars(page);
      const sentAt7 = await page.evaluate(() => performance.now());
      await pane(page).getByTestId("thread-composer-send").click();
      await expect(pane(page).getByTestId("seat-threads-message").filter({ hasText: text })).toBeVisible({ timeout: 15_000 });
      await expect.poll(async () => (await ears(page)).said.map((x) => x.text), { timeout: 30_000 }).toEqual(["Eve has it."]);
      await settle(2_500);
      frames.push(await shot("g7a-eve-has-it"));
      const heard = await ears(page);
      const said = heard.said.map((x) => x.text);
      const mailed = (await readSeatMailbox(page, CANVAS, s.eve.id)).some((m) => JSON.stringify(m).includes(text));
      if (heard.marks.length > 0 || JSON.stringify(said) !== JSON.stringify(["Eve has it."]) || !mailed)
        throw new Error(`waiting mark ${heard.marks.map((m, i) => `"${m.text}" drawn ${Math.round(m.t - sentAt7)} ms after the press, gone ${heard.gone[i] ? `${Math.round(heard.gone[i]!.t - m.t)} ms later` : "never"}`).join("; ")}; said ${JSON.stringify(said)} at ${JSON.stringify(heard.said.map((x) => Math.round(x.t - sentAt7)))} ms; in Eve's mailbox ${mailed}`);
      return `Eve woke on the send: no waiting mark drawn, said ${JSON.stringify(said)} once, the reply is in Eve's mailbox. The 1 s waiting line is not reachable from the UI (no noWake send, no seat that cannot start), so it is not checked here.`;
    });
    await closeThreads(page).catch(() => undefined);

    // 8. Seat view: Dov is opened on Threads, stopped there, and a reply wakes it: "Dov has it." once, no waiting mark; reopening the thread says nothing.
    await check("g8-reply-to-stopped-seat-seat-view", async (frames) => {
      await card(page, s.dov.id).dblclick();
      const surface = page.locator('[data-testid="native-terminal-surface"]:has(#seat-stage-seat-dov)');
      await expect(surface).toBeVisible({ timeout: 20_000 });
      await surface.getByTestId("seat-view-threads").click();
      await page.evaluate(async ([canvas, id]) => window.junto!.modelStop({ canvas, id }), [CANVAS, s.dov.id] as const);
      await settle(1_500);
      await surface.getByTestId("seat-threads-row").first().click();
      const text = "Dov, after the restart please confirm.";
      const input = surface.getByTestId("thread-composer-input");
      await input.click();
      await input.fill(text);
      await clearEars(page);
      await surface.getByTestId("thread-composer-send").click();
      await expect(surface.getByTestId("seat-threads-message").filter({ hasText: text })).toBeVisible({ timeout: 15_000 });
      await expect.poll(async () => (await ears(page)).said.map((x) => x.text), { timeout: 30_000 }).toEqual(["Dov has it."]);
      await settle(2_500);
      frames.push(await shot("g8a-dov-has-it"));
      const heard = await ears(page);
      const sentSaid = heard.said.map((x) => x.text);
      const marksSent = heard.marks.length;
      await surface.getByRole("button", { name: "Close view" }).first().click();
      await expect(surface).toHaveCount(0, { timeout: 10_000 });
      await clearEars(page);
      await card(page, s.dov.id).dblclick();
      await expect(surface).toBeVisible({ timeout: 20_000 });
      await surface.getByTestId("seat-view-threads").click();
      await surface.getByTestId("seat-threads-row").first().click();
      await settle(1_500);
      frames.push(await shot("g8b-reopened"));
      const reopen = await ears(page);
      await surface.getByRole("button", { name: "Close view" }).first().click();
      const problems: string[] = [];
      if (marksSent > 0) problems.push(`${marksSent} waiting mark(s) drawn on the send`);
      if (JSON.stringify(sentSaid) !== JSON.stringify(["Dov has it."])) problems.push(`said on send ${JSON.stringify(sentSaid)}`);
      if (reopen.said.length > 0 || reopen.marks.length > 0) problems.push(`on reopen said ${JSON.stringify(reopen.said)}, marks ${reopen.marks.length}`);
      if (problems.length > 0) throw new Error(problems.join("; "));
      return `seat view: no waiting mark, said ${JSON.stringify(sentSaid)} once on send; reopening the thread said nothing and drew no mark`;
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
      // The tally counts unread messages (Ada has two); the list is one row per thread.
      if (total < 3 || listed.length < 3 || unreadRows !== listed.length)
        throw new Error(`opened with Unread on, untouched 2 s: unread ${total}, rows ${listed.length}, unread rows ${unreadRows}: ${JSON.stringify(listed)}`);
      await rows(page).filter({ hasText: "Bea" }).first().click();
      await expect(pane(page)).toContainText("Bravo copy reviewed.", { timeout: 10_000 });
      await settle(1_000);
      const after = await unreadTotal(page);
      const afterRows = await rowTexts(page);
      const afterUnread = await page.getByTestId("operator-threads-row-unread").count();
      frames.push(await shot("g10b-one-pick"));
      await unreadChip(page).click();
      await closeThreads(page);
      if (after !== total - 1 || afterUnread !== listed.length - 1 || afterRows.length !== listed.length) throw new Error(`after one pick: unread ${total} -> ${after}, unread rows ${listed.length} -> ${afterUnread}, rows ${listed.length} -> ${afterRows.length}: ${JSON.stringify(afterRows)}`);
      return `opened with Unread on, untouched 2 s: ${total} unread in ${listed.length} rows, all unread; one pick (Bea): ${after} unread, ${afterUnread} unread rows, ${afterRows.length} rows still listed`;
    });

    // 11. Opens Most urgent first in the urgent order, not newest first (4b62ed661).
    await check("g11-urgent-order-at-open", async (frames) => {
      // Data on which the two orders must differ: the operator writes to Bea last, so Bea's thread is the newest but waits on nobody, while Ada's, Dov's and Eve's older threads wait on the operator.
      // Most urgent first ranks by seat state (urgentSeatsFirst), so Ada must be in an urgent group: she raises a blocked signal.
      const raised = await seat.ada.op("signal.raise", { kind: "blocked", text: "Ada cannot go on without the release notes" });
      if (!raised.ok) throw new Error(`signal refused ${JSON.stringify(raised)}`);
      await settle(1_000);
      await openThreads(page);
      await rows(page).filter({ hasText: "Bea" }).first().click();
      const note = "Bravo, anything else on the copy?";
      const noteInput = pane(page).getByTestId("thread-composer-input");
      await noteInput.click();
      await noteInput.fill(note);
      await pane(page).getByTestId("thread-composer-send").click();
      await expect(pane(page).getByTestId("seat-threads-message").filter({ hasText: note })).toBeVisible({ timeout: 15_000 });
      await settle(1_500);
      await closeThreads(page);
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
      if (!differs) throw new Error(`the two orders coincide on data built to differ: ${JSON.stringify(newest)}`);
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
        await page.keyboard.press(mod("U"));
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
