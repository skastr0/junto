import type { RegionEnvironmentReport } from "@shared/region-environment";
import { regionEnvironmentReport } from "../region-env/live";

/**
 * The seam to the region environment resolver's report.
 *
 * `env.doctor` returns the resolver's canonical canvas-wide report: names,
 * kinds, origins and status, never a value. The shape is the resolver's
 * (`RegionEnvironmentReport`); this side only narrows it to one node.
 * Undefined means the canvas could not be read.
 */
export type OverseerEnvReport = (
  canvasName: string,
) => Promise<RegionEnvironmentReport | undefined>;

export const overseerEnvReport: OverseerEnvReport | undefined = regionEnvironmentReport;
