declare const HermesProfileNameTypeId: unique symbol;

export type HermesProfileName = string & {
  readonly [HermesProfileNameTypeId]: typeof HermesProfileNameTypeId;
};

/**
 * Hermes host ids are canonical agent-key prefixes. The configured station
 * self id and every enrolled remote's exact hermesKeyFor(host) are identities,
 * not aliases for one another.
 */
export type HermesHostId = string;

export interface ParsedAgentKey {
  readonly host: HermesHostId;
  readonly profile: HermesProfileName;
}

/** Durable physical + Hermes self identity loaded from settings.station. */
export interface HermesStationIdentity {
  readonly hostId: string;
  readonly agentHostId: HermesHostId;
}

export const resolveHermesStationIdentity = (station: {
  readonly role: string;
  readonly hostId: string;
  readonly agentHostId?: string;
}): HermesStationIdentity => {
  if (station.role === "remote" && station.agentHostId === undefined) {
    throw new Error("Remote station is missing its canonical Hermes host identity");
  }
  return {
    hostId: station.hostId,
    // Command Center and pre-configuration identity is the physical station
    // host id. A Remote's separately configured Hermes id is mandatory above.
    agentHostId:
      station.role === "remote" ? station.agentHostId! : station.hostId,
  };
};

/**
 * A Hermes key is local only when its host prefix is the station's exact
 * configured self identity. The string `local` has no special meaning here:
 * it is local only for a station whose canonical identity is literally local.
 */
export const isLocalHermesHost = (
  host: HermesHostId,
  station: HermesStationIdentity,
): boolean => host === station.agentHostId;

export const canonicalLocalAgentKey = (
  station: HermesStationIdentity,
  profile: HermesProfileName,
): string => `${station.agentHostId}:${profile}`;

const PROFILE_NAME_RE = /^[A-Za-z0-9_-]+$/;

export const parseHermesProfileName = (value: string): HermesProfileName | undefined =>
  PROFILE_NAME_RE.test(value) ? (value as HermesProfileName) : undefined;

export const parseAgentKey = (key: string): ParsedAgentKey | undefined => {
  const separator = key.indexOf(":");
  if (separator <= 0) return undefined;

  const host = key.slice(0, separator);
  // Validate host shape (not leading dash / empty); membership is checked
  // against the registry at call sites that need a live host.
  if (!host || host.startsWith("-") || host.length > 64) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(host)) return undefined;

  const profile = parseHermesProfileName(key.slice(separator + 1));
  return profile === undefined ? undefined : { host, profile };
};

export const isDefaultHermesProfile = (profile: HermesProfileName): boolean =>
  profile === "default";
