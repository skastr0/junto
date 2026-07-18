declare const HermesProfileNameTypeId: unique symbol;

export type HermesProfileName = string & {
  readonly [HermesProfileNameTypeId]: typeof HermesProfileNameTypeId;
};

export type HermesHostId = "local" | "remote-a";

export interface ParsedAgentKey {
  readonly host: HermesHostId;
  readonly profile: HermesProfileName;
}

const PROFILE_NAME_RE = /^[A-Za-z0-9_-]+$/;

export const parseHermesProfileName = (value: string): HermesProfileName | undefined =>
  PROFILE_NAME_RE.test(value) ? value as HermesProfileName : undefined;

export const parseAgentKey = (key: string): ParsedAgentKey | undefined => {
  const separator = key.indexOf(":");
  if (separator <= 0) return undefined;

  const host = key.slice(0, separator);
  if (host !== "local" && host !== "remote-a") return undefined;

  const profile = parseHermesProfileName(key.slice(separator + 1));
  return profile === undefined ? undefined : { host, profile };
};

export const isDefaultHermesProfile = (profile: HermesProfileName): boolean =>
  profile === "default";
