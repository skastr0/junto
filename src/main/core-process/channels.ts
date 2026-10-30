/**
 * Every push on the core bus, by channel and by what it carries. The core
 * publishes here; main listens on the port and republishes on its own bus,
 * where the handlers that send to a window read them. This file is the
 * contract, and it holds no operation body, so main links no core module by
 * naming a channel.
 *
 * `CORE_PUSHES` is the whole registry. `publish` accepts a channel only if it
 * is here, with exactly that channel's payload; `relayWindowPushes` listens
 * for every one of them. So a push cannot be published without main hearing
 * it, which is what a hand-kept forward list got wrong.
 */
import type { AgentSeatStateEvent } from "@shared/agent-seat-state";
import type { AgentSignal } from "@shared/agent-signals";
import type { CompanionDeviceRecord } from "@shared/companion-devices";
import { IPC_CHANNELS } from "@shared/ipc";
import type { KernelSnapshot } from "@shared/ipc";
import type { MailWaitingFact } from "@shared/mail-waiting";
import type { MailReadChanged } from "@shared/mail-threads";
import type { MachineCommandProgress } from "@shared/machine-progress";
import { MENTION_IPC_CHANNELS } from "@shared/mention-ipc-channels";
import type { Canvas, CanvasesChanged, Changed } from "@shared/model";
import type { ObservabilityLogEntry } from "@shared/observability";
import type { LiveSnapshot } from "@shared/overseer-live";
import type { PreambleEvent } from "@shared/preamble";
import type { ReferencesChangedEvent } from "@shared/references";
import type { SeatOnboardingEvent } from "@shared/seat-onboarding-status";
import type { SeatOffboardProgress } from "@shared/seat-sessions";
import type { Settings } from "@shared/settings";
import type { UsageState } from "@shared/usage";
import type { ViewStateEvent } from "@shared/view-state";
import type { WireTrafficEvent } from "@shared/wire-traffic";
import type { SeatAwarenessEvent } from "@renderer/lib/seat-awareness-contract";
import type { FilesChanged } from "@shared/files";
import type { RemoteChange } from "../junto/files/link-client";
import type { ActorRefsChanged } from "../junto/model/actor-refs";
import type { LocalHostEvent } from "../junto/term/local-host";

/** Where the settings go on every change, provider secrets masked, once `settings.watch` started it. */
export const SETTINGS_CHANGED = "settings.changed";
/** A seat's preamble, as the core's work control server takes it, for the window to show. */
export const WORK_PREAMBLE = "work.preamble";
/** Every agent signal the core writes, for the window and the raised hands. */
export const AGENT_SIGNAL_CHANGED = "signals.changed";
/** The paired phones, after any change, for Settings. */
export const COMPANION_DEVICES = "companion.devices";
/** The live overseer's snapshot on every change, once `live.watch` started it. */
export const LIVE_CHANGED = "live.changed";
/** A mail thread's read point moved, from any surface, once `ipc.threads.watch` started it. */
export const SEAT_THREAD_READ_CHANGED = "threads.readChanged";
/** Mail held on a seat past its wait, once `ipc.threads.watch` started it. */
export const MAIL_WAITING = "mail.waiting";
/** A canvas changed, with the document as it is now, or was removed; once `model.watchCanvases` started it. */
export const CANVAS_CHANGED = "model.canvasChanged";

/** What the canvas notice carries: the canvas, and the document as it is now or `undefined` once removed. */
export type CanvasChangedPush = { readonly canvas: string; readonly next: Canvas | undefined };

/** A resource's rows changed, from any surface: main broadcasts it to the window. */
export const RESOURCE_CHANGED = "resource.changed";
/** A comment landed on a resource whose own rows did not change. */
export const RESOURCE_THREAD_CHANGED = "resource.threadChanged";

/** What crosses on the two notices: the window's own channel and what it carries. */
export type ResourceChangedPush = { readonly channel: string; readonly canvasName: string };
export type ResourceThreadChangedPush = ResourceChangedPush & { readonly kind: string };

/** A wire's traffic: one typed message, or a held line. Main relays it. */
export const WIRE_TRAFFIC = "wire.traffic";

/** A change to a node a window has open: the webContents id it goes to, and what changed. */
export const FILES_CHANGED = "files.changed";

export type FilesChangedPush = { readonly subscriber: number; readonly event: FilesChanged };

/** A change under a node opened on another machine. */
export const FILES_REMOTE_CHANGED = "files.remoteChanged";

/** A running machine command's progress, tagged with the call that asked for it. */
export const MACHINE_PROGRESS = "hosts.machineProgress";

export type MachineProgressPushed = {
  readonly requestId: string;
  readonly progress: MachineCommandProgress;
};

/** A terminal event from the plane (output, status, exit, title), for the window holding its lease. */
export const TERM_EVENT = "term.event";
/** A linked seat's view its machine ended. */
export const TERM_LEASE_ENDED = "term.leaseEnded";
/** A seat changed state: one this machine runs, or one on another machine over the seats channel. */
export const TERM_SEAT_STATE = "term.seatState";

/** A view's surface opened or was refused, by the id main sent with it. Carried on the port, never the bus. */
export const SURFACE_OPENED = "term.surfaceOpened";

/** One log row, while a panel watches: the ring captures always, the push is for the open panel. */
export const OBSERVABILITY_LOG = "observability.log";
/** The ring was cleared: a panel drops what it holds. */
export const OBSERVABILITY_CLEARED = "observability.cleared";

export type ObservabilityCleared = { readonly newestId: number; readonly total: number; readonly dropped: number };

/** A seat's cache window changed, and the auto mode's due seats, for the window. */
export const SEAT_CACHE_DUE_CHANGED = "seatCacheDue.changed";

/** What a lease's end says: which view, and why its machine ended it. */
export type TermLeaseEnded = { readonly leaseId: string; readonly reason: string };

/** A resource changed under a canvas: which canvas, and which node. */
export type ResourceChanged = { readonly canvasName: string; readonly nodeId: string };

/** The payload witness: it names a channel's payload type, and is never called. */
const carries = <Payload>() => (payload: Payload): Payload => payload;

/**
 * Every push on the core bus. A channel is publishable only from here, and a
 * publish carries exactly the payload named for it.
 */
export const CORE_PUSHES = {
  [SETTINGS_CHANGED]: carries<Settings>(),
  [WORK_PREAMBLE]: carries<PreambleEvent>(),
  [AGENT_SIGNAL_CHANGED]: carries<AgentSignal>(),
  [COMPANION_DEVICES]: carries<ReadonlyArray<CompanionDeviceRecord>>(),
  [LIVE_CHANGED]: carries<LiveSnapshot>(),
  [SEAT_THREAD_READ_CHANGED]: carries<MailReadChanged>(),
  [MAIL_WAITING]: carries<MailWaitingFact>(),
  [CANVAS_CHANGED]: carries<CanvasChangedPush>(),
  [RESOURCE_CHANGED]: carries<ResourceChangedPush>(),
  [RESOURCE_THREAD_CHANGED]: carries<ResourceThreadChangedPush>(),
  [WIRE_TRAFFIC]: carries<WireTrafficEvent>(),
  [FILES_REMOTE_CHANGED]: carries<RemoteChange>(),
  [FILES_CHANGED]: carries<FilesChangedPush>(),
  [OBSERVABILITY_LOG]: carries<ObservabilityLogEntry>(),
  [OBSERVABILITY_CLEARED]: carries<ObservabilityCleared>(),
  [MACHINE_PROGRESS]: carries<MachineProgressPushed>(),
  [TERM_EVENT]: carries<LocalHostEvent>(),
  [TERM_LEASE_ENDED]: carries<TermLeaseEnded>(),
  [TERM_SEAT_STATE]: carries<AgentSeatStateEvent>(),
  [SEAT_CACHE_DUE_CHANGED]: carries<null>(),
  // A backlink landed; the panes read their mentions again.
  [MENTION_IPC_CHANNELS.changed]: carries<{ readonly canvasName: string }>(),
  // The model's own watches, each on the window's channel name (ops/ipc-watch.ts).
  [IPC_CHANNELS.modelChanged]: carries<Changed>(),
  [IPC_CHANNELS.modelCanvasesChanged]: carries<CanvasesChanged>(),
  [IPC_CHANNELS.modelActorRefsChanged]: carries<ActorRefsChanged>(),
  [IPC_CHANNELS.viewStateChanged]: carries<ViewStateEvent>(),
  [IPC_CHANNELS.referencesChanged]: carries<ReferencesChangedEvent>(),
  [IPC_CHANNELS.workMailChanged]: carries<ResourceChanged>(),
  [IPC_CHANNELS.workSinkChanged]: carries<ResourceChanged>(),
  [IPC_CHANNELS.seatAwarenessChanged]: carries<SeatAwarenessEvent>(),
  [IPC_CHANNELS.usageChanged]: carries<UsageState>(),
  [IPC_CHANNELS.kernelChanged]: carries<KernelSnapshot>(),
  [IPC_CHANNELS.automationsChanged]: carries<ResourceChanged>(),
  [IPC_CHANNELS.seatOffboardProgress]: carries<SeatOffboardProgress>(),
  [IPC_CHANNELS.seatOnboardingChanged]: carries<SeatOnboardingEvent>(),
  [IPC_CHANNELS.coreRestarted]: carries<Record<string, never>>(),
} as const;

/** Every channel on the core bus. */
export type CorePushChannel = keyof typeof CORE_PUSHES;

/** What one channel carries. */
export type CorePushOf<K extends CorePushChannel> = Parameters<(typeof CORE_PUSHES)[K]>[0];

/** Every channel on the core bus, for the relay to listen on. */
export const CORE_PUSH_CHANNELS = Object.keys(CORE_PUSHES) as ReadonlyArray<CorePushChannel>;
