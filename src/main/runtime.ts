import { Effect, Layer, ManagedRuntime } from "effect";
import type { DoctorReport, ServiceCheck } from "@shared/contracts";
import { CodexLive, CodexService } from "./services/codex";
import { FolderLive, FolderService } from "./services/folder";
import { PrismLive, PrismService } from "./services/prism";
import { StoreLive, StoreService } from "./services/store";
import { CanvasesLive, CanvasesService } from "./vellum/canvases";
import { SnapshotsLive, SnapshotsService } from "./vellum/snapshots";

export const RootLayer = Layer.mergeAll(
  StoreLive,
  FolderLive,
  PrismLive,
  CodexLive,
  CanvasesLive,
  SnapshotsLive,
);

export const AppRuntime = ManagedRuntime.make(RootLayer);

export const buildDoctorReport = Effect.gen(function* () {
  const store = yield* StoreService;
  const folder = yield* FolderService;
  const prism = yield* PrismService;
  const codex = yield* CodexService;
  const canvases = yield* CanvasesService;
  const snapshots = yield* SnapshotsService;

  const station = yield* prism.stationInfo;
  const serviceResults = yield* Effect.all(
    [store.doctor, folder.doctor, prism.doctor, codex.doctor, canvases.doctor, snapshots.doctor],
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
