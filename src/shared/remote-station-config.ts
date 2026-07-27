import type { StationSettings } from "./settings";
import { isValidStationHostId } from "./station";

/**
 * Pure planner for installing / configuring a Remote station's durable
 * settings.station fields over SSH.
 *
 * Product: Command Center pushes role=remote, hostId=<remote registry id>,
 * agentHostId=<hermes key>, supervisedPreferred when possible. Remote is a
 * role on that machine — not a third binary. Reverse reachability is not
 * part of station topology.
 *
 * No I/O. The station configuration transport applies this value through the
 * app-owned settings service.
 */

export type RemoteStationConfigInput = {
  /** Registry id of the remote host being configured (stamped as station.hostId). */
  readonly remoteHostId: string;
  /**
   * Effective Hermes agent-key prefix for this station. Configure/deploy pass
   * the exact `hermesKeyFor(host)`. It is never inferred from a physical id.
   */
  readonly agentHostId: string;
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
    typeof input.agentHostId === "string" ? input.agentHostId.trim() : "";
  if (!isValidStationHostId(remoteHostId)) {
    throw new Error(`invalid remote host id: ${JSON.stringify(input.remoteHostId)}`);
  }
  if (!isValidStationHostId(agentHostId)) {
    throw new Error(`invalid agent host id: ${JSON.stringify(input.agentHostId)}`);
  }
  return {
    role: "remote",
    hostId: remoteHostId,
    agentHostId,
    supervisedPreferred: input.supervisedPreferred ?? true,
  };
};

export const planRemoteStationConfig = (
  input: RemoteStationConfigInput,
): RemoteStationConfigPlan => {
  const station = planRemoteStationFields(input);
  return {
    station,
    summary: `role=remote · hostId=${station.hostId} · agentHostId=${station.agentHostId} · supervisedPreferred=${station.supervisedPreferred}`,
  };
};
