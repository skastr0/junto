/**
 * Shared factory-delivery composition.
 *
 * The product delivery paths — kernel pulses, the injection supervisor,
 * board wakes, and first-typed doctrine, plus mailbox mail where its input
 * exists — all reach a managed seat PTY through one destination drive.
 * Command Center wires all five in `ipc.ts`; the packaged Node Remote
 * wires the four locally-sourced paths through its own destination drive
 * and leaves mail explicitly uncomposed (actor mailboxes are CC-homed; a
 * Remote never materializes message.append, so no local store read can
 * source pending mail). Both callsites supply their own evidence sources
 * (runtime, kernel, canvases, pause); this module owns only the shared
 * recipe, so neither side can drift into a raw PTY bypass.
 *
 * Product supervisory layers stay at their own callsites and are not part of
 * the drive lifecycle runtime (`managed-drive-runtime.ts`): this module is
 * the delivery composition above that runtime.
 *
 * Every writer below funnels into `drive.writePrompt`. Nothing here writes
 * raw bytes to a seat, and nothing here invents a second drive.
 */

import type { AgentSeatStateEvent } from "@shared/agent-seat-state";
import type { CanvasDoc } from "@shared/canvas";
import { seatPaused, type CanvasPauseState } from "@shared/pause";
import type { WritePromptOptions } from "./drive";
import type { ObserverGridSnapshot } from "./observer/types";
import {
  makeManagedPulseDeliver,
  type ManagedPulseDeliver,
} from "./managed-pulse-bridge";
import type { BoardDeliveryTransport } from "../work/board-delivery";
import type {
  MessageDeliveryReadSite,
  MessageDeliveryStore,
  MessageDeliveryTransport,
} from "../work/message-delivery";
import type { CanvasReadTag } from "../canvases";

/** Minimal drive surface every delivery path needs. */
export type FactoryDeliveryDrive = {
  readonly writePrompt: (
    bindingId: string,
    text: string,
    options: WritePromptOptions,
  ) => Promise<boolean>;
  readonly pasteWriteCount: (bindingId: string) => number;
};

export type FactoryWritePromptOptions = {
  readonly queueTimeoutMs?: number;
  readonly ready?: boolean;
  readonly interruptIfBusy?: boolean;
  readonly awaitTurnStart?: boolean;
};

export type FactoryWritePrompt = (
  bindingId: string,
  text: string,
  options?: FactoryWritePromptOptions,
) => Promise<boolean>;

/** Kernel seat starter for lazy managed seats (both runtimes). */
export type FactoryDeliveryKernel = {
  readonly wakeManagedSeat: (
    canvas: string,
    nodeId: string,
  ) => boolean | Promise<boolean>;
};

export type FactoryDeliveryPause = {
  readonly stateFor: (canvas: string) => CanvasPauseState;
  readonly subscribe: (listener: (canvas: string) => void) => () => void;
};

export type FactoryDeliverySeatSnapshot =
  | {
      readonly idle: boolean;
      readonly generationKey: string;
      readonly operatorDraft: boolean;
    }
  | undefined;

export type FactoryDeliveryEvents = {
  readonly subscribeSeatState: (
    listener: (event: AgentSeatStateEvent) => void,
  ) => () => void;
  readonly subscribeComposerEmpty: (
    listener: (bindingId: string) => void,
  ) => () => void;
  readonly subscribeSnapshots: (listener: (snap: ObserverGridSnapshot) => void) => () => void;
};

export type FactoryDeliverySupervisor = {
  readonly setWriter: (
    writer: (bindingId: string, text: string) => boolean | Promise<boolean>,
  ) => void;
  readonly setEscalationHandler: (
    handler: (bindingId: string, reason: string) => void,
  ) => void;
  readonly noteSeatState: (event: AgentSeatStateEvent) => void;
  readonly onSnapshot: (snap: ObserverGridSnapshot) => void;
};

export type FactoryDeliveryMail = {
  readonly configure: (input: {
    readonly transport: MessageDeliveryTransport;
    readonly store: MessageDeliveryStore;
    readonly seatPaused?: (
      canvas: string,
      doc: CanvasDoc,
      nodeId: string,
    ) => boolean;
  }) => void;
  readonly onManagedTerminalIdle: (bindingId: string) => void;
  readonly onComposerEmpty: (bindingId: string) => void;
  readonly onResumed: () => void;
  readonly onBooted: () => void;
  readonly suspend: () => void;
};

export type FactoryDeliveryPulse = {
  readonly setDeliver: (
    fn:
      | ((bindingId: string, message: string) => Promise<boolean>)
      | undefined,
  ) => void;
};

export type FactoryDeliveryBoard = {
  readonly configure: (transport: BoardDeliveryTransport) => void;
};

export type FactoryDeliveryFirstTyped = {
  readonly peekEntry: (
    bindingId: string,
  ) => { readonly text: string; readonly seq: number } | undefined;
  readonly takeEntryIfCurrent: (
    bindingId: string,
    seq: number,
  ) => string | undefined;
  readonly clearDeliveredForBinding: (bindingId: string) => void;
};

/**
 * One perf tag per delivery call site — a read loop must name its driver.
 * Identical vocabulary on both runtimes so the perf tape stays comparable.
 */
export const factoryDeliveryReadTag = (
  site: MessageDeliveryReadSite,
): CanvasReadTag => {
  switch (site) {
    case "scan":
      return "delivery.scan";
    case "attempt":
      return "delivery.attempt";
    case "batch":
      return "delivery.batch";
  }
};

/** Pause law (@shared/pause) against a pause plane snapshot. */
export const factorySeatPaused = (
  pause: FactoryDeliveryPause,
  canvas: string,
  doc: CanvasDoc,
  nodeId: string,
): boolean => seatPaused(pause.stateFor(canvas), doc, nodeId);

/**
 * Managed-prompt writer with a readiness default: explicit `ready` wins,
 * otherwise the callsite's drive-ready predicate decides. Mirrors the
 * Command Center writer so the Remote transport gates identically.
 */
export const makeFactoryWriteManagedPrompt = (
  drive: FactoryDeliveryDrive,
  driveReady: (bindingId: string) => boolean,
): FactoryWritePrompt =>
  (bindingId, text, options) =>
    drive.writePrompt(bindingId, text, {
      ready: options?.ready ?? driveReady(bindingId),
      ...(options ?? {}),
    });

/**
 * First-typed doctrine kick: peek first, consume only after a successful
 * physical paste+CR. No turn-start wait — weak-chrome harnesses never
 * publish working, so a stall watch would leave the arm live and re-paste
 * on every idle re-entry. One arm at a time per binding.
 *
 * Arm ownership: the completing write consumes the arm only when the live
 * arm still carries the seq it sent (takeEntryIfCurrent) — text equality
 * is not identity. A generation replacement that rearms mid-flight keeps
 * its newer doctrine; a late success must never eat it. Rejections release
 * the flight without consuming anything and schedule no retry.
 *
 * Liveness: the flight is owned per arm seq, not per binding. A new idle
 * that finds an older arm still settling remembers one re-kick; when the
 * old write settles, the re-kick fires once if the newer arm is still live
 * and the drive is ready. Without this, a same-text rearm stranded behind
 * a slow old write would wait for an idle that never comes on weak-chrome
 * seats.
 */
export const makeFactoryFirstTypedKick = (input: {
  readonly firstTyped: FactoryDeliveryFirstTyped;
  readonly driveReady: (bindingId: string) => boolean;
  readonly write: FactoryWritePrompt;
}): {
  readonly kick: (bindingId: string) => void;
  readonly inFlight: ReadonlyMap<string, number>;
} => {
  const inFlight = new Map<string, number>();
  const pendingRekick = new Set<string>();
  const kick = (bindingId: string): void => {
    const arm = input.firstTyped.peekEntry(bindingId);
    if (!arm || !input.driveReady(bindingId)) return;
    const owner = inFlight.get(bindingId);
    if (owner !== undefined) {
      // An older arm is still settling. Remember one re-kick only when a
      // strictly newer arm is live; the same arm refusing must never loop.
      if (arm.seq !== owner) pendingRekick.add(bindingId);
      return;
    }
    inFlight.set(bindingId, arm.seq);
    void input
      .write(bindingId, arm.text, { awaitTurnStart: false })
      .then(
        (ok) => {
          if (ok) input.firstTyped.takeEntryIfCurrent(bindingId, arm.seq);
        },
        () => {},
      )
      .finally(() => {
        // Stale-finally fence: only the owning completion releases the
        // flight it opened.
        if (inFlight.get(bindingId) === arm.seq) inFlight.delete(bindingId);
        if (pendingRekick.delete(bindingId)) kick(bindingId);
      });
  };
  return { kick, inFlight };
};

/**
 * Kernel pulse transport through the destination drive. Returns the
 * concrete deliver closure it registers: callsites must route later
 * conditional re-registrations through this closure, never through the
 * global dispatcher — wrapping the dispatcher re-registers the wrapper
 * itself and recurses on every pulse.
 */
export const factoryPulseTransport = (input: {
  readonly pulse: FactoryDeliveryPulse;
  readonly drive: FactoryDeliveryDrive;
  readonly driveReady: (bindingId: string) => boolean;
}): ManagedPulseDeliver => {
  const deliver = makeManagedPulseDeliver(
    (bindingId, text, options) =>
      input.drive.writePrompt(bindingId, text, options),
    input.driveReady,
  );
  input.pulse.setDeliver(deliver);
  return deliver;
};

/** Board megaphone transport through the destination drive. */
export const factoryBoardTransport = (input: {
  readonly kernel: FactoryDeliveryKernel;
  readonly write: FactoryWritePrompt;
}): BoardDeliveryTransport => ({
  wakeManagedSeat: (canvas, nodeId) =>
    input.kernel.wakeManagedSeat(canvas, nodeId),
  sendManagedTerminalPrompt: (bindingId, text, options) =>
    input.write(bindingId, text, options),
});

/**
 * Mailbox transport through the destination drive. Raw geography shells get
 * no auto-submit; managed seats get paste+CR via the idle-gated drive. The
 * gate snapshot must prove an EMPTY composer — a visible operator draft, a
 * stuck paste chip, or an unreadable composer holds mail, the same verdict
 * the drive enforces at the paste boundary.
 */
export const factoryMailTransport = (input: {
  readonly kernel: FactoryDeliveryKernel;
  readonly write: FactoryWritePrompt;
  readonly drive: FactoryDeliveryDrive;
  readonly seatSnapshot: (
    bindingId: string,
  ) => FactoryDeliverySeatSnapshot | Promise<FactoryDeliverySeatSnapshot>;
}): MessageDeliveryTransport => ({
  wakeManagedSeat: (canvas, nodeId) =>
    input.kernel.wakeManagedSeat(canvas, nodeId),
  sendTerminalPaste: (_bindingId, _text, _messageId) => false,
  sendManagedTerminalPrompt: (bindingId, text, options) =>
    input.write(bindingId, text, options),
  pasteWriteCount: (bindingId) => input.drive.pasteWriteCount(bindingId),
  seatDeliverySnapshot: (bindingId) => input.seatSnapshot(bindingId),
});

/**
 * Supervisor re-delivery through the destination drive. Returns the
 * snapshot-subscription teardown — the composition owns it, so dispose
 * closes every subscription this module opened.
 */
export const wireFactorySupervisor = (input: {
  readonly supervisor: FactoryDeliverySupervisor;
  readonly write: FactoryWritePrompt;
  readonly escalate: (bindingId: string, reason: string) => void;
  readonly subscribeSnapshots: (
    listener: (snap: ObserverGridSnapshot) => void,
  ) => () => void;
}): (() => void) => {
  input.supervisor.setWriter((bindingId, text) => input.write(bindingId, text));
  input.supervisor.setEscalationHandler((bindingId, reason) =>
    input.escalate(bindingId, reason),
  );
  return input.subscribeSnapshots((snap) =>
    input.supervisor.onSnapshot(snap),
  );
};

export type ComposeFactoryDeliveryInput = {
  readonly drive: FactoryDeliveryDrive;
  readonly driveReady: (bindingId: string) => boolean;
  readonly kernel: FactoryDeliveryKernel;
  readonly pause: FactoryDeliveryPause;
  readonly events: FactoryDeliveryEvents;
  readonly supervisor: FactoryDeliverySupervisor;
  readonly escalate: (bindingId: string, reason: string) => void;
  /**
   * Mailbox mail is Command Center-only: actor mailboxes are CC-homed and
   * a Remote never materializes message.append, so no local store read can
   * source pending mail there. A runtime without a CC-authoritative pending
   * delivery input omits both; the composition then wires
   * pulse/supervisor/board/firstTyped only and claims no mail completion.
   */
  readonly mail?: FactoryDeliveryMail;
  readonly store?: MessageDeliveryStore;
  readonly pulse: FactoryDeliveryPulse;
  readonly board: FactoryDeliveryBoard;
  readonly firstTyped: FactoryDeliveryFirstTyped;
  readonly seatSnapshot: (
    bindingId: string,
  ) => FactoryDeliverySeatSnapshot | Promise<FactoryDeliverySeatSnapshot>;
  /** Boot rescan delay for durable backlog (matches Command Center). */
  readonly bootRescanMs?: number;
  readonly scheduleBootRescan?: (fn: () => void, ms: number) => void;
};

export type ComposedFactoryDelivery = {
  readonly write: FactoryWritePrompt;
  readonly kickFirstTyped: (bindingId: string) => void;
  readonly dispose: () => void;
};

/**
 * Compose the factory delivery paths through one destination drive. With
 * mail/store supplied this is all five paths; without them (a runtime with
 * no CC-authoritative pending-mail input, such as the Node Remote) it is
 * pulse/supervisor/board/firstTyped with mail explicitly uncomposed.
 * Returns the writer plus the doctrine kick (for the runtime's pre-idle
 * hook) and a dispose closing every subscription this call opened.
 */
export const composeFactoryDelivery = (
  input: ComposeFactoryDeliveryInput,
): ComposedFactoryDelivery => {
  const write = makeFactoryWriteManagedPrompt(input.drive, input.driveReady);
  const { kick } = makeFactoryFirstTypedKick({
    firstTyped: input.firstTyped,
    driveReady: input.driveReady,
    write,
  });

  factoryPulseTransport({
    pulse: input.pulse,
    drive: input.drive,
    driveReady: input.driveReady,
  });
  input.board.configure(
    factoryBoardTransport({ kernel: input.kernel, write }),
  );
  const mail = input.mail !== undefined && input.store !== undefined
    ? { service: input.mail, store: input.store }
    : undefined;
  if (mail) {
    mail.service.configure({
      transport: factoryMailTransport({
        kernel: input.kernel,
        write,
        drive: input.drive,
        seatSnapshot: input.seatSnapshot,
      }),
      store: mail.store,
      seatPaused: (canvas, doc, nodeId) =>
        factorySeatPaused(input.pause, canvas, doc, nodeId),
    });
  }
  const unsubs: Array<() => void> = [];
  unsubs.push(
    wireFactorySupervisor({
      supervisor: input.supervisor,
      write,
      escalate: input.escalate,
      subscribeSnapshots: input.events.subscribeSnapshots,
    }),
  );
  unsubs.push(
    input.events.subscribeSeatState((event) => {
      input.supervisor.noteSeatState(event);
      if (event.state === "gone") {
        input.firstTyped.clearDeliveredForBinding(event.bindingId);
      }
      if (event.state === "idle") {
        mail?.service.onManagedTerminalIdle(event.bindingId);
      }
    }),
  );
  if (mail) {
    unsubs.push(
      input.events.subscribeComposerEmpty((bindingId) => {
        mail.service.onComposerEmpty(bindingId);
      }),
    );
    unsubs.push(
      input.pause.subscribe((canvas) => {
        if (input.pause.stateFor(canvas).playing) mail.service.onResumed();
      }),
    );

    const bootMs = input.bootRescanMs ?? 10_000;
    if (input.scheduleBootRescan) {
      input.scheduleBootRescan(() => mail.service.onBooted(), bootMs);
    } else {
      const timer = setTimeout(() => mail.service.onBooted(), bootMs);
      timer.unref?.();
      unsubs.push(() => clearTimeout(timer));
    }
  }

  return {
    write,
    kickFirstTyped: kick,
    dispose: () => {
      for (const unsub of unsubs) {
        try {
          unsub();
        } catch {
          // Best-effort unsubscribe; process shutdown reclaims the rest.
        }
      }
    },
  };
};
