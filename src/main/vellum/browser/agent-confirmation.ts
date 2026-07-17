import { isValidProfileId } from "@shared/browser";
import { formatNodeRef, parseNodeRef } from "@shared/node-ref";
import {
  BROWSER_AGENT_AUTHORITY_MAX_TARGETS,
  type BrowserAutomationConfirmation,
} from "./agent-authority";
import {
  BROWSER_CAPABILITY_ACTIONS,
  type BrowserCapabilityAction,
  type BrowserCapabilityTarget,
} from "./capabilities";

const MAX_CONFIRMATION_DETAIL_BYTES = 48 * 1_024;
const MAX_LINE_BYTES = 4_096;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const KNOWN_ACTIONS = new Set<string>(BROWSER_CAPABILITY_ACTIONS);

export interface BrowserAutomationNativePrompt {
  readonly type: "warning";
  readonly title: string;
  readonly message: string;
  readonly detail: string;
  readonly buttons: readonly ["Cancel", "Allow Access"];
  readonly defaultId: 0;
  readonly cancelId: 0;
  readonly noLink: true;
}

const isSafeLine = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  !CONTROL_CHARACTER.test(value) &&
  Buffer.byteLength(value, "utf8") <= MAX_LINE_BYTES;

const isCanonicalRef = (value: unknown): value is string => {
  if (!isSafeLine(value)) return false;
  const parsed = parseNodeRef(value);
  return parsed.ok && formatNodeRef(parsed.value) === value;
};

const isCanonicalOrigin = (value: unknown): value is string => {
  if (!isSafeLine(value)) return false;
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.origin !== "null" &&
      parsed.origin === value
    );
  } catch {
    return false;
  }
};

const isTarget = (target: BrowserCapabilityTarget): boolean =>
  typeof target === "object" &&
  target !== null &&
  isCanonicalRef(target.ref) &&
  isValidProfileId(target.profile) &&
  Array.isArray(target.exactOrigins) &&
  target.exactOrigins.length > 0 &&
  target.exactOrigins.every(isCanonicalOrigin) &&
  new Set(target.exactOrigins).size === target.exactOrigins.length;

const isActions = (
  actions: ReadonlyArray<BrowserCapabilityAction>,
): actions is ReadonlyArray<BrowserCapabilityAction> =>
  Array.isArray(actions) &&
  actions.length > 0 &&
  actions.every((action) => typeof action === "string" && KNOWN_ACTIONS.has(action)) &&
  new Set(actions).size === actions.length;

const positiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const durationLabel = (milliseconds: number): string => {
  if (milliseconds % 60_000 === 0) {
    const minutes = milliseconds / 60_000;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const seconds = Math.ceil(milliseconds / 1_000);
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
};

const targetLines = (targets: ReadonlyArray<BrowserCapabilityTarget>): string =>
  targets
    .map(
      (target, index) =>
        `${index + 1}. ${target.ref}\n` +
        `   Profile: ${target.profile}\n` +
        `   Origin${target.exactOrigins.length === 1 ? "" : "s"}: ${target.exactOrigins.join(", ")}`,
    )
    .join("\n\n");

/**
 * Snapshot the exact grant into a bounded native prompt. Undefined means the
 * scope cannot be rendered completely and issuance must fail closed.
 */
export const buildBrowserAutomationNativePrompt = (
  request: BrowserAutomationConfirmation,
): BrowserAutomationNativePrompt | undefined => {
  if (
    typeof request !== "object" ||
    request === null ||
    !isSafeLine(request.subject?.label) ||
    !Array.isArray(request.targets) ||
    request.targets.length === 0 ||
    request.targets.length > BROWSER_AGENT_AUTHORITY_MAX_TARGETS ||
    request.targetCount !== request.targets.length ||
    request.targets.some((target) => !isTarget(target)) ||
    new Set(request.targets.map((target) => target.ref)).size !== request.targets.length ||
    !isActions(request.actions) ||
    !positiveInteger(request.ttlMs) ||
    !positiveInteger(request.maxUses) ||
    !positiveInteger(request.maxInFlight)
  ) {
    return undefined;
  }

  const detail = [
    `This local agent can read, navigate, and interact with the exact browser pages below for ${durationLabel(request.ttlMs)}. Vellum revokes access when it expires or when you revoke it.`,
    `Actions: ${request.actions.join(", ")}`,
    `Command limit: ${request.maxUses}`,
    `Concurrent commands: ${request.maxInFlight}`,
    "Exact page scope:",
    targetLines(request.targets),
  ].join("\n\n");
  if (Buffer.byteLength(detail, "utf8") > MAX_CONFIRMATION_DETAIL_BYTES) return undefined;

  const count = request.targets.length;
  return Object.freeze({
    type: "warning" as const,
    title: "Browser Automation Access",
    message: `Allow ${request.subject.label} to control ${count} browser page${count === 1 ? "" : "s"}?`,
    detail,
    buttons: Object.freeze(["Cancel", "Allow Access"] as const),
    defaultId: 0 as const,
    cancelId: 0 as const,
    noLink: true as const,
  });
};
