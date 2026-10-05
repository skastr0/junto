/**
 * Region environment bound to this installation: the real stores
 * (`./sources.ts`), the saved canvases, this station's host id and the seats
 * running in this process.
 *
 * The app runtime is imported lazily: it composes the seat launch, which
 * reads from here.
 */
import { Effect } from "effect";
import type { CanvasDoc } from "@shared/canvas";
import type { RegionEnvironmentReport } from "@shared/region-environment";
import { DEFAULT_STATION_HOST_ID } from "@shared/station";
import { termPlane } from "../term/plane";
import type { SeatEnvironmentResolver } from "../term/seat-process";
import {
  makeRegionEnvironmentResolution,
  type ResolvedRegionEnvironment,
} from "./resolve";
import {
  makeRegionEnvironmentService,
  type RegionEnvironmentService,
} from "./service";
import { resolveEnvSource, staticNamesOf } from "./sources";

const resolution = makeRegionEnvironmentResolution({
  resolve: resolveEnvSource,
  staticNamesOf,
});

const readDoc = async (canvasName: string): Promise<CanvasDoc | undefined> => {
  try {
    const [{ AppRuntime }, { CanvasesService }] = await Promise.all([
      import("../../runtime"),
      import("../canvases"),
    ]);
    const read = await AppRuntime.runPromise(
      Effect.gen(function* () {
        const canvases = yield* CanvasesService;
        return yield* canvases.read(canvasName, "term.seatPlan").pipe(Effect.result);
      }),
    );
    return read._tag === "Success" ? read.success.doc : undefined;
  } catch {
    return undefined;
  }
};

const hostId = async (): Promise<string> => {
  try {
    const [{ AppRuntime }, { StationRepository }] = await Promise.all([
      import("../../runtime"),
      import("../station/repository"),
    ]);
    const record = await AppRuntime.runPromise(
      Effect.gen(function* () {
        const station = yield* StationRepository;
        return yield* station.configuration;
      }),
    );
    return record?.configuration.hostId?.trim() || DEFAULT_STATION_HOST_ID;
  } catch {
    return DEFAULT_STATION_HOST_ID;
  }
};

let service: RegionEnvironmentService | undefined;

/** The one service every surface reads: launch, screen, doctor, `env.report`. */
export const regionEnvironmentService = (): RegionEnvironmentService => {
  service ??= makeRegionEnvironmentService({
    resolution,
    readDoc,
    hostId,
    launchRecord: (bindingId) =>
      termPlane.host.regionEnvironmentRecord(bindingId),
  });
  return service;
};

/**
 * The spec's entry point: what the regions containing a seat resolve to on
 * this machine. `env` is for a spawn only; `report` is safe to show.
 */
export const resolveRegionEnvironment = (
  doc: CanvasDoc,
  nodeId: string,
  host: string,
): Promise<ResolvedRegionEnvironment> =>
  resolution.resolve(doc, { seat: nodeId }, host);

/** The canvas-wide report the overseer doctor prints. */
export const regionEnvironmentReport = (
  canvasName: string,
): Promise<RegionEnvironmentReport | undefined> =>
  regionEnvironmentService().canvasReport(canvasName);

/** What every local seat launch asks before it spawns. */
export const liveSeatEnvironment: SeatEnvironmentResolver = async (seat) => {
  const resolved = await regionEnvironmentService().forLaunch(seat);
  return {
    env: resolved.env,
    folders: resolved.folders,
    record: resolved.record,
    ...(resolved.refusal !== undefined ? { refusal: resolved.refusal } : {}),
  };
};
