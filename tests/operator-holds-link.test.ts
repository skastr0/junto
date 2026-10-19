/**
 * A seat on a linked machine is cut there, so the operator's hold on it rides
 * the link: the editing machine's view sends a Hold on its handle, and the
 * seat's machine keeps it on that attach, typing timed on its own clock.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeMachineLog, installMachineLog } from "../src/main/junto/observability/logger";
import { machineLogDir } from "../src/main/junto/observability/log-file";
import { makeOperatorHolds, subscribeOperatorTyped, type OperatorHoldSource } from "../src/main/junto/term/operator-holds";
import { TerminalRouter } from "../src/main/junto/term/router";
import { makeSeatViews, type SeatViews } from "../src/main/junto/term/seat-views";
import { unwrapSeatsFailure } from "../src/main/junto/term/seats-failure";
import { OPERATOR_TYPING_GRACE_MS } from "../src/shared/operator-hold";
import { eventually, miniSeat, twoCoreCanvas as canvas, twoCoreProcess, twoCores } from "./support/two-cores";

const cleanups: Array<() => Promise<void>> = [];
let restore: () => void;
beforeEach(() => { restore = twoCoreProcess(); });
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  restore();
});

const T0 = Date.UTC(2026, 9, 18, 12, 0);

/** The book's window holds and its views of the mini's seat; the mini's clock and what it holds. */
const linked = async () => {
  let views: SeatViews | undefined;
  let miniNow = T0;
  let source: OperatorHoldSource = () => undefined;
  const cores = await twoCores({
    cleanups,
    book: { attachStream: (context, frame) => views?.frame(context, frame), addHoldSource: () => () => undefined },
    mini: { now: () => miniNow, addHoldSource: (added) => { source = added; return () => undefined; } },
  });
  const windows = makeOperatorHolds(() => T0);
  views = makeSeatViews({
    locate: async (bindingId) => bindingId === miniSeat.bindingId
      ? { machine: "mini", canvas, seatId: miniSeat.id, harness: miniSeat.harness } : undefined,
    request: (_machine, payload, operationId) =>
      cores.bookEnd.request("seats", payload, operationId).catch((cause: unknown) => { throw unwrapSeatsFailure(cause); }),
    sendEvent: (_machine, payload) => cores.bookEnd.sendEvent("seats", payload),
  }, windows);
  const router = new TerminalRouter(cores.book.host);
  router.setSeatViews(views);
  cleanups.push(async () => { router.setSeatViews(undefined); router.beginShutdown(); });
  const started = await cores.bookEnd.request("seats", { _tag: "Start", canvas, seatId: miniSeat.id }) as { generation: string };
  const attach = async (mode: "control" | "observe" = "control") => {
    const attached = await router.attach({ bindingId: miniSeat.bindingId, mode, takeover: true, hostId: "mini" });
    if (!attached.ok) throw new Error(attached.message);
    return attached.lease;
  };
  return {
    ...cores, router, windows, started, attach,
    at: (ms: number) => { miniNow = T0 + ms; },
    held: (ms: number) => source(miniSeat.bindingId, T0 + ms) !== undefined,
    hold: (ms: number) => source(miniSeat.bindingId, T0 + ms),
  };
};

describe("the operator's hold across the link", () => {
  it("holds the seat on its machine while a window here shows it, and lets go when none does", async () => {
    const pair = await linked();
    // The window says it shows the seat before its view reaches the mini.
    pair.windows.surfaces(1, [miniSeat.bindingId]);
    await pair.attach();
    await eventually(() => expect(pair.held(0)).toBe(true));
    // Shown: no end to give, the window letting go is when.
    expect(pair.hold(0)).toEqual({});
    pair.windows.surfaces(1, []);
    await eventually(() => expect(pair.held(0)).toBe(false));
    pair.windows.surfaces(2, [miniSeat.bindingId]);
    await eventually(() => expect(pair.held(0)).toBe(true));
    pair.windows.dropWindow(2);
    await eventually(() => expect(pair.held(0)).toBe(false));
  });

  it("holds for the grace after a key, timed on the seat's machine, and takes typing at most once per report interval", async () => {
    const pair = await linked();
    // Each key taken warms the seat on its machine (its cache window's clock).
    const warmed: string[] = [];
    const offTyped = subscribeOperatorTyped((bindingId) => warmed.push(bindingId));
    cleanups.push(async () => offTyped());
    await pair.attach();
    pair.at(0);
    pair.windows.typed(1, miniSeat.bindingId);
    await eventually(() => expect(pair.held(0)).toBe(true));
    // The seat's machine knows when typing's hold ends, so its card can say when it goes cold.
    expect(pair.hold(0)).toEqual({ until: T0 + OPERATOR_TYPING_GRACE_MS });
    // A second key report 4 s later changes nothing there: the grace still runs from the first.
    pair.at(4_000);
    pair.windows.typed(1, miniSeat.bindingId);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pair.held(OPERATOR_TYPING_GRACE_MS - 1)).toBe(true);
    expect(pair.held(OPERATOR_TYPING_GRACE_MS)).toBe(false);
    expect(warmed).toEqual([miniSeat.bindingId]);
  });

  it("a hold ends with its view", async () => {
    const pair = await linked();
    pair.windows.surfaces(1, [miniSeat.bindingId]);
    const lease = await pair.attach();
    await eventually(() => expect(pair.held(0)).toBe(true));
    await pair.router.release(lease, "mini");
    await eventually(() => expect(pair.held(0)).toBe(false));
  });
});

describe("the Hold request on the seat's machine", () => {
  const attached = async (mode: "control" | "observe") => {
    const pair = await linked();
    const view = await pair.bookEnd.request("seats", { _tag: "Attach", canvas, seatId: miniSeat.id,
      generation: pair.started.generation, mode, takeover: true }) as { readonly handle: string };
    return { ...pair, handle: view.handle };
  };

  it("answers Held, and an observing view may be shown but not typed into", async () => {
    const pair = await attached("observe");
    expect(await pair.bookEnd.request("seats", { _tag: "Hold", handle: pair.handle, open: true, typed: false }))
      .toEqual({ _tag: "Held", handle: pair.handle, accepted: true });
    expect(pair.held(0)).toBe(true);
    await expect(pair.bookEnd.request("seats", { _tag: "Hold", handle: pair.handle, open: true, typed: true }))
      .rejects.toMatchObject({ detail: { _tag: "SeatAttachObserveOnly" } });
  });

  it("refuses a handle it does not hold and any field past handle, open and typed", async () => {
    const pair = await attached("control");
    await expect(pair.bookEnd.request("seats", { _tag: "Hold", handle: "A".repeat(22), open: true, typed: false }))
      .rejects.toMatchObject({ detail: { _tag: "SeatAttachUnknown" } });
    await expect(pair.bookEnd.request("seats", { _tag: "Hold", handle: pair.handle, open: true, typed: false, window: 1 }))
      .rejects.toBeDefined();
    expect(pair.held(0)).toBe(false);
  });

  it("writes no row per Hold and never the handle", async () => {
    const home = await mkdtemp(join(tmpdir(), "junto-hold-log-"));
    cleanups.push(async () => { closeMachineLog(); await rm(home, { recursive: true, force: true }); });
    installMachineLog({ home, process: "core", echo: false });
    const pair = await attached("control");
    for (let i = 0; i < 3; i++)
      await pair.bookEnd.request("seats", { _tag: "Hold", handle: pair.handle, open: i % 2 === 0, typed: true });
    await expect(pair.bookEnd.request("seats", { _tag: "Hold", handle: "B".repeat(22), open: true, typed: false }))
      .rejects.toBeDefined();
    const log = await readFile(join(machineLogDir(home), "core.jsonl"), "utf8");
    expect(log).toContain("seat attach opened");
    expect(log).not.toContain("seat attach hold");
    expect(log).not.toContain(pair.handle);
  });
});
