/**
 * The Junto core in its own Electron utilityProcess (Wave 3, protect the main
 * thread). It boots the same graph the machine core boots (`startCore`), so
 * the business writer, the sockets, the link, the kernel and the mail all run
 * here and none on Electron main. It serves its RPC groups to main over the
 * parent port, asks main's host groups on the same port, and sends every
 * published change back on it, in order.
 *
 * Main passes what only Electron's `app` knows as one JSON argument
 * (`CoreBoot`), because this process has no `app`.
 */
import { getCompiledMachineReleaseCatalog } from "@shared/machine-release";
import { makeMachineBundleSources } from "./hosts/machine-bundle-download";
import { startCore } from "./core";
import { enforceBootRefusal } from "../node/boot-guard";
import { type CoreMessage, type CorePort } from "../contract/core/port";
import { Effect, Layer } from "effect";
import { heldForServer } from "@shared/rpc-port";
import { CoreLink } from "../contract/core/link";
import { CoreServerLive } from "./link";
import { HostLink } from "../contract/host/link";
import { HostClientsLive } from "./host-clients";
import { serveCore } from "./serve";
import { CoreStartup } from "./ops/ipc-startup";
import { closeCoreProcess, stopCoreOnSignal } from "./core-stop";
import { CorePushes } from "./push";
import { hostOverseer, OverseerPageFlights } from "./ops/overseer-pages";
import { AGENT_SIGNAL_CHANGED, COMPANION_DEVICES } from "../contract/core/channels";
import { publishWindowBroadcasts } from "./ops/main-index";
import { companionE2eEnvironment, readCompanionEnvironment } from "./companion/service";
import { RunningLiveOverseer } from "./ops/overseer-live";
import { CoreSeatSessions } from "./ops/ipc-seats";
import { openCoreSurface, type SurfaceOpenMessage } from "./ops/term-surface";
import { LIVE_OVERSEER_ENABLED } from "@shared/features";
import { armMainThreadBudget } from "../node/observability/main-thread-budget";
import { startSqlTimingLog } from "./observability/sql-timing-log";
import { createLogger } from "../node/observability/logger";
import { registeredSecretValues } from "./credentials/known-secrets";
import { observabilityRing } from "./observability/ring";
import type { TerminalPortMain } from "./terminals/over-ports";

export type CoreBoot = {
  readonly home: string;
  readonly build: string;
  /** Where the packaged machine bundles sit, when no release catalog is compiled in. */
  readonly bundlesRoot: string;
  /** Junto was launched for operator control: the socket listens from boot and takes every command. */
  readonly operatorCommands: boolean;
  /** What the phone companion reads of the app: its version, and where the junto command ships. */
  readonly app: { readonly version: string; readonly packaged: boolean; readonly resourcesPath: string; readonly appPath: string };
};

type ParentPort = {
  readonly postMessage: (message: unknown) => void;
  readonly on: (event: "message", listener: (event: { readonly data: unknown; readonly ports?: ReadonlyArray<TerminalPortMain & { readonly close: () => void }> }) => void) => void;
  readonly off: (event: "message", listener: (event: { readonly data: unknown }) => void) => void;
};

const parentPortOf = (): ParentPort | undefined => (process as unknown as { parentPort?: ParentPort }).parentPort;

export const parentCorePort = (parent: ParentPort): CorePort => ({
  post: (message) => parent.postMessage(message),
  listen: (handler) => {
    const on = (event: { readonly data: unknown }) => handler(event.data as CoreMessage);
    parent.on("message", on);
    return () => parent.off("message", on);
  },
});

const main = async (parent: ParentPort): Promise<void> => {
  const boot = JSON.parse(process.argv.at(-1) ?? "{}") as CoreBoot;
  // A process entry refuses before it opens anything: a launch that inherited
  // a seat's identity, or an E2E launch pointed at the operator's real home,
  // never reaches the database, a log or a socket (src/shared/e2e-sandbox.ts).
  // startCore stays a library function; its callers in tests are not entries.
  enforceBootRefusal({ juntoHome: boot.home });
  // Every row this process writes lands in its ring, the one the panel reads,
  // and is scrubbed with the secrets this core holds.
  const log = createLogger({
    process: "core",
    echo: true,
    sink: (row) => observabilityRing.append(row),
    knownSecrets: registeredSecretValues,
  });
  // The core's own pid, first in its log: whoever runs it (main, a test, the
  // operator reading the log) learns which process is the core from here.
  console.info(`[core] pid ${String(process.pid)}`);
  // The 4ms assertion on the core's own thread, where SQLite and the kernel
  // run: armed in a dev run, silent when packaged unless JUNTO_BUDGET says
  // otherwise. Armed, the top statements by time land in
  // ~/.junto/logs/sql-timing.json every minute and on exit.
  armMainThreadBudget({ enabled: !boot.app.packaged });
  startSqlTimingLog({ home: boot.home });
  // The port opens before the core boots: what boots may already publish.
  const served = serveCore(parentCorePort(parent));
  // The core's RPC groups ride the same port; a request that comes before
  // the server listens waits for it.
  const link = heldForServer(parentCorePort(parent));
  const pushes = CorePushes.over(served.push);
  // A view's surface port, beside its message: the core's plane hands it on to the terminal process.
  parent.on("message", (event) => {
    const message = event.data as { readonly kind?: unknown } | undefined;
    const port = event.ports?.[0];
    if (message?.kind === "surfaceOpen" && port !== undefined) openCoreSurface(message as SurfaceOpenMessage, port, served.push);
  });
  const broadcasts = publishWindowBroadcasts(pushes);
  // This core's overseer page calls: the host pages give each its id, and the recheck handler reads them back.
  const pageFlights = OverseerPageFlights.make();
  const core = await startCore({
    home: boot.home,
    build: boot.build,
    log,
    // What the core asks of Electron rides the same port, answered by main's host server.
    host: Layer.merge(
      HostClientsLive.pipe(Layer.provide(Layer.succeed(HostLink, parentCorePort(parent)))),
      Layer.succeed(CorePushes, pushes),
    ),
    canvasControl: true,
    windowTerminals: { parent },
    overseer: hostOverseer(pageFlights),
    onPreamble: broadcasts.onPreamble,
    overseerLive: LIVE_OVERSEER_ENABLED,
    operator: { listen: boot.operatorCommands ? "always" : "on-demand", commands: boot.operatorCommands },
    companion: {
      appVersion: boot.app.version,
      environment: () =>
        companionE2eEnvironment() ??
        readCompanionEnvironment({ packaged: boot.app.packaged, resourcesPath: boot.app.resourcesPath, repoRoot: boot.app.appPath }),
      onDevicesChanged: (devices) => Effect.runSync(pushes.publish(COMPANION_DEVICES, devices)),
      showSignal: (signal) => Effect.runSync(pushes.publish(AGENT_SIGNAL_CHANGED, signal)),
    },
    ...makeMachineBundleSources({
      home: boot.home,
      build: boot.build,
      catalog: getCompiledMachineReleaseCatalog(),
      localRoot: () => boot.bundlesRoot,
      machine: () => log.machine(),
    }),
  });
  // The core's one server on its link to main (link.ts), in the runtime's
  // scope: it answers with the runtime's services and closes with it.
  await core.runtime.runPromise(
    Layer.buildWithScope(
      CoreServerLive.pipe(
        Layer.provide([
          Layer.succeed(CoreLink, link),
          Layer.succeed(OverseerPageFlights, pageFlights),
          RunningLiveOverseer.layerOf(core.overseerLive),
          Layer.succeed(CoreSeatSessions, core.seatSessions),
        ]),
      ),
      core.runtime.scope,
    ),
  );
  // The core's share of the window startup wiring is a Layer of the runtime's
  // scope, built where the core services live; a failure is logged and the
  // core still serves.
  await core.runtime
    .runPromise(Layer.buildWithScope(CoreStartup, core.runtime.scope))
    .catch((cause: unknown) => console.error("[core] startup wiring failed:", cause instanceof Error ? cause.message : cause));
  served.push("core.ready", {});
  const stop = (): void => {
    // Main stops the core; a host call still out fails when its link says main is gone.
    stopCoreOnSignal(() => closeCoreProcess(() => core.close()));
  };
  process.once("SIGTERM", stop);
};

const parent = parentPortOf();
if (parent !== undefined) {
  void main(parent).catch((cause: unknown) => {
    console.error("[core] Junto core failed to start in its process", cause);
    process.exit(1);
  });
}
