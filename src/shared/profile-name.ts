/**
 * The shape of a harness profile name (Hermes), wherever one crosses a trust
 * boundary: the link's inventory snapshot and the profile a launch passes as
 * one argv value. One constant, so a profile that cannot cross cannot launch.
 *
 * No colon (the agent key is `host:profile`), no slash or dot (never a path or
 * traversal), and an alphanumeric first character (never a flag). A name
 * that does not fit is left out, never rewritten.
 *
 * Effect-free: the preload may reach this module.
 */
export const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const MAX_PROFILES = 64;

export const isProfileName = (value: string): boolean => PROFILE_NAME_PATTERN.test(value);

/** The names that fit, first come, at most MAX_PROFILES, each once. */
export const profileNamesOf = (names: readonly string[]): readonly string[] =>
  [...new Set(names.filter(isProfileName))].slice(0, MAX_PROFILES);
