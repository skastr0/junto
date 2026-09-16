/**
 * Node-only ManagedRuntime for a Remote station — single warm Effect entry.
 *
 * Canonical end state (docs/END_STATE-effect-foundation.md §S1 + V4-ENTRY):
 *
 *   boot  → ManagedRuntime.make(RemoteRootLayer) once  // RemoteRuntime below
 *   entry → RemoteRuntime.runPromise(handler)          // remote boot / station APIs
 *   loops → RemoteRuntime.runFork / same warm Context  // factory program (V4-PROGRAM)
 *   quit  → RemoteRuntime.dispose()                    // vellum-command-remote drainAndExit
 *
 * Same laws as Command Center AppRuntime (src/main/runtime.ts):
 * - One ManagedRuntime per process; never rebuild per call.
 * - Domain Effects enter via RemoteRuntime.runPromise / runFork — not bare
 *   Effect.runPromise (empty Context; S0 fitness gate).
 * - V4-ENTRY: src/main/vellum-remote.ts has zero bare Effect.runPromise; only
 *   RemoteRuntime for product domain work.
 * - Sole product store: StateEngine → junto.db. InstallOps co-composed for
 *   ContentService; install-ops.db is install-local, not product truth.
 *
 * Intentionally has no Electron shell, renderer host, browser host, update, or
 * Electron IPC. isPackaged is env / release-tree placement — never app.isPackaged.
 */
import { Effect, Layer, ManagedRuntime } from "effect";
import { ObservabilityLoggerLive } from "./vellum-command/observability";
import { CURRENT_STATION_PROTOCOL_SUPPORT } from "@shared/station-protocol";
import { assessSupervisedRuntime } from "@shared/station";
import { CanvasesLive } from "./vellum-command/canvases";
import {
  ChatServiceFromHermesLive,
  HermesPlaneLive,
} from "./vellum-command/hermes/plane";
import { HermesTransportLive } from "./vellum-command/hermes/transport";
import { KernelLive } from "./vellum-command/kernel/service";
import { KernelStateRepositoryLive } from "./vellum-command/kernel/repository";
import { PausePlaneLive } from "./vellum-command/pause-plane";
import { FactoryPauseRepositoryLive } from "./vellum-command/pause/repository";
import { SchedulerRepositoryLive } from "./vellum-command/scheduler/repository";
import { WorkLive } from "./vellum-command/work/service";
import { WorkRepositoryLive } from "./vellum-command/work/repository";
import { CrewRepositoryLive } from "./vellum-command/work/crew-repository";
import { makeContentServiceLive } from "./vellum-command/content/service";
import { InstallOpsLive } from "./vellum-command/install-ops/engine";
import { RegionRollupLive } from "./vellum-command/region-rollup";
import { makeSettingsLive } from "./vellum-command/settings/service";
import { SnapshotsLive } from "./vellum-command/snapshots";
import { UsageLive } from "./vellum-command/usage/live";
import { HostsServiceLive } from "./vellum-command/hosts";
import { HostRuntimeLive } from "./vellum-command/hosts/host-runtime";
import { SshTransportLive } from "./vellum-command/ssh";
import { StationStatusLive } from "./vellum-command/station-status-store";
import { StateEngineLive } from "./vellum-command/state/engine";
import { StationFleetTargetRepositoryLive } from "./vellum-command/station/fleet-target-repository";
import {
  StationRepository,
  StationRepositoryLive,
  type StationProjection,
  type StationStatusFacts,
} from "./vellum-command/station/repository";
import { StationApiLive } from "./vellum-command/station/api";
import { StationPropagationLive } from "./vellum-command/station/propagation";
import {
  OpenSshStationPeerRouteResolverLive,
  StationFleetPropagationLive,
} from "./vellum-command/station/fleet-propagation";
import { OpenSshStationPeerExchangeLive } from "./vellum-command/station/openssh-peer-exchange";
import { StationLivePeerRegistryLive } from "./vellum-command/station/session-registry";
import { CURRENT_STATE_SCHEMA_VERSION } from "./vellum-command/state/migrations";
import { ActorSeatOccupyLive } from "./vellum-command/term/actor-seat-occupy-live";
import {
  resolveCandidateRuntimeRootFromRemoteBinary,
  resolveReleaseDirectoryFromRemoteBinary,
} from "./vellum-command/supervision/install-user-service";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Packaged / product identity (Node-safe — never electron.app)
// ---------------------------------------------------------------------------

/**
 * True when this process is a release-tree candidate or forced via env.
 * Used for product packaging checks.
 * Staging extracts under ~/.junto/runtime/staging/… count as packaged
 * candidates during remote install cutover.
 */
export const isRemotePackaged = (
  binaryPath: string = process.argv[1] ?? process.execPath,
): boolean => {
  if (process.env.JUNTO_PACKAGED === "1") return true;
  const absolute = resolve(binaryPath);
  try {
    resolveReleaseDirectoryFromRemoteBinary(absolute);
    return true;
  } catch {
    // fall through to staging candidate
  }
  try {
    resolveCandidateRuntimeRootFromRemoteBinary(absolute);
    return true;
  } catch {
    return false;
  }
};

/**
 * Product version for protocol/station advertisements. Build injects
 * `__JUNTO_APP_VERSION__`; env override is for tests only.
 */
declare const __JUNTO_APP_VERSION__: string | undefined;

export const remoteAppVersion = (): string => {
  if (
    typeof process.env.JUNTO_APP_VERSION === "string" &&
    process.env.JUNTO_APP_VERSION.trim().length > 0
  ) {
    return process.env.JUNTO_APP_VERSION.trim();
  }
  if (
    typeof __JUNTO_APP_VERSION__ === "string" &&
    __JUNTO_APP_VERSION__.trim().length > 0
  ) {
    return __JUNTO_APP_VERSION__.trim();
  }
  return "0.0.0";
};

// ---------------------------------------------------------------------------
// Memoized StateEngine owner — same reference for every repository plane
// ---------------------------------------------------------------------------

// One shared settings layer reference: the usage plane's operator-credential
// reader and every other consumer get the same memoized SettingsService.
const RemoteSettingsLive = makeSettingsLive({ ensureDefaultCommandCenter: false });

const StateRepositoriesLive = Layer.provideMerge(
  Layer.mergeAll(
    KernelStateRepositoryLive,
    FactoryPauseRepositoryLive,
    WorkRepositoryLive,
    CrewRepositoryLive,
    Layer.provideMerge(UsageLive, RemoteSettingsLive),
    RemoteSettingsLive,
    SchedulerRepositoryLive,
    StationStatusLive,
    StationRepositoryLive,
    StationFleetTargetRepositoryLive,
    makeContentServiceLive(),
  ),
  Layer.mergeAll(StateEngineLive, InstallOpsLive),
);

const CanvasesWithStateLive = Layer.provideMerge(
  CanvasesLive,
  StateRepositoriesLive,
);

const StatefulServicesLive = Layer.provideMerge(
  StationApiLive,
  CanvasesWithStateLive,
);

const StationPropagationServicesLive = Layer.provideMerge(
  StationPropagationLive,
  StatefulServicesLive,
);

const OpenSshStationPeerExchangeFromStateLive = Layer.unwrap(
  Effect.gen(function* () {
    const repository = yield* StationRepository;
    const localInstallationId = yield* repository.installationId;
    return OpenSshStationPeerExchangeLive(localInstallationId, {
      appVersion: remoteAppVersion(),
      stateSchemaVersion: CURRENT_STATE_SCHEMA_VERSION,
      support: CURRENT_STATION_PROTOCOL_SUPPORT,
    });
  }),
);

const StationSessionInfrastructureLive = Layer.provideMerge(
  Layer.mergeAll(
    StationLivePeerRegistryLive,
    OpenSshStationPeerRouteResolverLive,
    OpenSshStationPeerExchangeFromStateLive,
  ),
  Layer.mergeAll(StateRepositoriesLive, SshTransportLive),
);

const StationFleetServicesLive = Layer.provideMerge(
  StationFleetPropagationLive,
  Layer.mergeAll(
    StationPropagationServicesLive,
    StationSessionInfrastructureLive,
  ),
);

// HostRuntimeLive yields HostsService at acquire — provide, don't sibling-merge.
const HostsWithSshLive = Layer.provideMerge(
  Layer.provideMerge(HostRuntimeLive, HostsServiceLive),
  Layer.mergeAll(
    SshTransportLive,
    StateRepositoriesLive,
    StationFleetServicesLive,
  ),
);

const ProductTransportsLive = Layer.provideMerge(
  HermesTransportLive,
  HostsWithSshLive,
);

export const RemoteProductPlanesLive = Layer.provideMerge(
  HermesPlaneLive,
  ProductTransportsLive,
);

// ChatServiceContext is required by RegionRollup; hermes owns the chat instance.
const ProductPlanesWithChatLive = Layer.provideMerge(
  ChatServiceFromHermesLive,
  RemoteProductPlanesLive,
);

const SnapshotsWithProductsLive = Layer.provideMerge(
  SnapshotsLive,
  ProductPlanesWithChatLive,
);

const BaseLayer = Layer.mergeAll(
  SnapshotsWithProductsLive,
  HostsWithSshLive,
  StationFleetServicesLive,
);

const BaseWithPauseLive = Layer.provideMerge(PausePlaneLive, BaseLayer);

// Base owns StationRepository; provide it into the per-call actor WHEN while
// retaining ActorSeatOccupy as a root service for KernelLive and other ingress.
const BaseWithActorSeatOccupyLive = Layer.provideMerge(
  ActorSeatOccupyLive,
  BaseWithPauseLive,
);

const KernelWithWorkLive = Layer.provideMerge(KernelLive, WorkLive);

const RemoteRootLayer = Layer.provideMerge(
  Layer.mergeAll(KernelWithWorkLive, RegionRollupLive),
  Layer.provideMerge(
    BaseWithActorSeatOccupyLive,
    Layer.mergeAll(ProductPlanesWithChatLive, CanvasesWithStateLive),
  ),
);

// RemoteRuntime is the sole warm ManagedRuntime for the displayless Remote
// process. Constructed once at module load; never remake. Callers: vellum-command-remote
// boot, station/work control bridges, product planes. Dispose exactly once on
// SIGTERM/SIGINT via RemoteRuntime.dispose() in drainAndExit.
const RemoteAppLayer = Layer.mergeAll(RemoteRootLayer, ObservabilityLoggerLive);
export const RemoteRuntime = ManagedRuntime.make(
  RemoteAppLayer as Layer.Layer<
    Layer.Success<typeof RemoteAppLayer>,
    Layer.Error<typeof RemoteAppLayer>,
    never
  >,
);

// ---------------------------------------------------------------------------
// Pure readiness helpers (Node-safe reimplementation — no electron import)
// ---------------------------------------------------------------------------

export const supervisorAlignedForReadiness = (
  input: Parameters<typeof assessSupervisedRuntime>[0],
): boolean => assessSupervisedRuntime(input).aligned;

export const stationProjectionInstalledForReadiness = (
  facts: StationStatusFacts,
  projection: StationProjection | undefined,
): boolean => {
  if (facts.configuration === undefined) return false;
  if (facts.configuration.role === "command-center") return true;
  return (
    facts.projection !== undefined &&
    projection !== undefined &&
    projection.scope === "full" &&
    projection.generation === facts.projection.generation &&
    projection.contentSha256 === facts.projection.contentSha256 &&
    projection.receivedAt === facts.projection.receivedAt
  );
};
