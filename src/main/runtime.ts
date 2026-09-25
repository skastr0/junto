/**
 * Command Center product ManagedRuntime — single warm Effect entry for Electron main.
 *
 * Canonical end state (docs/END_STATE-effect-foundation.md §S1 + V4-ENTRY):
 *
 *   boot  → ManagedRuntime.make(RootLayer) once   // AppRuntime below
 *   IPC   → AppRuntime.runPromise(handler)        // adapters only (src/main/ipc.ts, junto/ipc.ts)
 *   loops → AppRuntime.runFork / same Context     // factory program (V4-PROGRAM)
 *   quit  → AppRuntime.dispose()                  // sole teardown; index.ts owns the call
 *
 * Laws:
 * - One ManagedRuntime per process role (CC = AppRuntime; Remote = RemoteRuntime).
 * - Never rebuild RootLayer or make() per IPC/handler call.
 * - Domain Effects enter via AppRuntime.runPromise / runFork — bare Effect.runPromise
 *   is empty Context (S0 fitness gate; permanent allowlist is host/post-dispose only).
 * - V4-ENTRY: src/main/index.ts, src/main/ipc.ts, src/main/junto/ipc.ts carry zero
 *   bare Effect.runPromise; only AppRuntime for product domain work.
 * - Sole product store: StateEngine → junto.db. InstallOps (install-ops.db) is
 *   install-local bookkeeping co-composed here so ContentService sees both; it is
 *   never a second product truth store.
 *
 * Remote stations use src/main/remote-runtime.ts (Node-only, no Electron shell).
 */
import { existsSync } from "node:fs";
import { app } from "electron";
import { Effect, Layer, ManagedRuntime } from "effect";
import { ObservabilityLoggerLive } from "./junto/observability";
import productMetadata from "../../package.json";
import type { DoctorReport, ServiceCheck } from "@shared/contracts";
import { linuxDesktopInstallStorageDoctor } from "./junto/update/linux-install";
import { assessSupervisedRuntime } from "@shared/station";
import { CURRENT_STATION_PROTOCOL_SUPPORT } from "@shared/station-protocol";
import {
  assessStationDoctor,
  kernelRecordFromSnapshot,
} from "@shared/station-status";
import { termControlSocketPath } from "@shared/term-control";
import { CodexLive, CodexService } from "./services/codex";
import { AppInfoLive, AppInfoService } from "./services/app-info";
import { CanvasesLive, CanvasesService } from "./junto/canvases";
import { ChatServiceFromHermesLive, HermesPlaneLive } from "./junto/hermes/plane";
import { HermesTransportLive } from "./junto/hermes/transport";
import { ActorSeatOccupyLive } from "./junto/term/actor-seat-occupy-live";
import { termPlane } from "./junto/term/plane";
import {
  assessNativeTerminalDoctor,
  probeNativeTerminalReadiness,
} from "./junto/term/native-readiness";
import { KernelLive, KernelService } from "./junto/kernel/service";
import { KernelStateRepositoryLive } from "./junto/kernel/repository";
import { PausePlaneLaunchPlayingLive } from "./junto/pause-plane";
import { FactoryPauseRepositoryLive } from "./junto/pause/repository";
import { AgentSignalRepositoryLive } from "./junto/signals/repository";
import { SchedulerRepositoryLive } from "./junto/scheduler/repository";
import { SquadRepositoryLive } from "./junto/squads/repository";
import { WorkLive } from "./junto/work/service";
import { WorkRepositoryLive } from "./junto/work/repository";
import { CrewRepositoryLive } from "./junto/work/crew-repository";
import { makeContentServiceLive } from "./junto/content/service";
import { InstallOpsLive } from "./junto/install-ops/engine";
import { RegionRollupLive, RegionRollupService } from "./junto/region-rollup";
import { SettingsLive, SettingsService } from "./junto/settings/service";
import { probeSupervisedRuntime } from "./junto/settings/supervised-probe";
import { SnapshotsLive, SnapshotsService } from "./junto/snapshots";
import { UsageLive } from "./junto/usage/live";
import { UsageService } from "./junto/usage/usage-service";
import { HostsService, HostsServiceLive } from "./junto/hosts";
import { HostRuntimeLive } from "./junto/hosts/host-runtime";
import { composeMainFleetCompatibilitySnapshot } from "./junto/hosts/fleet-compatibility";
import { SshTransportLive } from "./junto/ssh";
import {
  BoxCliLive,
  BoxFleetServiceLive,
  BoxActivityPolicyLive,
  BoxOwnershipRepositoryLive,
  BoxProcessRunnerLive,
} from "./junto/box";
import { primeHostsSnapshot } from "./junto/hosts/snapshot";
import {
  StationStatusLive,
  StationStatusService,
} from "./junto/station-status-store";
import {
  createStationReadinessCoordinator,
  stationReadinessMetadata,
} from "./junto/station-readiness";
import { stationControlReadiness } from "./junto/station/control-server";
import { workControlReadiness } from "./junto/work/control";
import { StateEngineLive } from "./junto/state/engine";
import { CURRENT_STATE_SCHEMA_VERSION } from "./junto/state/migrations";
import {
  StationFleetTargetRepositoryLive,
} from "./junto/station/fleet-target-repository";
import {
  StationRepository,
  StationRepositoryLive,
  type StationProjection,
  type StationStatusFacts,
} from "./junto/station/repository";
import { StationApiLive } from "./junto/station/api";
import { StationPropagationLive } from "./junto/station/propagation";
import {
  OpenSshStationPeerRouteResolverLive,
  StationFleetPropagationLive,
} from "./junto/station/fleet-propagation";
import {
  OpenSshStationPeerExchangeLive,
} from "./junto/station/openssh-peer-exchange";
import {
  StationLivePeerRegistryLive,
} from "./junto/station/session-registry";
import { CanvasEntityRepositoryLive } from "./junto/entities/repository";
import {
  deferredUpdateHostHooks,
  installUpdateProviderHandle,
  macArm64UpdateFeed,
  linuxX64UpdateFeed,
  makePlatformUpdateProvider,
  makeUpdateServiceLayer,
} from "./junto/update";

// Keep this exact layer value as the sole database owner in the runtime graph.
// Effect memoizes layers by reference, so every repository below receives the
// same scoped StateEngine connection even when the composed layers are reused
// by more than one product plane.
// Product StateEngine + install-ops (backfill ledger) are co-owned at this
// boundary. ContentService needs both; install-ops.db is never product state.
const StateRepositoriesLive = Layer.provideMerge(
  Layer.mergeAll(
    KernelStateRepositoryLive,
    FactoryPauseRepositoryLive,
    AgentSignalRepositoryLive,
    WorkRepositoryLive,
    CrewRepositoryLive,
    SquadRepositoryLive,
    // The usage plane reads operator provider credentials from settings, so
    // the memoized SettingsService instance feeds it here (same reference).
    Layer.provideMerge(UsageLive, SettingsLive),
    SettingsLive,
    SchedulerRepositoryLive,
    StationStatusLive,
    StationRepositoryLive,
    StationFleetTargetRepositoryLive,
    BoxOwnershipRepositoryLive,
    CanvasEntityRepositoryLive,
    makeContentServiceLive(),
  ),
  Layer.mergeAll(StateEngineLive, InstallOpsLive),
);

// Canvases projects durable work rows on reads while keeping its authority
// snapshot authorial-only, so it consumes the already memoized repository
// graph rather than constructing another engine or work repository.
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
      appVersion: productMetadata.version,
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

const BoxCliWithProcessLive = Layer.provideMerge(
  BoxCliLive,
  BoxProcessRunnerLive,
);

const BoxFleetLive = Layer.provideMerge(
  BoxFleetServiceLive,
  Layer.mergeAll(
    BoxCliWithProcessLive,
    StateRepositoriesLive,
    HostsWithSshLive,
  ),
);

const BoxActivityPolicyWithFleetLive = Layer.provideMerge(
  BoxActivityPolicyLive,
  Layer.mergeAll(
    BoxFleetLive,
    CanvasesWithStateLive,
    StateRepositoriesLive,
  ),
);

// HostsServiceLive loads the durable registry while acquiring HostsWithSshLive.
// Making that complete input feed the host-aware transports is the boot-order
// barrier: no Hermes plane can construct before synchronous routing has
// the persisted host inventory.
const ProductTransportsLive = Layer.provideMerge(
  HermesTransportLive,
  HostsWithSshLive,
);

export const ProductPlanesLive = Layer.provideMerge(
  HermesPlaneLive,
  ProductTransportsLive,
);

const ProductPlanesWithChatLive = Layer.provideMerge(
  ChatServiceFromHermesLive,
  ProductPlanesLive,
);

const SnapshotsWithProductsLive = Layer.provideMerge(
  SnapshotsLive,
  ProductPlanesWithChatLive,
);

// UpdateService joins this ManagedRuntime — never a second runtime.
// Host quiesce/relaunch hooks are late-bound from main/index after boot.
const UpdateServiceLive = Layer.unwrap(
  Effect.sync(() => {
    const provider = makePlatformUpdateProvider({
      platform: process.platform,
      isPackaged: app.isPackaged,
      currentVersion: app.getVersion() || productMetadata.version,
    });
    installUpdateProviderHandle(provider);
    const packaged = app.isPackaged;
    return makeUpdateServiceLayer({
      currentVersion: app.getVersion() || productMetadata.version,
      provider,
      host: deferredUpdateHostHooks(),
      install: {
        packaged,
        platform: process.platform,
        arch: process.arch,
        electronVersion: process.versions.electron ?? "unknown",
        providerKind: provider.kind,
        ...(packaged && provider.kind === "mac"
          ? { feedUrl: macArm64UpdateFeed().url }
          : packaged && provider.kind === "linux"
            ? { feedUrl: linuxX64UpdateFeed().url }
            : {}),
      },
    });
  }),
);

const BaseLayer = Layer.mergeAll(
  AppInfoLive,
  CodexLive,
  SnapshotsWithProductsLive,
  HostsWithSshLive,
  StationFleetServicesLive,
  BoxActivityPolicyWithFleetLive,
  UpdateServiceLive,
);

// Pause plane sits between the base services and the acting planes so the
// kernel, work control, and IPC all share ONE born-paused switch instance.
// Every canvas played before comes back playing (pause-plane.ts LAUNCH).
const BaseWithPauseLive = Layer.provideMerge(PausePlaneLaunchPlayingLive, BaseLayer);

// Base owns StationRepository; provide it into the per-call actor WHEN while
// retaining ActorSeatOccupy as a root service for KernelLive and other ingress.
const BaseWithActorSeatOccupyLive = Layer.provideMerge(
  ActorSeatOccupyLive,
  BaseWithPauseLive,
);

const KernelWithWorkLive = Layer.provideMerge(KernelLive, WorkLive);

export const RootLayer = Layer.provideMerge(
  Layer.mergeAll(KernelWithWorkLive, RegionRollupLive),
  BaseWithActorSeatOccupyLive,
);

// Observability logger is an additional Effect sink (ring buffer) — does not
// replace the default pretty console logger.
//
// AppRuntime is the sole warm ManagedRuntime for Command Center main.
// Constructed once at module load; never remake. Callers: Electron IPC adapters
// (AppRuntime.runPromise), boot wiring in index.ts, and process loops that share
// the same Context. Dispose exactly once on quit via AppRuntime.dispose()
// (index.ts disposeRuntime / disposeRuntimeFailClosed).
const AppLayer = Layer.mergeAll(RootLayer, ObservabilityLoggerLive);
export const AppRuntime = ManagedRuntime.make(
  AppLayer as Layer.Layer<
    Layer.Success<typeof AppLayer>,
    Layer.Error<typeof AppLayer>,
    never
  >,
);

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

export interface CurrentStationReadinessOptions {
  /** Tests and callers with a current supervisor observation may supply it. */
  readonly supervisorAligned?: boolean;
  readonly station?: Readonly<{
    facts: StationStatusFacts;
    projection?: StationProjection;
  }>;
}

/** Deep product-path assessment for Doctor; it never gates station boot. */
export const assessCurrentStationReadiness = (
  options: CurrentStationReadinessOptions = {},
) =>
  Effect.gen(function* () {
    const appInfo = yield* AppInfoService;
    const repository = yield* StationRepository;
    const kernel = yield* KernelService;
    const stationInfo = yield* appInfo.stationInfo;
    const station = options.station ??
      (yield* Effect.all({
        facts: repository.statusFacts,
        projection: repository.projection,
      }));
    const configuration = station.facts.configuration;
    const supervisorAligned = options.supervisorAligned ??
      supervisorAlignedForReadiness({
        role: configuration?.role ?? "",
        hostId: configuration?.hostId ?? "unconfigured",
        supervisedPreferred: configuration?.supervisedPreferred ?? false,
        supervisedInstalled: yield* Effect.promise(() => probeSupervisedRuntime()),
      });
    // Region Pulse arming fault retired; kernel snapshot is always simulation-ready.
    const simulationReady = true;
    return yield* Effect.promise(() =>
      createStationReadinessCoordinator().assess({
        version: stationInfo.version,
        ...(configuration === undefined ? {} : { configuration }),
        packageIdentity: stationInfo.name,
        supervisorAligned,
        projectionInstalled: stationProjectionInstalledForReadiness(
          station.facts,
          station.projection,
        ),
        databaseReady: true,
        workControlReady: workControlReadiness.ready(),
        simulationReady,
      }),
    );
  });

export const buildDoctorReport = Effect.gen(function* () {
  // Ensure registry snapshot is current before host-aware doctor / transports.
  yield* Effect.tryPromise({
    try: () => primeHostsSnapshot(),
    catch: () => undefined,
  }).pipe(Effect.ignore);

  const appInfo = yield* AppInfoService;
  const codex = yield* CodexService;
  const canvases = yield* CanvasesService;
  const snapshots = yield* SnapshotsService;
  const kernel = yield* KernelService;
  const regionRollup = yield* RegionRollupService;
  const usage = yield* UsageService;
  const settings = yield* SettingsService;
  const hosts = yield* HostsService;
  const stationRepository = yield* StationRepository;
  const stationStatus = yield* StationStatusService;

  const station = yield* appInfo.stationInfo;
  // One bounded SSH pass feeds both the host service row and the station fleet
  // projection. Doctor must not double-probe a host and accidentally present
  // observations from two different moments as one report.
  const hostsDoctorSnapshot = yield* hosts.doctorSnapshot;
  const stationAssessment = yield* Effect.gen(function* () {
    const stationState = yield* Effect.all({
      facts: stationRepository.statusFacts,
      projection: stationRepository.projection,
      observations: stationStatus.read,
    });
    const registeredHosts = yield* Effect.result(hosts.list);
    const registeredRemoteEndpoints =
      registeredHosts._tag === "Success"
        ? Object.fromEntries(
            registeredHosts.success.flatMap((host) =>
              host.kind === "remote" && host.sshEndpoint
                ? [[host.id, host.sshEndpoint] as const]
                : [],
            ),
          )
        : undefined;
    const supervisedInstalled = yield* Effect.promise(() => probeSupervisedRuntime());
    const workControlReady = workControlReadiness.ready();
    const kernelRecord = kernelRecordFromSnapshot(kernel.getSnapshot());
    const configuration = stationState.facts.configuration;
    const supervisorAligned = supervisorAlignedForReadiness({
      role: configuration?.role ?? "",
      hostId: configuration?.hostId ?? "unconfigured",
      supervisedPreferred: configuration?.supervisedPreferred ?? false,
      supervisedInstalled,
    });
    const stationDoctor = assessStationDoctor({
      installationId: stationState.facts.installationId,
      ...(configuration === undefined ? {} : { configuration }),
      ...(stationState.facts.configuredAt === undefined
        ? {}
        : { configuredAt: stationState.facts.configuredAt }),
      ...(stationState.facts.projection === undefined
        ? {}
        : { projection: stationState.facts.projection }),
      receivedThrough: stationState.facts.receivedThrough,
      version: station.version,
      supervisedInstalled,
      status: stationState.observations,
      kernel: kernelRecord,
      registeredRemoteEndpoints,
      remoteObservations: hostsDoctorSnapshot.observations,
      readiness: {
        database: true,
        workControl: workControlReady,
        simulation: kernelRecord.fault === undefined,
        session: stationControlReadiness.sessionReady(),
      },
    });
    const readiness = yield* assessCurrentStationReadiness({
      supervisorAligned,
      station: {
        facts: stationState.facts,
        ...(stationState.projection === undefined
          ? {}
          : { projection: stationState.projection }),
      },
    });
    const check = {
      ...stationDoctor,
      status: stationDoctor.status === "error"
        ? "error"
        : readiness.state === "ready" ? stationDoctor.status : "warning" as const,
      detail: `${stationDoctor.detail}; readiness ${readiness.state}`,
      metadata: {
        ...(stationDoctor.metadata ?? {}),
        ...stationReadinessMetadata(readiness),
      },
    } satisfies ServiceCheck;
    const compatibility = configuration?.role === "remote"
      ? composeMainFleetCompatibilitySnapshot({
          hostId: configuration.hostId,
          installationId: stationState.facts.installationId,
          ...(stationState.facts.projection === undefined
            ? {}
            : { projectionReceipt: stationState.facts.projection }),
        })
      : undefined;
    return { check, compatibility };
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed({
        check: {
          id: "station",
          label: "Station",
          status: "error" as const,
          detail: error instanceof Error ? error.message : String(error),
        } satisfies ServiceCheck,
        compatibility: undefined,
      }),
    ),
  );

  const serviceResults = yield* Effect.all(
    [
      codex.doctor,
      canvases.doctor,
      snapshots.doctor,
      kernel.doctor,
      regionRollup.doctor,
      usage.doctor,
      settings.doctor,
      Effect.succeed(hostsDoctorSnapshot.check),
    ],
    { concurrency: "unbounded" },
  );

  const running = termPlane.router.runningCount();
  const sockOk = existsSync(termControlSocketPath());
  const nativeTerminalProbe = yield* Effect.promise(() =>
    probeNativeTerminalReadiness()
  );
  const terminalCheck = assessNativeTerminalDoctor({
    probe: nativeTerminalProbe,
    controlReady: sockOk,
    running,
  });
  const linuxInstallStorage = process.platform === "linux"
    ? yield* Effect.promise(() => linuxDesktopInstallStorageDoctor({ executablePath: process.execPath }))
    : undefined;
  const services: ReadonlyArray<ServiceCheck> = [
    ...serviceResults,
    terminalCheck,
    stationAssessment.check,
    ...(linuxInstallStorage === undefined ? [] : [linuxInstallStorage]),
  ];
  const recommendations = services
    .filter((service) => service.status !== "ok")
    .map((service) => `${service.label}: ${service.detail}`);

  return {
    checkedAt: new Date().toISOString(),
    station,
    services,
    recommendations,
    ...(stationAssessment.compatibility === undefined
      ? {}
      : { fleetCompatibility: stationAssessment.compatibility }),
  } satisfies DoctorReport;
});
