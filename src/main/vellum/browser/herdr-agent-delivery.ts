import { isAbsolute, normalize } from "node:path";
import {
  CONTROL_CAPABILITY_ENV,
  CONTROL_HOME_ENV,
  inspectControlJson,
  isValidControlCapability,
} from "../../../shared/browser-control";
import {
  BROWSER_MAX_METADATA_BYTES,
  isUtf8WithinLimit,
  isValidBrowserSessionId,
} from "../../../shared/browser-limits";
import {
  BROWSER_AUTOMATION_HERDR_AGENTS,
  type BrowserAutomationHerdrAgent,
} from "../../../shared/ipc";
import { LocalMirrorTransport } from "../herdr/mirror-transport";

const HERDR_AGENT_START_TIMEOUT_MS = 15_000;
const HERDR_AGENT_START_MAX_RESPONSE_BYTES = 16 * 1024;
const HERDR_AGENT_START_MAX_INPUT_BYTES = 16 * 1024;

const SUPPORTED_AGENTS = Object.freeze({
  claude: Object.freeze({ name: "claude", executable: "claude" }),
  codex: Object.freeze({ name: "codex", executable: "codex" }),
  hermes: Object.freeze({ name: "hermes", executable: "hermes" }),
  kimi: Object.freeze({ name: "kimi", executable: "kimi" }),
  opencode: Object.freeze({ name: "opencode", executable: "opencode" }),
} as const satisfies Record<
  BrowserAutomationHerdrAgent,
  { readonly name: string; readonly executable: string }
>);

export type SupportedHerdrBrowserAgent = BrowserAutomationHerdrAgent;

export const SUPPORTED_HERDR_BROWSER_AGENTS = BROWSER_AUTOMATION_HERDR_AGENTS;

export interface LocalHerdrBrowserAgentStart {
  readonly agent: SupportedHerdrBrowserAgent;
  readonly capability: string;
  readonly controlHome: string;
  readonly cwd: string;
  readonly workspaceId?: string;
  readonly tabId?: string;
}

export interface LocalHerdrBrowserAgentResult {
  readonly terminalId: string;
  readonly workspaceId: string;
  readonly tabId: string;
  readonly paneId: string;
}

export type HerdrAgentDeliveryErrorCode =
  | "invalid_input"
  | "local_transport_required"
  | "transport_failed"
  | "malformed_response";

/**
 * Deliberately carries no cause or caller-controlled text. In particular, a
 * Herdr/server error can never relay the browser capability into app logs.
 */
export class HerdrAgentDeliveryError extends Error {
  override readonly name = "HerdrAgentDeliveryError";

  constructor(readonly code: HerdrAgentDeliveryErrorCode) {
    super("local Herdr browser-agent delivery failed");
  }
}

const fail = (code: HerdrAgentDeliveryErrorCode): never => {
  throw new HerdrAgentDeliveryError(code);
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const hasOnlyKeys = (
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean => Object.keys(value).every((key) => allowed.has(key));

const hasExactKeys = (
  value: Record<string, unknown>,
  expected: ReadonlySet<string>,
): boolean =>
  Object.keys(value).length === expected.size && hasOnlyKeys(value, expected);

const INPUT_KEYS = new Set([
  "agent",
  "capability",
  "controlHome",
  "cwd",
  "workspaceId",
  "tabId",
]);
const REQUIRED_INPUT_KEYS = new Set(["agent", "capability", "controlHome", "cwd"]);

const isCanonicalAbsolutePath = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  isUtf8WithinLimit(value, BROWSER_MAX_METADATA_BYTES) &&
  !/[\u0000-\u001f\u007f]/.test(value) &&
  isAbsolute(value) &&
  normalize(value) === value;

const isSupportedAgent = (value: unknown): value is SupportedHerdrBrowserAgent =>
  typeof value === "string" && Object.hasOwn(SUPPORTED_AGENTS, value);

const isNullableBoundedString = (value: unknown): boolean =>
  value === null ||
  (typeof value === "string" && isUtf8WithinLimit(value, BROWSER_MAX_METADATA_BYTES));

const AGENT_STATUSES = new Set(["idle", "working", "blocked", "done", "unknown"]);
const AGENT_INFO_KEYS = new Set([
  "agent",
  "agent_session",
  "agent_status",
  "custom_status",
  "cwd",
  "display_agent",
  "focused",
  "foreground_cwd",
  "name",
  "pane_id",
  "revision",
  "screen_detection_skipped",
  "state_labels",
  "tab_id",
  "terminal_id",
  "title",
  "workspace_id",
]);
const AGENT_SESSION_KEYS = new Set(["source", "agent", "kind", "value"]);
const AGENT_STARTED_KEYS = new Set(["type", "agent", "argv"]);

const isAgentSession = (value: unknown): boolean => {
  if (!isPlainRecord(value) || !hasExactKeys(value, AGENT_SESSION_KEYS)) return false;
  return (
    typeof value.source === "string" &&
    isUtf8WithinLimit(value.source, BROWSER_MAX_METADATA_BYTES) &&
    typeof value.agent === "string" &&
    isUtf8WithinLimit(value.agent, BROWSER_MAX_METADATA_BYTES) &&
    (value.kind === "id" || value.kind === "path") &&
    typeof value.value === "string" &&
    isUtf8WithinLimit(value.value, BROWSER_MAX_METADATA_BYTES)
  );
};

const isStateLabels = (value: unknown): boolean => {
  if (!isPlainRecord(value)) return false;
  return Object.entries(value).every(
    ([key, label]) =>
      isUtf8WithinLimit(key, BROWSER_MAX_METADATA_BYTES) &&
      typeof label === "string" &&
      isUtf8WithinLimit(label, BROWSER_MAX_METADATA_BYTES),
  );
};

const isAgentInfo = (value: unknown): value is Record<string, unknown> => {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, AGENT_INFO_KEYS)) return false;
  if (
    !isValidBrowserSessionId(value.terminal_id) ||
    !isValidBrowserSessionId(value.workspace_id) ||
    !isValidBrowserSessionId(value.tab_id) ||
    !isValidBrowserSessionId(value.pane_id) ||
    typeof value.agent_status !== "string" ||
    !AGENT_STATUSES.has(value.agent_status) ||
    typeof value.focused !== "boolean" ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0
  ) {
    return false;
  }

  for (const key of [
    "agent",
    "custom_status",
    "cwd",
    "display_agent",
    "foreground_cwd",
    "name",
    "title",
  ] as const) {
    if (key in value && !isNullableBoundedString(value[key])) return false;
  }
  if (
    "agent_session" in value &&
    value.agent_session !== null &&
    !isAgentSession(value.agent_session)
  ) {
    return false;
  }
  if (
    "screen_detection_skipped" in value &&
    typeof value.screen_detection_skipped !== "boolean"
  ) {
    return false;
  }
  if ("state_labels" in value && !isStateLabels(value.state_labels)) return false;
  return true;
};

const parseAgentStarted = (
  response: unknown,
  executable: string,
  capability: string,
): LocalHerdrBrowserAgentResult => {
  const inspected = inspectControlJson(response, HERDR_AGENT_START_MAX_RESPONSE_BYTES);
  if (!inspected.ok || !isPlainRecord(response) || !hasExactKeys(response, AGENT_STARTED_KEYS)) {
    return fail("malformed_response");
  }
  if (
    response.type !== "agent_started" ||
    !Array.isArray(response.argv) ||
    response.argv.length !== 1 ||
    response.argv[0] !== executable ||
    !isAgentInfo(response.agent)
  ) {
    return fail("malformed_response");
  }

  const agent = response.agent;
  const identifiers = [agent.terminal_id, agent.workspace_id, agent.tab_id, agent.pane_id] as const;
  if (identifiers.some((identifier) => (identifier as string).includes(capability))) {
    return fail("malformed_response");
  }

  return Object.freeze({
    terminalId: agent.terminal_id as string,
    workspaceId: agent.workspace_id as string,
    tabId: agent.tab_id as string,
    paneId: agent.pane_id as string,
  });
};

/**
 * Start one stock Herdr agent with browser authority delivered only through its
 * environment. No caller can supply a command, name, argv item, or extra env.
 */
export const startLocalHerdrBrowserAgent = async (
  transport: LocalMirrorTransport,
  input: LocalHerdrBrowserAgentStart,
): Promise<LocalHerdrBrowserAgentResult> => {
  let isLocal = false;
  try {
    isLocal = transport instanceof LocalMirrorTransport;
  } catch {
    // A hostile proxy is not a local transport.
  }
  if (!isLocal) return fail("local_transport_required");

  const inspectedInput = inspectControlJson(input, HERDR_AGENT_START_MAX_INPUT_BYTES);
  if (!inspectedInput.ok || !isPlainRecord(input) || !hasOnlyKeys(input, INPUT_KEYS)) {
    return fail("invalid_input");
  }
  for (const key of REQUIRED_INPUT_KEYS) {
    if (!(key in input)) return fail("invalid_input");
  }
  if (
    !isSupportedAgent(input.agent) ||
    !isValidControlCapability(input.capability) ||
    !isCanonicalAbsolutePath(input.controlHome) ||
    !isCanonicalAbsolutePath(input.cwd) ||
    (input.workspaceId !== undefined && !isValidBrowserSessionId(input.workspaceId)) ||
    (input.tabId !== undefined && !isValidBrowserSessionId(input.tabId)) ||
    (input.tabId !== undefined && input.workspaceId === undefined)
  ) {
    return fail("invalid_input");
  }

  const capability = input.capability;
  const nonEnvironmentValues = [input.controlHome, input.cwd, input.workspaceId, input.tabId];
  if (nonEnvironmentValues.some((value) => value?.includes(capability) === true)) {
    return fail("invalid_input");
  }

  const definition = SUPPORTED_AGENTS[input.agent];
  const env = Object.freeze({
    [CONTROL_CAPABILITY_ENV]: capability,
    [CONTROL_HOME_ENV]: input.controlHome,
  });
  const params = Object.freeze({
    name: definition.name,
    argv: Object.freeze([definition.executable]),
    cwd: input.cwd,
    env,
    focus: false,
    ...(input.workspaceId === undefined ? {} : { workspace_id: input.workspaceId }),
    ...(input.tabId === undefined ? {} : { tab_id: input.tabId }),
  });

  let response: unknown;
  try {
    response = await transport.request(
      "agent.start",
      params,
      HERDR_AGENT_START_TIMEOUT_MS,
    );
  } catch {
    return fail("transport_failed");
  }
  return parseAgentStarted(response, definition.executable, capability);
};
