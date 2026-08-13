import type { DoctorReport, ServiceCheck } from "@shared/contracts";
import type { StationSettings } from "@shared/settings";
import type { TerminalSessionSummary } from "@shared/terminal";

export type RemoteStationServiceRow = {
  readonly label: string;
  readonly status: string;
  readonly detail: string;
};

export type RemoteStationFaceStats = {
  readonly role: string;
  readonly hostId: string;
  readonly installationId?: string;
  readonly appVersion?: string;
  readonly services?: ReadonlyArray<RemoteStationServiceRow>;
  readonly terminalCount?: number;
  readonly runningTerminalCount?: number;
  readonly projection?: string;
  readonly lastCheckIn?: string;
};

export type RemoteStationFaceApi = {
  readonly doctor?: () => Promise<DoctorReport>;
  readonly terminalList?: (
    hostId?: string,
  ) => Promise<ReadonlyArray<TerminalSessionSummary>>;
};

const present = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === "" || trimmed === "unknown") {
    return undefined;
  }
  return trimmed;
};

const pickMethod = <T>(
  api: unknown,
  name: string,
): T | undefined => {
  if (api === null || typeof api !== "object") return undefined;
  const value = Reflect.get(api, name);
  if (typeof value !== "function") return undefined;
  return (value as (...args: never[]) => unknown).bind(api) as T;
};

/** Doctor lives on chassis; admit vellumCommand.doctor if a host ever surfaces it. */
export const pickRemoteStationFaceApi = (
  vellumCommand: unknown,
  chassis?: unknown,
): RemoteStationFaceApi => {
  const doctor =
    pickMethod<() => Promise<DoctorReport>>(vellumCommand, "doctor") ??
    pickMethod<() => Promise<DoctorReport>>(chassis, "doctor");
  const terminalList = pickMethod<
    (hostId?: string) => Promise<ReadonlyArray<TerminalSessionSummary>>
  >(vellumCommand, "terminalList");
  return {
    ...(doctor === undefined ? {} : { doctor }),
    ...(terminalList === undefined ? {} : { terminalList }),
  };
};

export const formatRemoteProjection = (
  metadata: Readonly<Record<string, string>> | undefined,
): string | undefined => {
  if (metadata === undefined) return undefined;
  const generation = present(metadata.projectionGeneration);
  const receivedAt = present(metadata.projectionReceivedAt);
  if (generation !== undefined && receivedAt !== undefined) {
    return `${generation}, received ${receivedAt}`;
  }
  if (generation !== undefined) return generation;
  if (receivedAt !== undefined) return `received ${receivedAt}`;
  return undefined;
};

export const readRemoteLastCheckIn = (
  metadata: Readonly<Record<string, string>> | undefined,
): string | undefined => {
  if (metadata === undefined) return undefined;
  const direct = present(metadata.lastCheckInAt) ?? present(metadata.lastCheckIn);
  if (direct !== undefined) return direct;
  for (const [key, value] of Object.entries(metadata)) {
    if (key.endsWith("lastCheckInAt") || key.endsWith("lastCheckIn")) {
      const found = present(value);
      if (found !== undefined) return found;
    }
  }
  return undefined;
};

export const stationServiceFromDoctor = (
  report: DoctorReport,
): ServiceCheck | undefined =>
  report.services.find((service) => service.id === "station");

export const serviceRowsFromDoctor = (
  report: DoctorReport,
): ReadonlyArray<RemoteStationServiceRow> =>
  report.services.map((service) => ({
    label: service.label,
    status: service.status,
    detail: service.detail,
  }));

export const identityFromStation = (
  station: Pick<StationSettings, "role" | "hostId">,
): Pick<RemoteStationFaceStats, "role" | "hostId"> => ({
  role: station.role,
  hostId: station.hostId,
});

export const statsFromDoctor = (
  report: DoctorReport,
): Pick<
  RemoteStationFaceStats,
  "installationId" | "appVersion" | "services" | "projection" | "lastCheckIn"
> => {
  const station = stationServiceFromDoctor(report);
  const metadata = station?.metadata;
  const appVersion = present(report.station.version);
  const installationId = present(metadata?.installationId);
  const projection = formatRemoteProjection(metadata);
  const lastCheckIn = readRemoteLastCheckIn(metadata);
  return {
    ...(appVersion === undefined ? {} : { appVersion }),
    ...(installationId === undefined ? {} : { installationId }),
    services: serviceRowsFromDoctor(report),
    ...(projection === undefined ? {} : { projection }),
    ...(lastCheckIn === undefined ? {} : { lastCheckIn }),
  };
};

export const statsFromTerminals = (
  sessions: ReadonlyArray<Pick<TerminalSessionSummary, "status">>,
): Pick<RemoteStationFaceStats, "terminalCount" | "runningTerminalCount"> => ({
  terminalCount: sessions.length,
  runningTerminalCount: sessions.filter((session) => session.status === "running")
    .length,
});

export const loadRemoteStationFaceStats = async (
  station: Pick<StationSettings, "role" | "hostId">,
  api: RemoteStationFaceApi,
): Promise<RemoteStationFaceStats> => {
  const identity = identityFromStation(station);
  const doctor = api.doctor === undefined
    ? undefined
    : await api.doctor().catch(() => undefined);
  const sessions = api.terminalList === undefined
    ? undefined
    : await api.terminalList().catch(() => undefined);
  return {
    ...identity,
    ...(doctor === undefined ? {} : statsFromDoctor(doctor)),
    ...(sessions === undefined ? {} : statsFromTerminals(sessions)),
  };
};
