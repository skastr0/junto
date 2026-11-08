import { ARTIFACTS_ENABLED, BROWSER_ENABLED, TASKS_ENABLED } from "../../shared/features";

export interface CapabilityInvocation {
  readonly port: string;
  readonly command: string;
  readonly discover: string;
}

/**
 * One predicate for every discovery surface a feature gate can silence:
 * schemas, examples, capability rows, and edge-grant invocations. A disabled
 * product command is never advertised, so an agent cannot discover its way
 * back to a surface the kernel already refuses.
 */
export const commandSurfaceEnabled = (commandId: string): boolean => {
  if (commandId.startsWith("task.")) return TASKS_ENABLED;
  // Staging a file serves signals, which every build has.
  if (commandId === "content.stage") return true;
  if (commandId.startsWith("content.")) return TASKS_ENABLED;
  // Region rulings are part of the region contract, which rides the Tasks gate.
  if (commandId === "rulings") return TASKS_ENABLED;
  if (commandId.startsWith("artifact.")) return ARTIFACTS_ENABLED;
  if (commandId.startsWith("browser.")) return BROWSER_ENABLED;
  return true;
};

const BROWSER_INVOCATION: CapabilityInvocation = {
  port: "browser.automate",
  command: "junto browser",
  discover: "junto browser pages",
};

const CREW_INVOCATIONS: ReadonlyArray<CapabilityInvocation> = [
  {
    port: "msg.prompt",
    command: "junto msg send --prompt",
    discover: "junto schema show msg.prompt",
  },
  {
    port: "seat.wait",
    command: "junto seat wait",
    discover: "junto schema show seat.wait",
  },
  {
    port: "terminal.read",
    command: "junto seat read",
    discover: "junto schema show seat.read",
  },
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const invocationsForConnected = (value: unknown): unknown => {
  if (!Array.isArray(value)) return value;
  return value.map((entry) => {
    if (!isRecord(entry) || !Array.isArray(entry.grants)) return entry;
    const grants = entry.grants;
    const invocations: CapabilityInvocation[] = [];
    // Inline on purpose, like the CLI's own guard: a machine bundle has no junto browser to teach.
    const machineBuild = typeof __JUNTO_MACHINE_BUILD__ === "boolean" && __JUNTO_MACHINE_BUILD__;
    if (!machineBuild && BROWSER_ENABLED && entry.grants.includes("browser.automate")) {
      invocations.push(BROWSER_INVOCATION);
    }
    invocations.push(
      ...CREW_INVOCATIONS.filter((invocation) => grants.includes(invocation.port)),
    );
    return invocations.length > 0 ? { ...entry, invocations } : entry;
  });
};

/**
 * Add command realization to live edge grants. The daemon remains the authority
 * for what is held; the CLI explains how the agent can exercise a cross-plane
 * grant without requiring a harness-native tool registry.
 */
export const annotateCapabilityInvocations = <T>(value: T): T => {
  if (!isRecord(value)) return value;
  const capabilities = isRecord(value.capabilities)
    ? {
        ...value.capabilities,
        connected: invocationsForConnected(value.capabilities.connected),
      }
    : value.capabilities;
  return {
    ...value,
    connected: invocationsForConnected(value.connected),
    ...(capabilities === undefined ? {} : { capabilities }),
  } as T;
};
