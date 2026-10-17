/**
 * A seat's terminal read by command: on the machine that runs it, and from
 * the machine that edits its canvas over the seats channel. The text reaches
 * the caller only: never a log row.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeMachineLog, installMachineLog } from "../src/main/junto/observability/logger";
import { machineLogDir } from "../src/main/junto/observability/log-file";
import { readSeatWindow } from "../src/main/junto/term/seat-read";
import type { SeatGrid } from "../src/main/junto/term/seat-read-window";
import { eventually, miniSeat, twoCoreCanvas as canvas, twoCoreProcess, twoCores } from "./support/two-cores";

const cleanups: Array<() => Promise<void>> = [];
let restore: () => void;
beforeEach(() => { restore = twoCoreProcess(); });
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  restore();
});

/** A settled grid that shows whatever the test says, for the live generation. */
const shownGrid = (lines: () => ReadonlyArray<string>, epoch: () => string | undefined): SeatGrid => async (bindingId, count) => {
  const live = epoch();
  return live === undefined ? undefined : { bindingId, epoch: live, cols: 80, rows: 24, seq: 1n,
    lines: lines().slice(-count), totalLines: lines().length, truncated: false };
};

describe("seat read over the seats channel", () => {
  it("the editing machine reads the seat's grid; a vacant seat answers Vacant", async () => {
    let shown: string[] = [];
    let generation: string | undefined;
    const cores = await twoCores({ cleanups, mini: { grid: shownGrid(() => shown, () => generation) } });
    expect(await cores.bookEnd.request("seats", { _tag: "Read", canvas, seatId: miniSeat.id }))
      .toMatchObject({ _tag: "Vacant", machine: "mini" });

    const started = await cores.bookEnd.request("seats", { _tag: "Start", canvas, seatId: miniSeat.id }) as { generation: string };
    generation = started.generation;
    shown = ["first", "second", "third"];
    expect(await cores.bookEnd.request("seats", { _tag: "Read", canvas, seatId: miniSeat.id, lines: 2 })).toEqual({
      _tag: "ReadWindow", canvas, seatId: miniSeat.id, machine: "mini", generation: started.generation,
      text: "second\nthird", lines: 2, cols: 80, rows: 24, truncated: false,
    });
  });

  it("a live seat whose grid is not up is SeatReadUnavailable, with no text", async () => {
    const cores = await twoCores({ cleanups, mini: { grid: async () => undefined } });
    await cores.bookEnd.request("seats", { _tag: "Start", canvas, seatId: miniSeat.id });
    await expect(cores.bookEnd.request("seats", { _tag: "Read", canvas, seatId: miniSeat.id }))
      .rejects.toMatchObject({ detail: { _tag: "SeatReadUnavailable", machine: "mini" } });
  });

  it("clips a wide grid to the byte cap from the top", async () => {
    let generation: string | undefined;
    const wide = Array.from({ length: 2000 }, (_, index) => `${index}:${"y".repeat(200)}`);
    const cores = await twoCores({ cleanups, mini: { grid: shownGrid(() => wide, () => generation) } });
    generation = (await cores.bookEnd.request("seats", { _tag: "Start", canvas, seatId: miniSeat.id }) as { generation: string }).generation;
    const read = await cores.bookEnd.request("seats", { _tag: "Read", canvas, seatId: miniSeat.id, lines: 2000 }) as
      { text: string; truncated: boolean; lines: number };
    expect(read.truncated).toBe(true);
    expect(Buffer.byteLength(read.text)).toBeLessThanOrEqual(64 * 1024);
    expect(read.text.endsWith(`1999:${"y".repeat(200)}`)).toBe(true);
  });

  it("logs the read with its line count and never its text", async () => {
    const home = await mkdtemp(join(tmpdir(), "junto-seat-read-log-"));
    cleanups.push(async () => { closeMachineLog(); await rm(home, { recursive: true, force: true }); });
    installMachineLog({ home, process: "core", echo: false });
    let generation: string | undefined;
    const secret = "printed-secret-5c2e91";
    const cores = await twoCores({ cleanups, mini: { grid: shownGrid(() => [secret], () => generation) } });
    generation = (await cores.bookEnd.request("seats", { _tag: "Start", canvas, seatId: miniSeat.id }) as { generation: string }).generation;
    expect(await cores.bookEnd.request("seats", { _tag: "Read", canvas, seatId: miniSeat.id }, "read-op-1"))
      .toMatchObject({ text: secret });
    const file = join(machineLogDir(home), "core.jsonl");
    let log = "";
    for (let tries = 0; tries < 100 && !log.includes("seat read"); tries++) {
      log = await readFile(file, "utf8").catch(() => "");
      if (!log.includes("seat read")) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(log).toContain("seat read");
    expect(log).toContain("read-op-1");
    expect(log).not.toContain(secret);
  });
});

describe("the owner's seat read", () => {
  it("reads a seat on this machine from its own grid, and over the link for a seat on another", async () => {
    let generation: string | undefined;
    const cores = await twoCores({ cleanups, mini: { grid: shownGrid(() => ["on the mini"], () => generation) } });
    generation = (await cores.bookEnd.request("seats", { _tag: "Start", canvas, seatId: miniSeat.id }) as { generation: string }).generation;
    // The mini's own owner reads its seat here: no link.
    const local = await cores.mini.runtime.runPromise(readSeatWindow({ canvas, seatId: miniSeat.id }, {
      plane: { router: { isLocalHostId: (host: string) => host === "mini" } as never, host: cores.mini.host },
      grid: shownGrid(() => ["on the mini"], () => generation),
    }) as Effect.Effect<Awaited<ReturnType<typeof readSeatWindow>> extends Effect.Effect<infer A, never, never> ? A : never, unknown, never>);
    expect(local).toMatchObject({ hostId: "mini", window: { text: "on the mini", machine: "mini" } });
  });

  it("answers vacant for a seat with no occupant, and refuses a node that is not a seat", async () => {
    const cores = await twoCores({ cleanups });
    const plane = { router: { isLocalHostId: (host: string) => host === "mini" } as never, host: cores.mini.host };
    const vacant = await cores.mini.runtime.runPromise(readSeatWindow({ canvas, seatId: miniSeat.id }, { plane }) as never);
    expect(vacant).toMatchObject({ hostId: "mini", window: undefined });
    await expect(cores.mini.runtime.runPromise(readSeatWindow({ canvas, seatId: "ghost" as never }, { plane }) as never))
      .rejects.toMatchObject({ _tag: "SeatNotFound" });
  });
});
