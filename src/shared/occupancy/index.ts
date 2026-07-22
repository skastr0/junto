// Derived seat occupancy spectrum (pure).
// Occupancy is a live plane — never stored in the canvas document.
// Phase stays in execution-graph; capability stays in physics; this is seats.

export {
  DEFAULT_STALL_AFTER_MS,
  OccupancyActivity,
  OccupancyFlags,
  OccupancyHarnessState,
  OccupancySpectrum,
  deriveOccupancy,
} from "./derive";
export type {
  DeriveOccupancyInput,
  OccupancyActivity as OccupancyActivityValue,
  OccupancyFlags as OccupancyFlagsValue,
  OccupancyHarnessState as OccupancyHarnessStateName,
  OccupancySpectrum as OccupancySpectrumName,
} from "./derive";
