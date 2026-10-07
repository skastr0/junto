import { ARTIFACTS_ENABLED, BOARD_ENABLED, BROWSER_ENABLED, PAD_ENABLED, REQUESTS_ENABLED, SHEET_ENABLED, TASKS_ENABLED } from "../../shared/features";

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
  if (commandId.startsWith("tasks.")) return TASKS_ENABLED;
  // Staging a file serves signals, which every build has.
  if (commandId === "content.stage") return true;
  if (commandId.startsWith("content.")) return TASKS_ENABLED;
  // Region rulings are part of the region contract, which rides the Tasks gate.
  if (commandId === "rulings") return TASKS_ENABLED;
  if (commandId.startsWith("board.")) return BOARD_ENABLED;
  if (commandId.startsWith("pad.")) return PAD_ENABLED;
  if (commandId === "sheet.read") return SHEET_ENABLED;
  if (commandId.startsWith("request.")) return REQUESTS_ENABLED;
  if (commandId.startsWith("artifact.")) return ARTIFACTS_ENABLED;
  if (commandId.startsWith("browser.")) return BROWSER_ENABLED;
  return true;
};

const BROWSER_INVOCATION: CapabilityInvocation = {
  port: "browser.automate",
  command: "junto browser",
  discover: "junto browser pages --json",
};

const PAD_READ_INVOCATIONS: ReadonlyArray<CapabilityInvocation> = [
  {
    port: "pad.read",
    command: "junto pad read",
    discover: "junto schema show pad.read",
  },
  {
    port: "pad.read",
    command: "junto pad digest",
    discover: "junto schema show pad.digest",
  },
  {
    port: "pad.read",
    command: "junto pad svg",
    discover: "junto schema show pad.svg",
  },
  {
    port: "pad.read",
    command: "junto pad look-here",
    discover: "junto schema show pad.look-here",
  },
  {
    port: "pad.read",
    command: "junto pad get",
    discover: "junto schema show pad.get",
  },
  {
    port: "pad.read",
    command: "junto pad tagged",
    discover: "junto schema show pad.tagged",
  },
];

const SHEET_READ_INVOCATION: CapabilityInvocation = {
  port: "sheet.read",
  command: "junto sheet read",
  discover: "junto schema show sheet.read",
};

const PAD_PATCH_INVOCATION: CapabilityInvocation = {
  port: "pad.patch",
  command: "junto pad patch",
  discover: "junto schema show pad.patch",
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
  {
    port: "verdict.post",
    command: "junto verdict post",
    discover: "junto schema show verdict.post",
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
    if (BROWSER_ENABLED && entry.grants.includes("browser.automate")) {
      invocations.push(BROWSER_INVOCATION);
    }
    if (PAD_ENABLED && entry.grants.includes("pad.read")) {
      invocations.push(...PAD_READ_INVOCATIONS);
    }
    if (PAD_ENABLED && entry.grants.includes("pad.patch")) {
      invocations.push(PAD_PATCH_INVOCATION);
    }
    if (SHEET_ENABLED && entry.grants.includes("sheet.read")) {
      invocations.push(SHEET_READ_INVOCATION);
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
