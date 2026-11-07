/**
 * Chromium switches that remove a Linux sandbox layer. The names mirror
 * sandbox/policy/switches.cc and are queried through Electron's parsed command
 * line rather than trusting process.argv retention.
 */
export const PACKAGED_SANDBOX_DISABLING_SWITCHES = Object.freeze([
  "no-sandbox",
  "disable-gpu-sandbox",
  "disable-namespace-sandbox",
  "disable-seccomp-filter-sandbox",
  "disable-setuid-sandbox",
  "no-zygote-sandbox",
] as const);

export interface PackagedSandboxSwitchQuery {
  readonly packaged: boolean;
  readonly hasSwitch: (name: string) => boolean;
}

/**
 * Returns only the canonical switch name. Caller-controlled values never
 * enter diagnostics, and unpackaged development remains outside release
 * policy so Electron's own test tooling can choose its environment.
 */
export const findPackagedSandboxDisablingSwitch = (
  input: PackagedSandboxSwitchQuery,
): (typeof PACKAGED_SANDBOX_DISABLING_SWITCHES)[number] | undefined => {
  if (!input.packaged) return undefined;
  return PACKAGED_SANDBOX_DISABLING_SWITCHES.find((name) => input.hasSwitch(name));
};
