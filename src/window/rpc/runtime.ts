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
import { type Context, Layer, ManagedRuntime } from "effect";
import type { RpcPort } from "@shared/rpc-port";
import { WindowLink } from "../../contract/window/link";
import { UpdateWindow } from "../../contract/window/update";
import { UpdateState } from "../lib/update-state";

export const WindowClientsLive = Layer.mergeAll(UpdateWindow.layer);

export const WindowServicesLive = Layer.mergeAll(UpdateState.layer).pipe(Layer.provideMerge(WindowClientsLive));

export type WindowServices = Layer.Success<typeof WindowServicesLive>;

export const makeWindowRuntime = (link: RpcPort) =>
  ManagedRuntime.make(WindowServicesLive.pipe(Layer.provide(Layer.succeed(WindowLink, link))));

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
