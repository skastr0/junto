import { Context, Effect, Exit, Layer, Scope } from "effect";
import { CoreLink } from "../../contract/core/link";
import { TermCore } from "../../contract/core/term-ipc";
import { HostLink } from "../../contract/host/link";
import { AppRuntime } from "../runtime";
import { CoreClientsLive, type CoreClients, type CoreGroupClients } from "./clients";
import { HostServerLive } from "./host-server";
import { SystemClipboard, type SystemClipboardShape } from "./main-side/clipboard";
import { FilesShell, type FilesShellShape } from "./main-side/files";
import { workControlDir } from "@shared/work-control";
import { TERMINAL_CONNECT } from "../../contract/terminal/protocol";
import { TerminalGrant, type TerminalProcessForCore } from "../terminals/host";
import type { ApplicationCaptureResult } from "../../core/overseer/native";
import type { OverseerPages } from "../../node/overseer/pages";
import type { CoreBoot } from "../../core/entry";
import { IPC_CHANNELS } from "@shared/ipc";
import { askEveryCoreAsk } from "./every-core";
import { startCoreProcess, type CoreDidNotStop } from "./host";
import { assertWorkControlSocketPathFits } from "../../node/work/socket-path";
import { bridgeModuleBus, CorePushesMain, makeCorePushesMain } from "./main-side/core-pushes";
import { relayWindowPushes } from "./main-side/window-pushes";
import { overseerHostServices } from "./main-side/overseer-pages";
import { coreSurfacePlane, type PortedCoreMessage, type SurfacePlane, type SurfacePlanes } from "./main-side/term-surface";
import type { PortPushes } from "../../contract/core/port";
import type { RpcPort } from "@shared/rpc-port";

/**
 * Every hookup main makes to a core in its own process, in one place (Wave 3):
 * start the process, carry its window pushes onto main's bus, serve what it
 * asks of Electron, and build main's clients of its groups. Each boot piece that moves
 * into the core adds its main-side half here, so turning the core process on
 * is this one call.
 */
export type CoreProcessForMain = {
  /** The core's pushes, by channel. */
  readonly client: PortPushes;
  /** The link the core's RPC groups ride. */
  readonly link: RpcPort;
  /**
   * Main's clients of the core's groups (core-process/clients.ts), once main's
   * host server answers the core (core-process/host-server.ts). Both are built
   * once, on links that outlive a core restart, and live as long as main's runtime.
   */
  readonly clients: Promise<Context.Context<CoreClients>>;
  /** Where this boot's surface ports go: the core's plane while it is up, none after it stops. */
  readonly surfacePlanes: SurfacePlanes;
  /** Close the core: signal it, wait for its drain and exit bounded, fail tagged when it hangs. */
  readonly stop: () => Effect.Effect<void, CoreDidNotStop>;
};

export const startCoreProcessForMain = (input: {
  readonly boot: CoreBoot;
  /** The browser the overseer drives, once the browser composition bound it. */
  readonly pages: () => OverseerPages | undefined;
  readonly captureApplicationPage: () => Promise<ApplicationCaptureResult>;
  /** The system clipboard the core's clipboard group is answered with. */
  readonly clipboard: SystemClipboardShape;
  /** Electron's shell, which the core's Files service asks to trash, open and reveal. */
  readonly shell: FilesShellShape;
  /** Tests start a core over a MessageChannel instead of a utilityProcess; its stop may be synchronous. */
  readonly start?: (boot: CoreBoot) => PortPushes & { readonly stop: () => Effect.Effect<void, CoreDidNotStop>; readonly postSurface?: (message: PortedCoreMessage, port: unknown) => boolean; readonly link: RpcPort; readonly hostLink: RpcPort };
  /** The terminal process the core's plane drives: main hands the core each port to it. */
  readonly terminals?: TerminalProcessForCore;
}): CoreProcessForMain => {
  // The core's work socket is <home>/.junto/work/control.sock. Refuse a path
  // that cannot bind before the fork: otherwise the core exits before ready,
  // restarts, and the app only reaches the generic core-unavailable dialog
  // without naming the path or the limit.
  assertWorkControlSocketPathFits(workControlDir(input.boot.home));
  const started = (input.start ?? startCoreProcess)(input.boot);
  // Main's bus of the core's pushes, for this boot: the relay and core.ready
  // feed it, every registrar reads it from the clients context, and closing
  // its scope at stop ends every listener on it.
  const busScope = Scope.makeUnsafe();
  const { pushes, deliver } = Effect.runSync(Scope.provide(makeCorePushesMain, busScope));
  const stopModuleBus = bridgeModuleBus(pushes);
  // The core asks for its port to the terminal process as it boots, and is
  // handed a new one each time the terminal process starts again.
  const postSurface = started.postSurface;
  const terminals = input.terminals;
  const giveTerminals = (): boolean =>
    terminals !== undefined && postSurface !== undefined &&
    postSurface({ kind: "push", channel: TERMINAL_CONNECT, payload: {} }, terminals.connect());
  // What the core asks of Electron, and main's clients of what main asks the core.
  const hosts = Layer.mergeAll(
    Layer.succeed(SystemClipboard, input.clipboard),
    Layer.succeed(FilesShell, input.shell),
    Layer.succeed(TerminalGrant, { give: giveTerminals }),
    overseerHostServices({
      pages: input.pages,
      captureApplicationPage: input.captureApplicationPage,
      coreLink: started.link,
      run: (effect) => AppRuntime.runPromise(effect),
    }),
  );
  const clients = Promise.all([
    serveHost(started.hostLink, hosts),
    buildCoreClients(started.link),
  ]).then(([, built]): Context.Context<CoreClients> => Context.add(built, CorePushesMain, pushes));
  // Each core that says ready is asked what main asks of every core; after the
  // first, the windows then read again what changed while no core ran.
  let readies = 0;
  const stopReady = started.onPush("core.ready", () => {
    const restarted = readies > 0;
    readies += 1;
    askEveryCoreAsk(() => {
      if (restarted) deliver(IPC_CHANNELS.coreRestarted, {});
    });
  });
  const stopRelay = relayWindowPushes(started, deliver);
  // The terminal plane is the core's: each view's surface port rides to it.
  // One accessor per main boot, answering for the core that is up.
  let surfacePlane: SurfacePlane | undefined;
  if (postSurface !== undefined) {
    surfacePlane = coreSurfacePlane({ postSurface, onPush: started.onPush, closeSurface: (lease) => clients.then((core) => AppRuntime.runPromise(Context.get(core, TermCore).TermSurfaceClose({ lease }))) });
  }
  const surfacePlanes: SurfacePlanes = { current: () => surfacePlane };
  const stopRestart = terminals?.onRestart(() => void giveTerminals()) ?? (() => undefined);
  return {
    client: started,
    link: started.link,
    clients,
    surfacePlanes,
    stop: () =>
      // The core drains before it exits, and its drain can still ask main for a
      // page or a terminal port, so every host stays served until the core is
      // gone; main's host server serves the host groups for main's whole life. A stop that fails or is
      // interrupted still unregisters them, and the failure is not swallowed.
      started.stop().pipe(
        Effect.ensuring(
          Effect.sync(() => {
            stopReady();
            stopRestart();
            surfacePlane = undefined;
            stopRelay();
            stopModuleBus();
          }),
        ),
        Effect.ensuring(Scope.close(busScope, Exit.void)),
      ),
  };
};

/** Main's clients of the core's groups on the link to the core process, for main's whole life. */
export const buildCoreClients = (link: RpcPort): Promise<Context.Context<CoreGroupClients>> =>
  AppRuntime.runPromise(
    Layer.buildWithScope(CoreClientsLive.pipe(Layer.provide(Layer.succeed(CoreLink, link))), AppRuntime.scope),
  );

/**
 * What main's host server needs besides its link: what only Electron has, a
 * service for each host group's handlers. A group added to HostRpcs with a
 * handler that needs a new service fails startCoreProcessForMain's compile
 * until it is given here.
 */
export type MainHosts = Exclude<Layer.Services<typeof HostServerLive>, HostLink>;

/**
 * Main's one server of the host groups, on the host link of the core process
 * it hosts. A core request that comes first waits on the link; the server
 * lives as long as main's runtime.
 */
export const serveHost = (hostLink: RpcPort, hosts: Layer.Layer<MainHosts>): Promise<void> =>
  AppRuntime.runPromise(
    Layer.buildWithScope(HostServerLive.pipe(Layer.provide([Layer.succeed(HostLink, hostLink), hosts])), AppRuntime.scope),
  ).then(() => undefined);
