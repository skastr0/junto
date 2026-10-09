/**
 * Region environment bound to this installation: the real stores
 * (`./sources.ts`), the saved canvases, this machine's name and the seats
 * running in this process.
 *
 * The app runtime is imported lazily: it composes the seat launch, which
 * reads from here.
 */
import { Effect } from "effect";
import type { Canvas } from "@shared/model";
import type { RegionEnvironmentReport } from "@shared/region-environment";
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

const readDoc = async (canvasName: string): Promise<Canvas | undefined> => {
  try {
    const [{ coreRunner }, { ModelService }] = await Promise.all([
      import("../../core-runner"),
      import("../model/service"),
    ]);
    const read = await coreRunner.runPromise(
      Effect.gen(function* () {
        const model = yield* ModelService;
        return yield* model.canvas(canvasName).pipe(Effect.result);
      }),
    );
    return read._tag === "Success" ? read.success : undefined;
  } catch {
    return undefined;
  }
};

const hostId = async (): Promise<string> => {
  const [{ coreRunner }, { MachineRepository }] = await Promise.all([
    import("../../core-runner"), import("../machines/repository"),
  ]);
  return coreRunner.runPromise(Effect.flatMap(MachineRepository, (machine) => machine.machineName));
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
  doc: Canvas,
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
