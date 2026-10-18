/**
 * A seat's terminal, attached over the seats channel from the machine that
 * edits its canvas (docs/machines.md, The link: "terminal bytes ride the link").
 * The seat's machine owns the lease; the peer holds only a handle bound to its
 * link session, the seat and the generation. Terminal bytes travel only in
 * Screen and Output events and in nothing else: no failure, log row, scrub
 * registry or disk on either side.
 */
import { randomBytes } from "node:crypto";
import { Effect, Schema } from "effect";
import { CanvasName, NodeId } from "@shared/model";
import { MachineName } from "@shared/machine-control";
import { OPERATOR_TYPED_REPORT_MS, OPERATOR_TYPING_GRACE_MS } from "@shared/operator-hold";
import type { LinkChannelContext, LinkEventContext } from "../link/types";
import type { ControlLease, LocalHostEvent, LocalSessionHost } from "./local-host";

const Generation = Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(256)));
export const AttachHandle = Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9_-]{22}$/)));
/** A frame count, decimal, at most 20 digits. */
const Seq = Schema.String.pipe(Schema.check(Schema.isPattern(/^(0|[1-9][0-9]{0,19})$/)));
/** UTF-16 units; at most three UTF-8 bytes each, so a frame's text stays under 64 KiB. */
export const CHUNK_UNITS = 21_845;
const Bytes = Schema.String.pipe(Schema.check(Schema.isMaxLength(CHUNK_UNITS)));
const Int = (minimum: number, maximum: number) => Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum, maximum })));
const Mode = Schema.Literals(["control", "observe"]);

export const SeatsAttach = Schema.Struct({
  _tag: Schema.Literal("Attach"), canvas: CanvasName, seatId: NodeId, generation: Generation, mode: Mode,
  takeover: Schema.optionalKey(Schema.Boolean),
});
export const SeatsInput = Schema.Struct({ _tag: Schema.Literal("Input"), handle: AttachHandle, data: Bytes });
export const SeatsResize = Schema.Struct({
  _tag: Schema.Literal("Resize"), handle: AttachHandle, cols: Int(2, 1000), rows: Int(1, 500),
});
export const SeatsDetach = Schema.Struct({ _tag: Schema.Literal("Detach"), handle: AttachHandle });
/**
 * The operator's hold on the seat, from the machine editing its canvas: a
 * window there shows this view (open), or the operator just typed into it
 * (typed). The seat's session is not cut at the cache window while held.
 * Closed: exactly these fields, nothing added without remote-security.
 */
export const SeatsHold = Schema.Struct({
  _tag: Schema.Literal("Hold"), handle: AttachHandle, open: Schema.Boolean, typed: Schema.Boolean,
});
export const SeatsAttachRequest = Schema.Union([SeatsAttach, SeatsInput, SeatsResize, SeatsDetach, SeatsHold]);
export type SeatsAttachRequest = typeof SeatsAttachRequest.Type;

export const SeatsAttached = Schema.Struct({
  _tag: Schema.Literal("Attached"), canvas: CanvasName, seatId: NodeId, machine: MachineName,
  generation: Generation, handle: AttachHandle, mode: Mode, cols: Int(1, 1000), rows: Int(1, 500),
  status: Schema.Literals(["starting", "running", "exited"]),
});
export const SeatsWritten = Schema.Struct({ _tag: Schema.Literal("Written"), handle: AttachHandle, accepted: Schema.Boolean });
export const SeatsResized = Schema.Struct({ _tag: Schema.Literal("Resized"), handle: AttachHandle, accepted: Schema.Boolean });
export const SeatsDetached = Schema.Struct({ _tag: Schema.Literal("Detached"), handle: AttachHandle });
export const SeatsHeld = Schema.Struct({ _tag: Schema.Literal("Held"), handle: AttachHandle, accepted: Schema.Boolean });
export const SeatsAttachResponse = Schema.Union([SeatsAttached, SeatsWritten, SeatsResized, SeatsDetached, SeatsHeld]);

export const SeatsScreen = Schema.Struct({
  _tag: Schema.Literal("Screen"), handle: AttachHandle, seq: Seq, part: Int(0, 1023), last: Schema.Boolean, data: Bytes,
});
export const SeatsOutput = Schema.Struct({ _tag: Schema.Literal("Output"), handle: AttachHandle, seq: Seq, data: Bytes });
/** The peer fell behind: what it missed is dropped and a fresh Screen follows. */
export const SeatsResync = Schema.Struct({ _tag: Schema.Literal("Resync"), handle: AttachHandle, seq: Seq });
export const ATTACH_END_REASONS = [
  "exited", "released", "replaced", "generation-changed", "admission-lost", "link-closed",
] as const;
/** On exited, how the process ended: its exit code or signal number, never what it printed. */
export const SeatsEnded = Schema.Struct({
  _tag: Schema.Literal("Ended"), handle: AttachHandle, reason: Schema.Literals(ATTACH_END_REASONS),
  code: Schema.optionalKey(Int(-2_147_483_648, 2_147_483_647)),
  signal: Schema.optionalKey(Int(0, 255)),
});
/** The editing machine received every frame of the handle up to seq: their credit returns. */
export const SeatsAck = Schema.Struct({ _tag: Schema.Literal("Ack"), handle: AttachHandle, upTo: Seq });
export const SeatsAttachEvent = Schema.Union([SeatsScreen, SeatsOutput, SeatsResync, SeatsEnded, SeatsAck]);
export type SeatsAttachEvent = typeof SeatsAttachEvent.Type;
export type SeatsStreamFrame = Exclude<SeatsAttachEvent, typeof SeatsAck.Type>;
export type AttachEndReason = typeof SeatsEnded.Type.reason;

/** Unacknowledged stream frames per link session, across its attaches, well under the link's held events (64, or 8 MiB). */
export const ATTACH_CREDITS = 8;
/** Live attaches per peer installation. */
export const ATTACH_LIMIT = 8;
/** The serialized screen sent at attach, across its parts. */
export const SCREEN_LIMIT_UNITS = 1024 * 1024;
/** Output buffered for a slow peer before it is dropped for a Resync. */
export const BACKLOG_LIMIT_UNITS = 1024 * 1024;
const COALESCE_MS = 16;

export type AttachHost = Pick<LocalSessionHost, "get" | "attach" | "write" | "resize" | "release" | "subscribeEvents">;

export type AttachBinding = {
  readonly canvas: CanvasName;
  readonly seatId: NodeId;
  readonly machine: string;
  readonly bindingId: string;
};

type Attachment = AttachBinding & {
  readonly handle: string;
  readonly context: LinkEventContext;
  readonly generation: string;
  readonly mode: "control" | "observe";
  readonly lease: ControlLease;
  /** The Attach request's operation id, so both ends of one attach join in the logs. */
  readonly operationId: string | undefined;
  /** Frames waiting for credit: screen parts and resyncs, in order, before output. */
  readonly queue: Array<{ readonly kind: "screen"; readonly part: number; readonly last: boolean; readonly data: string } | { readonly kind: "resync" }>;
  out: string;
  /** Output at or before this host sequence is already inside the sent screen. */
  screenSeq: bigint;
  sent: bigint;
  acked: bigint;
  sending: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  ended: boolean;
  /**
   * The operator's hold, kept on the attach itself so it ends with it: a
   * window on the peer shows this view, and when the last key was received
   * here (this machine's clock, never a sent time).
   */
  open: boolean;
  typedAt: number | undefined;
};

export const mintAttachHandle = (): string => randomBytes(16).toString("base64url");

/** Split text into frame-sized parts without cutting a surrogate pair. */
export const chunkUnits = (text: string, size = CHUNK_UNITS): string[] => {
  const parts: string[] = [];
  for (let at = 0; at < text.length;) {
    let end = Math.min(text.length, at + size);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    parts.push(text.slice(at, end));
    at = end;
  }
  return parts;
};

export type SeatAttachmentsOptions = {
  readonly host: AttachHost;
  /** Runs a send on the channel's runtime. */
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  /** The clock a Hold's typing is received on. */
  readonly now?: () => number;
};

/** The seat machine's live attaches: one handle per peer view, bound to its link session and generation. */
export const makeSeatAttachments = (options: SeatAttachmentsOptions) => {
  const { host, run } = options;
  const now = options.now ?? Date.now;
  const live = new Map<string, Attachment>();
  const inFlight = new Map<string, number>();
  let unsubscribe: (() => void) | undefined;

  const logEnded = (attachment: Attachment, reason: AttachEndReason) =>
    Effect.logInfo("seat attach ended").pipe(Effect.annotateLogs({
      area: "seats", seat: attachment.seatId, canvas: attachment.canvas, peer: attachment.context.peer.machineName,
      mode: attachment.mode, reason,
      ...(attachment.operationId === undefined ? {} : { operationId: attachment.operationId }),
    }));

  const pumpSession = (sessionId: string): void => {
    for (const attachment of live.values()) if (attachment.context.sessionId === sessionId) pump(attachment);
  };

  const nextFrame = (attachment: Attachment): SeatsStreamFrame | undefined => {
    const seq = String(attachment.sent + 1n);
    const queued = attachment.queue.shift();
    if (queued?.kind === "screen")
      return { _tag: "Screen", handle: attachment.handle, seq, part: queued.part, last: queued.last, data: queued.data };
    if (queued?.kind === "resync") return { _tag: "Resync", handle: attachment.handle, seq };
    if (attachment.out.length === 0 || attachment.timer !== undefined) return undefined;
    const [data = "", ...rest] = chunkUnits(attachment.out);
    attachment.out = rest.join("");
    return { _tag: "Output", handle: attachment.handle, seq, data };
  };

  const pump = (attachment: Attachment): void => {
    if (attachment.ended || attachment.sending || attachment.context.signal.aborted) return;
    const session = attachment.context.sessionId;
    if ((inFlight.get(session) ?? 0) >= ATTACH_CREDITS) return;
    const frame = nextFrame(attachment);
    if (frame === undefined) return;
    attachment.sending = true;
    attachment.sent += 1n;
    inFlight.set(session, (inFlight.get(session) ?? 0) + 1);
    void run(attachment.context.sendEvent("seats", frame)).then(
      () => { attachment.sending = false; pump(attachment); },
      () => { attachment.sending = false; end(attachment, "link-closed", false); },
    );
  };

  const schedule = (attachment: Attachment): void => {
    if (attachment.timer !== undefined) return;
    attachment.timer = setTimeout(() => { attachment.timer = undefined; pump(attachment); }, COALESCE_MS);
  };

  /** Queue the seat's serialized screen; over its bound, the view starts from what comes next. */
  const queueScreen = (attachment: Attachment, serialized: string | undefined, seq: bigint): void => {
    attachment.screenSeq = seq;
    const text = serialized !== undefined && serialized.length <= SCREEN_LIMIT_UNITS ? serialized : "";
    const parts = chunkUnits(text);
    if (parts.length === 0) parts.push("");
    parts.forEach((data, part) => attachment.queue.push({ kind: "screen", part, last: part === parts.length - 1, data }));
  };

  const resync = async (attachment: Attachment): Promise<void> => {
    attachment.out = "";
    attachment.queue.length = 0;
    attachment.queue.push({ kind: "resync" });
    // A fresh screen through an observe lease of its own, given back at once.
    const fresh = await host.attach({ bindingId: attachment.bindingId, mode: "observe" });
    if (fresh.ok) {
      host.release(fresh.lease);
      if (fresh.lease.epoch === attachment.generation) queueScreen(attachment, fresh.screen?.serialized, fresh.screen?.seq ?? 0n);
    }
    pump(attachment);
  };

  const held = (attachment: Attachment, accepted: boolean): boolean => {
    if (accepted || attachment.mode !== "control") return accepted;
    const live = host.get(attachment.bindingId);
    if (live !== undefined && live.epoch === attachment.generation && (live.status === "running" || live.status === "starting"))
      end(attachment, "replaced");
    return false;
  };

  const end = (attachment: Attachment, reason: AttachEndReason, notify = true,
    exit?: { readonly code: number | undefined; readonly signal: number | undefined }): void => {
    if (attachment.ended) return;
    attachment.ended = true;
    if (attachment.timer !== undefined) clearTimeout(attachment.timer);
    live.delete(attachment.handle);
    host.release(attachment.lease);
    const session = attachment.context.sessionId;
    inFlight.set(session, Math.max(0, (inFlight.get(session) ?? 0) - Number(attachment.sent - attachment.acked)));
    if (notify && !attachment.context.signal.aborted)
      void run(attachment.context.sendEvent("seats", { _tag: "Ended", handle: attachment.handle, reason,
        ...(exit?.code === undefined ? {} : { code: exit.code }),
        ...(exit?.signal === undefined ? {} : { signal: exit.signal }) })).catch(() => undefined);
    void run(logEnded(attachment, reason));
    if (live.size === 0) { unsubscribe?.(); unsubscribe = undefined; }
    pumpSession(session);
  };

  const onHostEvent = (event: LocalHostEvent): void => {
    for (const attachment of [...live.values()]) {
      if (attachment.bindingId !== event.bindingId) continue;
      if (event.epoch !== attachment.generation) {
        if (event.type === "session") end(attachment, "generation-changed");
        continue;
      }
      if (event.type === "exit") end(attachment, "exited", true, { code: event.code, signal: event.signal });
      else if (event.type === "output" && event.seq > attachment.screenSeq) {
        attachment.out += event.data;
        if (attachment.out.length > BACKLOG_LIMIT_UNITS) void resync(attachment);
        else schedule(attachment);
      }
    }
  };

  return {
    /** A handle the request may use: its own link session and peer, still live. */
    held: (context: LinkChannelContext, handle: string): Attachment | undefined => {
      const attachment = live.get(handle);
      return attachment !== undefined && !attachment.ended && attachment.context.sessionId === context.sessionId &&
        attachment.context.peer.installationId === context.peer.installationId ? attachment : undefined;
    },
    list: (): ReadonlyArray<Attachment> => [...live.values()],
    count: (context: LinkChannelContext): number =>
      [...live.values()].filter((attachment) => attachment.context.peer.installationId === context.peer.installationId).length,
    /** Lease the seat's terminal for the peer and queue its screen; undefined when the host refused. */
    open: async (context: LinkChannelContext, binding: AttachBinding, request: typeof SeatsAttach.Type) => {
      unsubscribe ??= host.subscribeEvents(onHostEvent);
      const leased = await host.attach({ bindingId: binding.bindingId, mode: request.mode,
        ...(request.takeover === true ? { takeover: true } : {}) });
      if (!leased.ok) return { ok: false as const, epoch: undefined, message: leased.message };
      if (leased.lease.epoch !== request.generation) {
        host.release(leased.lease);
        return { ok: false as const, epoch: leased.lease.epoch, message: "The seat's occupant changed before the attach reached it." };
      }
      // Never two control handles: a takeover ends the one it replaced.
      if (request.mode === "control")
        for (const other of [...live.values()])
          if (other.bindingId === binding.bindingId && other.mode === "control") end(other, "replaced");
      const attachment: Attachment = { ...binding, handle: mintAttachHandle(), context, generation: leased.lease.epoch,
        mode: request.mode, lease: leased.lease, operationId: context.operationId, queue: [], out: "", screenSeq: 0n, sent: 0n, acked: 0n,
        sending: false, timer: undefined, ended: false, open: false, typedAt: undefined };
      live.set(attachment.handle, attachment);
      queueScreen(attachment, leased.screen?.serialized, leased.screen?.seq ?? 0n);
      pump(attachment);
      return { ok: true as const, attachment, cols: leased.cols, rows: leased.rows, status: leased.status };
    },
    /**
     * A refused write or resize on a live generation means this view's lease
     * is gone: a window on this machine took control. The view hears it as
     * Ended replaced, not as keys that silently go nowhere.
     */
    write: (attachment: Attachment, data: string): boolean => held(attachment, host.write(attachment.lease, data)),
    resize: (attachment: Attachment, cols: number, rows: number): boolean =>
      held(attachment, host.resize(attachment.lease, cols, rows)),
    /**
     * The peer's hold on this view. Typing is received at most once per report
     * interval, whatever rate the peer sends at: one sooner is accepted and
     * changes nothing.
     */
    hold: (attachment: Attachment, open: boolean, typed: boolean): boolean => {
      attachment.open = open;
      if (!typed) return true;
      const at = now();
      if (attachment.typedAt === undefined || at - attachment.typedAt >= OPERATOR_TYPED_REPORT_MS) attachment.typedAt = at;
      return true;
    },
    /** Whether a live view of the binding is held by its peer at `at`. */
    holds: (bindingId: string, at: number): boolean => {
      for (const attachment of live.values()) {
        if (attachment.ended || attachment.bindingId !== bindingId) continue;
        if (attachment.open) return true;
        if (attachment.typedAt !== undefined && at - attachment.typedAt < OPERATOR_TYPING_GRACE_MS) return true;
      }
      return false;
    },
    end,
    ack: (context: LinkEventContext, handle: string, upTo: bigint): void => {
      const attachment = live.get(handle);
      if (attachment === undefined || attachment.context.sessionId !== context.sessionId) return;
      const next = upTo > attachment.sent ? attachment.sent : upTo;
      if (next <= attachment.acked) return;
      const session = context.sessionId;
      inFlight.set(session, Math.max(0, (inFlight.get(session) ?? 0) - Number(next - attachment.acked)));
      attachment.acked = next;
      pumpSession(session);
    },
    /** The link session is gone: its attaches end without a word on the closed link. */
    closeSession: (context: LinkEventContext): void => {
      for (const attachment of [...live.values()])
        if (attachment.context.sessionId === context.sessionId) end(attachment, "link-closed", false);
      inFlight.delete(context.sessionId);
    },
    /** A peer that lost its pin or its canvas: every attach of it ends at once. */
    endPeer: (installationId: string, canvas?: string): void => {
      for (const attachment of [...live.values()])
        if (attachment.context.peer.installationId === installationId && (canvas === undefined || attachment.canvas === canvas))
          end(attachment, "admission-lost");
    },
  };
};
export type SeatAttachments = ReturnType<typeof makeSeatAttachments>;
