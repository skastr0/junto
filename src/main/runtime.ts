import { existsSync } from "node:fs";
import { Effect, Layer, ManagedRuntime } from "effect";
import type { DoctorReport, ServiceCheck } from "@shared/contracts";
import { assessSupervisedRuntime } from "@shared/station";
import {
  assessStationDoctor,
  kernelRecordFromSnapshot,
  STATION_PULL_STALE_AFTER_MS,
  type StationStatusDocument,
} from "@shared/station-status";
import type { StationSettings } from "@shared/settings";
import { termControlSocketPath } from "@shared/term-control";
import { CodexLive, CodexService } from "./services/codex";
import { FolderLive, FolderService } from "./services/folder";
import { PrismLive, PrismService } from "./services/prism";
import { StoreLive, StoreService } from "./services/store";
import { CanvasesLive, CanvasesService } from "./vellum/canvases";
import { ChatServiceFromHermesLive, HermesPlaneLive } from "./vellum/hermes/plane";
import { HermesTransportLive } from "./vellum/hermes/transport";
import { HerdrPlaneLive } from "./vellum/herdr/plane";
import { HerdrTransportLive } from "./vellum/herdr/transport";
import { termPlane } from "./vellum/term/plane";
import {
  assessNativeTerminalDoctor,
  probeNativeTerminalReadiness,
} from "./vellum/term/native-readiness";
import { KernelLive, KernelService } from "./vellum/kernel/service";
import { WorkLive } from "./vellum/work/service";
import { RegionRollupLive, RegionRollupService } from "./vellum/region-rollup";
import { SettingsLive, SettingsService } from "./vellum/settings/service";
import { probeSupervisedRuntime } from "./vellum/settings/supervised-probe";
import { SnapshotsLive, SnapshotsService } from "./vellum/snapshots";
import { UsageLive } from "./vellum/usage/live";
import { UsageService } from "./vellum/usage/usage-service";
import { HostsService, HostsServiceLive } from "./vellum/hosts";
import { SshTransportLive } from "./vellum/ssh";
import { primeHostsSnapshot } from "./vellum/hosts/snapshot";
import { readStationStatus } from "./vellum/station-status-store";
import {
  readLocalCanvasMirrorWitness,
  stationSettingsWitness,
  type CanvasMirrorWitness,
} from "./vellum/station-witness";
import {
  createStationReadinessCoordinator,
  stationReadinessMetadata,
} from "./vellum/station-readiness";
import { workControlReadiness } from "./vellum/work/control";

// KernelLive requires CanvasesService/SnapshotsService/StoreService;
// RegionRollupLive requires CanvasesService/SnapshotsService.
// Layer.mergeAll builds merged layers independently — it does not thread one
// merge member's output to satisfy another's requirement — so both derived
// layers are provided the base layer explicitly (Layer.provideMerge keeps its
// inputs memoized: the SAME CanvasesService instance the rest of the app
// uses, not a second independent one with its own file watcher and own-write
// tracking).
// UsageLive is already composed (UsageServiceLive + CodexBarSourcesLive) so
// it can sit in BaseLayer as one self-contained member.
const HostsWithSshLive = Layer.provideMerge(
  HostsServiceLive,
  SshTransportLive,
);

// HostsServiceLive loads the durable registry while acquiring HostsWithSshLive.
// Making that complete input feed the host-aware transports is the boot-order
// barrier: no Herdr/Hermes plane can construct before synchronous routing has
// the persisted host inventory.
const ProductTransportsLive = Layer.provideMerge(
  Layer.mergeAll(HerdrTransportLive, HermesTransportLive),
  HostsWithSshLive,
);

export const ProductPlanesLive = Layer.provideMerge(
  Layer.mergeAll(HerdrPlaneLive, HermesPlaneLive),
  Layer.mergeAll(ProductTransportsLive, SettingsLive),
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
  StoreLive,
  FolderLive,
  PrismLive,
  CodexLive,
  CanvasesLive,
  SnapshotsWithProductsLive,
  UsageLive,
  SettingsLive,
);

export const RootLayer = Layer.provideMerge(
  Layer.mergeAll(KernelLive, RegionRollupLive, WorkLive),
  BaseLayer,
);

export const AppRuntime = ManagedRuntime.make(RootLayer);

export const supervisorAlignedForReadiness = (
  input: Parameters<typeof assessSupervisedRuntime>[0],
): boolean => assessSupervisedRuntime(input).aligned;

export const stationCanvasPullReadiness = (
  station: StationSettings,
  status: StationStatusDocument,
  now: number = Date.now(),
): "fresh" | "stale" | "missing" | "not-required" => {
  if (station.role !== "remote") return "not-required";
  const pull = status.lastPull;
  if (
    pull === undefined ||
    !pull.ok ||
    pull.keptLocal ||
    pull.failedCount !== 0 ||
    (pull.status !== "ok" && pull.status !== "empty") ||
    pull.admission === undefined ||
    pull.commandCenterRef !== station.commandCenterRef ||
    pull.admission.stationHostId !== station.hostId ||
    pull.admission.stationConfigSha256 !== stationSettingsWitness(station)
  ) {
    return "missing";
  }
  const observed = Date.parse(pull.at);
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(observed) ||
    observed > now ||
    now - observed > STATION_PULL_STALE_AFTER_MS
  ) {
    return "stale";
  }
  return "fresh";
};

export const stationCanvasPullMatchesMirror = (
  status: StationStatusDocument,
  mirror: CanvasMirrorWitness,
): boolean => {
  const pull = status.lastPull;
  const admission = pull?.admission;
  if (pull === undefined || admission === undefined) return false;
  return admission.canvasMirrorSha256 === mirror.sha256 &&
    admission.canvasCount === mirror.canvasCount &&
    pull.pulledCount === mirror.canvasCount &&
    (pull.status !== "empty" || mirror.canvasCount === 0) &&
    (pull.status !== "ok" || mirror.canvasCount > 0);
};

export interface CurrentStationReadinessOptions {
  /** Tests and callers with a current supervisor observation may supply it. */
  readonly supervisorAligned?: boolean;
  readonly now?: number;
}

/** Deep product-path assessment for Doctor; it never gates station boot. */
export const assessCurrentStationReadiness = (
  options: CurrentStationReadinessOptions = {},
) =>
  Effect.gen(function* () {
    const settings = yield* SettingsService;
    const prism = yield* PrismService;
    const stationInfo = yield* prism.stationInfo;
    const settingsDoc = yield* settings.get;
    const statusDoc = yield* Effect.promise(() => readStationStatus());
    const supervisorAligned = options.supervisorAligned ??
      supervisorAlignedForReadiness({
        role: settingsDoc.station.role,
        hostId: settingsDoc.station.hostId,
        supervisedPreferred: settingsDoc.station.supervisedPreferred,
        supervisedInstalled: yield* Effect.promise(() => probeSupervisedRuntime()),
      });
    let canvasPull = stationCanvasPullReadiness(
      settingsDoc.station,
      statusDoc,
      options.now,
    );
    if (canvasPull === "fresh" && settingsDoc.station.role === "remote") {
      const mirror = yield* Effect.either(
        Effect.tryPromise({
          try: readLocalCanvasMirrorWitness,
          catch: (error) => error instanceof Error ? error : new Error(String(error)),
        }),
      );
      if (
        mirror._tag === "Left" ||
        !stationCanvasPullMatchesMirror(statusDoc, mirror.right)
      ) {
        canvasPull = "missing";
      }
    }
    return yield* Effect.promise(() =>
      createStationReadinessCoordinator().assess({
        version: stationInfo.version,
        role: settingsDoc.station.role,
        hostId: settingsDoc.station.hostId,
        packageIdentity: stationInfo.name,
        supervisorAligned,
        canvasPull,
        workControlReady: workControlReadiness.ready(),
      }),
    );
  });

export const buildDoctorReport = Effect.gen(function* () {
  // Ensure registry snapshot is current before host-aware doctor / transports.
  yield* Effect.tryPromise({
    try: () => primeHostsSnapshot(),
    catch: () => undefined,
  }).pipe(Effect.ignore);

  const store = yield* StoreService;
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

  const station = yield* prism.stationInfo;
  // One bounded SSH pass feeds both the host service row and the station fleet
  // projection. Doctor must not double-probe a host and accidentally present
  // observations from two different moments as one report.
  const hostsDoctorSnapshot = yield* hosts.doctorSnapshot;
  const stationCheck = yield* Effect.gen(function* () {
    const settingsDoc = yield* settings.get;
    const statusDoc = yield* Effect.promise(() => readStationStatus());
    const registeredHosts = yield* Effect.either(hosts.list);
    const registeredRemoteEndpoints =
      registeredHosts._tag === "Right"
        ? Object.fromEntries(
            registeredHosts.right.flatMap((host) =>
              host.kind === "remote" && host.endpoint
                ? [[host.id, host.endpoint] as const]
                : [],
            ),
          )
        : undefined;
    const supervisedInstalled = yield* Effect.promise(() => probeSupervisedRuntime());
    const workControlReady = workControlReadiness.ready();
    const supervisorAligned = supervisorAlignedForReadiness({
      role: settingsDoc.station.role,
      hostId: settingsDoc.station.hostId,
      supervisedPreferred: settingsDoc.station.supervisedPreferred,
      supervisedInstalled,
    });
    const stationDoctor = assessStationDoctor({
      role: settingsDoc.station.role,
      hostId: settingsDoc.station.hostId,
      commandCenterRef: settingsDoc.station.commandCenterRef,
      version: station.version,
      supervisedPreferred: settingsDoc.station.supervisedPreferred,
      supervisedInstalled,
      status: statusDoc,
      kernel: kernelRecordFromSnapshot(kernel.getSnapshot()),
      registeredRemoteEndpoints,
      remoteObservations: hostsDoctorSnapshot.observations,
      workControlReady,
    });
    const readiness = yield* assessCurrentStationReadiness({
      supervisorAligned,
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
      store.doctor,
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
