import {
  stationSupervisorFailure,
  type StationSupervisor,
  type StationSupervisorHandoff,
  type StationSupervisorMetadata,
  type StationSupervisorObservation,
} from "./contract";

const unsupported = stationSupervisorFailure(
  "unsupported",
  "This platform has no Vellum station-supervisor provider.",
);

const metadata: StationSupervisorMetadata = Object.freeze({
  provider: "standalone",
  displayName: "Standalone",
  recovery: Object.freeze({
    title: "Station supervision is unavailable",
    detail: "Run Vellum as a standalone desktop process on this platform.",
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
