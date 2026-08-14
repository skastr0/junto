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
 * - Sole product store: StateEngine → vellum-command.db. InstallOps co-composed for
 *   ContentService; install-ops.db is install-local, not product truth.
 *
 * Intentionally has no Electron shell, renderer host, browser host, update, or
 * Electron IPC. isPackaged is env / release-tree placement — never app.isPackaged.
 */
import { Effect, Layer, ManagedRuntime } from "effect";
import { ObservabilityLoggerLive } from "./vellum/observability";
import { CURRENT_STATION_PROTOCOL_SUPPORT } from "@shared/station-protocol";
import { assessSupervisedRuntime } from "@shared/station";
import { CanvasesLive } from "./vellum/canvases";
import {
  ChatServiceFromHermesLive,
  HermesPlaneLive,
} from "./vellum/hermes/plane";
import { HermesTransportLive } from "./vellum/hermes/transport";
import { HerdrPlaneLive, HerdrPlane } from "./vellum/herdr/plane";
import { HerdrTransportLive } from "./vellum/herdr/transport";
import { KernelLive } from "./vellum/kernel/service";
import { KernelStateRepositoryLive } from "./vellum/kernel/repository";
import { PausePlaneLive } from "./vellum/pause-plane";
import { FactoryPauseRepositoryLive } from "./vellum/pause/repository";
import { SchedulerRepositoryLive } from "./vellum/scheduler/repository";
import { WorkLive } from "./vellum/work/service";
import { WorkRepositoryLive } from "./vellum/work/repository";
import { makeContentServiceLive } from "./vellum/content/service";
import { InstallOpsLive } from "./vellum/install-ops/engine";
import { RegionRollupLive } from "./vellum/region-rollup";
import { makeSettingsLive } from "./vellum/settings/service";
import { SnapshotsLive } from "./vellum/snapshots";
import { UsageLive } from "./vellum/usage/live";
import { HostsServiceLive } from "./vellum/hosts";
import { HostRuntimeLive } from "./vellum/hosts/host-runtime";
import { SshTransportLive } from "./vellum/ssh";
import { StationStatusLive } from "./vellum/station-status-store";
import { StateEngineLive } from "./vellum/state/engine";
import { StationFleetTargetRepositoryLive } from "./vellum/station/fleet-target-repository";
import {
  StationRepository,
  StationRepositoryLive,
  type StationProjection,
  type StationStatusFacts,
} from "./vellum/station/repository";
import { StationApiLive } from "./vellum/station/api";
import { StationPropagationLive } from "./vellum/station/propagation";
import {
  OpenSshStationPeerRouteResolverLive,
  StationFleetPropagationLive,
} from "./vellum/station/fleet-propagation";
import { OpenSshStationPeerExchangeLive } from "./vellum/station/openssh-peer-exchange";
import { StationLivePeerRegistryLive } from "./vellum/station/session-registry";
import { CURRENT_STATE_SCHEMA_VERSION } from "./vellum/state/migrations";
import { TerminalSessions } from "./vellum/term/sessions";
import { compiledLicenseBuildConfig } from "./vellum/license/compiled-config";
import { makeDodoLicenseClient } from "./vellum/license/dodo-client";
import {
  LicenseRepository,
  LicenseRepositoryLive,
} from "./vellum/license/repository";
import {
  LicenseService,
  makeLicenseService,
} from "./vellum/license/service";
import {
  resolveCandidateRuntimeRootFromRemoteBinary,
  resolveReleaseDirectoryFromRemoteBinary,
} from "./vellum/supervision/install-user-service";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Packaged / product identity (Node-safe — never electron.app)
// ---------------------------------------------------------------------------

/**
 * True when this process is a release-tree candidate or forced via env.
 * Used for license build config and product packaging checks.
 * Staging extracts under ~/.vellum-command/runtime/staging/… count as packaged
 * candidates during remote install cutover.
 */
export const isRemotePackaged = (
  binaryPath: string = process.argv[1] ?? process.execPath,
): boolean => {
  if (process.env.VELLUM_COMMAND_PACKAGED === "1") return true;
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
 * `__VELLUM_COMMAND_APP_VERSION__`; env override is for tests only.
 */
declare const __VELLUM_COMMAND_APP_VERSION__: string | undefined;

export const remoteAppVersion = (): string => {
  if (
    typeof process.env.VELLUM_COMMAND_APP_VERSION === "string" &&
    process.env.VELLUM_COMMAND_APP_VERSION.trim().length > 0
  ) {
    return process.env.VELLUM_COMMAND_APP_VERSION.trim();
  }
  if (
    typeof __VELLUM_COMMAND_APP_VERSION__ === "string" &&
    __VELLUM_COMMAND_APP_VERSION__.trim().length > 0
  ) {
    return __VELLUM_COMMAND_APP_VERSION__.trim();
  }
  return "0.0.0";
};

// ---------------------------------------------------------------------------
// Memoized StateEngine owner — same reference for every repository plane
// ---------------------------------------------------------------------------

const StateRepositoriesLive = Layer.provideMerge(
  Layer.mergeAll(
    KernelStateRepositoryLive,
    FactoryPauseRepositoryLive,
    WorkRepositoryLive,
    UsageLive,
    makeSettingsLive({ ensureDefaultCommandCenter: false }),
    SchedulerRepositoryLive,
    StationStatusLive,
    StationRepositoryLive,
    StationFleetTargetRepositoryLive,
    LicenseRepositoryLive,
    makeContentServiceLive(),
  ),
  Layer.mergeAll(StateEngineLive, InstallOpsLive),
);

// License never opens a second StateEngine — same memoized repository graph.
const LicenseServiceFromStateLive = Layer.effect(
  LicenseService,
  Effect.gen(function* () {
    const repository = yield* LicenseRepository;
    const station = yield* StationRepository;
    const installationId = yield* station.installationId;
    const config = compiledLicenseBuildConfig(isRemotePackaged());
    const client =
      config.configured && config.channel === "production"
        ? makeDodoLicenseClient()
        : undefined;

    return makeLicenseService({
      config,
      installationId,
      repository,
      ...(client === undefined ? {} : { client }),
    });
  }),
);

const LicenseWithStateLive = Layer.provideMerge(
  LicenseServiceFromStateLive,
  StateRepositoriesLive,
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

const HostsServiceReady = Layer.provideMerge(
  HostsServiceLive,
  Layer.mergeAll(
    SshTransportLive,
    StateRepositoriesLive,
    StationFleetServicesLive,
  ),
);
const HostsWithSshLive = Layer.mergeAll(
  HostsServiceReady,
  Layer.provideMerge(HostRuntimeLive, HostsServiceReady),
);

const ProductTransportsLive = Layer.provideMerge(
  Layer.mergeAll(HerdrTransportLive, HermesTransportLive),
  HostsWithSshLive,
);

// TerminalSessions is plane.sessions — one instance, no dual path.
const TerminalSessionsLive = Layer.effect(
  TerminalSessions,
  Effect.map(HerdrPlane, (plane) => plane.sessions),
);

const HerdrWithSessionsLive = Layer.provideMerge(
  TerminalSessionsLive,
  HerdrPlaneLive,
);

export const RemoteProductPlanesLive = Layer.provideMerge(
  Layer.mergeAll(HerdrWithSessionsLive, HermesPlaneLive),
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
  LicenseWithStateLive,
);

const BaseWithPauseLive = Layer.provideMerge(PausePlaneLive, BaseLayer);

const KernelWithWorkLive = Layer.provideMerge(KernelLive, WorkLive);

const RemoteRootLayer = Layer.provideMerge(
  Layer.mergeAll(KernelWithWorkLive, RegionRollupLive),
  Layer.provideMerge(
    BaseWithPauseLive,
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
