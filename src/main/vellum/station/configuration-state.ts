import { Schema } from "effect";
import {
  StationConfiguration,
  type StationConfiguration as StationConfigurationValue,
} from "@shared/station-api";
import {
  defaultStation,
  type StationSettings,
} from "@shared/settings";
import {
  type StateReader,
  type StateRow,
  type StateWriter,
} from "../state/service";

/**
 * The one durable station-topology representation.
 *
 * Absence is the explicit pre-configuration state. A present row is always a
 * complete StationConfiguration; Remote identity is never reconstructed from
 * the smaller renderer-facing Settings aggregate.
 */
export type StationConfigurationRow = StateRow & {
  readonly role: string;
  readonly host_id: string;
  readonly agent_host_id: string | null;
  readonly command_center_installation_id: string | null;
  readonly command_center_ref: string | null;
  readonly supervised_preferred: number;
  readonly configured_at: string;
};

export type StoredStationConfiguration = {
  readonly configuration: StationConfigurationValue;
  readonly configuredAt: string;
};

const decodeConfiguration = Schema.decodeUnknownSync(StationConfiguration);

export const selectStationConfigurationRow = (
  reader: StateReader,
): StationConfigurationRow | undefined =>
  reader.get<StationConfigurationRow>(
    `SELECT
       role,
       host_id,
       agent_host_id,
       command_center_installation_id,
       command_center_ref,
       supervised_preferred,
       configured_at
     FROM station_configuration
     WHERE singleton = 1`,
  );

export const stationConfigurationFromRow = (
  row: StationConfigurationRow,
): StoredStationConfiguration => ({
  configuration:
    row.role === "command-center"
      ? decodeConfiguration({
          role: row.role,
          hostId: row.host_id,
          supervisedPreferred: row.supervised_preferred === 1,
        })
      : decodeConfiguration({
          role: row.role,
          hostId: row.host_id,
          agentHostId: row.agent_host_id,
          commandCenterInstallationId:
            row.command_center_installation_id,
          commandCenterRef: row.command_center_ref,
          supervisedPreferred: row.supervised_preferred === 1,
        }),
  configuredAt: row.configured_at,
});

export const selectStationConfiguration = (
  reader: StateReader,
): StoredStationConfiguration | undefined => {
  const row = selectStationConfigurationRow(reader);
  return row === undefined ? undefined : stationConfigurationFromRow(row);
};

/** Public Settings aggregate derived from canonical normalized state. */
export const stationSettingsFromConfiguration = (
  stored: StoredStationConfiguration | undefined,
): StationSettings => {
  if (stored === undefined) return defaultStation();
  const configuration = stored.configuration;
  return configuration.role === "command-center"
    ? {
        role: "command-center",
        hostId: configuration.hostId,
        commandCenterRef: "",
        supervisedPreferred: configuration.supervisedPreferred,
      }
    : {
        role: "remote",
        hostId: configuration.hostId,
        agentHostId: configuration.agentHostId,
        commandCenterRef: configuration.commandCenterRef,
        supervisedPreferred: configuration.supervisedPreferred,
      };
};

export const writeStationConfiguration = (
  writer: StateWriter,
  configuration: StationConfigurationValue,
  configuredAt: string,
): void => {
  const remote =
    configuration.role === "remote" ? configuration : undefined;
  writer.run(
    `INSERT INTO station_configuration(
       singleton,
       role,
       host_id,
       agent_host_id,
       command_center_installation_id,
       command_center_ref,
       supervised_preferred,
       configured_at
     ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(singleton) DO UPDATE SET
       role = excluded.role,
       host_id = excluded.host_id,
       agent_host_id = excluded.agent_host_id,
       command_center_installation_id =
         excluded.command_center_installation_id,
       command_center_ref = excluded.command_center_ref,
       supervised_preferred = excluded.supervised_preferred,
       configured_at = excluded.configured_at`,
    [
      configuration.role,
      configuration.hostId,
      remote?.agentHostId ?? null,
      remote?.commandCenterInstallationId ?? null,
      remote?.commandCenterRef ?? null,
      configuration.supervisedPreferred ? 1 : 0,
      configuredAt,
    ],
  );
};
