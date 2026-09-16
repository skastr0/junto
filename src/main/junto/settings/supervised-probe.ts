import type { SupervisedInstallState } from "@shared/station";
import {
  loadStationSupervisor,
} from "../supervision/select";
import type { StationSupervisor } from "../supervision/contract";

export type SupervisedProbe = () => Promise<SupervisedInstallState>;

const installStateFromObservation = (
  observation: Awaited<ReturnType<StationSupervisor["observe"]>>,
): SupervisedInstallState => {
  switch (observation.state) {
    case "active":
      return "installed";
    case "inactive":
    case "absent":
    case "unsupported":
      return "absent";
    case "degraded":
    case "unknown":
      return "unknown";
  }
  return "unknown";
};

/**
 * Observe the platform's station supervisor. "installed" means the provider
 * has observed a healthy active service; service-manager acceptance alone is
 * never treated as product readiness.
 */
export const createSupervisedProbe = (
  load: () => Promise<StationSupervisor> = loadStationSupervisor,
): SupervisedProbe => async () => {
  try {
    return installStateFromObservation(await (await load()).observe());
  } catch {
    return "unknown";
  }
};

/** Production probe selected by the current platform's supervisor provider. */
export const probeSupervisedRuntime: SupervisedProbe = createSupervisedProbe();
