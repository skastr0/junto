/**
 * Shared factory-delivery composition.
 *
 * The product delivery paths — kernel pulses, the injection supervisor,
 * and board wakes — all reach a managed seat PTY
 * through one destination drive. Command Center and the packaged Node
 * Remote both compose them here; mailbox mail is Command Center-only (actor
 * mailboxes are CC-homed) and is wired beside this in `ipc.ts` through the
 * drive's `writeMail`. Both callsites supply their own evidence sources
 * (runtime, kernel, canvases); this module owns only the shared recipe, so
 * neither side can drift into a raw PTY bypass.
 *
 * Product supervisory layers stay at their own callsites and are not part of
 * the drive lifecycle runtime (`managed-drive-runtime.ts`): this module is
 * the delivery composition above that runtime.
 *
 * Every writer below funnels into `drive.writePrompt`. Nothing here writes
 * raw bytes to a seat, and nothing here invents a second drive.
 */

import type { AgentSeatStateEvent } from "@shared/agent-seat-state";
import { isPromptSubmitted, type ManagedPromptOutcome } from "@shared/managed-prompt";
import type { WritePromptOptions } from "./drive";
import type { ObserverGridSnapshot } from "./observer/types";
import {
  makeManagedPulseDeliver,
  type ManagedPulseDeliver,
} from "./managed-pulse-bridge";
import type { BoardDeliveryTransport } from "../work/board-delivery";
import type { MessageDeliveryReadSite } from "../work/message-delivery";
import type { CanvasReadTag } from "../canvases";

/** Minimal drive surface every delivery path needs. */
export type FactoryDeliveryDrive = {
  readonly writePrompt: (
    bindingId: string,
    text: string,
    options: WritePromptOptions,
  ) => Promise<ManagedPromptOutcome>;
};

export type FactoryWritePromptOptions = {
  readonly queueTimeoutMs?: number;
  readonly ready?: boolean;
  readonly awaitTurnStart?: boolean;
  /** False refuses at once on a busy or unwritable seat instead of queueing. */
  readonly queueIfBusy?: boolean;
};

export type FactoryWritePrompt = (
  bindingId: string,
  text: string,
  options?: FactoryWritePromptOptions,
) => Promise<ManagedPromptOutcome>;

/** Kernel seat starter for lazy managed seats (both runtimes). */
export type FactoryDeliveryKernel = {
  readonly wakeManagedSeat: (
    canvas: string,
    nodeId: string,
  ) => boolean | Promise<boolean>;
};

export type FactoryDeliveryEvents = {
  readonly subscribeSeatState: (
    listener: (event: AgentSeatStateEvent) => void,
  ) => () => void;
  readonly subscribeSnapshots: (listener: (snap: ObserverGridSnapshot) => void) => () => void;
};

export type FactoryDeliverySupervisor = {
  readonly setWriter: (
    writer: (bindingId: string, text: string) => boolean | Promise<boolean>,
  ) => void;
  readonly setComposerLookup: (
    lookup: (bindingId: string) => "empty" | "draft" | null,
  ) => void;
  readonly noteSeatState: (event: AgentSeatStateEvent) => void;
  readonly onSnapshot: (snap: ObserverGridSnapshot) => void;
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
  }
};

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
      input.drive.writePrompt(bindingId, text, options).then(isPromptSubmitted),
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
    input.write(bindingId, text, options).then(isPromptSubmitted),
});

/**
 * The supervisor's onboarding nudge through the destination drive's gated
 * write, never the mail path. It refuses at once on a busy seat, an operator
 * draft, or an unreadable composer, and the supervisor tries again at a later
 * event; nothing is queued. Returns the snapshot-subscription teardown — the
 * composition owns it, so dispose closes every subscription this module
 * opened.
 */
export const wireFactorySupervisor = (input: {
  readonly supervisor: FactoryDeliverySupervisor;
  readonly write: FactoryWritePrompt;
  /** The same composer reading the drive gates on. */
  readonly composerVerdict: (bindingId: string) => "empty" | "draft" | null;
  readonly subscribeSnapshots: (
    listener: (snap: ObserverGridSnapshot) => void,
  ) => () => void;
}): (() => void) => {
  input.supervisor.setComposerLookup(input.composerVerdict);
  input.supervisor.setWriter((bindingId, text) =>
    input.write(bindingId, text, { queueIfBusy: false }).then(isPromptSubmitted),
  );
  return input.subscribeSnapshots((snap) =>
    input.supervisor.onSnapshot(snap),
  );
};

export type ComposeFactoryDeliveryInput = {
  readonly drive: FactoryDeliveryDrive;
  readonly driveReady: (bindingId: string) => boolean;
  readonly kernel: FactoryDeliveryKernel;
  readonly events: FactoryDeliveryEvents;
  readonly supervisor: FactoryDeliverySupervisor;
  readonly composerVerdict: (bindingId: string) => "empty" | "draft" | null;
  readonly pulse: FactoryDeliveryPulse;
  readonly board: FactoryDeliveryBoard;
};

export type ComposedFactoryDelivery = {
  readonly write: FactoryWritePrompt;
  readonly dispose: () => void;
};

/**
 * Compose pulse, supervisor, and board delivery through one destination
 * drive. Returns the writer and a dispose closing every subscription this
 * call opened.
 */
export const composeFactoryDelivery = (
  input: ComposeFactoryDeliveryInput,
): ComposedFactoryDelivery => {
  const write = makeFactoryWriteManagedPrompt(input.drive, input.driveReady);

  factoryPulseTransport({
    pulse: input.pulse,
    drive: input.drive,
    driveReady: input.driveReady,
  });
  input.board.configure(
    factoryBoardTransport({ kernel: input.kernel, write }),
  );
  const unsubs: Array<() => void> = [];
  unsubs.push(
    wireFactorySupervisor({
      supervisor: input.supervisor,
      write,
      composerVerdict: input.composerVerdict,
      subscribeSnapshots: input.events.subscribeSnapshots,
    }),
  );
  unsubs.push(
    input.events.subscribeSeatState((event) => {
      input.supervisor.noteSeatState(event);
    }),
  );

  return {
    write,
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
