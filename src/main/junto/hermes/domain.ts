declare const HermesProfileNameTypeId: unique symbol;

export type HermesProfileName = string & {
  readonly [HermesProfileNameTypeId]: typeof HermesProfileNameTypeId;
};

/** Hermes host ids are the registry's exact agent-key prefixes. */
export type HermesHostId = string;

export interface ParsedAgentKey {
  readonly host: HermesHostId;
  readonly profile: HermesProfileName;
}

/** Physical placement and the registry's Hermes prefix are separate facts. */
export interface HermesMachineIdentity {
  readonly hostId: string;
  readonly agentHostId: HermesHostId;
}

export const isLocalHermesHost = (
  host: HermesHostId,
  machine: HermesMachineIdentity,
): boolean => host === machine.agentHostId;

export const canonicalLocalAgentKey = (
  machine: HermesMachineIdentity,
  profile: HermesProfileName,
): string => `${machine.agentHostId}:${profile}`;

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
