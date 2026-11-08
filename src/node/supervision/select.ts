import type { StationSupervisor } from "./contract";

export interface StationSupervisorLoaders {
  readonly darwin: () => Promise<StationSupervisor>;
  readonly linux: () => Promise<StationSupervisor>;
  readonly standalone: () => Promise<StationSupervisor>;
}

const productionLoaders: StationSupervisorLoaders = Object.freeze({
  darwin: async () => {
    const { createDarwinStationSupervisor } = await import("./darwin");
    return createDarwinStationSupervisor();
  },
  linux: async () => {
    const { createSystemdUserStationSupervisor } = await import(
      "./systemd-user"
    );
    return createSystemdUserStationSupervisor();
  },
  standalone: async () => {
    const { createStandaloneStationSupervisor } = await import("./standalone");
    return createStandaloneStationSupervisor();
  },
});

/** Each platform calls one lazy loader; unsupported platforms stay standalone. */
export const createStationSupervisorSelector = (
  loaders: StationSupervisorLoaders,
): (platform: NodeJS.Platform) => Promise<StationSupervisor> =>
  (platform) => {
    if (platform === "darwin") return loaders.darwin();
    if (platform === "linux") return loaders.linux();
    return loaders.standalone();
  };

const selectProductionSupervisor = createStationSupervisorSelector(
  productionLoaders,
);

export const loadStationSupervisor = (
  platform: NodeJS.Platform = process.platform,
): Promise<StationSupervisor> => selectProductionSupervisor(platform);
