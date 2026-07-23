import {
  applySettingsPatch,
  defaultSettings,
  type Settings,
  type StationSettings,
} from "./settings";
import { isValidStationHostId } from "./station";

/**
 * Pure planner for installing / configuring a Remote station's durable
 * settings.station fields over SSH.
 *
 * Product: Command Center pushes role=remote, hostId=<remote registry id>,
 * commandCenterRef=<this CC host id or configured ref>, supervisedPreferred
 * when possible. Remote is a role on that machine — not a third binary.
 *
 * No I/O. Main-process SSH writer merges this payload into the remote
 * ~/.vellum/settings.json document.
 */

export type RemoteStationConfigInput = {
  /** Registry id of the remote host being configured (stamped as station.hostId). */
  readonly remoteHostId: string;
  /**
   * Effective Hermes agent-key prefix for this station. Configure/deploy pass
   * `hermesKeyFor(host)`; direct callers may omit it when it equals hostId.
   */
  readonly agentHostId?: string;
  /** How the Remote finds the Command Center (usually the CC station.hostId). */
  readonly commandCenterRef: string;
  /** Prefer LaunchAgent supervised run. Defaults true for Remote. */
  readonly supervisedPreferred?: boolean;
};

export type RemoteStationConfigPlan = {
  readonly station: StationSettings;
  readonly summary: string;
};

/**
 * Build the station value object written onto a Remote.
 * Does not invent host ids — rejects empty / invalid identifiers.
 */
export const planRemoteStationFields = (
  input: RemoteStationConfigInput,
): StationSettings => {
  const remoteHostId = input.remoteHostId.trim();
  const agentHostId =
    input.agentHostId === undefined
      ? remoteHostId
      : input.agentHostId.trim();
  const commandCenterRef = input.commandCenterRef.trim();
  if (!isValidStationHostId(remoteHostId)) {
    throw new Error(`invalid remote host id: ${JSON.stringify(input.remoteHostId)}`);
  }
  if (!isValidStationHostId(agentHostId)) {
    throw new Error(`invalid agent host id: ${JSON.stringify(input.agentHostId)}`);
  }
  // commandCenterRef reuses StationReachability (max 255); allow empty only when
  // caller deliberately clears — configure path always supplies a non-empty ref.
  if (commandCenterRef.length === 0) {
    throw new Error("commandCenterRef is required when configuring a Remote");
  }
  if (commandCenterRef.length > 255) {
    throw new Error("commandCenterRef exceeds 255 characters");
  }
  return {
    role: "remote",
    hostId: remoteHostId,
    agentHostId,
    commandCenterRef,
    supervisedPreferred: input.supervisedPreferred ?? true,
  };
};

export const planRemoteStationConfig = (
  input: RemoteStationConfigInput,
): RemoteStationConfigPlan => {
  const station = planRemoteStationFields(input);
  return {
    station,
    summary: `role=remote · hostId=${station.hostId} · agentHostId=${station.agentHostId} · commandCenterRef=${station.commandCenterRef} · supervisedPreferred=${station.supervisedPreferred}`,
  };
};

/**
 * Merge Remote station fields into an existing Settings document.
 * Preserves appearance/canvas/kernel/…; only stamps station.
 */
export const mergeRemoteStationSettings = (
  current: Settings,
  input: RemoteStationConfigInput,
): Settings => {
  const station = planRemoteStationFields(input);
  return applySettingsPatch(current, { station });
};

/**
 * Merge onto defaults when the remote has no settings document yet.
 */
export const remoteStationSettingsFromScratch = (
  input: RemoteStationConfigInput,
): Settings => mergeRemoteStationSettings(defaultSettings(), input);

/** True when settings.station already matches the planned Remote stamp. */
export const remoteStationAlreadyConfigured = (
  settings: Settings,
  input: RemoteStationConfigInput,
): boolean => {
  const planned = planRemoteStationFields(input);
  const s = settings.station;
  return (
    s.role === planned.role &&
    s.hostId === planned.hostId &&
    s.agentHostId === planned.agentHostId &&
    s.commandCenterRef === planned.commandCenterRef &&
    s.supervisedPreferred === planned.supervisedPreferred
  );
};
