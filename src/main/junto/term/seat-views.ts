/**
 * The editing machine's view of a seat that runs on another machine, over the
 * seats channel (seat-attach.ts holds the seat machine's side). The router
 * hands a linked seat's attach, input, resize and release here; what comes
 * back is display only: Screen and Output go to the view's lease as router
 * output, never into seat state, a log row or disk. A reloaded window attaches
 * again and gets a fresh Screen.
 */
import { randomBytes } from "node:crypto";
import { Effect } from "effect";
import { isThisMachine } from "@shared/machine-name";
import { seatExitMessage } from "@shared/spawn-failure";
import type { TerminalSessionSummary } from "@shared/terminal";
import { coreRunner } from "../../core-runner";
import { HostsService } from "../hosts/service";
import { MachineLink } from "../link/service";
import type { LinkEventContext } from "../link/types";
import { MachineRepository } from "../machines/repository";
import { ModelService } from "../model/service";
import { unwrapSeatsFailure } from "./seats-failure";
import type { AttachOk, AttachResult } from "./router";
import type { ControlLease, LocalHostEvent } from "./local-host";
import { ATTACH_CREDITS, CHUNK_UNITS, chunkUnits, SCREEN_LIMIT_UNITS, type SeatsStreamFrame } from "./seat-attach";

/** A seat on a canvas this machine edits, run by another machine. */
export type LinkedSeat = {
  readonly machine: string; readonly canvas: string; readonly seatId: string; readonly harness?: string;
};
/** Why a view's lease ended without its window releasing it. */
export type SeatViewLeaseEnd = { readonly leaseId: string; readonly bindingId: string; readonly reason: "replaced" | "admission-lost" | "link-closed" | "generation-changed" };

export type SeatViewTransport = {
  readonly locate: (bindingId: string) => Promise<LinkedSeat | undefined>;
  /** A seats-channel request to the seat's machine; rejects with its typed failure. */
  readonly request: (machine: string, payload: unknown, operationId: string) => Promise<unknown>;
  readonly sendEvent: (machine: string, payload: unknown) => Promise<void>;
};

type View = {
  readonly machine: string;
  readonly canvas: string;
  readonly seatId: string;
  readonly harness: string | undefined;
  readonly handle: string;
  readonly bindingId: string;
  readonly epoch: string;
  readonly lease: ControlLease;
  parts: string[];
  /** UTF-16 units of the screen being received; the seat's machine caps it, and so does this side. */
  screenUnits: number;
  /** The last frame's sequence: frames count up per handle, so the window orders them as it does a local host's. */
  seq: bigint;
  /** Set while attach waits for the first Screen. */
  screen: ((serialized: string | undefined) => void) | undefined;
  /**
   * Keys typed while an Input is in flight wait here and go in order as the
   * next one: the link closes past 32 pending requests, and a key per request
   * reached that with one typed sentence.
   */
  typed: string;
  typedWaiters: Array<(written: boolean) => void>;
  typing: boolean;
  /** The size asked for while a Resize is in flight; only the latest is sent. */
  size: { readonly cols: number; readonly rows: number; readonly waiters: Array<(resized: boolean) => void> } | undefined;
  sizing: boolean;
};

/** How long an attach waits for the seat's screen before showing what comes next. */
const SCREEN_WAIT_MS = 5_000;
/** Terminal reset: a Resync's fresh screen repaints from nothing. */
const RESET = "\u001bc";

/** Generations whose end this window saw, so a read after the exit says how it ended. */
const ENDED_KEPT = 64;
/** Typing waiting behind an Input in flight; a paste past this is refused, not queued without end. */
const TYPED_LIMIT_UNITS = SCREEN_LIMIT_UNITS;

const tagOf = (cause: unknown): string =>
  typeof cause === "object" && cause !== null && "_tag" in cause && typeof cause._tag === "string" ? cause._tag : "Error";

export const makeSeatViews = (transport: SeatViewTransport) => {
  const byLease = new Map<string, View>();
  const byHandle = new Map<string, View>();
  // Frames that beat their Attached answer; credits bound them to a few per handle.
  const early = new Map<string, SeatsStreamFrame[]>();
  const listeners = new Set<(event: LocalHostEvent) => void>();
  const leaseListeners = new Set<(end: SeatViewLeaseEnd) => void>();
  const ended = new Map<string, { readonly epoch: string; readonly at: number; readonly exitMessage: string }>();
  const emit = (event: LocalHostEvent) => { for (const listener of listeners) listener(event); };
  const log = (message: string, fields: Record<string, unknown>) =>
    Effect.runFork(Effect.logInfo(message).pipe(Effect.annotateLogs({ area: "seats", ...fields })));

  const drop = (view: View): void => {
    byLease.delete(view.lease.leaseId);
    byHandle.delete(view.handle);
    view.screen?.(undefined);
  };
  const output = (view: View, data: string): void =>
    emit({ type: "output", bindingId: view.bindingId, epoch: view.epoch, seq: view.seq, data });

  const ack = (view: View, seq: string): void => {
    void transport.sendEvent(view.machine, { _tag: "Ack", handle: view.handle, upTo: seq }).catch((cause: unknown) => {
      // The link is gone: so is the view.
      log("seat view ack not sent", { machine: view.machine, failure: tagOf(cause) });
      drop(view);
    });
  };

  /** A seat's machine that breaks the stream's bounds loses the view: nothing it sends grows this core. */
  const abandon = (view: View, failure: "ScreenOverBound" | "ScreenOutOfOrder"): void => {
    drop(view);
    view.parts = [];
    log("seat view refused", { machine: view.machine, failure });
    void transport.request(view.machine, { _tag: "Detach", handle: view.handle }, randomBytes(16).toString("hex"))
      .catch(() => undefined);
  };

  const deliver = (view: View, frame: SeatsStreamFrame): void => {
    if (frame._tag !== "Ended") view.seq = BigInt(frame.seq);
    switch (frame._tag) {
      case "Screen": {
        if (frame.part !== view.parts.length) return abandon(view, "ScreenOutOfOrder");
        view.screenUnits += frame.data.length;
        if (view.screenUnits > SCREEN_LIMIT_UNITS + CHUNK_UNITS) return abandon(view, "ScreenOverBound");
        view.parts.push(frame.data);
        if (frame.last) {
          const serialized = view.parts.join("");
          view.parts = [];
          view.screenUnits = 0;
          if (view.screen !== undefined) view.screen(serialized);
          else output(view, RESET + serialized);
        }
        return ack(view, frame.seq);
      }
      case "Output":
        output(view, frame.data);
        return ack(view, frame.seq);
      case "Resync":
        view.parts = [];
        view.screenUnits = 0;
        return ack(view, frame.seq);
      case "Ended":
        drop(view);
        log("seat view ended", { machine: view.machine, reason: frame.reason });
        if (frame.reason === "exited") {
          // Worded as a local seat's exit is, from its code or signal only: what it printed stays on its machine.
          ended.delete(view.bindingId);
          ended.set(view.bindingId, { epoch: view.epoch, at: Date.now(),
            exitMessage: seatExitMessage({ harness: view.harness, code: frame.code, signal: frame.signal }) });
          if (ended.size > ENDED_KEPT) ended.delete(ended.keys().next().value!);
          emit({ type: "exit", bindingId: view.bindingId, epoch: view.epoch, seq: view.seq + 1n, code: frame.code, signal: frame.signal });
        } else if (frame.reason !== "released") {
          for (const listener of leaseListeners) listener({ leaseId: view.lease.leaseId, bindingId: view.bindingId, reason: frame.reason });
        }
        return;
    }
  };

  const sendTyped = async (view: View): Promise<void> => {
    view.typing = true;
    while (view.typed.length > 0) {
      const data = view.typed;
      const waiters = view.typedWaiters;
      view.typed = "";
      view.typedWaiters = [];
      let written = true;
      try {
        for (const part of chunkUnits(data)) {
          const answer = await transport.request(view.machine, { _tag: "Input", handle: view.handle, data: part },
            randomBytes(16).toString("hex")) as { readonly accepted?: boolean };
          if (answer.accepted !== true) { written = false; break; }
        }
      } catch (cause) {
        written = false;
        if (tagOf(cause) === "SeatAttachUnknown") drop(view);
        log("seat view input refused", { machine: view.machine, failure: tagOf(cause) });
      }
      for (const waiter of waiters) waiter(written);
      if (!written) {
        // Keys after a refused one are refused too: none lands out of order.
        for (const waiter of view.typedWaiters) waiter(false);
        view.typed = "";
        view.typedWaiters = [];
      }
    }
    view.typing = false;
  };

  const sendSize = async (view: View): Promise<void> => {
    view.sizing = true;
    while (view.size !== undefined) {
      const { cols, rows, waiters } = view.size;
      view.size = undefined;
      let resized = false;
      try {
        const answer = await transport.request(view.machine, { _tag: "Resize", handle: view.handle, cols, rows },
          randomBytes(16).toString("hex")) as { readonly accepted?: boolean };
        resized = answer.accepted === true;
      } catch (cause) {
        if (tagOf(cause) === "SeatAttachUnknown") drop(view);
        log("seat view resize refused", { machine: view.machine, failure: tagOf(cause) });
      }
      for (const waiter of waiters) waiter(resized);
    }
    view.sizing = false;
  };

  return {
    onEvent: (listener: (event: LocalHostEvent) => void): (() => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    /** A view's lease ended on the seat's machine (a takeover, lost admission, a closed link). */
    onLeaseEnded: (listener: (end: SeatViewLeaseEnd) => void): (() => void) => {
      leaseListeners.add(listener);
      return () => { leaseListeners.delete(listener); };
    },
    /** The seat's live generation, or the one whose end this window saw; asks its machine. */
    get: async (bindingId: string): Promise<TerminalSessionSummary | undefined> => {
      const seat = await transport.locate(bindingId);
      if (seat === undefined) return undefined;
      const base = { bindingId, hostId: seat.machine, canvasName: seat.canvas, nodeId: seat.seatId, detached: false };
      const live = await transport.request(seat.machine, { _tag: "Get", canvas: seat.canvas, seatId: seat.seatId },
        randomBytes(16).toString("hex")) as { readonly _tag: string; readonly generation?: string; readonly status?: "starting" | "running"; readonly createdAt?: number };
      if (live._tag === "Started" && live.generation !== undefined && live.status !== undefined)
        return { ...base, epoch: live.generation, status: live.status, createdAt: live.createdAt ?? Date.now() };
      const last = ended.get(bindingId);
      return last === undefined ? undefined
        : { ...base, epoch: last.epoch, status: "exited", createdAt: last.at, exitMessage: last.exitMessage };
    },
    /** True when the seat runs on that machine, on a canvas this machine edits. */
    serves: async (hostId: string, bindingId: string): Promise<boolean> =>
      (await transport.locate(bindingId))?.machine === hostId,
    holds: (leaseId: string): boolean => byLease.has(leaseId),

    /** A frame from the seat's machine; one for a handle this machine holds of another peer is dropped. */
    frame: (context: LinkEventContext, frame: SeatsStreamFrame): void => {
      const view = byHandle.get(frame.handle);
      if (view === undefined) {
        if (frame._tag === "Ended") { early.delete(frame.handle); return; }
        const held = early.get(frame.handle) ?? [];
        if (held.length >= ATTACH_CREDITS || early.size >= 64) return;
        held.push(frame);
        early.set(frame.handle, held);
        return;
      }
      if (view.machine !== context.peer.machineName) return;
      deliver(view, frame);
    },

    attach: async (input: {
      readonly bindingId: string; readonly mode: "control" | "observe"; readonly takeover?: boolean;
    }): Promise<AttachResult> => {
      const seat = await transport.locate(input.bindingId);
      if (seat === undefined) return { ok: false, message: "This seat does not run on a machine this one links to." };
      const operationId = randomBytes(16).toString("hex");
      try {
        const live = await transport.request(seat.machine, { _tag: "Get", canvas: seat.canvas, seatId: seat.seatId }, operationId) as
          { readonly _tag: string; readonly generation?: string };
        if (live._tag !== "Started" || live.generation === undefined)
          return { ok: false, message: `This seat has no occupant on ${seat.machine}.` };
        const attached = await transport.request(seat.machine, { _tag: "Attach", canvas: seat.canvas, seatId: seat.seatId,
          generation: live.generation, mode: input.mode, ...(input.takeover === true ? { takeover: true } : {}) }, operationId) as
          { readonly handle: string; readonly generation: string; readonly cols: number; readonly rows: number; readonly status: string };
        const lease: ControlLease = { leaseId: `lv_${randomBytes(8).toString("hex")}`, bindingId: input.bindingId,
          epoch: attached.generation, mode: input.mode };
        const view: View = { machine: seat.machine, canvas: seat.canvas, seatId: seat.seatId, harness: seat.harness, handle: attached.handle, bindingId: input.bindingId,
          epoch: attached.generation, lease, parts: [], screenUnits: 0, seq: 0n, screen: undefined,
          typed: "", typedWaiters: [], typing: false, size: undefined, sizing: false };
        const screen = new Promise<string | undefined>((resolve) => {
          const timer = setTimeout(() => resolve(undefined), SCREEN_WAIT_MS);
          view.screen = (serialized) => { clearTimeout(timer); view.screen = undefined; resolve(serialized); };
        });
        byLease.set(lease.leaseId, view);
        byHandle.set(view.handle, view);
        for (const frame of early.get(view.handle) ?? []) deliver(view, frame);
        early.delete(view.handle);
        const serialized = await screen;
        if (!byLease.has(lease.leaseId)) return { ok: false, message: "The seat's machine ended the view before it showed." };
        log("seat view opened", { machine: seat.machine, seat: seat.seatId, canvas: seat.canvas, mode: input.mode, operationId });
        const ok: AttachOk = {
          ok: true, lease, cols: attached.cols, rows: attached.rows, journal: [], status: attached.status,
          ...(serialized === undefined ? {} : { screen: { bindingId: input.bindingId, epoch: attached.generation,
            cols: attached.cols, rows: attached.rows, seq: view.seq, serialized } }),
        };
        return ok;
      } catch (cause) {
        log("seat view refused", { machine: seat.machine, seat: seat.seatId, canvas: seat.canvas, failure: tagOf(cause), operationId });
        const message = typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string"
          ? cause.message : "The seat's machine refused the view.";
        return { ok: false, message };
      }
    },

    /** The operator's typing, in frame-sized parts, one Input in flight per view; never logged, never kept. */
    write: (lease: ControlLease, data: string): Promise<boolean> => {
      const view = byLease.get(lease.leaseId);
      // An observing view takes no keys: refused here, never sent.
      if (view === undefined || view.lease.mode === "observe") return Promise.resolve(false);
      if (view.typed.length + data.length > TYPED_LIMIT_UNITS) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        view.typed += data;
        view.typedWaiters.push(resolve);
        if (!view.typing) void sendTyped(view);
      });
    },

    /** One Resize in flight per view; sizes asked for meanwhile collapse to the latest. */
    resize: (lease: ControlLease, cols: number, rows: number): Promise<boolean> => {
      const view = byLease.get(lease.leaseId);
      if (view === undefined) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        view.size = { cols: Math.max(2, Math.min(1000, Math.trunc(cols))), rows: Math.max(1, Math.min(500, Math.trunc(rows))),
          waiters: [...(view.size?.waiters ?? []), resolve] };
        if (!view.sizing) void sendSize(view);
      });
    },

    release: async (lease: ControlLease): Promise<void> => {
      const view = byLease.get(lease.leaseId);
      if (view === undefined) return;
      drop(view);
      try {
        await transport.request(view.machine, { _tag: "Detach", handle: view.handle }, randomBytes(16).toString("hex"));
      } catch (cause) {
        // The seat's machine ends a view whose link closed on its own.
        log("seat view detach refused", { machine: view.machine, failure: tagOf(cause) });
      }
    },
  };
};
export type SeatViews = ReturnType<typeof makeSeatViews>;

/**
 * The transport over this process's core: a seat is linked when a canvas here
 * names it on another machine. The seat's machine admits the view like Stop,
 * so a canvas this machine does not edit is refused there, typed.
 */
export const linkSeatViewTransport = (run = coreRunner.runPromise): SeatViewTransport => ({
  locate: (bindingId) => run(Effect.gen(function* () {
    const model = yield* ModelService;
    const self = yield* (yield* MachineRepository).machineName;
    for (const canvas of yield* model.listCanvases()) {
      for (const node of (yield* model.canvas(canvas)).nodes.values()) {
        if (node.kind === "agent" && node.bindingId === bindingId && !isThisMachine(node.host, self))
          return { machine: node.host, canvas, seatId: node.id, harness: node.harness };
      }
    }
    return undefined;
  })),
  request: (machine, payload, operationId) => run(Effect.gen(function* () {
    const host = yield* (yield* HostsService).get(machine);
    if (host === undefined) return yield* Effect.fail(new Error("This seat's machine is unavailable."));
    const link = yield* MachineLink;
    yield* link.connect(host);
    return yield* link.request(machine, "seats", payload, { operationId }).pipe(Effect.mapError(unwrapSeatsFailure));
  })),
  sendEvent: (machine, payload) => run(Effect.flatMap(MachineLink, (link) => link.sendEvent(machine, "seats", payload))),
});

let active: SeatViews | undefined;
/** The views this process's window holds; the seats channel hands their frames here. */
export const installSeatViews = (views: SeatViews | undefined): void => { active = views; };
/** The seats channel's default stream sink: display only, dropped when no view holds it. */
export const deliverSeatViewFrame = (context: LinkEventContext, frame: SeatsStreamFrame): void => active?.frame(context, frame);
