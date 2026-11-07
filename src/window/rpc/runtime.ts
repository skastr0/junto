/**
 * The window's one Effect runtime: its clients of main's window groups on the
 * page's link, and the window services built on them. Built once at window
 * boot (main.tsx) and handed to React through `WindowRuntimeContext`; tests
 * build one on a `MessageChannel`.
 *
 * Building it is synchronous: the link holds requests until its port
 * arrives, so a component reads a service on its first render.
 */
import { createContext, useContext, useMemo } from "react";
import { type Context, Effect, Fiber, Layer, ManagedRuntime, Stream } from "effect";
import type { RpcPort } from "@shared/rpc-port";
import { CompanionWindow } from "../../contract/window/companion";
import { ContentWindow } from "../../contract/window/content";
import { GitWindow } from "../../contract/window/git";
import { WindowLink } from "../../contract/window/link";
import { DemoWindow } from "../../contract/window/demo";
import { NotificationsWindow } from "../../contract/window/notifications";
import { ObservabilityWindow } from "../../contract/window/observability";
import { ReferencesWindow } from "../../contract/window/references";
import { SeatCacheDueWindow } from "../../contract/window/seat-cache-due";
import { ShellEnvironmentWindow } from "../../contract/window/shell-environment";
import { SignalsWindow } from "../../contract/window/signals";
import { AgentSignalsSync } from "../lib/agent-signals-sync";
import { UpdateWindow } from "../../contract/window/update";
import { SeatCacheDueState } from "../lib/seat-cache-due-state";
import { UpdateState } from "../lib/update-state";

export const WindowClientsLive = Layer.mergeAll(UpdateWindow.layer, ReferencesWindow.layer, SeatCacheDueWindow.layer, ShellEnvironmentWindow.layer, ObservabilityWindow.layer, GitWindow.layer, CompanionWindow.layer, SignalsWindow.layer, ContentWindow.layer, NotificationsWindow.layer, DemoWindow.layer);

export const WindowServicesLive = Layer.mergeAll(UpdateState.layer, SeatCacheDueState.layer, AgentSignalsSync.layer).pipe(Layer.provideMerge(WindowClientsLive));

export type WindowServices = Layer.Success<typeof WindowServicesLive>;

/** `tracing` is the window's tracing (tracing.ts), empty unless main traces. */
export const makeWindowRuntime = (link: RpcPort, tracing: Layer.Layer<never> = Layer.empty) =>
  ManagedRuntime.make(Layer.mergeAll(WindowServicesLive.pipe(Layer.provide(Layer.succeed(WindowLink, link))), tracing));

export type WindowRuntime = ManagedRuntime.ManagedRuntime<WindowServices, never>;

export const WindowRuntimeContext = createContext<WindowRuntime | undefined>(undefined);

/** The window's runtime, from the nearest provider: boot puts one above the app. */
export const useWindowRuntime = (): WindowRuntime => {
  const runtime = useContext(WindowRuntimeContext);
  if (runtime === undefined) throw new Error("no window runtime: mount under WindowRuntimeContext");
  return runtime;
};

/** One of the window's services, read from its runtime once per runtime. */
export const useWindowService = <I extends WindowServices, S>(service: Context.Key<I, S>): S => {
  const runtime = useWindowRuntime();
  return useMemo(() => runtime.runSync(service), [runtime, service]);
};

/**
 * Follow a stream on the window's runtime, handing each element to `onItem`;
 * `onEnd` hears a failure, or the link going. Returns the stop, for an
 * effect's cleanup.
 */
export const follow = <A, E>(
  runtime: WindowRuntime,
  stream: Stream.Stream<A, E, WindowServices>,
  onItem: (item: A) => void,
  onEnd?: () => void,
): (() => void) => {
  const following = runtime.runFork(
    stream.pipe(
      Stream.runForEach((item) => Effect.sync(() => onItem(item))),
      Effect.catchCause(() => Effect.sync(() => onEnd?.())),
    ),
  );
  return () => {
    runtime.runFork(Fiber.interrupt(following));
  };
};
