/**
 * [fake-tui] Quick thread from the canvas, in the real app with live seats:
 * its key, the seat and region picker, the thread input in it, a send to one
 * seat and to several (one new thread per seat, files included), the receipt
 * for a stopped seat, the draft kept across a close, the canvas selection,
 * and the Escape ladder.
 *
 * Each line is checked on its own and recorded pass or fail with its frame;
 * the test fails if any line failed. Frames and results.json land in
 * JUNTO_E2E_FRAMES_DIR (default test-results/quick-thread).
 *   bun run test:e2e:fast e2e/scenarios/quick-thread.spec.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { mod } from "../harness/keys";
import { card, canvasReady, cameraSettled, selectedIds } from "../harness/canvas";
import { crewOccupySeat, crewPlayFactory, crewSeat, installCrewSeatHarness } from "../harness/crew-fixture";
import { modelFixture, modelRegion, modelSeat } from "../harness/model";
import { readSeatMailbox } from "../harness/work-mail";
import { expect, launchJunto, test } from "../harness/launch";

const CANVAS = "quickthread";
const FRAMES = process.env.JUNTO_E2E_FRAMES_DIR ?? join("test-results", "quick-thread");

const seats = {
  ada: modelSeat({ id: "seat-ada", label: "Ada", x: 60, y: 120 }),
  bea: modelSeat({ id: "seat-bea", label: "Bea", x: 400, y: 120 }),
  dov: modelSeat({ id: "seat-dov", label: "Dov", x: 900, y: 120 }),
  cyd: modelSeat({ id: "seat-cyd", label: "Cyd", x: 1240, y: 120 }),
  bart: modelSeat({ id: "seat-bart", label: "Bartholomew Reviewer", x: 1580, y: 120 }),
};
const doc = modelFixture([
  modelRegion({ id: "region-core", label: "Core", x: 0, y: 0, width: 760, height: 420 }),
  ...Object.values(seats),
]);

type Line = { readonly id: string; readonly pass: boolean; readonly note: string; readonly frames: string[] };

const frameOf = (page: Page): Locator => page.getByTestId("quick-thread");
const field = (page: Page): Locator => frameOf(page).getByRole("combobox", { name: "Seat or region" });
const message = (page: Page): Locator => frameOf(page).getByTestId("thread-composer-input");
const chosen = (page: Page): Promise<string[]> =>
  frameOf(page).getByTestId("quick-thread-seat").evaluateAll((all) => all.map((e) => e.getAttribute("data-seat") ?? ""));
const activeTestId = (page: Page): Promise<string | null> =>
  page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.getAttribute("aria-label") ?? null);

const openQuickThread = async (page: Page): Promise<void> => {
  await page.keyboard.press(mod("Shift+U"));
  await expect(frameOf(page)).toBeVisible({ timeout: 10_000 });
};

/**
 * Open it with no seat chosen. Quick thread opens with the seat the keyboard was in chosen, and with a seat
 * chosen the picker sits behind the + (Add a seat), so a line that types in Seat or region starts from here.
 */
const openEmpty = async (page: Page): Promise<void> => {
  await openQuickThread(page);
  for (let i = 0; i < 6 && (await chosen(page)).length > 0; i += 1) {
    await frameOf(page).getByTestId("quick-thread-seat").first().getByRole("button").first().click();
    await settle(150);
  }
  await expect(field(page)).toBeVisible({ timeout: 10_000 });
};

/** Messages in a seat's mailbox whose text includes `text`. */
const mailWith = async (page: Page, seatId: string, text: string) =>
  (await readSeatMailbox(page, CANVAS, seatId)).filter((m) => JSON.stringify(m.parts).includes(text));

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("[fake-tui] Quick thread from the canvas", async () => {
  test.setTimeout(420_000);
  await mkdir(FRAMES, { recursive: true });
  const lines: Line[] = [];
  const upload = join(FRAMES, "quick-thread-attachment.txt");
  await writeFile(upload, "a file sent with a quick thread\n");
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
      // Leave nothing open for the next line.
      for (let i = 0; i < 3 && (await frameOf(page).count()) > 0; i += 1) await page.keyboard.press("Escape");
    }
    await writeFile(join(FRAMES, "results.json"), `${JSON.stringify(lines, null, 2)}\n`);
  };
  const settleMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const emptyCanvas = async (): Promise<void> => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await page.mouse.click(30, 300);
      await settleMs(250);
      if ((await selectedIds(page)).length === 0) return;
      await page.keyboard.press("Escape");
    }
    throw new Error(`canvas selection will not clear: ${JSON.stringify(await selectedIds(page))}`);
  };

  try {
    await canvasReady(page, { timeout: 30_000 });
    await page.getByRole("button", { name: "Fit all nodes" }).click();
    await cameraSettled(page);
    await crewPlayFactory(page);
    for (const seat of [seats.ada, seats.bea, seats.dov, seats.bart]) {
      await crewOccupySeat(page, CANVAS, { id: seat.id }, crewSeat(junto.sandbox, CANVAS, seat.id));
    }

    // 1. The key opens it from the canvas and from a focused terminal; 560 wide; keyboard in the field.
    await check("q1-key-opens", async (frames) => {
      await emptyCanvas();
      await openQuickThread(page);
      const box = await frameOf(page).boundingBox();
      await expect(field(page)).toBeFocused();
      frames.push(await shot("q1a-opened-from-canvas"));
      const width = box?.width ?? 0;
      await page.keyboard.press("Escape");
      await expect(frameOf(page)).toHaveCount(0);
      // With a terminal focused.
      await card(page, seats.ada.id).dblclick();
      const surface = page.locator('[data-testid="native-terminal-surface"]:has(#seat-stage-seat-ada)');
      await expect(surface).toBeVisible({ timeout: 20_000 });
      await surface.locator(".xterm").first().click();
      await openQuickThread(page);
      // The open seat is the canvas selection, so line 7 applies: it may start chosen, keyboard in the message.
      await settleMs(400);
      const overTerminal = await page.evaluate(() => {
        const frame = document.querySelector('[data-testid="quick-thread"]');
        const active = document.activeElement;
        return {
          chosen: [...(frame?.querySelectorAll('[data-testid="quick-thread-seat"]') ?? [])].map((el) => el.getAttribute("data-seat")),
          focus: active?.getAttribute("aria-label") ?? active?.getAttribute("placeholder") ?? active?.tagName ?? "",
          inMessage: active?.matches("textarea") === true,
        };
      });
      frames.push(await shot("q1b-opened-over-terminal"));
      const fieldFocused = await field(page).evaluate((el) => el === document.activeElement).catch(() => false);
      const asLine7 = overTerminal.chosen.join() === seats.ada.id && overTerminal.inMessage;
      if (!fieldFocused && !asLine7) throw new Error(`over a focused terminal: ${JSON.stringify(overTerminal)}`);
      // Leave no draft: take the seat off, then close.
      if (overTerminal.chosen.length > 0) await frameOf(page).getByTestId("quick-thread-seat").first().getByRole("button").first().click();
      await page.keyboard.press("Escape");
      if ((await frameOf(page).count()) > 0) await page.keyboard.press("Escape");
      await expect(frameOf(page)).toHaveCount(0);
      await surface.getByRole("button", { name: "Close view" }).first().click();
      await emptyCanvas();
      const top = box?.y ?? -1;
      if (Math.abs(width - 560) > 24) throw new Error(`frame is ${width}px wide`);
      const terminalNote = asLine7 ? "over a focused terminal it opens with that seat already chosen (it is the canvas selection, line 7) and the keyboard in the message" : "over a focused terminal the keyboard is in Seat or region";
      return `opens from the canvas (keyboard in Seat or region) and ${terminalNote}; ${Math.round(width)}px wide, top at ${Math.round(top)}px`;
    });

    // 2. Picker: ranking, region narrows, Enter picks and moves on, Shift+Enter stays, re-pick removes, Backspace ladder.
    await check("q2-picker", async (frames) => {
      await emptyCanvas();
      await openEmpty(page);
      const notes: string[] = [];
      await field(page).fill("Co");
      const options = frameOf(page).getByTestId("quick-thread-option");
      await expect(options.first()).toBeVisible();
      const kinds = await options.evaluateAll((all) => all.map((o) => `${o.getAttribute("data-kind")}:${(o.textContent ?? "").trim().slice(0, 20)}`));
      notes.push(`"Co" offers ${JSON.stringify(kinds.slice(0, 5))}`);
      frames.push(await shot("q2a-ranked"));
      // Enter on the region narrows and adds nobody.
      await field(page).fill("Core");
      await page.keyboard.press("Enter");
      await expect(frameOf(page).getByTestId("quick-thread-narrowed")).toBeVisible();
      if ((await chosen(page)).length !== 0) throw new Error("Enter on a region chose seats");
      const narrowed = await options.evaluateAll((all) => all.map((o) => o.getAttribute("data-seat")).filter(Boolean));
      notes.push(`region narrows to ${JSON.stringify(narrowed)}, nobody added`);
      frames.push(await shot("q2b-region-narrowed"));
      // Shift+Enter picks and stays.
      await field(page).fill("Bea");
      await page.keyboard.press("Shift+Enter");
      await expect.poll(() => chosen(page)).toEqual([seats.bea.id]);
      await expect(field(page)).toBeFocused();
      notes.push("Shift+Enter chose Bea and stayed in the field");
      // Re-pick takes it off.
      await field(page).fill("Bea");
      await page.keyboard.press("Shift+Enter");
      await expect.poll(() => chosen(page)).toEqual([]);
      notes.push("picking Bea again took her off");
      // Enter on a seat chips it with its portrait and moves to the message.
      await field(page).fill("Ada");
      await page.keyboard.press("Enter");
      await expect.poll(() => chosen(page)).toEqual([seats.ada.id]);
      await expect(message(page)).toBeFocused();
      const portrait = await frameOf(page).getByTestId("quick-thread-seat").first().locator("canvas, svg, img").count();
      notes.push(`Enter chose Ada (chip has ${portrait} portrait element(s)) and moved to the message`);
      frames.push(await shot("q2c-seat-chipped"));
      // Backspace in the empty field: region off, then last seat.
      await frameOf(page).getByTestId("quick-thread-add").click();
      await expect(field(page)).toBeFocused();
      await page.keyboard.press("Backspace");
      const regionGone = (await frameOf(page).getByTestId("quick-thread-narrowed").count()) === 0;
      await page.keyboard.press("Backspace");
      const afterSecond = await chosen(page);
      frames.push(await shot("q2d-backspace-ladder"));
      notes.push(`Backspace 1 took the region off: ${regionGone}; Backspace 2 left ${JSON.stringify(afterSecond)}`);
      if (!regionGone || afterSecond.length !== 0) throw new Error(notes.join("; "));
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      return notes.join("; ");
    });

    // 3. The message is the thread input: @ list not clipped, files attach.
    await check("q3-thread-input", async (frames) => {
      await openQuickThread(page);
      await field(page).fill("Ada");
      await page.keyboard.press("Enter");
      await expect(message(page)).toBeFocused();
      await page.keyboard.type("@");
      const list = page.getByRole("listbox").filter({ hasNot: frameOf(page).getByTestId("quick-thread-picker") }).last();
      await expect(list).toBeVisible({ timeout: 5_000 });
      const unclipped = await list.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const points = [
          [r.left + r.width / 2, r.top + 4],
          [r.left + r.width / 2, r.bottom - 4],
          [r.left + 4, r.top + r.height / 2],
          [r.right - 4, r.top + r.height / 2],
        ];
        return points.every(([x, y]) => el.contains(document.elementFromPoint(x!, y!))) && r.bottom <= window.innerHeight;
      });
      frames.push(await shot("q3a-mention-list"));
      await page.keyboard.press("Escape");
      await page.keyboard.press("Backspace");
      await frameOf(page).getByTestId("attach-files-input").setInputFiles(upload);
      await expect(frameOf(page).getByTestId("attachment-chip")).toHaveCount(1, { timeout: 10_000 });
      frames.push(await shot("q3b-file-attached"));
      if (!unclipped) throw new Error("the @ list is clipped or covered");
      return "@ list drawn whole (all four edges hit-test to it); file chip attached";
    });

    // 4a. Send to one seat (draft from line 3, with its file): one new thread, frame closes.
    await check("q4a-send-one", async (frames) => {
      if ((await frameOf(page).count()) === 0) throw new Error("frame from line 3 is not open");
      const text = "Quick thread to one seat";
      await message(page).fill(text);
      const send = frameOf(page).getByTestId("thread-composer-send");
      const label = ((await send.textContent()) ?? "").trim();
      await send.click();
      await expect(frameOf(page)).toHaveCount(0, { timeout: 15_000 });
      await expect.poll(async () => (await mailWith(page, seats.ada.id, text)).length, { timeout: 15_000 }).toBe(1);
      const mail = (await mailWith(page, seats.ada.id, text))[0]!;
      const hasFile = JSON.stringify(mail).includes("quick-thread-attachment");
      frames.push(await shot("q4a-sent-closed"));
      if (!hasFile) throw new Error(`Ada's mail carries no file: ${JSON.stringify(mail).slice(0, 400)}`);
      return `button read "${label}"; frame closed; Ada has 1 new mail with the text and the file`;
    });

    // 4b + lead line. Send to three with a file: one new thread per seat, same text and files.
    await check("q4b-send-three", async (frames) => {
      await emptyCanvas();
      await openEmpty(page);
      for (const name of ["Ada", "Bea"]) {
        await field(page).fill(name);
        await page.keyboard.press("Shift+Enter");
      }
      await field(page).fill("Dov");
      await page.keyboard.press("Enter");
      await expect.poll(() => chosen(page)).toEqual([seats.ada.id, seats.bea.id, seats.dov.id]);
      const text = "Quick thread to three seats";
      await message(page).fill(text);
      await frameOf(page).getByTestId("attach-files-input").setInputFiles(upload);
      await expect(frameOf(page).getByTestId("attachment-chip")).toHaveCount(1, { timeout: 10_000 });
      const send = frameOf(page).getByTestId("thread-composer-send");
      const label = ((await send.textContent()) ?? "").trim() || ((await send.getAttribute("aria-label")) ?? "");
      frames.push(await shot("q4b-three-chosen"));
      await send.click();
      await expect(frameOf(page)).toHaveCount(0, { timeout: 15_000 });
      const per: Record<string, { count: number; file: boolean; id?: string }> = {};
      for (const seat of [seats.ada, seats.bea, seats.dov, seats.bart]) {
        await expect.poll(async () => (await mailWith(page, seat.id, text)).length, { timeout: 15_000 }).toBeGreaterThan(0);
        const mail = await mailWith(page, seat.id, text);
        per[seat.id] = { count: mail.length, file: JSON.stringify(mail).includes("quick-thread-attachment"), id: mail[0]?.messageId };
      }
      frames.push(await shot("q4b-sent-closed"));
      const ids = new Set(Object.values(per).map((p) => p.id));
      const problems: string[] = [];
      if (!/Send to 3/.test(label)) problems.push(`button read "${label}"`);
      for (const [id, p] of Object.entries(per)) {
        if (p.count !== 1) problems.push(`${id} has ${p.count} mails`);
        if (!p.file) problems.push(`${id} has no file`);
      }
      if (ids.size !== 3) problems.push("the three mails are not three separate messages");
      if (problems.length > 0) throw new Error(`${problems.join("; ")} ${JSON.stringify(per)}`);
      return `button read "${label}"; frame closed; 3 separate new mails, one per seat, each with the text and the file`;
    });

    // 5. A stopped seat: the receipt, its announcement, Done focused and described, nothing sent twice.
    await check("q5-stopped-seat-receipt", async (frames) => {
      await emptyCanvas();
      await openEmpty(page);
      await field(page).fill("Cyd");
      await page.keyboard.press("Enter");
      const text = "Quick thread to a stopped seat";
      await message(page).fill(text);
      await frameOf(page).getByTestId("thread-composer-send").click();
      const receipt = frameOf(page).getByTestId("quick-thread-receipt");
      await expect(receipt).toBeVisible({ timeout: 15_000 });
      const sentLine = ((await receipt.locator(".quick-thread__sent").textContent()) ?? "").trim();
      const waitingLine = ((await frameOf(page).getByTestId("quick-thread-waiting-line").textContent()) ?? "").trim();
      const clock = await receipt.getByTestId("quick-thread-sent-seat").locator("svg").count();
      const done = frameOf(page).getByTestId("quick-thread-done");
      await expect(done).toBeFocused();
      const doneDescription = await done.evaluate((el) => {
        const ids = (el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
        return ids.map((id) => document.getElementById(id)?.textContent?.trim() ?? "").join(" ");
      });
      const spoken = ((await page.getByTestId("quick-thread-spoken").textContent()) ?? "").trim();
      frames.push(await shot("q5a-receipt"));
      await done.click();
      await expect(frameOf(page)).toHaveCount(0);
      await settle(1_500);
      const mails = await mailWith(page, seats.cyd.id, text);
      const problems: string[] = [];
      if (!/Sent to 1 seat/.test(sentLine)) problems.push(`sent line "${sentLine}"`);
      if (waitingLine !== "Waiting for Cyd. It arrives when the seat is back.") problems.push(`waiting line "${waitingLine}"`);
      if (mails.length !== 1) problems.push(`Cyd's mailbox holds ${mails.length} copies`);
      if (!doneDescription.includes("Waiting for Cyd")) problems.push(`Done is described as "${doneDescription}"`);
      if (!spoken.includes("Waiting for Cyd")) problems.push(`announced "${spoken}"`);
      if (problems.length > 0) throw new Error(problems.join("; "));
      return `receipt "${sentLine}", "${waitingLine}", ${clock} icon(s) on the seat; Done focused, described as "${doneDescription}"; live region "${spoken}" (accessibility tree, not a VoiceOver run); Cyd holds exactly 1 copy`;
    });

    // 6. Escape with an unsent draft, open again: the chosen seats are cleared, the text and files stay (operator ruling, 50c03bc9c and 904e3da1e).
    await check("q6-draft-kept", async (frames) => {
      await emptyCanvas();
      await openEmpty(page);
      await field(page).fill("Bea");
      await page.keyboard.press("Enter");
      await message(page).fill("Draft that must survive");
      await frameOf(page).getByTestId("attach-files-input").setInputFiles(upload);
      await expect(frameOf(page).getByTestId("attachment-chip")).toHaveCount(1, { timeout: 10_000 });
      await page.keyboard.press("Escape");
      if ((await frameOf(page).count()) > 0) await page.keyboard.press("Escape");
      await expect(frameOf(page)).toHaveCount(0);
      await openQuickThread(page);
      const back = { seats: await chosen(page), text: await message(page).inputValue().catch(async () => (await message(page).textContent()) ?? ""), files: await frameOf(page).getByTestId("attachment-chip").count() };
      frames.push(await shot("q6a-draft-back-after-escape"));
      // A press outside, then again.
      await page.mouse.click(20, page.viewportSize() ? page.viewportSize()!.height - 20 : 700);
      await expect(frameOf(page)).toHaveCount(0, { timeout: 5_000 });
      await openQuickThread(page);
      const back2 = { seats: await chosen(page), text: await message(page).inputValue().catch(async () => (await message(page).textContent()) ?? ""), files: await frameOf(page).getByTestId("attachment-chip").count() };
      frames.push(await shot("q6b-draft-back-after-press-outside"));
      if (back.seats.length !== 0 || !back.text.includes("Draft that must survive") || back.files !== 1 || back2.seats.length !== 0 || !back2.text.includes("Draft that must survive") || back2.files !== 1)
        throw new Error(`after Escape ${JSON.stringify(back)}; after a press outside ${JSON.stringify(back2)}; wanted no seats, the text and 1 file each time`);
      // Clear the draft for line 7: no seat is chosen, so empty the text and file.
      await message(page).fill("");
      await frameOf(page).getByRole("button", { name: /^Remove / }).first().click().catch(() => undefined);
      await page.keyboard.press("Escape");
      if ((await frameOf(page).count()) > 0) await page.keyboard.press("Escape");
      return `after Escape: ${JSON.stringify(back)}; after a press outside: ${JSON.stringify(back2)}`;
    });

    // 7. Seats selected on the canvas start chosen.
    await check("q7-canvas-selection", async (frames) => {
      await card(page, seats.ada.id).click();
      await card(page, seats.dov.id).click({ modifiers: ["Shift"] });
      await expect.poll(async () => page.evaluate(() => window.__juntoCanvas?.selection() ?? [])).toHaveLength(2);
      await openQuickThread(page);
      const picked = await chosen(page);
      frames.push(await shot("q7-selection-chosen"));
      await page.keyboard.press("Escape");
      if ((await frameOf(page).count()) > 0) await page.keyboard.press("Escape");
      if (picked.sort().join() !== [seats.ada.id, seats.dov.id].sort().join()) throw new Error(`chosen ${JSON.stringify(picked)}`);
      return `Ada and Dov selected on the canvas start chosen: ${JSON.stringify(picked)}`;
    });

    // 8. Escape ladder from the plus picker, and focus goes back where it was.
    await check("q8-escape-ladder", async (frames) => {
      await emptyCanvas();
      await page.getByRole("button", { name: "Fit all nodes" }).focus();
      await openQuickThread(page);
      // Clear any seats line 7 left chosen.
      for (let i = 0; i < 4 && (await chosen(page)).length > 0; i += 1) await page.keyboard.press("Backspace");
      await field(page).fill("Ada");
      await page.keyboard.press("Enter");
      await expect(message(page)).toBeFocused();
      await frameOf(page).getByTestId("quick-thread-add").click();
      await expect(field(page)).toBeFocused();
      frames.push(await shot("q8a-plus-picker"));
      await page.keyboard.press("Escape");
      const afterFirst = { open: (await frameOf(page).count()) > 0, messageFocused: await message(page).evaluate((el) => el === document.activeElement || el.contains(document.activeElement)).catch(() => false) };
      await page.keyboard.press("Escape");
      await expect(frameOf(page)).toHaveCount(0, { timeout: 5_000 });
      const focusBack = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName ?? "");
      frames.push(await shot("q8b-closed-focus-back"));
      if (!afterFirst.open || !afterFirst.messageFocused || focusBack !== "Fit all nodes")
        throw new Error(`first Escape ${JSON.stringify(afterFirst)}; focus after close on "${focusBack}"`);
      return `first Escape back to the message, second closes, focus back on "${focusBack}"`;
    });
    // product-design, cb54ddeef: a row whose time carries a year, beside an unread pill, in the narrow list.
    // The renderer's clock is moved a year on (init script, then a reload), so today's mail reads as a date with a year.
    await check("t1-narrow-row-dated", async (frames) => {
      const bart = crewSeat(junto.sandbox, CANVAS, seats.bart.id);
      const sent = await page.evaluate(
        async ([canvasName, nodeId]) => window.junto!.seatThreadSend({ canvasName, nodeId, text: "Old thread for the date check" } as never),
        [CANVAS, seats.bart.id] as const,
      );
      if (!sent.ok) throw new Error(`send refused ${JSON.stringify(sent)}`);
      const reply = await bart.op("msg.reply", { target: "operator", inReplyTo: sent.messageId, text: "Reply that will read as last year" });
      if (!reply.ok) throw new Error(`reply refused ${JSON.stringify(reply)}`);
      await page.context().addInitScript(() => {
        const shift = 375 * 24 * 60 * 60 * 1000;
        const RealDate = Date;
        const realNow = RealDate.now.bind(RealDate);
        class ShiftedDate extends RealDate {
          constructor(...args: unknown[]) {
            if (args.length === 0) super(realNow() + shift);
            else super(...(args as [number]));
          }
          static now(): number {
            return realNow() + shift;
          }
        }
        (globalThis as unknown as { Date: DateConstructor }).Date = ShiftedDate as unknown as DateConstructor;
      });
      await page.reload();
      await canvasReady(page, { timeout: 30_000 });
      const yearNow = await page.evaluate(() => new Date().getFullYear());
      await page.getByRole("button", { name: "Fit all nodes" }).click();
      await cameraSettled(page);
      await card(page, seats.bart.id).dblclick();
      const surface = page.locator('[data-testid="native-terminal-surface"]:has(#seat-stage-seat-bart)');
      await expect(surface).toBeVisible({ timeout: 20_000 });
      await surface.getByTestId("seat-view-threads").click();
      const row = surface.getByTestId("seat-threads-row").first();
      await expect(row).toBeVisible({ timeout: 15_000 });
      const original = await junto.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getSize());
      const readings: unknown[] = [];
      for (const width of [original[0]!, 1280, 1100, 960, 820, 720]) {
        await junto.app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0]!.setSize(w, h), [width, original[1]!] as [number, number]);
        await settle(700);
        const reading = await row.evaluate((el) => {
          const who = el.querySelector<HTMLElement>(".seat-threads__row-who");
          const time = el.querySelector<HTMLElement>('[data-testid="thread-time"]');
          const pill = el.querySelector<HTMLElement>('[data-testid="seat-threads-row-unread"]');
          const list = el.closest("ul")?.getBoundingClientRect().width ?? 0;
          let letters = 0;
          const node = who?.firstChild;
          if (who && node && node.nodeType === Node.TEXT_NODE) {
            const box = who.getBoundingClientRect();
            const range = document.createRange();
            for (let i = 1; i <= (node.textContent ?? "").length; i += 1) {
              range.setStart(node, 0);
              range.setEnd(node, i);
              if (range.getBoundingClientRect().right <= box.right + 0.5) letters = i;
            }
          }
          return {
            list: Math.round(list),
            row: Math.round(el.getBoundingClientRect().width),
            name: who?.textContent ?? "",
            lettersShown: letters,
            time: time?.querySelector('[aria-hidden="true"]')?.textContent ?? time?.textContent ?? "",
            // TooltipLayer moves a native title to data-junto-tooltip.
            timeTitle: time?.getAttribute("title") || time?.dataset.juntoTooltip || "",
            pill: pill?.textContent ?? "",
          };
        });
        readings.push({ window: width, ...reading });
        frames.push(await shot(`t1-narrow-row-${String(width)}`));
      }
      // The message time's hover, in the open chat.
      await row.click();
      const messageTime = surface.getByTestId("seat-threads-message").last().getByTestId("thread-time");
      const messageTitle = (await messageTime.evaluate((el) => el.getAttribute("title") || (el as HTMLElement).dataset.juntoTooltip || "")) ?? "";
      await messageTime.hover();
      await settle(400);
      const messageTip = ((await page.locator("#junto-tooltip").textContent().catch(() => "")) ?? "").trim();
      frames.push(await shot("t1-message-time-hover"));
      await junto.app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0]!.setSize(w, h), original as [number, number]);
      await writeFile(join(FRAMES, "t1-readings.json"), `${JSON.stringify({ yearNow, readings, messageTitle, messageTip }, null, 2)}\n`);
      const narrowest = readings[readings.length - 1] as { lettersShown: number; time: string; timeTitle: string; list: number; pill: string };
      const hoverForm = /^[A-Z][a-z]+day \d{1,2} [A-Z][a-z]+ \d{4}, \d{2}:\d{2}$/;
      const problems: string[] = [];
      if (narrowest.pill === "") problems.push("no unread pill on the row, so it is not beside one");
      if (!/\d{4}/.test(narrowest.time)) problems.push(`row time "${narrowest.time}" has no year`);
      if (narrowest.lettersShown < 6) problems.push(`only ${narrowest.lettersShown} letters of the name at list width ${narrowest.list}px`);
      if (!hoverForm.test(narrowest.timeTitle)) problems.push(`row hover "${narrowest.timeTitle}"`);
      if (!hoverForm.test(messageTitle)) problems.push(`message hover "${messageTitle}"`);
      if (problems.length > 0) throw new Error(`${problems.join("; ")} ${JSON.stringify(readings)}`);
      return `clock at ${yearNow}; ${JSON.stringify(readings)}; message hover "${messageTitle}", tooltip drawn "${messageTip}"`;
    });
  } finally {
    await writeFile(join(FRAMES, "results.json"), `${JSON.stringify(lines, null, 2)}\n`).catch(() => undefined);
    await junto.close();
  }
  const failed = lines.filter((l) => !l.pass);
  expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
});
