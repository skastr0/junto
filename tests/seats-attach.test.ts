/**
 * A seat's terminal attached over the seats channel, on two cores joined by
 * a real link session: the book (editing machine) types into and reads the
 * mini's seat. Terminal bytes travel only as Screen and Output frames.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LinkEventContext } from "../src/main/junto/link/types";
import { closeMachineLog, installMachineLog } from "../src/main/junto/observability/logger";
import { machineLogDir } from "../src/main/junto/observability/log-file";
import { ATTACH_CREDITS, BACKLOG_LIMIT_UNITS, type SeatsStreamFrame } from "../src/main/junto/term/seat-attach";
import { eventually, miniSeat, twoCoreCanvas as canvas, twoCoreProcess, twoCores } from "./support/two-cores";

const cleanups: Array<() => Promise<void>> = [];
let restore: () => void;
beforeEach(() => { restore = twoCoreProcess(); });
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  restore();
});

type Attached = { readonly handle: string; readonly generation: string; readonly mode: string };

/** The book's view: it keeps every frame and, unless held, acknowledges each one as it lands. */
const attachedPair = async (options: { readonly holdAcks?: boolean } = {}) => {
  const frames: SeatsStreamFrame[] = [];
  let ack: (context: LinkEventContext, frame: SeatsStreamFrame) => void = () => undefined;
  const cores = await twoCores({ cleanups, book: { attachStream: (context, frame) => { frames.push(frame); ack(context, frame); } } });
  const ackFrame = (frame: SeatsStreamFrame) => {
    if (frame._tag === "Ended") return;
    void cores.bookEnd.sendEvent("seats", { _tag: "Ack", handle: frame.handle, upTo: frame.seq });
  };
  if (options.holdAcks !== true) ack = (_context, frame) => ackFrame(frame);
  const started = await cores.bookEnd.request("seats", { _tag: "Start", canvas, seatId: miniSeat.id }) as { generation: string };
  const attach = (mode: "control" | "observe", takeover?: boolean) =>
    cores.bookEnd.request("seats", { _tag: "Attach", canvas, seatId: miniSeat.id, generation: started.generation, mode,
      ...(takeover === undefined ? {} : { takeover }) }) as Promise<Attached>;
  const output = (handle: string) => frames
    .filter((frame): frame is Extract<SeatsStreamFrame, { _tag: "Output" | "Screen" }> =>
      (frame._tag === "Output" || frame._tag === "Screen") && frame.handle === handle)
    .map((frame) => frame.data).join("");
  return { ...cores, frames, started, attach, output, ackFrame };
};

describe("seat attach over the link", () => {
  it("the editing machine reads the seat's screen and output, types into it, resizes it and detaches", async () => {
    const pair = await attachedPair();
    const controller = pair.mini.fake.controllers[0]!;
    controller.emitData("before attach\r\n");
    const view = await pair.attach("control", true);
    expect(view).toMatchObject({ _tag: "Attached", machine: "mini", mode: "control", generation: pair.started.generation });
    expect(view.handle).toMatch(/^[A-Za-z0-9_-]{22}$/);
    await eventually(() => expect(pair.frames.some((frame) => frame._tag === "Screen" && frame.last)).toBe(true));

    controller.emitData("hello from the mini\r\n");
    await eventually(() => expect(pair.output(view.handle)).toContain("hello from the mini"));

    expect(await pair.bookEnd.request("seats", { _tag: "Input", handle: view.handle, data: "echo typed\r" }))
      .toEqual({ _tag: "Written", handle: view.handle, accepted: true });
    expect(controller.writes.join("")).toContain("echo typed\r");
    expect(await pair.bookEnd.request("seats", { _tag: "Resize", handle: view.handle, cols: 120, rows: 40 }))
      .toEqual({ _tag: "Resized", handle: view.handle, accepted: true });
    expect(controller.resizes).toContainEqual({ cols: 120, rows: 40 });

    expect(await pair.bookEnd.request("seats", { _tag: "Detach", handle: view.handle }))
      .toEqual({ _tag: "Detached", handle: view.handle });
    await expect(pair.bookEnd.request("seats", { _tag: "Input", handle: view.handle, data: "late" }))
      .rejects.toMatchObject({ detail: { _tag: "SeatAttachUnknown" } });
    // The released lease is free again on the mini: a local window takes control without takeover.
    expect(await pair.mini.host.attach({ bindingId: miniSeat.bindingId, mode: "control" })).toMatchObject({ ok: true });
  });

  it("an observing view refuses input and resize, typed, and writes nothing", async () => {
    const pair = await attachedPair();
    const view = await pair.attach("observe");
    await expect(pair.bookEnd.request("seats", { _tag: "Input", handle: view.handle, data: "nope" }))
      .rejects.toMatchObject({ detail: { _tag: "SeatAttachObserveOnly" } });
    await expect(pair.bookEnd.request("seats", { _tag: "Resize", handle: view.handle, cols: 90, rows: 30 }))
      .rejects.toMatchObject({ detail: { _tag: "SeatAttachObserveOnly" } });
    expect(pair.mini.fake.controllers[0]!.writes.join("")).not.toContain("nope");
  });

  it("a takeover ends the control view it replaces", async () => {
    const pair = await attachedPair();
    const first = await pair.attach("control", true);
    const second = await pair.attach("control", true);
    await eventually(() => expect(pair.frames).toContainEqual({ _tag: "Ended", handle: first.handle, reason: "replaced" }));
    await expect(pair.bookEnd.request("seats", { _tag: "Input", handle: first.handle, data: "x" }))
      .rejects.toMatchObject({ detail: { _tag: "SeatAttachUnknown" } });
    expect(await pair.bookEnd.request("seats", { _tag: "Input", handle: second.handle, data: "y" }))
      .toMatchObject({ accepted: true });
  });

  it("sends no more than its credits until the view acknowledges, then the rest", async () => {
    const pair = await attachedPair({ holdAcks: true });
    const view = await pair.attach("control", true);
    const controller = pair.mini.fake.controllers[0]!;
    for (let burst = 0; burst < 20; burst++) {
      controller.emitData(`burst ${burst}\r\n`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const mine = () => pair.frames.filter((frame) => frame._tag !== "Ended" && frame.handle === view.handle);
    await eventually(() => expect(mine()).toHaveLength(ATTACH_CREDITS));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(mine()).toHaveLength(ATTACH_CREDITS);
    for (const frame of mine()) pair.ackFrame(frame);
    await eventually(() => expect(pair.output(view.handle)).toContain("burst 19"));
  });

  it("a view that falls behind past its backlog gets a Resync and a fresh screen, never a growing buffer", async () => {
    const pair = await attachedPair({ holdAcks: true });
    const view = await pair.attach("control", true);
    pair.mini.fake.controllers[0]!.emitData("x".repeat(BACKLOG_LIMIT_UNITS + 10));
    for (const frame of pair.frames.slice()) pair.ackFrame(frame);
    await eventually(() => expect(pair.frames.some((frame) => frame._tag === "Resync" && frame.handle === view.handle)).toBe(true));
  });

  it("ends the view when the seat's generation exits, and when the link closes", async () => {
    const pair = await attachedPair();
    const view = await pair.attach("control", true);
    pair.mini.fake.controllers[0]!.exit(0);
    await eventually(() => expect(pair.frames).toContainEqual({ _tag: "Ended", handle: view.handle, reason: "exited", code: 0 }));

    const again = await attachedPair();
    await again.attach("control", true);
    await again.bookEnd.close();
    // The closed link gave the lease back on the mini: a local window takes control without takeover.
    let local = await again.mini.host.attach({ bindingId: miniSeat.bindingId, mode: "control" });
    for (let tries = 0; !local.ok && tries < 100; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      local = await again.mini.host.attach({ bindingId: miniSeat.bindingId, mode: "control" });
    }
    expect(local).toMatchObject({ ok: true });
  });

  it("a canvas copy that moves the seat off this machine ends the peer's views at once", async () => {
    const pair = await attachedPair();
    const view = await pair.attach("control", true);
    await pair.mini.install(2, "book-install", [{ ...miniSeat, host: "book", agentKey: "book:mini-seat" }]);
    await eventually(() => expect(pair.frames).toContainEqual({ _tag: "Ended", handle: view.handle, reason: "admission-lost" }));
  });

  it("never writes a typed or printed byte to the log", async () => {
    const home = await mkdtemp(join(tmpdir(), "junto-attach-log-"));
    cleanups.push(async () => { closeMachineLog(); await rm(home, { recursive: true, force: true }); });
    installMachineLog({ home, process: "core", echo: false });
    const pair = await attachedPair();
    const view = await pair.attach("control", true);
    const typed = "typed-password-4f9a2c";
    const printed = "printed-token-8b1e7d";
    await pair.bookEnd.request("seats", { _tag: "Input", handle: view.handle, data: typed });
    pair.mini.fake.controllers[0]!.emitData(printed);
    await eventually(() => expect(pair.output(view.handle)).toContain(printed));
    await pair.bookEnd.request("seats", { _tag: "Detach", handle: view.handle });
    const log = await readFile(join(machineLogDir(home), "core.jsonl"), "utf8");
    expect(log).toContain("seat attach opened");
    expect(log).not.toContain(typed);
    expect(log).not.toContain(printed);
  });
});
