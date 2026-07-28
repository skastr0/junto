import { existsSync } from "node:fs";
import { Effect, Layer, ManagedRuntime } from "effect";
import type { DoctorReport, ServiceCheck } from "@shared/contracts";
import { assessSupervisedRuntime } from "@shared/station";
import {
  assessStationDoctor,
  kernelRecordFromSnapshot,
} from "@shared/station-status";
import { termControlSocketPath } from "@shared/term-control";
import { CodexLive, CodexService } from "./services/codex";
import { FolderLive, FolderService } from "./services/folder";
import { PrismLive, PrismService } from "./services/prism";
import { CanvasesLive, CanvasesService } from "./vellum/canvases";
import { ChatServiceFromHermesLive, HermesPlaneLive } from "./vellum/hermes/plane";
import { HermesTransportLive } from "./vellum/hermes/transport";
import { HerdrPlaneLive } from "./vellum/herdr/plane";
import { HerdrTransportLive } from "./vellum/herdr/transport";
import { TerminalSessions } from "./vellum/term/sessions";
import { termPlane } from "./vellum/term/plane";
import { HerdrPlane } from "./vellum/herdr/plane";
import {
  assessNativeTerminalDoctor,
  probeNativeTerminalReadiness,
} from "./vellum/term/native-readiness";
import { KernelLive, KernelService } from "./vellum/kernel/service";
import { KernelStateRepositoryLive } from "./vellum/kernel/repository";
import { PausePlaneLive } from "./vellum/pause-plane";
import { FactoryPauseRepositoryLive } from "./vellum/pause/repository";
import { SchedulerRepositoryLive } from "./vellum/scheduler/repository";
import { WorkLive } from "./vellum/work/service";
import { WorkRepositoryLive } from "./vellum/work/repository";
import { RegionRollupLive, RegionRollupService } from "./vellum/region-rollup";
import { SettingsLive, SettingsService } from "./vellum/settings/service";
import { probeSupervisedRuntime } from "./vellum/settings/supervised-probe";
import { SnapshotsLive, SnapshotsService } from "./vellum/snapshots";
import { UsageLive } from "./vellum/usage/live";
import { UsageService } from "./vellum/usage/usage-service";
import { HostsService, HostsServiceLive } from "./vellum/hosts";
import { SshTransportLive } from "./vellum/ssh";
import { primeHostsSnapshot } from "./vellum/hosts/snapshot";
import {
  StationStatusLive,
  StationStatusService,
} from "./vellum/station-status-store";
import {
  createStationReadinessCoordinator,
  stationReadinessMetadata,
} from "./vellum/station-readiness";
import { stationControlReadiness } from "./vellum/station/control-server";
import { workControlReadiness } from "./vellum/work/control";
import { StateEngineLive } from "./vellum/state/engine";
import {
  StationFleetTargetRepositoryLive,
} from "./vellum/station/fleet-target-repository";
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
import {
  OpenSshStationPeerExchangeLive,
} from "./vellum/station/openssh-peer-exchange";
import {
  StationLivePeerRegistryLive,
} from "./vellum/station/session-registry";

// Keep this exact layer value as the sole database owner in the runtime graph.
// Effect memoizes layers by reference, so every repository below receives the
// same scoped StateEngine connection even when the composed layers are reused
// by more than one product plane.
const StateRepositoriesLive = Layer.provideMerge(
  Layer.mergeAll(
    KernelStateRepositoryLive,
    FactoryPauseRepositoryLive,
    WorkRepositoryLive,
    UsageLive,
    SettingsLive,
    SchedulerRepositoryLive,
    StationStatusLive,
    StationRepositoryLive,
    StationFleetTargetRepositoryLive,
  ),
  StateEngineLive,
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

const OpenSshStationPeerExchangeFromStateLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const repository = yield* StationRepository;
    const localInstallationId = yield* repository.installationId;
    return OpenSshStationPeerExchangeLive(localInstallationId);
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

const HostsWithSshLive = Layer.provideMerge(
  HostsServiceLive,
  Layer.mergeAll(
    SshTransportLive,
    StateRepositoriesLive,
    StationFleetServicesLive,
  ),
);

// HostsServiceLive loads the durable registry while acquiring HostsWithSshLive.
// Making that complete input feed the host-aware transports is the boot-order
// barrier: no Herdr/Hermes plane can construct before synchronous routing has
// the persisted host inventory.
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

export const ProductPlanesLive = Layer.provideMerge(
  Layer.mergeAll(HerdrWithSessionsLive, HermesPlaneLive),
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

const BaseLayer = Layer.mergeAll(
  FolderLive,
  PrismLive,
  CodexLive,
  SnapshotsWithProductsLive,
  HostsWithSshLive,
  StationFleetServicesLive,
);

// Pause plane sits between the base services and the acting planes so the
// kernel, work control, and IPC all share ONE born-paused switch instance.
const BaseWithPauseLive = Layer.provideMerge(PausePlaneLive, BaseLayer);

const KernelWithWorkLive = Layer.provideMerge(KernelLive, WorkLive);

export const RootLayer = Layer.provideMerge(
  Layer.mergeAll(KernelWithWorkLive, RegionRollupLive),
  BaseWithPauseLive,
);

export const AppRuntime = ManagedRuntime.make(RootLayer);

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
    const prism = yield* PrismService;
    const repository = yield* StationRepository;
    const kernel = yield* KernelService;
    const stationInfo = yield* prism.stationInfo;
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
    const simulationReady = kernel.getSnapshot().fault === undefined;
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

  const folder = yield* FolderService;
  const prism = yield* PrismService;
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

  const station = yield* prism.stationInfo;
  // One bounded SSH pass feeds both the host service row and the station fleet
  // projection. Doctor must not double-probe a host and accidentally present
  // observations from two different moments as one report.
  const hostsDoctorSnapshot = yield* hosts.doctorSnapshot;
  const stationCheck = yield* Effect.gen(function* () {
    const stationState = yield* Effect.all({
      facts: stationRepository.statusFacts,
      projection: stationRepository.projection,
      observations: stationStatus.read,
    });
    const registeredHosts = yield* Effect.either(hosts.list);
    const registeredRemoteEndpoints =
      registeredHosts._tag === "Right"
        ? Object.fromEntries(
            registeredHosts.right.flatMap((host) =>
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
    return {
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
  }).pipe(
    Effect.catchAll((error) =>
      Effect.succeed({
        id: "station",
        label: "Station",
        status: "error" as const,
        detail: error instanceof Error ? error.message : String(error),
      } satisfies ServiceCheck),
    ),
  );

  const serviceResults = yield* Effect.all(
    [
      folder.doctor,
      prism.doctor,
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
  const services: ReadonlyArray<ServiceCheck> = [
    ...serviceResults,
    terminalCheck,
    stationCheck,
  ];
  const recommendations = services
    .filter((service) => service.status !== "ok")
    .map((service) => `${service.label}: ${service.detail}`);

  return {
    checkedAt: new Date().toISOString(),
    station,
    services,
    recommendations,
  } satisfies DoctorReport;
});
