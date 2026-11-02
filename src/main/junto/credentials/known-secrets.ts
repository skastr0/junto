/**
 * Values this machine must never let into a failure, a link frame or a log
 * row: each seat generation's resolved secrets and its credential, a Boat
 * machine key, a vault token. They live in the child's environment, not this
 * process's, so the launch path registers them here and the generation's end
 * removes them.
 *
 * The registry is the core's. Seats are spawned there, and it is the core that
 * reads a seat's environment, so this module is loaded only in the core: the
 * first registration installs it as the process's known-value source
 * (scrub.ts), and main, which holds none of these values, never imports it.
 */

import { setKnownSecretValuesSource } from "./scrub";

const registered = new Map<string, ReadonlyArray<string>>();

/** `owner` names the holder, such as "seat:<bindingId>@<epoch>"; a second call replaces its set. */
export const registerKnownSecrets = (owner: string, values: Iterable<string | undefined>): void => {
  registered.set(owner, [...values].filter((value): value is string => value !== undefined && value.length > 0));
  // The first registration is what makes this process the one that knows: a
  // process that never registers (main) keeps scrubbing with its environment.
  setKnownSecretValuesSource(registeredSecretValues);
};

export const releaseKnownSecrets = (owner: string): void => {
  registered.delete(owner);
};

/** Every registered set, flattened: the core's answer to "what must never show". */
export const registeredSecretValues = (): ReadonlyArray<string> => {
  const values: string[] = [];
  for (const set of registered.values()) values.push(...set);
  return values;
};

