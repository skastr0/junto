import { Effect, Layer, ManagedRuntime } from "effect";
import type { DoctorReport, ServiceCheck } from "@shared/contracts";
import { CodexLive, CodexService } from "./services/codex";
import { FolderLive, FolderService } from "./services/folder";
import { PrismLive, PrismService } from "./services/prism";
import { StoreLive, StoreService } from "./services/store";
import { CanvasesLive, CanvasesService } from "./vellum/canvases";
import { ChatService } from "./vellum/chat/service";
import { KernelLive, KernelService } from "./vellum/kernel/service";
import { RegionRollupLive } from "./vellum/region-rollup";
import { SnapshotsLive, SnapshotsService } from "./vellum/snapshots";

// One shared ACP-session manager for the whole app: pulse-driven turns
// (KernelService, below) and user-driven turns (registerChatIpc, wired in
// vellum/ipc.ts) reuse the same live sessions per agent rather than racing
// two independent ChatService instances (kernel-design.md §2.3).
export const chatService = new ChatService();

// KernelLive requires CanvasesService/SnapshotsService/StoreService;
// RegionRollupLive requires CanvasesService/SnapshotsService.
// Layer.mergeAll builds merged layers independently — it does not thread one
// merge member's output to satisfy another's requirement — so both derived
// layers are provided the base layer explicitly (Layer.provideMerge keeps its
// inputs memoized: the SAME CanvasesService instance the rest of the app
// uses, not a second independent one with its own file watcher and own-write
// tracking).
// Tower/quasar SDK clients (TowerSdkLive/QuasarSdkLive) deliberately do NOT
// live in this layer — see adapters/sdk-runtime.ts for why (a dedicated
// small runtime avoids a circular-dependency cluster between this file and
// the adapters that would otherwise need it).
const BaseLayer = Layer.mergeAll(StoreLive, FolderLive, PrismLive, CodexLive, CanvasesLive, SnapshotsLive);

export const RootLayer = Layer.provideMerge(
  Layer.mergeAll(KernelLive(chatService), RegionRollupLive(chatService)),
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

  const station = yield* prism.stationInfo;
  const serviceResults = yield* Effect.all(
    [store.doctor, folder.doctor, prism.doctor, codex.doctor, canvases.doctor, snapshots.doctor, kernel.doctor],
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
