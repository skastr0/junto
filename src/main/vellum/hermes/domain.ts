declare const HermesProfileNameTypeId: unique symbol;

export type HermesProfileName = string & {
  readonly [HermesProfileNameTypeId]: typeof HermesProfileNameTypeId;
};

/**
 * Hermes host ids are canonical agent-key strings from the remote-host
 * registry (`local`, or exactly hermesKeyFor(host)). Product ids are not an
 * alternate route when a remote declares a distinct hermesId.
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
  readonly hostId: string;
  readonly agentHostId?: string;
}): HermesStationIdentity => ({
  hostId: station.hostId,
  agentHostId: station.agentHostId ?? station.hostId,
});

/**
 * `local` remains the legacy on-machine alias. The configured self Hermes key
 * is also local only inside that exact station process; no other HostId is
 * admitted by this predicate.
 */
export const isLocalHermesHost = (
  host: HermesHostId,
  station: HermesStationIdentity,
): boolean => host === "local" || host === station.agentHostId;

export const canonicalLocalAgentKey = (
  station: HermesStationIdentity,
  profile: HermesProfileName,
): string => `${station.agentHostId}:${profile}`;

/** Translate this station's canonical agent key for local-only adapters. */
export const localAdapterAgentKey = (
  key: string,
  station: HermesStationIdentity,
): string => {
  const parsed = parseAgentKey(key);
  if (!parsed || !isLocalHermesHost(parsed.host, station)) return key;
  return `local:${parsed.profile}`;
};

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
