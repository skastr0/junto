/**
 * The overseer's broadcast at 60 seats, from the command line: one region of
 * sixty, one send, one notice per seat marked broadcast and held from waking
 * it, a receipt that counts sixty, and the time from the press to the last
 * arrival.
 *
 * The CLI must be built first (dist/junto); the spec refuses without it, like
 * overseer-offboard-cli.spec.ts, because it tests the CLI itself.
 *   bun run cli:build && bun run test:e2e:fast e2e/scenarios/overseer-broadcast-60.spec.ts
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { mailThreadOf } from "../../src/shared/crew";
import { card, canvasReady } from "../harness/canvas";
import { crewOccupySeat, crewSeat, installCrewSeatHarness, type CrewCliResult } from "../harness/crew-fixture";
import { grantOverseer, modelFixture, modelRegion, modelSeat } from "../harness/model";
import { readSeatMailbox } from "../harness/work-mail";
import { expect, launchJunto, test } from "../harness/launch";

const CANVAS = "broadcastsixtycli";
const FRAMES = process.env.JUNTO_E2E_FRAMES_DIR ?? join("test-results", "overseer-broadcast-60");
const COUNT = 60;
const CLI_BUILT = existsSync(join(process.cwd(), "dist", "junto"));
const CLI_MISSING =
  "SETUP: dist/junto is missing. This check tests the overseer's own CLI, so it does not run without it. Build it with `bun run cli:build` in the checkout the run starts from.";

const seats = Array.from({ length: COUNT }, (_, i) =>
  modelSeat({
    id: `seat-c${String(i).padStart(2, "0")}`,
    label: `Seat ${String(i).padStart(2, "0")}`,
    x: 40 + (i % 10) * 250,
    y: 50 + Math.floor(i / 10) * 140,
  }),
);
/** The overseer, outside Junto: the set is the sixty and no one else. */
const O = modelSeat({ id: "seat-overseer", label: "Overseer", x: 2700, y: 80 });
const doc = modelFixture([
  modelRegion({ id: "region-junto", label: "Junto", x: 0, y: 0, width: 2600, height: 900 }),
  ...seats,
  O,
]);

const jsonLine = (text: string): Record<string, unknown> | undefined => {
  for (const line of text.split("\n").reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // Not the line.
    }
  }
  return undefined;
};

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

test("[fake-tui] Overseer broadcast at 60 seats", async () => {
  test.setTimeout(420_000);
  if (!CLI_BUILT) throw new Error(CLI_MISSING);
  await mkdir(FRAMES, { recursive: true });
  const junto = await launchJunto({ seedModels: { [CANVAS]: doc }, afterSeed: installCrewSeatHarness });
  const { page, sandbox } = junto;
  const notes: string[] = [];
  const problems: string[] = [];
  const text = "Broadcast from the command line to sixty";

  try {
    await canvasReady(page, { timeout: 30_000 });
    await page.getByRole("button", { name: "Fit all nodes" }).click();
    await page.keyboard.press("Escape");

    const o = crewSeat(sandbox, CANVAS, O.id);
    await crewOccupySeat(page, CANVAS, O, o);
    await grantOverseer(page, CANVAS, O.id);
    await expect((await card(page, O.id).element()).locator(".junto-node")).toHaveAttribute("data-overseer", "true", { timeout: 15_000 });

    // The press.
    const pressed = Date.now();
    const ran: CrewCliResult = await o.cli(
      ["overseer", "msg", "broadcast", text, "--region", "Junto", "--expect", String(COUNT)],
      { timeoutMs: 180_000, awaitMs: 240_000 },
    );
    const cliMs = Date.now() - pressed;
    await writeFile(
      join(FRAMES, "cli.txt"),
      [`$ junto overseer msg broadcast <text> --region Junto --expect ${COUNT}`, `exit code: ${String(ran.exitCode)}`, `stdout: ${ran.stdout}`, `stderr: ${ran.stderr}`, ""].join("\n"),
    );
    const out = jsonLine(ran.stdout);
    const data = (out?.data ?? {}) as Record<string, unknown>;
    const rows = (Array.isArray(data.seats) ? data.seats : []) as ReadonlyArray<Record<string, unknown>>;
    notes.push(`cli exit ${String(ran.exitCode)} after ${cliMs}ms; count ${String(data.count)}; ${rows.length} seat rows; set ${String(data.set)}`);
    if (ran.exitCode !== 0 || out?.ok !== true) problems.push(`the command failed: exit ${String(ran.exitCode)} ${ran.stderr.trim().slice(0, 300)}`);
    if (out?.command !== "overseer msg broadcast") problems.push(`the envelope names ${String(out?.command)}`);
    if (data.count !== COUNT) problems.push(`the receipt counts ${String(data.count)}, not ${COUNT}`);
    if (rows.length !== COUNT) problems.push(`the receipt lists ${rows.length} seats, not ${COUNT}`);
    const notWaiting = rows.filter((row) => row.delivery !== "waiting");
    if (notWaiting.length > 0) problems.push(`${notWaiting.length} of the receipt's rows are not waiting (${JSON.stringify(notWaiting[0]?.delivery)})`);

    // Every seat's row, polled until the last landed; the time is the press to that row.
    let copies = await copiesIn(page, text);
    const deadline = Date.now() + 120_000;
    while (!copies.every((count) => count === 1) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      copies = await copiesIn(page, text);
    }
    const arrivedMs = Date.now() - pressed;
    notes.push(`last row after ${arrivedMs}ms`);
    const short = seats.flatMap((seat, i) => (copies[i] === 1 ? [] : [`${seat.id}:${copies[i]}`]));
    if (short.length > 0) problems.push(`not exactly one copy: ${short.join(", ")}`);

    const mails = await Promise.all(seats.map(async (seat) => ({ seat, rows: (await readSeatMailbox(page, CANVAS, seat.id)).filter((m) => JSON.stringify(m.parts).includes(text)) })));
    const threadIds = new Set<string>();
    const unmarked: string[] = [];
    for (const { seat, rows: held } of mails) {
      if (held.length !== 1) continue;
      const row = held[0]!;
      threadIds.add(mailThreadOf(row));
      if (row.metadata?.broadcast !== true || row.metadata?.noWake !== true) unmarked.push(seat.id);
    }
    if (threadIds.size !== COUNT) problems.push(`${threadIds.size} threads, not ${COUNT}`);
    if (unmarked.length > 0) {
      const sample = mails.find(({ seat }) => seat.id === unmarked[0])!.rows[0]!;
      problems.push(`${unmarked.length} of ${COUNT} notices are not marked broadcast and noWake (e.g. ${JSON.stringify(sample.metadata)})`);
    }

    // No seat was woken: no fake seat got its ready line, and the canvas holds no state for any of the sixty.
    const awake = seats.filter((seat) => existsSync(join(crewSeat(sandbox, CANVAS, seat.id).dir, "ready.json"))).map((seat) => seat.id);
    if (awake.length > 0) problems.push(`seats were started: ${awake.slice(0, 5).join(", ")}`);
    const started = await page.evaluate(async (seatIds) => {
      const events = (await window.junto!.agentSeatStateSnapshot()) as ReadonlyArray<{ bindingId: string; state: string }>;
      return events.filter((event) => seatIds.some((id) => event.bindingId === `local:${id}`)).map((event) => `${event.bindingId}:${event.state}`);
    }, seats.map((seat) => seat.id));
    if (started.length > 0) problems.push(`seats were started: ${started.slice(0, 5).join(", ")}`);

    await page.screenshot({ path: join(FRAMES, "receipt.png") });
    notes.push(`${COUNT} seats, one marked notice each, ${threadIds.size} threads, none started`);
  } finally {
    await writeFile(join(FRAMES, "results.json"), `${JSON.stringify({ pass: problems.length === 0, notes, problems }, null, 2)}\n`);
  }
  if (problems.length > 0) throw new Error(problems.join("; "));
});
