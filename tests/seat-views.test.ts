/**
 * The editing machine's window views a seat on a linked machine through its
 * terminal router: attach, typing, resize and release ride the seats channel
 * (seat-views.ts), never the SSH term-control route, and what comes back is
 * router output for the view only.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LocalHostEvent } from "../src/main/junto/term/local-host";
import { TerminalRouter } from "../src/main/junto/term/router";
import { unwrapSeatsFailure } from "../src/main/junto/term/seats-failure";
import { makeSeatViews, type SeatViews } from "../src/main/junto/term/seat-views";
import { eventually, miniSeat, twoCoreCanvas as canvas, twoCoreProcess, twoCores } from "./support/two-cores";

const cleanups: Array<() => Promise<void>> = [];
let restore: () => void;
beforeEach(() => { restore = twoCoreProcess(); });
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  restore();
});

/** The book's router, its seat views on the link to the mini, and everything the window would be sent. */
const bookWindow = async () => {
  let views: SeatViews | undefined;
  const cores = await twoCores({ cleanups, book: { attachStream: (context, frame) => views?.frame(context, frame) } });
  views = makeSeatViews({
    locate: async (bindingId) => bindingId === miniSeat.bindingId ? { machine: "mini", canvas, seatId: miniSeat.id } : undefined,
    request: (_machine, payload, operationId) =>
      cores.bookEnd.request("seats", payload, operationId).catch((cause: unknown) => { throw unwrapSeatsFailure(cause); }),
    sendEvent: (_machine, payload) => cores.bookEnd.sendEvent("seats", payload),
  });
  const router = new TerminalRouter(cores.book.host);
  router.setSeatViews(views);
  cleanups.push(async () => { router.setSeatViews(undefined); router.beginShutdown(); });
  const sent: LocalHostEvent[] = [];
  router.on("event", (event: LocalHostEvent) => sent.push(event));
  await cores.bookEnd.request("seats", { _tag: "Start", canvas, seatId: miniSeat.id });
  const shown = () => sent.flatMap((event) => event.type === "output" && event.bindingId === miniSeat.bindingId ? [event.data] : []).join("");
  return { ...cores, router, sent, shown };
};

describe("a linked seat's view through the router", () => {
  it("attaches with the seat's screen, shows its output, types into it, resizes and releases it", async () => {
    const window = await bookWindow();
    const controller = window.mini.fake.controllers[0]!;
    controller.emitData("printed before the view\r\n");
    const attached = await window.router.attach({ bindingId: miniSeat.bindingId, mode: "control", takeover: true, hostId: "mini" });
    if (!attached.ok) throw new Error(attached.message);
    expect(attached.screen?.serialized).toContain("printed before the view");

    controller.emitData("printed after\r\n");
    await eventually(() => expect(window.shown()).toContain("printed after"));
    // The window orders a view's output as it does a local host's: after the screen.
    const after = window.sent.find((event) => event.type === "output" && event.data.includes("printed after"));
    expect(after?.type === "output" && after.seq > attached.screen!.seq).toBe(true);

    expect(await window.router.write(attached.lease, "typed on the book\r", "mini")).toBe(true);
    expect(controller.writes.join("")).toContain("typed on the book\r");
    expect(await window.router.resize(attached.lease, 132, 43, "mini")).toBe(true);
    expect(controller.resizes).toContainEqual({ cols: 132, rows: 43 });

    await window.router.release(attached.lease, "mini");
    expect(await window.router.write(attached.lease, "after release", "mini")).toBe(false);
    // The mini gave its lease back: its own window takes control without takeover.
    let local = await window.mini.host.attach({ bindingId: miniSeat.bindingId, mode: "control" });
    for (let tries = 0; !local.ok && tries < 100; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      local = await window.mini.host.attach({ bindingId: miniSeat.bindingId, mode: "control" });
    }
    expect(local).toMatchObject({ ok: true });
  });

  it("an observing view cannot type", async () => {
    const window = await bookWindow();
    const attached = await window.router.attach({ bindingId: miniSeat.bindingId, mode: "observe", hostId: "mini" });
    if (!attached.ok) throw new Error(attached.message);
    expect(await window.router.write(attached.lease, "nope", "mini")).toBe(false);
    expect(window.mini.fake.controllers[0]!.writes.join("")).not.toContain("nope");
  });

  it("tells the window when the seat's generation exits", async () => {
    const window = await bookWindow();
    const attached = await window.router.attach({ bindingId: miniSeat.bindingId, mode: "control", takeover: true, hostId: "mini" });
    if (!attached.ok) throw new Error(attached.message);
    window.mini.fake.controllers[0]!.exit(0);
    await eventually(() => expect(window.sent.some((event) => event.type === "exit" && event.bindingId === miniSeat.bindingId)).toBe(true));
    expect(await window.router.write(attached.lease, "late", "mini")).toBe(false);
  });

  it("a takeover from another view ends this one", async () => {
    const window = await bookWindow();
    const first = await window.router.attach({ bindingId: miniSeat.bindingId, mode: "control", takeover: true, hostId: "mini" });
    const second = await window.router.attach({ bindingId: miniSeat.bindingId, mode: "control", takeover: true, hostId: "mini" });
    if (!first.ok || !second.ok) throw new Error("attach refused");
    let refused = true;
    for (let tries = 0; tries < 100 && (refused = await window.router.write(first.lease, "x", "mini")); tries++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(refused).toBe(false);
    expect(await window.router.write(second.lease, "y", "mini")).toBe(true);
  });

  it("a seat the views do not know falls through to the term-control route", async () => {
    const window = await bookWindow();
    const result = await window.router.attach({ bindingId: "not-a-linked-seat", mode: "control", hostId: "mini" });
    expect(result.ok).toBe(false);
  });
});
