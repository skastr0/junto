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
import type { AttachQuestion, SeatsViewFrame } from "../src/main/junto/term/seat-attach";
import type { SeatsChannelOptions } from "../src/main/junto/term/seats-link";
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

/** The book's window holds and its views of the mini's seat; the mini's clock, what it holds, and the questions it asks. */
const linked = async (cacheQuestions?: SeatsChannelOptions["cacheQuestions"]) => {
  let views: SeatViews | undefined;
  let miniNow = T0;
  let source: OperatorHoldSource = () => undefined;
  /** Every attach frame the book received, the question's included. */
  const seen: SeatsViewFrame[] = [];
  const cores = await twoCores({
    cleanups,
    book: { attachStream: (context, frame) => { seen.push(frame); views?.frame(context, frame); }, addHoldSource: () => () => undefined },
    mini: { now: () => miniNow, addHoldSource: (added) => { source = added; return () => undefined; },
      ...(cacheQuestions === undefined ? {} : { cacheQuestions }) },
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
    ...cores, router, windows, started, attach, seen, views: () => views!,
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

  it("a view shown and typed into still says when its typing's grace ends, for what counts typing alone", async () => {
    const pair = await linked();
    pair.windows.surfaces(1, [miniSeat.bindingId]);
    await pair.attach();
    pair.at(0);
    pair.windows.typed(1, miniSeat.bindingId);
    await eventually(() => expect(pair.hold(0)).toEqual({ typedUntil: T0 + OPERATOR_TYPING_GRACE_MS }));
    expect(pair.hold(OPERATOR_TYPING_GRACE_MS)).toEqual({});
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

/** The mini's open questions, as its offboard would hold them, settled by the first answer that names one. */
const questionHub = () => {
  let open: ReadonlyArray<AttachQuestion> = [];
  const listeners = new Set<() => void>();
  const answers: Array<{ readonly question: string; readonly answer: string; readonly generation: string }> = [];
  const tell = () => { for (const listener of listeners) listener(); };
  return {
    answers,
    set: (next: ReadonlyArray<AttachQuestion>) => { open = next; tell(); },
    port: {
      current: () => open,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      answer: async (seat: { readonly seatId: string }, question: string, answer: "fresh" | "keep", generation: string) => {
        answers.push({ question, answer, generation });
        const asked = open.find((candidate) => candidate.question === question && candidate.seatId === seat.seatId &&
          candidate.generation === generation);
        if (asked === undefined) return { settled: false as const };
        open = open.filter((candidate) => candidate !== asked);
        tell();
        return { settled: true as const, cut: answer === "fresh" };
      },
    },
  };
};

describe("the cache question across the link", () => {
  const Q1 = "Q".repeat(22);
  const asked = (generation: string, question = Q1): AttachQuestion => ({ bindingId: miniSeat.bindingId, canvasName: canvas,
    seatId: miniSeat.id, question, generation, windowEndsAt: T0 - 5 * 60_000 });
  const framesOf = (pair: Awaited<ReturnType<typeof linked>>, tag: "CacheDue" | "CacheSettled") =>
    pair.seen.filter((frame) => frame._tag === tag);
  const quiet = () => new Promise((resolve) => setTimeout(resolve, 50));

  it("asks a shown control view once, how far past its window, and takes the first answer on its handle", async () => {
    const hub = questionHub();
    const pair = await linked(hub.port);
    await pair.attach();
    // Not shown yet: not asked.
    hub.set([asked(pair.started.generation)]);
    await quiet();
    expect(framesOf(pair, "CacheDue")).toEqual([]);
    pair.windows.surfaces(1, [miniSeat.bindingId]);
    await eventually(() => expect(pair.views().questions()).toHaveLength(1));
    const [due] = framesOf(pair, "CacheDue");
    // These fields only: no canvas, seat id or answer beyond what the handle binds.
    expect(Object.keys(due!).sort()).toEqual(["_tag", "handle", "pastByMs", "question"]);
    expect(due).toMatchObject({ question: Q1, pastByMs: 5 * 60_000 });
    expect(pair.views().questions()).toMatchObject([{ machine: "mini", canvasName: canvas, seatId: miniSeat.id, question: Q1 }]);
    // Told of no change, or shown again: still once.
    hub.set([asked(pair.started.generation)]);
    pair.windows.surfaces(1, []);
    pair.windows.surfaces(1, [miniSeat.bindingId]);
    await quiet();
    expect(framesOf(pair, "CacheDue")).toHaveLength(1);
    expect(await pair.views().answer(Q1, "fresh")).toEqual({ ok: true });
    expect(hub.answers).toEqual([{ question: Q1, answer: "fresh", generation: pair.started.generation }]);
    expect(pair.views().questions()).toEqual([]);
    await eventually(() => expect(framesOf(pair, "CacheSettled")).toEqual([{ _tag: "CacheSettled", handle: due!.handle, question: Q1 }]));
    // Settled: the same id again is refused, typed, and settles nothing.
    await expect(pair.bookEnd.request("seats", { _tag: "CacheAnswer", handle: due!.handle, question: Q1, answer: "keep" }))
      .rejects.toMatchObject({ detail: { _tag: "SeatCacheQuestionUnknown" } });
    expect(await pair.views().answer(Q1, "keep")).toMatchObject({ ok: false });
  });

  it("withdrawn, the view is told it is settled and the window drops it", async () => {
    const hub = questionHub();
    const pair = await linked(hub.port);
    pair.windows.surfaces(1, [miniSeat.bindingId]);
    await pair.attach();
    await eventually(() => expect(pair.held(0)).toBe(true));
    hub.set([asked(pair.started.generation)]);
    await eventually(() => expect(pair.views().questions()).toHaveLength(1));
    hub.set([]);
    await eventually(() => expect(pair.views().questions()).toEqual([]));
    expect(framesOf(pair, "CacheSettled")).toMatchObject([{ question: Q1 }]);
  });

  it("an observing view is never asked and cannot answer; a question of another process is not asked and settles nothing", async () => {
    const hub = questionHub();
    const pair = await linked(hub.port);
    const request = (payload: Record<string, unknown>) => pair.bookEnd.request("seats", payload);
    const watch = await request({ _tag: "Attach", canvas, seatId: miniSeat.id, generation: pair.started.generation,
      mode: "observe" }) as { readonly handle: string };
    await request({ _tag: "Hold", handle: watch.handle, open: true, typed: false });
    hub.set([asked(pair.started.generation)]);
    await quiet();
    expect(framesOf(pair, "CacheDue")).toEqual([]);
    await expect(request({ _tag: "CacheAnswer", handle: watch.handle, question: Q1, answer: "fresh" }))
      .rejects.toMatchObject({ detail: { _tag: "SeatAttachObserveOnly" } });
    hub.set([asked("another-generation")]);
    const control = await request({ _tag: "Attach", canvas, seatId: miniSeat.id, generation: pair.started.generation,
      mode: "control", takeover: true }) as { readonly handle: string };
    await request({ _tag: "Hold", handle: control.handle, open: true, typed: false });
    await quiet();
    expect(framesOf(pair, "CacheDue")).toEqual([]);
    await expect(request({ _tag: "CacheAnswer", handle: control.handle, question: Q1, answer: "fresh" }))
      .rejects.toMatchObject({ detail: { _tag: "SeatCacheQuestionUnknown" } });
    await expect(request({ _tag: "CacheAnswer", handle: control.handle, question: Q1, answer: "fresh", why: "x" }))
      .rejects.toBeDefined();
    await expect(request({ _tag: "CacheAnswer", handle: control.handle, question: "short", answer: "fresh" }))
      .rejects.toBeDefined();
    expect(hub.answers.map((answer) => answer.generation)).toEqual([pair.started.generation]);
  });

  it("writes no row per notice or answer, and never the handle or the question", async () => {
    const home = await mkdtemp(join(tmpdir(), "junto-question-log-"));
    cleanups.push(async () => { closeMachineLog(); await rm(home, { recursive: true, force: true }); });
    installMachineLog({ home, process: "core", echo: false });
    const hub = questionHub();
    const pair = await linked(hub.port);
    pair.windows.surfaces(1, [miniSeat.bindingId]);
    await pair.attach();
    hub.set([asked(pair.started.generation)]);
    await eventually(() => expect(pair.views().questions()).toHaveLength(1));
    const [due] = framesOf(pair, "CacheDue");
    expect(await pair.views().answer(Q1, "keep")).toEqual({ ok: true });
    await expect(pair.bookEnd.request("seats", { _tag: "CacheAnswer", handle: due!.handle, question: Q1, answer: "keep" }))
      .rejects.toBeDefined();
    const log = await readFile(join(machineLogDir(home), "core.jsonl"), "utf8");
    expect(log).toContain("seat attach opened");
    expect(log).not.toContain("seat attach cache answer");
    expect(log).not.toContain(due!.handle);
    expect(log).not.toContain(Q1);
  });
});
