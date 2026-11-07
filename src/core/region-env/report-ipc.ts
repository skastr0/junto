/**
 * The region screen's two read calls: what a region resolves to, and which
 * running seats inside it are on an older resolution.
 *
 * Both answer with names, kinds, origins and status. No value crosses IPC in
 * either direction. Input arrives untyped and is checked here; a refusal is a
 * sentence for the operator, never a throw.
 */
import type {
  RegionEnvReportResult,
  RegionEnvStaleSeatsResult,
} from "@shared/ipc";
import { regionEnvironmentService } from "./live";
import type { RegionEnvironmentService } from "./service";

const NOT_A_REGION = "That region is not on this canvas.";
const UNREADABLE = "Junto could not read this region's environment.";

const target = (
  canvasName: unknown,
  regionId: unknown,
): { readonly canvasName: string; readonly regionId: string } | undefined =>
  typeof canvasName === "string" &&
  canvasName.trim().length > 0 &&
  typeof regionId === "string" &&
  regionId.trim().length > 0
    ? { canvasName: canvasName.trim(), regionId: regionId.trim() }
    : undefined;

/** The resolution for a seat placed directly in this region, in application order. */
export const regionEnvReport = async (
  canvasName: unknown,
  regionId: unknown,
  service: RegionEnvironmentService = regionEnvironmentService(),
): Promise<RegionEnvReportResult> => {
  const at = target(canvasName, regionId);
  if (!at) return { ok: false, message: NOT_A_REGION };
  try {
    const report = await service.regionReport(at.canvasName, at.regionId);
    return report === undefined
      ? { ok: false, message: NOT_A_REGION }
      : { ok: true, report };
  } catch {
    return { ok: false, message: UNREADABLE };
  }
};

/** Running seats inside the region whose launch environment is out of date. */
export const regionEnvStaleSeats = async (
  canvasName: unknown,
  regionId: unknown,
  service: RegionEnvironmentService = regionEnvironmentService(),
): Promise<RegionEnvStaleSeatsResult> => {
  const at = target(canvasName, regionId);
  if (!at) return { ok: false, message: NOT_A_REGION };
  try {
    const seats = await service.staleSeats(at.canvasName, at.regionId);
    return seats === undefined
      ? { ok: false, message: NOT_A_REGION }
      : { ok: true, seats };
  } catch {
    return { ok: false, message: UNREADABLE };
  }
};
