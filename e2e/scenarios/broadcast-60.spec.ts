/**
 * Broadcast at 60 seats, in the real app: one region of sixty, chosen as a
 * recipient in Quick thread, one send. The confirm names sixty; the receipt
 * counts them; each seat's mailbox holds exactly one thread of the operator's,
 * which it can answer; no seat is started; and the run records the time from
 * the press to the last arrival. The one-way notice marked broadcast and noWake
 * is the overseer's send, exercised by overseer-broadcast-60.spec.ts.
 *
 * The frame and results.json land in JUNTO_E2E_FRAMES_DIR (default
 * test-results/broadcast-60).
 *   bun run test:e2e:fast e2e/scenarios/broadcast-60.spec.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { mailThreadOf } from "../../src/shared/crew";
import { mod } from "../harness/keys";
import { canvasReady, cameraSettled } from "../harness/canvas";
import { modelFixture, modelRegion, modelSeat } from "../harness/model";
import { readSeatMailbox } from "../harness/work-mail";
import { expect, launchJunto, test } from "../harness/launch";

const CANVAS = "broadcastsixty";
const FRAMES = process.env.JUNTO_E2E_FRAMES_DIR ?? join("test-results", "broadcast-60");
const COUNT = 60;

/** Sixty seats on a ten by six grid, every one inside Junto. */
const seats = Array.from({ length: COUNT }, (_, i) =>
  modelSeat({
    id: `seat-b${String(i).padStart(2, "0")}`,
    label: `Seat ${String(i).padStart(2, "0")}`,
    x: 40 + (i % 10) * 250,
    y: 50 + Math.floor(i / 10) * 140,
  }),
);
const doc = modelFixture([
  modelRegion({ id: "region-junto", label: "Junto", x: 0, y: 0, width: 2600, height: 900 }),
  ...seats,
]);

const frameOf = (page: Page) => page.getByTestId("quick-thread");

/** Copies of `text` in every seat's mailbox, in one round trip. */
const copiesIn = (page: Page, text: string): Promise<ReadonlyArray<number>> =>
  page.evaluate(
    async ({ canvasName, seatIds, text }) => {
      const counted: number[] = [];
      for (const nodeId of seatIds) {
        let count = 0;
        let beforePosition: number | undefined;
        do {
          const page = await window.junto!.workMailPage({
            canvasName,
            nodeId,
            limit: 200,
            ...(beforePosition === undefined ? {} : { beforePosition }),
          });
          count += page.items.filter((item) => JSON.stringify(item.message.parts).includes(text)).length;
          beforePosition = page.nextBeforePosition;
        } while (beforePosition !== undefined);
        counted.push(count);
      }
      return counted;
    },
    { canvasName: CANVAS, seatIds: seats.map((seat) => seat.id), text },
  );

test("[fake-tui] Broadcast at 60 seats", async () => {
  test.setTimeout(420_000);
  await mkdir(FRAMES, { recursive: true });
  const junto = await launchJunto({ seedModels: { [CANVAS]: doc } });
  const page = junto.page;
  const notes: string[] = [];
  const problems: string[] = [];

  try {
    await canvasReady(page, { timeout: 30_000 });
    await page.getByRole("button", { name: "Fit all nodes" }).click();
    await cameraSettled(page);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    await page.keyboard.press(mod("Shift+U"));
    await expect(frameOf(page)).toBeVisible({ timeout: 10_000 });
    const field = frameOf(page).getByRole("combobox", { name: "Seat or region" });
    await field.fill("Junto");
    await page.keyboard.press("Enter");

    const token = ((await frameOf(page).getByTestId("quick-thread-region").textContent()) ?? "").trim();
    notes.push(`region token ${JSON.stringify(token)}`);
    if (token !== `Junto${COUNT}`) problems.push(`the region token reads ${JSON.stringify(token)}, not Junto${COUNT}`);

    const text = "Broadcast to all sixty";
    await frameOf(page).getByTestId("thread-composer-input").fill(text);
    const composerSend = ((await frameOf(page).getByTestId("thread-composer-send").textContent()) ?? "").trim();
    notes.push(`composer button ${JSON.stringify(composerSend)}`);

    // One press: the confirm, because a region is among the recipients.
    await frameOf(page).getByTestId("thread-composer-send").click();
    const confirm = page.getByTestId("quick-thread-confirm");
    await expect(confirm).toBeVisible({ timeout: 10_000 });
    const title = ((await confirm.locator(".quick-thread__confirm-title").textContent()) ?? "").trim();
    const detail = ((await confirm.locator(".quick-thread__confirm-detail").textContent()) ?? "").trim();
    const confirmSend = ((await confirm.getByTestId("quick-thread-confirm-send").textContent()) ?? "").trim();
    notes.push(`confirm ${JSON.stringify(title)}; ${JSON.stringify(detail)}; button ${JSON.stringify(confirmSend)}`);
    if (title !== `Send to ${COUNT} seats?`) problems.push(`the confirm asks ${JSON.stringify(title)}`);
    if (!detail.includes(`${COUNT} get it when they are back`)) problems.push(`the confirm's detail is ${JSON.stringify(detail)}`);
    if (confirmSend !== `Send to ${COUNT}`) problems.push(`the confirm's button reads ${JSON.stringify(confirmSend)}`);
    await page.screenshot({ path: join(FRAMES, "confirm-60.png") });

    // The press, to the last seat's row in the store.
    const pressed = Date.now();
    await confirm.getByTestId("quick-thread-confirm-send").click();
    const receipt = page.getByTestId("quick-thread-broadcast-receipt");
    await expect(receipt).toBeVisible({ timeout: 120_000 });
    const receiptMs = Date.now() - pressed;
    const later = ((await receipt.getByTestId("quick-thread-later").textContent()) ?? "").trim();
    notes.push(`receipt after ${receiptMs}ms: ${JSON.stringify(later)}`);
    if (!later.includes(`${COUNT} get it when they are back`)) problems.push(`the receipt's line is ${JSON.stringify(later)}`);
    await page.screenshot({ path: join(FRAMES, "receipt-60.png") });

    // Every seat's row, polled until the last landed; the time is the press to that row.
    let copies = await copiesIn(page, text);
    const deadline = Date.now() + 120_000;
    while (!copies.every((count) => count === 1) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      copies = await copiesIn(page, text);
    }
    const arrivedMs = Date.now() - pressed;
    notes.push(`last row after ${arrivedMs}ms; copies ${JSON.stringify(copies)}`);
    const short = seats.flatMap((seat, i) => (copies[i] === 1 ? [] : [`${seat.id}:${copies[i]}`]));
    if (short.length > 0) problems.push(`not exactly one copy: ${short.join(", ")}`);

    const mails = await Promise.all(seats.map(async (seat) => ({ seat, rows: (await readSeatMailbox(page, CANVAS, seat.id)).filter((m) => JSON.stringify(m.parts).includes(text)) })));
    const threadIds = new Set<string>();
    const notPrompt: string[] = [];
    for (const { seat, rows } of mails) {
      if (rows.length !== 1) continue;
      const row = rows[0]!;
      threadIds.add(mailThreadOf(row));
      // The window's send is the operator's own thread, one per seat, which the seat can answer; the one-way
      // notice marked broadcast and noWake is the overseer's, exercised by overseer-broadcast-60.spec.ts.
      if (row.metadata?.mailKind !== "prompt") notPrompt.push(seat.id);
    }
    if (threadIds.size !== COUNT) problems.push(`${threadIds.size} threads, not ${COUNT}`);
    if (notPrompt.length > 0) {
      const sample = mails.find(({ seat }) => seat.id === notPrompt[0])!.rows[0]!;
      problems.push(`${notPrompt.length} of ${COUNT} mails are not prompt threads (e.g. ${JSON.stringify(sample.metadata)})`);
    }

    // No seat was woken: the canvas holds no state for any of the sixty.
    const started = await page.evaluate(async (seatIds) => {
      const events = (await window.junto!.agentSeatStateSnapshot()) as ReadonlyArray<{ bindingId: string; state: string }>;
      return events.filter((event) => seatIds.some((id) => event.bindingId === `local:${id}`)).map((event) => `${event.bindingId}:${event.state}`);
    }, seats.map((seat) => seat.id));
    if (started.length > 0) problems.push(`seats were started: ${started.slice(0, 5).join(", ")}`);

    await receipt.getByTestId("quick-thread-done").click();
    await expect(receipt).toHaveCount(0, { timeout: 10_000 });

    notes.push(`${COUNT} seats, one copy each, ${threadIds.size} threads; no seat started`);
  } finally {
    await writeFile(join(FRAMES, "results.json"), `${JSON.stringify({ pass: problems.length === 0, notes, problems }, null, 2)}\n`);
  }
  if (problems.length > 0) throw new Error(problems.join("; "));
});
