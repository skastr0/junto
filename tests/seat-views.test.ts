/**
 * The editing machine's window views a seat on a linked machine through its
 * terminal router: attach, typing, resize and release ride the seats channel
 * (seat-views.ts), never the SSH term-control route, and what comes back is
 * router output for the view only.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LinkEventContext } from "../src/main/junto/link/types";
import type { LocalHostEvent } from "../src/main/junto/term/local-host";
import { CHUNK_UNITS } from "../src/main/junto/term/seat-attach";
import { TerminalRouter } from "../src/main/junto/term/router";
import { seatExitMessage } from "../src/shared/spawn-failure";
import { unwrapSeatsFailure } from "../src/main/junto/term/seats-failure";
import { linkSeatViewTransport, makeSeatViews, type SeatViews } from "../src/main/junto/term/seat-views";
import { Effect } from "effect";
import { LinkBuildMismatch } from "../src/main/junto/link/types";
import { MachineLink } from "../src/main/junto/link/service";
import { HostsService } from "../src/main/junto/hosts/service";
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
    locate: async (bindingId) => bindingId === miniSeat.bindingId
      ? { machine: "mini", canvas, seatId: miniSeat.id, harness: miniSeat.harness } : undefined,
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

  it("a burst of keys and sizes keeps the link open and lands every key in order", async () => {
    // On the mini, one typed sentence sent a request per key and closed the link past its 32 pending requests.
    const window = await bookWindow();
    const controller = window.mini.fake.controllers[0]!;
    const attached = await window.router.attach({ bindingId: miniSeat.bindingId, mode: "control", takeover: true, hostId: "mini" });
    if (!attached.ok) throw new Error(attached.message);
    const sentence = "Run the shell command hostname, then reply with exactly: PONG from the hostname\r".repeat(3);
    const keys = await Promise.all([...sentence].map((key) => window.router.write(attached.lease, key, "mini")));
    const sizes = await Promise.all(Array.from({ length: 100 }, (_, i) => window.router.resize(attached.lease, 80 + i, 24, "mini")));
    expect(keys.every(Boolean)).toBe(true);
    expect(sizes.every(Boolean)).toBe(true);
    expect(controller.writes.join("")).toBe(sentence);
    expect(controller.resizes.at(-1)).toEqual({ cols: 179, rows: 24 });
    expect(await window.router.write(attached.lease, "still open\r", "mini")).toBe(true);
  });

  it("an observing view cannot type", async () => {
    const window = await bookWindow();
    const attached = await window.router.attach({ bindingId: miniSeat.bindingId, mode: "observe", hostId: "mini" });
    if (!attached.ok) throw new Error(attached.message);
    expect(attached.lease.mode).toBe("observe");
    expect(await window.router.write(attached.lease, "nope", "mini")).toBe(false);
    expect(window.mini.fake.controllers[0]!.writes.join("")).not.toContain("nope");
  });

  it("tells the window when the seat's generation exits, worded as a local seat's exit", async () => {
    const window = await bookWindow();
    const attached = await window.router.attach({ bindingId: miniSeat.bindingId, mode: "control", takeover: true, hostId: "mini" });
    if (!attached.ok) throw new Error(attached.message);
    window.mini.fake.controllers[0]!.exit(0);
    await eventually(() => expect(window.sent).toContainEqual(expect.objectContaining({ type: "exit", bindingId: miniSeat.bindingId, code: 0 })));
    expect(await window.router.write(attached.lease, "late", "mini")).toBe(false);
    // The window's read after the exit: a clean exit, not a start that failed.
    let after = await window.router.get(miniSeat.bindingId, "mini");
    for (let tries = 0; tries < 100 && after?.status !== "exited"; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      after = await window.router.get(miniSeat.bindingId, "mini");
    }
    expect(after).toMatchObject({ status: "exited", epoch: attached.lease.epoch, exitMessage: seatExitMessage({ harness: miniSeat.harness, code: 0 }) });
    expect(after?.exitMessage).toMatch(/exited by itself$/);
  });

  it("reads a running linked seat for the window", async () => {
    const window = await bookWindow();
    expect(await window.router.get(miniSeat.bindingId, "mini")).toMatchObject({ status: "running", hostId: "mini", nodeId: miniSeat.id });
  });

  it("tells the window its view lost control when the seat's own machine takes over", async () => {
    const window = await bookWindow();
    const ended: Array<{ leaseId: string; reason: string }> = [];
    window.router.on("lease-ended", (end: { leaseId: string; reason: string }) => ended.push(end));
    const attached = await window.router.attach({ bindingId: miniSeat.bindingId, mode: "control", takeover: true, hostId: "mini" });
    if (!attached.ok) throw new Error(attached.message);
    expect(await window.mini.host.attach({ bindingId: miniSeat.bindingId, mode: "control", takeover: true })).toMatchObject({ ok: true });
    // The seat's machine learns of its own window's takeover at the view's next key.
    expect(await window.router.write(attached.lease, "x", "mini")).toBe(false);
    await eventually(() => expect(ended).toContainEqual(expect.objectContaining({ leaseId: attached.lease.leaseId, reason: "replaced" })));
    expect(await window.router.write(attached.lease, "x", "mini")).toBe(false);
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

  it("a seat whose machine runs another build reads as the typed mismatch, never wrapped", async () => {
    const cores = await twoCores({ cleanups });
    const mismatch = LinkBuildMismatch.of({ build: "old", installationId: "inst-mini" as never, machineName: "mini" }, "new");
    // The production transport, over a link whose connect refuses the mini's hello.
    const run = ((effect: Effect.Effect<unknown, unknown, never>) => Effect.runPromise(effect.pipe(
      Effect.provideService(HostsService, { get: () => Effect.succeed({ id: "mini" }) } as never),
      Effect.provideService(MachineLink, { connect: () => Effect.fail(mismatch) } as never),
    ) as Effect.Effect<unknown>)) as never;
    const router = new TerminalRouter(cores.book.host);
    router.setSeatViews(makeSeatViews({
      ...linkSeatViewTransport(run),
      locate: async () => ({ machine: "mini", canvas, seatId: miniSeat.id, harness: miniSeat.harness }),
    }));
    cleanups.push(async () => { router.setSeatViews(undefined); router.beginShutdown(); });
    await expect(router.get(miniSeat.bindingId, "mini")).rejects.toBe(mismatch);
  });

  it("a seat the views do not know falls through to the term-control route", async () => {
    const window = await bookWindow();
    const result = await window.router.attach({ bindingId: "not-a-linked-seat", mode: "control", hostId: "mini" });
    expect(result.ok).toBe(false);
  });
});

describe("a seat's machine that breaks the stream's bounds", () => {
  /** A view on a fake seat machine that answers Get and Attach and records every request. */
  const fakeView = () => {
    const requests: Array<{ readonly _tag: string }> = [];
    const views = makeSeatViews({
      locate: async () => ({ machine: "mini", canvas, seatId: miniSeat.id }),
      request: async (_machine, payload) => {
        const sent = payload as { readonly _tag: string };
        requests.push(sent);
        if (sent._tag === "Get") return { _tag: "Started", generation: "g1" };
        if (sent._tag === "Attach") return { _tag: "Attached", handle: "h".repeat(22), generation: "g1", cols: 80, rows: 24, status: "running" };
        return { _tag: "Detached", handle: "h".repeat(22) };
      },
      sendEvent: async () => undefined,
    });
    const context = { peer: { machineName: "mini" } } as unknown as LinkEventContext;
    const screen = (seq: number, part: number, data: string) =>
      views.frame(context, { _tag: "Screen", handle: "h".repeat(22), seq: String(seq), part, last: false, data });
    return { views, requests, screen };
  };

  it("drops the view and detaches when a screen never ends past its cap", async () => {
    const { views, requests, screen } = fakeView();
    const attached = views.attach({ bindingId: miniSeat.bindingId, mode: "observe" });
    await eventually(() => expect(requests.some((request) => request._tag === "Attach")).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const part = "x".repeat(CHUNK_UNITS);
    for (let index = 0; index < 60; index++) screen(index + 1, index, part);
    expect(await attached).toMatchObject({ ok: false });
    await eventually(() => expect(requests.some((request) => request._tag === "Detach")).toBe(true));
  });

  it("drops the view when screen parts arrive out of order", async () => {
    const { views, requests, screen } = fakeView();
    const attached = views.attach({ bindingId: miniSeat.bindingId, mode: "observe" });
    await eventually(() => expect(requests.some((request) => request._tag === "Attach")).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    screen(1, 0, "a");
    screen(2, 2, "c");
    expect(await attached).toMatchObject({ ok: false });
    await eventually(() => expect(requests.some((request) => request._tag === "Detach")).toBe(true));
  });
});
