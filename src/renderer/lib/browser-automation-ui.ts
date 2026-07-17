import { clampUtf8Bytes, isValidBrowserSessionId } from "@shared/browser-limits";
import type { CanvasNode } from "@shared/canvas";
import {
  BROWSER_AUTOMATION_HERDR_AGENTS,
  type BrowserAutomationEnableInput,
  type BrowserAutomationErrorCode,
  type BrowserAutomationHerdrAgent,
  type BrowserAutomationSummary,
} from "@shared/ipc";
import { formatNodeRef } from "@shared/node-ref";

const LOCAL_HERMES_AGENT = /^local:[A-Za-z0-9_-]+$/;

export const BROWSER_AUTOMATION_UI_TEXT_MAX_BYTES = 512;
export const BROWSER_AUTOMATION_AGENT_OPTIONS = BROWSER_AUTOMATION_HERDR_AGENTS;

export type BrowserAutomationEligibilityReason =
  | "unsupported"
  | "local_only"
  | "default_session_only"
  | "incomplete_binding"
  | "invalid_ref";

export type BrowserAutomationEligibility =
  | { readonly eligible: true; readonly kind: "hermes" | "herdr" }
  | {
      readonly eligible: false;
      readonly kind?: "hermes" | "herdr";
      readonly reason: BrowserAutomationEligibilityReason;
    };

export type BrowserAutomationUiOperation = "list" | "enable" | "revoke";
export interface BrowserAutomationUiNotice {
  readonly text: string;
  readonly tone: "neutral" | "error";
}

export const isBrowserAutomationHerdrAgent = (
  value: unknown,
): value is BrowserAutomationHerdrAgent =>
  typeof value === "string" &&
  BROWSER_AUTOMATION_HERDR_AGENTS.some((agent) => agent === value);

export const browserAutomationEligibility = (
  node: CanvasNode,
): BrowserAutomationEligibility => {
  const entity = node.ether?.entity;
  if (entity?.kind === "agent") {
    if (typeof entity.name !== "string" || !LOCAL_HERMES_AGENT.test(entity.name)) {
      return { eligible: false, kind: "hermes", reason: "local_only" };
    }
    return { eligible: true, kind: "hermes" };
  }

  if (entity?.kind !== "herdr") {
    return { eligible: false, reason: "unsupported" };
  }

  const binding = node.ether?.herdr;
  if (binding?.host !== "local") {
    return { eligible: false, kind: "herdr", reason: "local_only" };
  }
  if (binding.session !== undefined && binding.session !== null) {
    return { eligible: false, kind: "herdr", reason: "default_session_only" };
  }
  if (
    !isValidBrowserSessionId(binding.paneId) ||
    (binding.workspaceId !== undefined &&
      !isValidBrowserSessionId(binding.workspaceId)) ||
    (binding.tabId !== undefined && !isValidBrowserSessionId(binding.tabId)) ||
    (binding.tabId !== undefined && binding.workspaceId === undefined)
  ) {
    return { eligible: false, kind: "herdr", reason: "incomplete_binding" };
  }
  return { eligible: true, kind: "herdr" };
};

/**
 * Build the complete renderer-to-main payload. The returned object has no
 * authority knobs: main derives subject, page scope, actions, profile, TTL,
 * limits, and delivery from current trusted state after this locator arrives.
 */
export const buildBrowserAutomationEnableInput = (input: {
  readonly canvasName: string;
  readonly node: CanvasNode;
  readonly agent?: BrowserAutomationHerdrAgent;
}): BrowserAutomationEnableInput | undefined => {
  const eligibility = browserAutomationEligibility(input.node);
  if (!eligibility.eligible) return undefined;

  const ref = browserAutomationNodeRef(input.canvasName, input.node);
  if (ref === undefined) return undefined;

  if (eligibility.kind === "hermes") {
    return Object.freeze({ kind: "hermes" as const, ref });
  }
  if (!isBrowserAutomationHerdrAgent(input.agent)) return undefined;
  return Object.freeze({ kind: "herdr" as const, ref, agent: input.agent });
};

export const browserAutomationNodeRef = (
  canvasName: string,
  node: CanvasNode,
): string | undefined => {
  try {
    return formatNodeRef({ canvasName, nodeId: node.id });
  } catch {
    return undefined;
  }
};

export const isCurrentBrowserAutomationGrant = (
  grant: BrowserAutomationSummary,
  currentRef: string | undefined,
): boolean => currentRef !== undefined && grant.ref === currentRef;

export const boundedBrowserAutomationText = (
  value: string,
  maxBytes = BROWSER_AUTOMATION_UI_TEXT_MAX_BYTES,
): string => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return "";
  const bounded = clampUtf8Bytes(value, maxBytes);
  if (bounded === value) return value;
  if (maxBytes < 3) return bounded;
  return `${clampUtf8Bytes(value, maxBytes - 3)}…`;
};

const ELIGIBILITY_COPY: Readonly<Record<BrowserAutomationEligibilityReason, string>> =
  Object.freeze({
    unsupported: "Select a local Hermes agent or local Herdr node to enable access.",
    local_only: "Browser automation can only be enabled for a local agent.",
    default_session_only: "Browser automation requires Herdr's local default session.",
    incomplete_binding: "This Herdr node is not fully bound to a local pane.",
    invalid_ref: "This node does not have a valid Vellum reference.",
  });

export const browserAutomationEligibilityCopy = (
  reason: BrowserAutomationEligibilityReason,
): string => ELIGIBILITY_COPY[reason];

const OPERATION_COPY: Readonly<
  Record<BrowserAutomationUiOperation, Readonly<Record<BrowserAutomationErrorCode, string>>>
> = Object.freeze({
  list: Object.freeze({
    invalid: "Active browser access could not be read.",
    cancelled: "Active browser access could not be read.",
    capacity: "Active browser access could not be read.",
    delivery_failed: "Active browser access is temporarily unavailable.",
    closed: "Browser automation is unavailable while Vellum closes.",
    not_found: "Active browser access could not be read.",
  }),
  enable: Object.freeze({
    invalid: "This node cannot enable browser automation.",
    cancelled: "Access was not enabled.",
    capacity: "Browser automation is at capacity. Revoke an active grant and try again.",
    delivery_failed: "Browser access could not reach the local agent.",
    closed: "Browser automation is unavailable while Vellum closes.",
    not_found: "This node is no longer available.",
  }),
  revoke: Object.freeze({
    invalid: "This browser access grant could not be revoked.",
    cancelled: "This browser access grant could not be revoked.",
    capacity: "This browser access grant could not be revoked.",
    delivery_failed: "Browser access could not be revoked right now.",
    closed: "Browser automation is unavailable while Vellum closes.",
    not_found: "This browser access grant is no longer active.",
  }),
});

/** Fixed, bounded UI copy only. Unknown values and thrown exceptions never render. */
export const browserAutomationErrorCopy = (
  operation: BrowserAutomationUiOperation,
  code: unknown,
): string | undefined => {
  const knownCode: BrowserAutomationErrorCode | undefined =
    code === "invalid" ||
    code === "cancelled" ||
    code === "capacity" ||
    code === "delivery_failed" ||
    code === "closed" ||
    code === "not_found"
      ? code
      : undefined;
  const copy =
    knownCode === undefined
      ? "Browser automation is temporarily unavailable."
      : OPERATION_COPY[operation][knownCode];
  return boundedBrowserAutomationText(copy);
};

export const browserAutomationFailureNotice = (
  operation: BrowserAutomationUiOperation,
  code: unknown,
): BrowserAutomationUiNotice | undefined => {
  if (operation === "revoke" && code === "not_found") return undefined;
  const text = browserAutomationErrorCopy(operation, code);
  if (text === undefined) return undefined;
  return Object.freeze({
    text,
    tone: operation === "enable" && code === "cancelled" ? "neutral" : "error",
  });
};
