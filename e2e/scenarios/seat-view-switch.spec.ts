/**
 * [fake-tui] The seat modal's two views, Terminal and Threads, behind one
 * switch in the seat header, in the real app with live seats.
 *
 * Each line is checked on its own and recorded pass or fail with its frame,
 * so one failure does not hide the next; the test fails if any line failed.
 * The child's own view of its size comes from the fake seat's resize log
 * (SIGWINCH, e2e/harness/crew-fixture.ts), so "no redraw at a wrong size"
 * is read from the process, not from the window.
 *
 * Frames and results.json land in JUNTO_E2E_FRAMES_DIR
 * (default test-results/seat-view-switch).
 *   bun run test:e2e:fast e2e/scenarios/seat-view-switch.spec.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { mod } from "../harness/keys";
import { card, canvasReady, cameraSettled, selectedIds } from "../harness/canvas";
import { crewOccupySeat, crewPlayFactory, crewSeat, installCrewSeatHarness, type CrewSeat } from "../harness/crew-fixture";
import { modelFixture, modelMessagesWire, modelSeat } from "../harness/model";
import { waitForTerminalPaint } from "../harness/term-ready";
import { readSeatMailbox } from "../harness/work-mail";
import { expect, launchJunto, test } from "../harness/launch";

const CANVAS = "seatview";
const A = "seat-a";
const B = "seat-b";
const C = "seat-c";
const FRAMES = process.env.JUNTO_E2E_FRAMES_DIR ?? join("test-results", "seat-view-switch");

const seatA = modelSeat({ id: A, label: "Ada", x: 40, y: 40 });
const seatB = modelSeat({ id: B, label: "Bea", x: 380, y: 40 });
const seatC = modelSeat({ id: C, label: "Cyd", x: 720, y: 40 });
const doc = modelFixture([seatA, seatB, seatC], [modelMessagesWire("e-ab", A, B, [seatA, seatB])]);

type Line = { readonly id: string; readonly pass: boolean; readonly note: string; readonly frames: string[] };

const surfaceOf = (page: Page, id: string): Locator =>
  page.locator(`[data-testid="native-terminal-surface"]:has(#seat-stage-${id})`);
const stageOf = (page: Page, id: string): Locator => page.locator(`#seat-stage-${id}`);
const tabOf = (page: Page, id: string, view: "terminal" | "threads"): Locator =>
  surfaceOf(page, id).getByTestId(`seat-view-${view}`);

type Box = { x: number; y: number; width: number; height: number };
const boxOf = async (locator: Locator): Promise<Box> => {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("no box");
  return box;
};
const sameBox = (a: Box, b: Box): boolean =>
  Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;

/** The frame parts that must not move on a switch: header, stage, rail. */
const frameParts = async (page: Page, id: string) => {
  const surface = surfaceOf(page, id);
  return {
    header: await boxOf(surface.locator("> *").first()),
    stage: await boxOf(stageOf(page, id)),
    rail: (await surface.getByTestId("actor-rail").count()) > 0 ? await boxOf(surface.getByTestId("actor-rail")) : undefined,
    surface: await boxOf(surface),
  };
};

/** The unread count the switch's Threads half carries; 0 when none is drawn. */
const unreadOnSwitch = async (page: Page, id: string): Promise<number> => {
  const text = ((await tabOf(page, id, "threads").textContent()) ?? "").replace("Threads", "").trim();
  return text === "" ? 0 : Number.parseInt(text, 10);
};

/** Sizes the child process heard, oldest first: its spawn size, then each SIGWINCH. */
const childSizes = async (seat: CrewSeat): Promise<ReadonlyArray<{ at: number; cols: number; rows: number }>> =>
  (await seat.events())
    .filter((e) => e.event === "spawn" || e.event === "resize")
    .map((e) => e as unknown as { at: number; cols: number; rows: number });

/** The xterm's own grid, as the seat header states it ("104×32"); 0x0 when not attached. */
const xtermGrid = async (page: Page, id: string): Promise<{ cols: number; rows: number }> => {
  const header = (await surfaceOf(page, id).locator("> *").first().textContent()) ?? "";
  const match = /(\d+)×(\d+)/.exec(header);
  return match ? { cols: Number(match[1]), rows: Number(match[2]) } : { cols: 0, rows: 0 };
};

/** Every mounted terminal's visible screen text (the WebGL renderer draws no DOM text). */
const screenTexts = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const registry = (window as unknown as { __juntoTermScreenText?: Map<string, () => string> }).__juntoTermScreenText;
    return registry === undefined ? [] : Array.from(registry.values()).map((read) => read());
  });

const openSeat = async (page: Page, id: string): Promise<void> => {
  await card(page, id).dblclick();
  await expect(stageOf(page, id)).toBeVisible({ timeout: 30_000 });
};

const closeSeat = async (page: Page, id: string): Promise<void> => {
  await surfaceOf(page, id).getByRole("button", { name: "Close view" }).first().click();
  await expect(stageOf(page, id)).toHaveCount(0, { timeout: 10_000 });
};

const settleMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("[fake-tui] seat view switch: Terminal and Threads in one seat modal", async () => {
  test.setTimeout(420_000);
  await mkdir(FRAMES, { recursive: true });
  const lines: Line[] = [];
  const junto = await launchJunto({ seedModels: { [CANVAS]: doc }, afterSeed: installCrewSeatHarness });
  const page = junto.page;
  const shot = async (name: string): Promise<string> => {
    const path = join(FRAMES, `${name}.png`);
    await page.screenshot({ path });
    return path;
  };
  /** Ada and Bea selected on the canvas, retried until the canvas holds both. */
  const selectBoth = async (): Promise<void> => {
    const selection = async () => [...(await selectedIds(page))].sort();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await card(page, A).click();
      await card(page, B).click({ modifiers: ["Shift"] });
      if ((await selection()).join() === [A, B].sort().join()) return;
      await settleMs(400);
    }
    throw new Error(`canvas selection is ${JSON.stringify(await selection())}, not Ada and Bea`);
  };
  const check = async (id: string, run: (frames: string[]) => Promise<string>): Promise<void> => {
    const frames: string[] = [];
    try {
      const note = await run(frames);
      lines.push({ id, pass: true, note, frames });
    } catch (error) {
      frames.push(await shot(`${id}-FAIL`).catch(() => "no frame"));
      lines.push({ id, pass: false, note: String(error instanceof Error ? error.message : error).slice(0, 900), frames });
    }
    await writeFile(join(FRAMES, "results.json"), `${JSON.stringify(lines, null, 2)}\n`);
  };

  try {
    await canvasReady(page, { timeout: 30_000 });
    await page.getByRole("button", { name: "Fit all nodes" }).click();
    await cameraSettled(page);
    await crewPlayFactory(page);
    const a = crewSeat(junto.sandbox, CANVAS, A);
    const b = crewSeat(junto.sandbox, CANVAS, B);
    const c = crewSeat(junto.sandbox, CANVAS, C);
    await crewOccupySeat(page, CANVAS, { id: A }, a);
    await crewOccupySeat(page, CANVAS, { id: B }, b);

    // Two threads with A, each answered by A: two unread for the operator.
    const send = (text: string) =>
      page.evaluate(
        async ([canvasName, nodeId, body]) => window.junto!.seatThreadSend({ canvasName, nodeId, text: body } as never),
        [CANVAS, A, text] as const,
      );
    const first = await send("First thread: status of the build?");
    const second = await send("Second thread: which tests failed?");
    if (!first.ok || !second.ok) throw new Error(`operator send refused: ${JSON.stringify([first, second])}`);
    for (const [sent, text] of [
      [first, "Build is green. Also see [Bea](junto://canvas/seatview?node=seat-b)."],
      [second, "Two tests failed in the settings suite."],
    ] as const) {
      const reply = await a.op("msg.reply", { target: "operator", inReplyTo: sent.messageId, text });
      if (!reply.ok) throw new Error(`seat reply refused: ${JSON.stringify(reply)}`);
    }

    // (1) Opens on Terminal by default; the switch is in the header.
    let before: Awaited<ReturnType<typeof frameParts>> | undefined;
    let sizesBefore = 0;
    let gridBefore = { cols: 0, rows: 0 };
    await check("01-opens-on-terminal", async (frames) => {
      await openSeat(page, A);
      await waitForTerminalPaint(page);
      await expect(surfaceOf(page, A).getByRole("tablist", { name: "Seat view" })).toBeVisible();
      await expect(tabOf(page, A, "terminal")).toHaveAttribute("aria-selected", "true");
      await expect(stageOf(page, A)).toHaveAttribute("aria-label", "Terminal");
      await expect(surfaceOf(page, A).getByTestId("seat-threads")).toBeHidden();
      // Left of Params.
      const sw = await boxOf(surfaceOf(page, A).getByRole("tablist", { name: "Seat view" }));
      const params = await boxOf(surfaceOf(page, A).getByTestId("terminal-start-params"));
      if (!(sw.x + sw.width <= params.x + 0.5)) throw new Error(`switch is not left of Params: ${JSON.stringify({ sw, params })}`);
      await expect.poll(() => unreadOnSwitch(page, A), { timeout: 15_000 }).toBe(2);
      await settleMs(1_500);
      before = await frameParts(page, A);
      sizesBefore = (await childSizes(a)).length;
      gridBefore = await xtermGrid(page, A);
      frames.push(await shot("01-opens-on-terminal"));
      return `Terminal selected, 2 unread on the Threads half, switch left of Params; xterm ${gridBefore.cols}x${gridBefore.rows}`;
    });

    // (6, modals) A thread behind Terminal stays unread.
    await check("02-unread-behind-terminal", async () => {
      await settleMs(2_000);
      const count = await unreadOnSwitch(page, A);
      if (count !== 2) throw new Error(`unread changed behind Terminal: ${count}`);
      return "2 unread after 2s behind Terminal";
    });

    // (1, lead) Threads in place of the terminal, same frame.
    await check("03-threads-same-frame", async (frames) => {
      await tabOf(page, A, "threads").click();
      await expect(stageOf(page, A)).toHaveAttribute("aria-label", "Threads");
      await expect(surfaceOf(page, A).getByTestId("seat-threads")).toBeVisible();
      await expect(surfaceOf(page, A).getByTestId("seat-threads-row").first()).toBeVisible({ timeout: 15_000 });
      await settleMs(500);
      const after = await frameParts(page, A);
      if (before === undefined) throw new Error("no Terminal frame to compare");
      const moved = (["header", "stage", "surface"] as const).filter((k) => !sameBox(before![k], after[k]));
      if (before.rail && after.rail && !sameBox(before.rail, after.rail)) moved.push("rail" as never);
      if ((before.rail === undefined) !== (after.rail === undefined)) moved.push("rail" as never);
      frames.push(await shot("03-threads-same-frame"));
      if (moved.length > 0) throw new Error(`moved on the switch: ${moved.join(", ")} ${JSON.stringify({ before, after })}`);
      return `header, stage, rail and surface boxes identical; rail ${before.rail ? "present" : "absent"}`;
    });

    // (3, lead) The count clears only for the thread shown.
    await check("04-unread-only-shown", async (frames) => {
      // Shown and untouched stays unread (40db2b1f9); one press in the chat reads only the shown thread.
      const shownRows = await surfaceOf(page, A).locator('[data-testid="seat-threads-row"][aria-current="true"]').count();
      await settleMs(2_000);
      const untouched = await unreadOnSwitch(page, A);
      const untouchedRows = await surfaceOf(page, A).locator('[data-testid="seat-threads-row"][data-unread="true"]').count();
      frames.push(await shot("04a-shown-untouched"));
      await surfaceOf(page, A).getByTestId("seat-threads-message").last().click();
      await expect.poll(() => unreadOnSwitch(page, A), { timeout: 10_000 }).toBe(1);
      const stillUnread = await surfaceOf(page, A).locator('[data-testid="seat-threads-row"][data-unread="true"]').count();
      frames.push(await shot("04b-after-press-in-chat"));
      if (untouched !== 2 || untouchedRows !== 2) throw new Error(`shown, untouched for 2 s: switch ${untouched}, unread rows ${untouchedRows}`);
      if (stillUnread !== 1) throw new Error(`after one press in the chat: rows still unread ${stillUnread}`);
      return `${shownRows} thread shown; untouched 2 s: switch 2, 2 rows unread; one press in the chat: switch 1, 1 row still unread`;
    });

    // (12, modals) The Threads half is named "Threads, N unread"; the pill is for the eye only.
    // Read from the accessibility tree, not from VoiceOver itself.
    await check("04b-switch-accessible-name", async () => {
      const count = await unreadOnSwitch(page, A);
      const tab = tabOf(page, A, "threads");
      await expect(tab).toHaveAccessibleName(`Threads, ${String(count)} unread`);
      const pillHidden = await tab.evaluate((el) =>
        Array.from(el.querySelectorAll("*")).filter((c) => /\d/.test(c.textContent ?? "") && c.children.length === 0).every((c) => c.closest("[aria-hidden='true']") !== null),
      );
      if (!pillHidden) throw new Error("the count pill is in the accessibility tree");
      const role = await tab.getAttribute("role");
      return `accessible name "Threads, ${String(count)} unread", role ${String(role)}, pill aria-hidden (accessibility tree, not a VoiceOver run)`;
    });

    // (3, modals) Keys under Threads never reach the terminal.
    await check("05-keys-not-in-terminal", async () => {
      const marker = "zzq-under-threads";
      await page.keyboard.type(marker);
      await settleMs(800);
      const stdin = await a.stdinLog();
      // Leave the composer empty again.
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.press("Backspace");
      if (stdin.includes(marker)) throw new Error("typed text reached the seat's PTY");
      return "typed marker absent from the seat's PTY input";
    });

    // (2, lead; 3, modals) Back to Terminal by click: intact, keyboard in it, no resize.
    await check("06-back-to-terminal-intact", async (frames) => {
      await tabOf(page, A, "terminal").click();
      await expect(stageOf(page, A)).toHaveAttribute("aria-label", "Terminal");
      await settleMs(1_000);
      const focusInTerminal = await surfaceOf(page, A).evaluate((root) => {
        const active = document.activeElement;
        return active !== null && root.querySelector(".xterm")?.contains(active) === true;
      });
      const sizes = await childSizes(a);
      const grid = await xtermGrid(page, A);
      const screen = (await screenTexts(page)).join("\n");
      frames.push(await shot("06-back-to-terminal"));
      const problems: string[] = [];
      if (!focusInTerminal) problems.push("keyboard is not in the terminal");
      if (sizes.length !== sizesBefore) problems.push(`child heard ${sizes.length - sizesBefore} resize(s): ${JSON.stringify(sizes.slice(sizesBefore))}`);
      if (grid.cols !== gridBefore.cols || grid.rows !== gridBefore.rows) problems.push(`xterm grid ${JSON.stringify(gridBefore)} -> ${JSON.stringify(grid)}`);
      if (!screen.includes("Ask Codex")) problems.push("screen lost its prompt");
      if (problems.length > 0) throw new Error(problems.join("; "));
      return `keyboard in terminal, no resize heard by the child, grid ${grid.cols}x${grid.rows} unchanged, prompt on screen`;
    });

    // (8, modals) Left and Right on the switch; (10) one Tab stop.
    await check("07-switch-keys", async (frames) => {
      await tabOf(page, A, "terminal").focus();
      await page.keyboard.press("ArrowRight");
      await expect(stageOf(page, A)).toHaveAttribute("aria-label", "Threads");
      const onThreadsTab = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
      frames.push(await shot("07a-right-to-threads"));
      await page.keyboard.press("ArrowLeft");
      await expect(stageOf(page, A)).toHaveAttribute("aria-label", "Terminal");
      const onTerminalTab = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
      const tabStops = await surfaceOf(page, A).getByRole("tablist", { name: "Seat view" }).evaluate(
        (list) => Array.from(list.querySelectorAll('[role="tab"]')).filter((t) => (t as HTMLElement).tabIndex >= 0).length,
      );
      await page.keyboard.press("Tab");
      const afterTab = await page.evaluate(() => ({ role: document.activeElement?.getAttribute("role"), id: document.activeElement?.getAttribute("data-testid") }));
      frames.push(await shot("07b-left-and-tab"));
      const problems: string[] = [];
      if (onThreadsTab !== "seat-view-threads") problems.push(`after Right the keyboard is on ${String(onThreadsTab)}`);
      if (onTerminalTab !== "seat-view-terminal") problems.push(`after Left the keyboard is on ${String(onTerminalTab)}`);
      if (tabStops !== 1) problems.push(`${tabStops} tab stops in the switch`);
      if (afterTab.role === "tab") problems.push(`one Tab left the keyboard on ${String(afterTab.id)}`);
      if (problems.length > 0) throw new Error(problems.join("; "));
      return `Right and Left switch views with the keyboard kept on the switch; 1 tab stop; Tab moved to ${String(afterTab.id ?? afterTab.role)}`;
    });

    // (4, modals revised) Resize the window under Threads: the covered terminal follows; back shows it, no redraw.
    await check("08-resize-under-threads", async (frames) => {
      await tabOf(page, A, "threads").click();
      await expect(stageOf(page, A)).toHaveAttribute("aria-label", "Threads");
      const sizesStart = (await childSizes(a)).length;
      const original = await junto.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getSize());
      await junto.app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0]!.setSize(w - 240, h - 160), original as [number, number]);
      await expect.poll(async () => (await childSizes(a)).length, { timeout: 10_000 }).toBeGreaterThan(sizesStart);
      await settleMs(1_200);
      const covered = await childSizes(a);
      const atSwitch = covered.length;
      const heard = covered[covered.length - 1]!;
      frames.push(await shot("08a-resized-under-threads"));
      await tabOf(page, A, "terminal").click();
      await expect(stageOf(page, A)).toHaveAttribute("aria-label", "Terminal");
      await settleMs(1_200);
      const after = await childSizes(a);
      const grid = await xtermGrid(page, A);
      frames.push(await shot("08b-back-at-new-size"));
      await junto.app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0]!.setSize(w, h), original as [number, number]);
      await settleMs(1_200);
      const problems: string[] = [];
      if (after.length !== atSwitch) problems.push(`child heard ${after.length - atSwitch} resize(s) on the way back: ${JSON.stringify(after.slice(atSwitch))}`);
      if (grid.cols !== heard.cols || grid.rows !== heard.rows) problems.push(`xterm ${grid.cols}x${grid.rows} vs child ${heard.cols}x${heard.rows}`);
      if (problems.length > 0) throw new Error(problems.join("; "));
      return `child followed under Threads to ${heard.cols}x${heard.rows} (${atSwitch - sizesStart} resize(s) while covered); none on the way back; xterm matches`;
    });

    // (3, lead) Reply from the Threads view; the other thread's unread clears when shown.
    await check("09-reply-from-threads", async (frames) => {
      await tabOf(page, A, "threads").click();
      const unreadRow = surfaceOf(page, A).locator('[data-testid="seat-threads-row"][data-unread="true"]').first();
      if ((await unreadRow.count()) > 0) await unreadRow.click();
      else await surfaceOf(page, A).getByTestId("seat-threads-row").nth(1).click();
      // Picking the row is a press in the list; if it does not read, one press in the chat must.
      let readBy = "the row pick";
      const picked = await expect.poll(() => unreadOnSwitch(page, A), { timeout: 3_000 }).toBe(0).then(() => true, () => false);
      if (!picked) {
        readBy = "a press in the chat after the pick";
        await surfaceOf(page, A).getByTestId("seat-threads-message").last().click();
        await expect.poll(() => unreadOnSwitch(page, A), { timeout: 10_000 }).toBe(0);
      }
      const text = "Reply from the Threads view, please rerun them.";
      const input = surfaceOf(page, A).getByTestId("thread-composer-input");
      await input.click();
      await input.fill(text);
      await surfaceOf(page, A).getByTestId("thread-composer-send").click();
      await expect(surfaceOf(page, A).getByTestId("seat-threads-message").filter({ hasText: text })).toBeVisible({ timeout: 15_000 });
      await expect.poll(async () => (await readSeatMailbox(page, CANVAS, A)).some((m) => JSON.stringify(m).includes(text)), { timeout: 15_000 }).toBe(true);
      frames.push(await shot("09-reply-from-threads"));
      return `second thread read by ${readBy}, count 0; reply drawn in the thread and stored in the seat's mailbox`;
    });

    // (7, modals) A mention opens what it names; the threads are still there after.
    await check("10-mention-opens", async (frames) => {
      const firstRow = surfaceOf(page, A).locator(`[data-testid="seat-threads-row"][data-thread-id="${first.ok ? first.threadId : ""}"]`);
      await firstRow.click();
      const mention = surfaceOf(page, A).getByTestId("seat-threads-mention").first();
      await expect(mention).toBeVisible({ timeout: 10_000 });
      await mention.click();
      await expect(stageOf(page, B)).toBeVisible({ timeout: 15_000 });
      frames.push(await shot("10a-mention-opened-bea"));
      await closeSeat(page, B);
      await settleMs(600);
      const aOpen = (await stageOf(page, A).count()) > 0;
      let note = `mention opened Bea's seat; after closing it, Ada's seat is ${aOpen ? "open" : "closed"}`;
      if (aOpen) {
        await expect(stageOf(page, A)).toHaveAttribute("aria-label", "Threads");
        await expect(surfaceOf(page, A).getByTestId("seat-threads-row").first()).toBeVisible();
        note += " and still on Threads with its list";
      } else {
        await openSeat(page, A);
        await tabOf(page, A, "threads").click();
        await expect(surfaceOf(page, A).getByTestId("seat-threads-row")).toHaveCount(2, { timeout: 10_000 });
        note += "; reopened, both threads are listed";
      }
      frames.push(await shot("10b-threads-still-there"));
      return note;
    });

    // (5, modals) Close closes the seat.
    await check("11-close-closes", async () => {
      if ((await stageOf(page, A).count()) === 0) await openSeat(page, A);
      await closeSeat(page, A);
      return "Close view removed the seat modal";
    });

    // (5, lead) A grid cell still shows the terminal, no switch.
    await check("12-grid-cell-terminal", async (frames) => {
      await selectBoth();
      await page.getByTestId("rts-open-grid").click();
      const grid = page.locator("[data-testid='terminal-grid-focus']");
      await expect(grid).toBeVisible({ timeout: 15_000 });
      await expect(grid.locator(".native-terminal-surface--grid")).toHaveCount(2, { timeout: 15_000 });
      try {
        await expect(grid.locator(".native-terminal-surface--grid .xterm")).toHaveCount(2, { timeout: 15_000 });
        await expect.poll(async () => (await screenTexts(page)).filter((t) => t.includes("Ask Codex")).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
      } finally {
        frames.push(await shot("12-grid-cells"));
      }
      const switches = await grid.locator('[data-testid^="seat-view"]').count();
      const threads = await grid.getByTestId("seat-threads").count();
      if (switches + threads > 0) throw new Error(`grid has ${switches} switch parts and ${threads} threads stages`);
      return "2 grid cells, each a terminal, no switch and no threads stage";
    });

    // Whatever line 12 did, the grid is closed before the next line.
    const leftGrid = page.getByRole("button", { name: "Close grid" });
    if ((await leftGrid.count()) > 0) await leftGrid.first().click().catch(() => undefined);
    await expect(page.locator("[data-testid='terminal-grid-focus']")).toHaveCount(0, { timeout: 10_000 });

    // (11, modals) Open seat from Global threads lands on Threads; a plain open after is back on the setting (Terminal here).
    const openFromThreads = async (frames: string[], name: string): Promise<void> => {
      await page.keyboard.press(mod("U"));
      const list = page.getByTestId("operator-threads").first();
      await expect(list).toBeVisible({ timeout: 10_000 });
      const row = page.getByTestId("operator-threads-row").filter({ hasText: "Ada" }).first();
      await expect(row).toBeVisible({ timeout: 15_000 });
      await row.click();
      await page.getByRole("button", { name: "Open seat Ada" }).click();
      await expect(stageOf(page, A)).toBeVisible({ timeout: 15_000 });
      frames.push(await shot(name));
    };
    await check("16-open-seat-from-global-threads", async (frames) => {
      const notes: string[] = [];
      // Closed seat.
      await openFromThreads(frames, "16a-closed-seat-from-threads");
      await expect(stageOf(page, A)).toHaveAttribute("aria-label", "Threads");
      notes.push("closed seat: Threads");
      await closeSeat(page, A);
      await openSeat(page, A);
      await expect(stageOf(page, A)).toHaveAttribute("aria-label", "Terminal");
      frames.push(await shot("16b-plain-open-terminal"));
      notes.push("plain open after: Terminal");
      await closeSeat(page, A);
      // Seat shown in the grid.
      await selectBoth();
      await page.getByTestId("rts-open-grid").click();
      await expect(page.locator("[data-testid='terminal-grid-focus']")).toBeVisible({ timeout: 15_000 });
      try {
        await openFromThreads(frames, "16c-grid-seat-from-threads");
      } catch (error) {
        frames.push(await shot("16c-grid-still-on-top"));
        const gridShown = await page.locator("[data-testid='terminal-grid-focus']").count();
        const under = await page.getByRole("button", { name: "Close grid" }).first().click().then(async () => {
          await settleMs(800);
          frames.push(await shot("16d-after-closing-grid"));
          return (await stageOf(page, A).count()) > 0 ? await stageOf(page, A).getAttribute("aria-label") : "no seat";
        }).catch(() => "grid would not close");
        throw new Error(`grid seat: after Open seat Ada the grid is ${gridShown ? "still on top" : "gone"} and no Ada seat modal shows over it; after closing the grid: ${String(under)}. ${String(error).slice(0, 200)}`);
      }
      await expect(stageOf(page, A)).toHaveAttribute("aria-label", "Threads");
      notes.push("seat in the grid: Threads");
      await closeSeat(page, A);
      const gridClose = page.getByRole("button", { name: "Close grid" });
      if ((await gridClose.count()) > 0) await gridClose.first().click();
      await openSeat(page, A);
      await expect(stageOf(page, A)).toHaveAttribute("aria-label", "Terminal");
      notes.push("plain open after: Terminal");
      await closeSeat(page, A);
      return `${notes.join("; ")}. Parked seat not driven.`;
    });
    // Whatever line 16 left: the grid, a Threads modal, a seat open beneath the grid.
    for (let round = 0; round < 3; round += 1)
      for (const leftover of ["Close grid", "Close view"]) {
        const button = page.getByRole("button", { name: leftover });
        if ((await button.count()) > 0) await button.first().click().catch(() => undefined);
      }
    await page.keyboard.press("Escape").catch(() => undefined);

    // (4, lead; 5, modals) Seat opens on Threads.
    await check("13-setting-threads-opens-on-threads", async (frames) => {
      await page.getByRole("button", { name: "Open settings" }).click();
      const dialog = page.getByRole("dialog", { name: "Settings" });
      await dialog.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Terminal" }).click();
      const trigger = dialog.locator('button[aria-label="Seat opens on"]');
      await trigger.click();
      await page.getByRole("listbox", { name: "Seat opens on" }).getByRole("option", { name: "Threads" }).click();
      await expect(trigger).toHaveText("Threads");
      await dialog.getByRole("button", { name: "Close settings" }).click();
      await expect(dialog).toHaveCount(0);
      // A fresh unread thread, for "opened on Threads, nothing touched, stays unread" (40db2b1f9).
      const third = await send("Third thread: does this stay unread?");
      if (!third.ok) throw new Error(`operator send refused: ${JSON.stringify(third)}`);
      const thirdReply = await a.op("msg.reply", { target: "operator", inReplyTo: third.messageId, text: "It should, until you press in the chat." });
      if (!thirdReply.ok) throw new Error(`seat reply refused: ${JSON.stringify(thirdReply)}`);
      await settleMs(1_000);
      let readNote = "";
      for (const round of [1, 2]) {
        await openSeat(page, A);
        await expect(stageOf(page, A)).toHaveAttribute("aria-label", "Threads");
        await expect(surfaceOf(page, A).getByTestId("seat-threads")).toBeVisible();
        if (round === 1) {
          await settleMs(2_000);
          const untouched = await unreadOnSwitch(page, A);
          const shownUnread = await surfaceOf(page, A).locator('[data-testid="seat-threads-row"][aria-current="true"][data-unread="true"]').count();
          frames.push(await shot("13-1-opens-on-threads-untouched"));
          await surfaceOf(page, A).getByTestId("seat-threads-message").last().click();
          await expect.poll(() => unreadOnSwitch(page, A), { timeout: 10_000 }).toBe(untouched - 1);
          frames.push(await shot("13-1b-after-press-in-chat"));
          if (untouched !== 1 || shownUnread !== 1) throw new Error(`opened on Threads, untouched 2 s: switch ${untouched}, shown row unread ${shownUnread}`);
          readNote = "; opened on Threads with 1 unread, untouched 2 s it stays unread (shown row too), one press in the chat reads it";
        } else frames.push(await shot(`13-${String(round)}-opens-on-threads`));
        await closeSeat(page, A);
      }
      return `two opens in a row, each on Threads; Close closed it each time${readNote}`;
    });

    // (4, lead; 9, modals) A cold seat starts under Threads, and is already at the pane size.
    await check("14-cold-seat-under-threads", async (frames) => {
      // Watch every live region in the cold seat's surface while it loads.
      await page.evaluate(() => {
        const w = window as unknown as { __liveLog?: string[] };
        w.__liveLog = [];
        const live = (el: Element) => el.closest('[role="status"],[role="alert"],[aria-live]:not([aria-live="off"])');
        new MutationObserver((records) => {
          for (const r of records) {
            const target = r.target instanceof Element ? r.target : r.target.parentElement;
            const region = target ? live(target) : null;
            if (region && region.closest('[data-testid="native-terminal-surface"]') && region.closest("[inert]") === null && region.closest('[aria-hidden="true"]') === null)
              w.__liveLog!.push((region.textContent ?? "").trim());
          }
        }).observe(document.body, { subtree: true, childList: true, characterData: true });
      });
      await openSeat(page, C);
      await expect(stageOf(page, C)).toHaveAttribute("aria-label", "Threads");
      // Only regions a screen reader can reach: not inside inert or aria-hidden.
      const liveRegions = await surfaceOf(page, C).locator('[role="status"],[role="alert"],[aria-live]:not([aria-live="off"])').evaluateAll((all) =>
        all
          .filter((e) => e.closest("[inert]") === null && e.closest('[aria-hidden="true"]') === null)
          .map((e) => (e.textContent ?? "").trim())
          .filter((t) => t.length > 0),
      );
      await c.ready(45_000);
      await expect.poll(async () => (await childSizes(c)).length, { timeout: 10_000 }).toBeGreaterThan(0);
      await settleMs(2_000);
      const covered = await childSizes(c);
      const heard = covered[covered.length - 1]!;
      frames.push(await shot("14a-cold-seat-on-threads"));
      await tabOf(page, C, "terminal").click();
      await expect(stageOf(page, C)).toHaveAttribute("aria-label", "Terminal");
      await waitForTerminalPaint(page);
      await settleMs(1_200);
      const after = await childSizes(c);
      const grid = await xtermGrid(page, C);
      frames.push(await shot("14b-cold-seat-first-terminal"));
      const problems: string[] = [];
      if (after.length !== covered.length) problems.push(`first Terminal made the child resize: ${JSON.stringify(after.slice(covered.length))}`);
      if (grid.cols !== heard.cols || grid.rows !== heard.rows) problems.push(`xterm ${grid.cols}x${grid.rows} vs child ${heard.cols}x${heard.rows}`);
      if (problems.length > 0) throw new Error(`${problems.join("; ")}; child sizes ${JSON.stringify(after)}`);
      const liveLog = await page.evaluate(() => (window as unknown as { __liveLog?: string[] }).__liveLog ?? []);
      const loadSaid = liveRegions.filter((t) => /start|load|connect|find|attach|session/i.test(t));
      await writeFile(join(FRAMES, "14-live-regions.json"), `${JSON.stringify({ liveRegions, liveLog }, null, 2)}\n`);
      if (loadSaid.length > 1) throw new Error(`load said by ${loadSaid.length} live regions at once: ${JSON.stringify(loadSaid)}`);
      return `load live regions at open: ${JSON.stringify(loadSaid)}; cold seat started under Threads; child at ${heard.cols}x${heard.rows} before the first Terminal; no resize on it; sizes ${JSON.stringify(after.map((s) => `${s.cols}x${s.rows}`))}`;
    });

    // (6, lead) No separate Threads modal from a seat.
    await check("15-no-seat-threads-modal", async () => {
      const dialogs = await page.getByRole("dialog").evaluateAll((all) =>
        all.map((d) => d.getAttribute("aria-label") ?? d.getAttribute("data-testid") ?? "").filter((n) => /thread/i.test(n)),
      );
      const popups = await page.locator('[data-testid="seat-threads-button"], [data-testid="seat-threads-popup"]').count();
      if (dialogs.length + popups > 0) throw new Error(`threads dialogs ${JSON.stringify(dialogs)}, old button or popup ${popups}`);
      return "no Threads dialog and no old Threads button or popup with a seat open on Threads";
    });
  } finally {
    await writeFile(join(FRAMES, "results.json"), `${JSON.stringify(lines, null, 2)}\n`).catch(() => undefined);
    await junto.close();
  }
  const failed = lines.filter((l) => !l.pass);
  expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
});
