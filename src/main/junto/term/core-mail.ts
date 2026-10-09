import { Effect } from "effect";
import { KernelService } from "../kernel/service";
import { cutBeforeMail } from "../seat-sessions/operator-offboard";
import { messageDelivery, type MessageDeliveryTransport } from "../work/message-delivery";
import { seatStateRuntime, type SeatStateRuntime } from "./agent-state";
import { closingFence, fencedWriter, type ClosingFence } from "./closing-fence";
import type { ClipboardSafeAssert } from "./drive";
import { createManagedTerminalDrive } from "./drive/managed-drive-factory";
import { attachManagedTerminalDriveRuntime } from "./drive/managed-drive-runtime";
import { MailReadinessLatch } from "./drive/mail-readiness";
import { isManagedTerminalReady } from "./drive/readiness";
import { injectionSupervisor, type InjectionSupervisor } from "./injection-supervisor";
import type { LocalSessionHost } from "./local-host";
import { bindManagedTerminalDriveForOverseer } from "./managed-drive-holder";
import { terminalObserverPlane, type TerminalObserverPlane } from "./observer";
import { termPlane, type TermProductAutomationSuspension } from "./plane";

type Options = {
  readonly wakeSeat: NonNullable<MessageDeliveryTransport["wakeSeat"]>;
  readonly host?: Pick<LocalSessionHost, "get" | "writeManagedSeat" | "setInputSealed" | "subscribeEvents">;
  readonly state?: SeatStateRuntime;
  readonly observer?: Pick<TerminalObserverPlane, "snapshot" | "subscribeGlobal">;
  readonly supervisor?: InjectionSupervisor;
  readonly fence?: ClosingFence;
  readonly delivery?: Pick<typeof messageDelivery, "onSeatLive" | "suspend">;
  readonly bindSuspension?: (suspension: TermProductAutomationSuspension) => void;
  readonly bindDrive?: typeof bindManagedTerminalDriveForOverseer;
};

export type CoreMailPolicy = {
  readonly seatLive?: MessageDeliveryTransport["seatLive"];
  readonly seatOnboarded?: MessageDeliveryTransport["seatOnboarded"];
  readonly cutColdSession?: MessageDeliveryTransport["cutColdSession"];
  readonly mailWritten?: (bindingId: string) => void;
};

/** One seat input path, whether this machine has a window or not. */
export const createCoreMailTransport = (options: Options) => {
  const host = options.host ?? termPlane.host;
  const state = options.state ?? seatStateRuntime;
  const observer = options.observer ?? terminalObserverPlane;
  const supervisor = options.supervisor ?? injectionSupervisor;
  const fence = options.fence ?? closingFence;
  const delivery = options.delivery ?? messageDelivery;
  const readiness = new MailReadinessLatch();
  const shutdownListeners = new Set<() => void>();
  const writableGenerations = new Map<string, string>();
  let suspended = false;
  let policy: CoreMailPolicy = {};
  let clipboardSafe: ClipboardSafeAssert = () => true;
  const harnessFor = (bindingId: string) => state.machine.getSlot(bindingId)?.harness;
  const mailReadyNow = (bindingId: string): boolean => {
    if (suspended) return false;
    const live = host.get(bindingId);
    const snap = observer.snapshot(bindingId);
    return readiness.observe(bindingId, {
      running: live?.status === "running", generation: live?.epoch,
      harness: harnessFor(bindingId), seatState: state.getState(bindingId),
      bracketedPaste: snap?.signals.modes.bracketedPaste === true,
      idleConfirmed: state.isSeatIdle(bindingId), lines: snap?.lines,
    });
  };
  fence.setLiveGeneration((bindingId) => {
    const live = host.get(bindingId);
    return live !== undefined && live.status !== "exited" && live.status !== "missing" ? live.epoch : undefined;
  });
  host.setInputSealed((bindingId) => suspended || fence.sealed(bindingId));
  state.start();
  const drive = createManagedTerminalDrive({
    write: fencedWriter(fence, (bindingId, data) => !suspended && host.writeManagedSeat(bindingId, data), false),
    isSeatIdle: (bindingId) => state.isSeatIdle(bindingId),
    seatState: (bindingId) => state.getState(bindingId),
    onAttention: (bindingId, reason) => {
      if (state.machine.getSlot(bindingId)) state.machine.force(bindingId, "attention", reason);
    },
    snapshot: (bindingId) => observer.snapshot(bindingId),
    bracketedPaste: (bindingId) => observer.snapshot(bindingId)?.signals.modes.bracketedPaste === true,
    composerVerdict: (bindingId) => state.composerVerdict(bindingId),
    harnessFor, assertClipboardSafe: (bindingId) => clipboardSafe(bindingId),
  });
  (options.bindDrive ?? bindManagedTerminalDriveForOverseer)(drive);
  const driveReady = (bindingId: string): boolean => !suspended && !fence.sealed(bindingId) && isManagedTerminalReady({
    harness: harnessFor(bindingId), seatState: state.getState(bindingId), snapshot: observer.snapshot(bindingId),
  });
  const writable = (bindingId: string): void => {
    if (!suspended) delivery.onSeatLive(bindingId);
  };
  const cleanups = [
    attachManagedTerminalDriveRuntime(drive, {
      subscribeHostEvents: (listener, replay) => host.subscribeEvents((event) => {
        if (event.type === "output") listener({ kind: "output", bindingId: event.bindingId });
        else if (event.type === "session") listener({ kind: "session", bindingId: event.bindingId,
          running: event.status === "running", exited: event.status === "exited" });
      }, replay),
      subscribeSeatState: (listener) => state.subscribe(listener),
      subscribeComposerEmpty: (listener) => state.subscribeComposerVerdict((bindingId, verdict) => {
        if (verdict === "empty") listener(bindingId);
      }),
      subscribeComposerDraft: (listener) => state.subscribeComposerVerdict((bindingId, verdict) => {
        if (verdict === "draft") listener(bindingId);
      }),
      harnessFor, snapshotText: (bindingId) => observer.snapshot(bindingId)?.text,
    }),
    drive.subscribeMailWritable((bindingId) => {
      writable(bindingId);
      if (!suspended) supervisor.noteWritable(bindingId);
    }),
    state.subscribe((event) => {
      supervisor.noteSeatState(event);
      if (event.state === "gone") fence.release(event.bindingId);
      else writable(event.bindingId);
    }),
    observer.subscribeGlobal((snap) => {
      // Readiness can change without a state change: the TUI enables paste,
      // or the operator's draft disappears while the harness stays idle.
      const generation = host.get(snap.bindingId)?.epoch;
      if (!mailReadyNow(snap.bindingId) || generation === undefined) {
        writableGenerations.delete(snap.bindingId);
      } else if (writableGenerations.get(snap.bindingId) !== generation) {
        writableGenerations.set(snap.bindingId, generation);
        writable(snap.bindingId);
      }
    }),
    fence.subscribeLifted(writable),
    supervisor.subscribeContinuationCleared(writable),
  ];
  const transport: MessageDeliveryTransport = {
    seatLive: (bindingId) => !suspended && !fence.sealed(bindingId) &&
      mailReadyNow(bindingId) && !supervisor.continuationHoldsMail(bindingId) && (policy.seatLive?.(bindingId) ?? true),
    seatOnboarded: (bindingId) => policy.seatOnboarded?.(bindingId) ?? supervisor.isOnboarded(bindingId),
    cutColdSession: (_bindingId, canvas, nodeId) => suspended ? Promise.resolve(false) :
      policy.cutColdSession?.(_bindingId, canvas, nodeId) ?? cutBeforeMail({ canvasName: canvas, seatId: nodeId }),
    wakeSeat: (bindingId, canvas, nodeId) => {
      if (suspended) return Promise.resolve(false);
      const live = host.get(bindingId);
      if (live?.status === "running" || live?.status === "starting") return Promise.resolve(true);
      return options.wakeSeat(bindingId, canvas, nodeId);
    },
    writeMail: async (bindingId, text) => {
      if (suspended) return "lost";
      const outcome = await drive.writeMail(bindingId, text);
      if (outcome === "written") {
        if (policy.mailWritten) policy.mailWritten(bindingId);
        else supervisor.noteMailWritten(bindingId);
      }
      return outcome;
    },
  };
  const suspend = (): void => {
    if (suspended) return;
    suspended = true;
    drive.suspend();
    delivery.suspend();
    readiness.clear();
    writableGenerations.clear();
    for (const cleanup of cleanups) cleanup();
    for (const listener of shutdownListeners) listener();
    shutdownListeners.clear();
    state.stop();
  };
  (options.bindSuspension ?? ((suspension) => termPlane.bindProductAutomationSuspension(suspension)))({ suspend });
  return {
    transport, drive, mailReadyNow, driveReady, suspend,
    setMailPolicy: (next: CoreMailPolicy): void => { policy = next; },
    setClipboardSafe: (check: ClipboardSafeAssert): void => { clipboardSafe = check; },
    onSuspend: (listener: () => void): (() => void) => {
      if (suspended) listener();
      else shutdownListeners.add(listener);
      return () => { shutdownListeners.delete(listener); };
    },
  };
};

export type CoreMailSeats = ReturnType<typeof createCoreMailTransport>;

/** Built by the common runtime, over its already-owned kernel and seats. */
export const makeCoreMailTransport = Effect.fn("CoreMail.makeTransport")(function* () {
  const kernel = yield* KernelService;
  const seats = createCoreMailTransport({ wakeSeat: (_binding, canvas, nodeId) => kernel.wakeManagedSeat(canvas, nodeId) });
  yield* Effect.addFinalizer(() => Effect.sync(seats.suspend));
  return seats;
});
