import { Effect, Layer, ManagedRuntime } from "effect";
import type { DoctorReport, ServiceCheck } from "@shared/contracts";
import { CodexLive, CodexService } from "./services/codex";
import { FolderLive, FolderService } from "./services/folder";
import { PrismLive, PrismService } from "./services/prism";
import { StoreLive, StoreService } from "./services/store";
import { CanvasesLive, CanvasesService } from "./vellum/canvases";
import { ChatServiceFromHermesLive, HermesPlaneLive } from "./vellum/hermes/plane";
import { HermesTransportLive } from "./vellum/hermes/transport";
import { HerdrPlaneLive } from "./vellum/herdr/plane";
import { HerdrTransportLive } from "./vellum/herdr/transport";
import { KernelLive, KernelService } from "./vellum/kernel/service";
import { RegionRollupLive, RegionRollupService } from "./vellum/region-rollup";
import { SettingsLive, SettingsService } from "./vellum/settings/service";
import { SnapshotsLive, SnapshotsService } from "./vellum/snapshots";
import { UsageLive } from "./vellum/usage/live";
import { UsageService } from "./vellum/usage/usage-service";
import { SshTransportLive } from "./vellum/ssh";

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
// Tower/quasar SDK clients (TowerSdkLive/QuasarSdkLive) deliberately do NOT
// live in this layer — see adapters/sdk-runtime.ts for why (a dedicated
// small runtime avoids a circular-dependency cluster between this file and
// the adapters that would otherwise need it).
const ProductTransportsLive = Layer.provideMerge(
  Layer.mergeAll(HerdrTransportLive, HermesTransportLive),
  SshTransportLive,
);

const ProductPlanesLive = Layer.provideMerge(
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
  Layer.mergeAll(KernelLive, RegionRollupLive),
  BaseLayer,
);

export const AppRuntime = ManagedRuntime.make(RootLayer);

export const buildDoctorReport = Effect.gen(function* () {
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

  const station = yield* prism.stationInfo;
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
    ],
    { concurrency: "unbounded" },
  );

  const services: ReadonlyArray<ServiceCheck> = serviceResults;
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
