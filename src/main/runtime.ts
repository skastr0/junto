import { CanvasControlQueries } from "./junto/canvas-control/queries";
import { installCoreRunner } from "./core-runner";
import { existsSync } from "node:fs";
import { app } from "electron";
import { Effect, Layer, ManagedRuntime } from "effect";
import { ObservabilityLoggerLive } from "./junto/observability";
import productMetadata from "../../package.json";
import type { DoctorReport, ServiceCheck } from "@shared/contracts";
import { linuxDesktopInstallStorageDoctor } from "./junto/update/linux-install";
import { termControlSocketPath } from "@shared/term-control";
import { CodexLive, CodexService } from "./services/codex";
import { AppInfoLive, AppInfoService } from "./services/app-info";
import { ModelService } from "./junto/model/service";
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
import { PortraitOverrideRepositoryLive } from "./junto/portraits/repository";
import { CompanionDeviceRepositoryLive } from "./junto/companion/repository";
import { SchedulerRepositoryLive } from "./junto/scheduler/repository";
import { SquadRepositoryLive } from "./junto/squads/repository";
import { SeatGuidanceRepositoryLive } from "./junto/seat-guidance/repository";
import { ReferencesRepositoryLive } from "./junto/references/repository";
import { ReferencesFollowCanvasLive } from "./junto/references/follow-canvas";
import { SeatSessionRepositoryLive } from "./junto/seat-sessions/repository";
import { ProfileRepositoryLive } from "./junto/profiles/repository";
import { WorkLive } from "./junto/work/service";
import { WorkRevisionsLive, WorkRepositoryLive } from "./junto/work/repository";
import { CrewRepositoryLive } from "./junto/work/crew-repository";
import { makeContentServiceLive } from "./junto/content/service";
import { InstallOpsLive } from "./junto/install-ops/engine";
import { SettingsLive, SettingsService } from "./junto/settings/service";
import { SnapshotsLive, SnapshotsService } from "./junto/snapshots";
import { UsageLive } from "./junto/usage/live";
import { UsageService } from "./junto/usage/usage-service";
import { HostsService, HostsServiceLive } from "./junto/hosts";
import { SshTransportLive } from "./junto/ssh";
import { primeHostsSnapshot } from "./junto/hosts/snapshot";
import { StateEngineLive } from "./junto/state/engine";
import { MachineRepositoryLive } from "./junto/machines/repository";
import { CURRENT_STATE_SCHEMA_VERSION } from "./junto/state/migrations";
import {
  StationFleetTargetRepositoryLive,
} from "./junto/station/fleet-target-repository";
import {
  StationRepositoryLive,
} from "./junto/station/repository";
import { WorkModelDependentsLive } from "./junto/work/model-dependents";
import { ModelLive } from "./junto/model/layer";
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
    PortraitOverrideRepositoryLive,
    CompanionDeviceRepositoryLive,
    WorkRepositoryLive,
    WorkRevisionsLive,
    CrewRepositoryLive,
    SquadRepositoryLive,
    SeatGuidanceRepositoryLive,
    Layer.provideMerge(ReferencesFollowCanvasLive, ReferencesRepositoryLive),
    SeatSessionRepositoryLive,
    ProfileRepositoryLive,
    // The usage plane reads operator provider credentials from settings, so
    // the memoized SettingsService instance feeds it here (same reference).
    Layer.provideMerge(UsageLive, SettingsLive),
    SettingsLive,
    SchedulerRepositoryLive,
    StationRepositoryLive,
    MachineRepositoryLive,
    StationFleetTargetRepositoryLive,
    makeContentServiceLive(),
  ),
  Layer.provideMerge(Layer.provide(ModelLive, WorkModelDependentsLive), Layer.mergeAll(StateEngineLive, InstallOpsLive)),
);

// The registry and SSH share the same product repositories.
const HostsWithSshLive = Layer.provideMerge(
  HostsServiceLive,
  Layer.mergeAll(
    SshTransportLive,
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
  Layer.mergeAll(KernelWithWorkLive, CanvasControlQueries.layer),
  BaseWithActorSeatOccupyLive,
);

// The product owns one warm runtime and disposes it on shutdown.
const AppLayer = Layer.mergeAll(RootLayer, ObservabilityLoggerLive);
export const AppRuntime = ManagedRuntime.make(
  AppLayer as Layer.Layer<
    Layer.Success<typeof AppLayer>,
    Layer.Error<typeof AppLayer>,
    never
  >,
);
installCoreRunner(AppRuntime);

export const buildDoctorReport = Effect.gen(function* () {
  // Ensure registry snapshot is current before host-aware doctor / transports.
  yield* Effect.tryPromise({
    try: () => primeHostsSnapshot(),
    catch: () => undefined,
  }).pipe(Effect.ignore);

  const appInfo = yield* AppInfoService;
  const codex = yield* CodexService;
  const model = yield* ModelService;
  const snapshots = yield* SnapshotsService;
  const kernel = yield* KernelService;
  const usage = yield* UsageService;
  const settings = yield* SettingsService;
  const hosts = yield* HostsService;

  const station = yield* appInfo.stationInfo;
  const hostsDoctorSnapshot = yield* hosts.doctorSnapshot;

  const serviceResults = yield* Effect.all(
    [
      codex.doctor,
      model.listCanvases().pipe(Effect.match({
        onFailure: () => ({ id: "canvases", label: "Canvases", status: "error" as const, detail: "Canvas storage is unavailable" }),
        onSuccess: (names) => ({ id: "canvases", label: "Canvases", status: "ok" as const, detail: `${names.length} canvases` }),
      })),
      snapshots.doctor,
      kernel.doctor,
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
  } satisfies DoctorReport;
});
