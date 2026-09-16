import {
  stationSupervisorFailure,
  type StationSupervisor,
  type StationSupervisorHandoff,
  type StationSupervisorMetadata,
  type StationSupervisorObservation,
} from "./contract";

const unsupported = stationSupervisorFailure(
  "unsupported",
  "Supervised startup isn't available on this platform.",
);

const metadata: StationSupervisorMetadata = Object.freeze({
  provider: "standalone",
  displayName: "Standalone",
  recovery: Object.freeze({
    title: "Supervised startup is unavailable",
    detail: "Run Junto as a regular desktop app on this platform.",
  }),
});

const observation: StationSupervisorObservation = Object.freeze({
  provider: "standalone",
  state: "unsupported",
  ownership: "none",
  failure: unsupported,
});

const handoff: StationSupervisorHandoff = Object.freeze({
  provider: "standalone",
  accepted: false,
  failure: unsupported,
});

export const createStandaloneStationSupervisor = (): StationSupervisor =>
  Object.freeze({
    metadata,
    observe: () => Promise.resolve(observation),
    requestHandoff: () => Promise.resolve(handoff),
  });
