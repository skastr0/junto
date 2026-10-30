/**
 * Every channel the core pushes a change on, and what each carries. Both
 * processes read this file, and nothing of each other's, for it: the core
 * publishes on these names, Electron main forwards them to the window. It
 * holds no operation body, so main links no core module by naming a channel.
 */
import type { MachineCommandProgress } from "@shared/machine-progress";
import type { Canvas } from "@shared/model";

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
/** The core opened or refused a view's surface port, by the id main sent with it. */
export const SURFACE_OPENED = "term.surfaceOpened";

/** A seat's cache window changed, and the auto mode's due seats, for the window. */
export const SEAT_CACHE_DUE_CHANGED = "seatCacheDue.changed";
