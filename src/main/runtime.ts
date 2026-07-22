import { access } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { Effect, Layer, ManagedRuntime } from "effect";
import type { DoctorReport, ServiceCheck } from "@shared/contracts";
import { assessStationDoctor } from "@shared/station-status";
import { termControlSocketPath } from "@shared/term-control";
import {
  workControlDir,
  workControlSocketPath,
  workControlTokenPath,
  WORK_HOME_ENV,
} from "@shared/work-control";
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
import { KernelLive, KernelService } from "./vellum/kernel/service";
import { WorkLive } from "./vellum/work/service";
import { RegionRollupLive, RegionRollupService } from "./vellum/region-rollup";
import { SettingsLive, SettingsService } from "./vellum/settings/service";
import { probeLaunchAgentLoaded } from "./vellum/settings/supervised-probe";
import { SnapshotsLive, SnapshotsService } from "./vellum/snapshots";
import { UsageLive } from "./vellum/usage/live";
import { UsageService } from "./vellum/usage/usage-service";
import { HostsService, HostsServiceLive } from "./vellum/hosts";
import { SshTransportLive } from "./vellum/ssh";
import { primeHostsSnapshot } from "./vellum/hosts/snapshot";
import { readStationStatus } from "./vellum/station-status-store";

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
  const stationCheck = yield* Effect.gen(function* () {
    const settingsDoc = yield* settings.get;
    const statusDoc = yield* Effect.promise(() => readStationStatus());
    const supervisedInstalled = yield* Effect.promise(() => probeLaunchAgentLoaded());
    const workHome = process.env[WORK_HOME_ENV] || workControlDir(homedir());
    const workControlReady = yield* Effect.tryPromise({
      try: async () => {
        await access(workControlSocketPath(workHome), constants.F_OK);
        await access(workControlTokenPath(workHome), constants.R_OK);
        return true;
      },
      catch: () => false as const,
    }).pipe(Effect.catchAll(() => Effect.succeed(false as const)));
    return assessStationDoctor({
      role: settingsDoc.station.role,
      hostId: settingsDoc.station.hostId,
      commandCenterRef: settingsDoc.station.commandCenterRef,
      supervisedPreferred: settingsDoc.station.supervisedPreferred,
      supervisedInstalled,
      status: statusDoc,
      workControlReady,
    });
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
      hosts.doctor,
    ],
    { concurrency: "unbounded" },
  );

  const running = termPlane.router.runningCount();
  const sockOk = existsSync(termControlSocketPath());
  const terminalCheck: ServiceCheck = sockOk
    ? {
        id: "terminal",
        label: "Native terminal",
        status: "ok",
        detail: `local host + control UDS ready (${running} running)`,
      }
    : {
        id: "terminal",
        label: "Native terminal",
        status: "warning",
        detail: `session host up (${running} running) but control socket missing — remote attach unavailable until term plane starts`,
      };
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
