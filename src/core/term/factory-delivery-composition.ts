/**
 * Shared factory-delivery composition.
 *
 * The product delivery path, the injection supervisor, reaches a managed seat
 * PTY through one destination drive. Command Center and the packaged Node
 * Remote both compose them here; mailbox mail is Command Center-only (actor
 * mailboxes are CC-homed) and is wired beside this in `ipc.ts` through the
 * drive's `writeMail`. Both callsites supply their own evidence sources
 * (runtime, kernel, model); this module owns only the shared recipe, so
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
import {
  outcomeWrotePhysical,
  type ManagedPromptOutcome,
} from "@shared/managed-prompt";
import type { WritePromptOptions } from "./drive";
import type { ObserverGridSnapshot } from "./observer/types";

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
  readonly setContinuationWriter: (
    writer: (bindingId: string, text: string) => boolean | Promise<boolean>,
  ) => void;
  readonly setComposerLookup: (
    lookup: (bindingId: string) => "empty" | "draft" | null,
  ) => void;
  readonly noteSeatState: (event: AgentSeatStateEvent) => void;
  readonly onSnapshot: (snap: ObserverGridSnapshot) => void;
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
 * The supervisor's onboarding nudge through the destination drive. It is an
 * interjection: `interject` types it whatever the seat is doing and yields
 * only to the operator composing there, the way mail is written, because a
 * nudge that waits for the turn to end can arrive hours late. It is not mail:
 * no mailbox, no receipt, and a nudge that could not be typed is simply tried
 * again at a later event.
 *
 * The continuation line of a session that follows `junto offboard --continue`
 * is the opposite case: it opens a fresh session, so it goes through the
 * gated `write`, refused rather than queued, and lands only on an idle seat
 * with a proven-empty composer. Typed bytes count as delivered even when the
 * turn start was not seen; the drive never replays them.
 *
 * Returns the snapshot-subscription teardown — the composition owns it, so
 * dispose closes every subscription this module opened.
 */
export const wireFactorySupervisor = (input: {
  readonly supervisor: FactoryDeliverySupervisor;
  /** True once the sentence and its CR reached the PTY. */
  readonly interject: (bindingId: string, text: string) => Promise<boolean>;
  readonly write: FactoryWritePrompt;
  /** The same composer reading the drive gates on. */
  readonly composerVerdict: (bindingId: string) => "empty" | "draft" | null;
  readonly subscribeSnapshots: (
    listener: (snap: ObserverGridSnapshot) => void,
  ) => () => void;
}): (() => void) => {
  input.supervisor.setComposerLookup(input.composerVerdict);
  input.supervisor.setWriter(input.interject);
  // The continuation line goes the way the nudge does, through the mail
  // gate: it can land in a turn the operator's prompt already started, and a
  // hold on it is announced when it clears.
  input.supervisor.setContinuationWriter(input.interject);
  return input.subscribeSnapshots((snap) =>
    input.supervisor.onSnapshot(snap),
  );
};

export type ComposeFactoryDeliveryInput = {
  readonly drive: FactoryDeliveryDrive;
  readonly driveReady: (bindingId: string) => boolean;
  readonly events: FactoryDeliveryEvents;
  readonly supervisor: FactoryDeliverySupervisor;
  /** Types the supervisor's nudge mid-turn; see wireFactorySupervisor. */
  readonly interject: (bindingId: string, text: string) => Promise<boolean>;
  readonly composerVerdict: (bindingId: string) => "empty" | "draft" | null;
};

export type ComposedFactoryDelivery = {
  readonly write: FactoryWritePrompt;
  readonly dispose: () => void;
};

/**
 * Compose supervisor delivery through one destination drive. Returns the writer and a dispose closing every subscription this
 * call opened.
 */
export const composeFactoryDelivery = (
  input: ComposeFactoryDeliveryInput,
): ComposedFactoryDelivery => {
  const write = makeFactoryWriteManagedPrompt(input.drive, input.driveReady);
  const unsubs: Array<() => void> = [];
  unsubs.push(
    wireFactorySupervisor({
      supervisor: input.supervisor,
      interject: input.interject,
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
