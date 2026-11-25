import type { StationSupervisor } from "./contract";

export interface StationSupervisorLoaders {
  readonly darwin: () => Promise<StationSupervisor>;
  readonly standalone: () => Promise<StationSupervisor>;
}

const productionLoaders: StationSupervisorLoaders = Object.freeze({
  darwin: async () => {
    const { createDarwinStationSupervisor } = await import("./darwin");
    return createDarwinStationSupervisor();
  },
  standalone: async () => {
    const { createStandaloneStationSupervisor } = await import("./standalone");
    return createStandaloneStationSupervisor();
  },
});

/** Each platform calls one lazy loader; every platform but macOS is standalone. */
export const createStationSupervisorSelector = (
  loaders: StationSupervisorLoaders,
): (platform: NodeJS.Platform) => Promise<StationSupervisor> =>
  (platform) => platform === "darwin" ? loaders.darwin() : loaders.standalone();

const selectProductionSupervisor = createStationSupervisorSelector(
  productionLoaders,
);

export const loadStationSupervisor = (
  platform: NodeJS.Platform = process.platform,
): Promise<StationSupervisor> => selectProductionSupervisor(platform);
