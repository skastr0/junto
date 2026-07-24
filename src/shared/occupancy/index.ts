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

// Cut 1 seam (S5): typed producer contracts. Interface + null producer ship
// here; real producers bind from consumer-side lanes (renderer ACP plane,
// PTY lane, fleet lane) without touching this module.
export { ActivityFeed, ActivityFeedNull, nullActivityFeed } from "./activity-feed";
export type { ActivityFeedService, OccupancyClue } from "./activity-feed";
export { HostLiveness, HostLivenessNull, nullHostLiveness } from "./host-liveness";
export type { HostLivenessService } from "./host-liveness";
