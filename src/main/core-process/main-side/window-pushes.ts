/**
 * Main's side of the core's window pushes. The core publishes on its own
 * channels; main listens on the port for exactly the ones the window takes
 * and republishes them on this process's push bus, where the handlers that
 * send to a window already subscribe.
 */
import { IPC_CHANNELS } from "@shared/ipc";
import {
  AGENT_SIGNAL_CHANGED,
  CANVAS_CHANGED,
  COMPANION_DEVICES,
  FILES_REMOTE_CHANGED,
  LIVE_CHANGED,
  MAIL_WAITING,
  MACHINE_PROGRESS,
  RESOURCE_CHANGED,
  RESOURCE_THREAD_CHANGED,
  SEAT_CACHE_DUE_CHANGED,
  SEAT_THREAD_READ_CHANGED,
  SETTINGS_CHANGED,
  TERM_EVENT,
  TERM_LEASE_ENDED,
  TERM_SEAT_STATE,
  WIRE_TRAFFIC,
  WORK_PREAMBLE,
} from "../channels";
import { publish } from "../push";

/** Every channel main forwards to the window. */
export const WINDOW_CHANNELS = [
  SETTINGS_CHANGED,
  WORK_PREAMBLE,
  AGENT_SIGNAL_CHANGED,
  COMPANION_DEVICES,
  CANVAS_CHANGED,
  LIVE_CHANGED,
  SEAT_THREAD_READ_CHANGED,
  MAIL_WAITING,
  RESOURCE_CHANGED,
  RESOURCE_THREAD_CHANGED,
  WIRE_TRAFFIC,
  // The model watches publish on the window's own channel names (ipc-watch.ts).
  IPC_CHANNELS.modelChanged,
  IPC_CHANNELS.modelCanvasesChanged,
  IPC_CHANNELS.modelActorRefsChanged,
  IPC_CHANNELS.viewStateChanged,
  IPC_CHANNELS.referencesChanged,
  IPC_CHANNELS.workMailChanged,
  IPC_CHANNELS.workSinkChanged,
  IPC_CHANNELS.seatAwarenessChanged,
  IPC_CHANNELS.usageChanged,
  IPC_CHANNELS.kernelChanged,
  IPC_CHANNELS.automationsChanged,
  IPC_CHANNELS.seatOffboardProgress,
  IPC_CHANNELS.seatOnboardingChanged,
  // A change under a node opened on another machine (files-remote.ts).
  FILES_REMOTE_CHANGED,
  // A running machine command's progress, for the window whose call asked.
  MACHINE_PROGRESS,
  // The terminal plane's events, a linked view's end and a remote seat's state (term/ipc.ts).
  TERM_EVENT,
  TERM_LEASE_ENDED,
  TERM_SEAT_STATE,
  // A seat's cache window changed (ipc-seats.ts); main rereads its due seats.
  SEAT_CACHE_DUE_CHANGED,
] as const;

/**
 * Each window push the core sent on the port reaches main's subscribers on the
 * push bus, as a publish in this process would. Returns the stop.
 */
export const relayWindowPushes = (client: { readonly onPush: (channel: string, listener: (payload: unknown) => void) => () => void }): (() => void) => {
  const stops = WINDOW_CHANNELS.map((channel) => client.onPush(channel, (payload) => publish(channel, payload)));
  return () => {
    for (const stop of stops) stop();
  };
};
