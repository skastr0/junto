import type { IpcMain, IpcMainInvokeEvent } from "electron";
import {
  BROWSER_AUTOMATION_HERDR_AGENTS,
  IPC_CHANNELS,
  type BrowserAutomationEnableInput,
  type BrowserAutomationEnableResult,
  type BrowserAutomationErrorCode,
  type BrowserAutomationHerdrAgent,
  type BrowserAutomationListResult,
  type BrowserAutomationRevokeResult,
  type BrowserAutomationSummary,
} from "@shared/ipc";
import { nodeRefKey, parseNodeRef, type NodeRefKey } from "@shared/node-ref";

const AUTOMATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_PUBLIC_SUMMARIES = 32;

const HERMES_INPUT_KEYS = new Set(["kind", "ref"]);
const HERDR_INPUT_KEYS = new Set(["kind", "ref", "agent"]);
const HERMES_SUMMARY_KEYS = new Set([
  "automationId",
  "kind",
  "ref",
  "issuedAt",
  "expiresAt",
]);
const HERDR_SUMMARY_KEYS = new Set([...HERMES_SUMMARY_KEYS, "agent"]);
const SUCCESS_KEYS = new Set(["ok", "data"]);
const FAILURE_KEYS = new Set(["ok", "code"]);
const REVOKED_KEYS = new Set(["revoked"]);
const HERDR_AGENTS = new Set<string>(BROWSER_AUTOMATION_HERDR_AGENTS);
const ERROR_CODES = new Set<BrowserAutomationErrorCode>([
  "invalid",
  "cancelled",
  "capacity",
  "delivery_failed",
  "closed",
  "not_found",
]);

const INVALID_RESULT = Object.freeze({ ok: false as const, code: "invalid" as const });
const DELIVERY_FAILED_RESULT = Object.freeze({
  ok: false as const,
  code: "delivery_failed" as const,
});

type SanitizedAutomationResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly code: BrowserAutomationErrorCode };

export interface BrowserAutomationIpcService {
  readonly enable: (
    input: BrowserAutomationEnableInput,
  ) => BrowserAutomationEnableResult | Promise<BrowserAutomationEnableResult>;
  readonly list: () => BrowserAutomationListResult | Promise<BrowserAutomationListResult>;
  readonly revoke: (
    automationId: string,
  ) => BrowserAutomationRevokeResult | Promise<BrowserAutomationRevokeResult>;
}

/** Runtime wiring must identify the one trusted Vellum renderer WebContents. */
export type BrowserAutomationTrustedSender = (event: IpcMainInvokeEvent) => boolean;

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const hasExactKeys = (
  value: Record<string, unknown>,
  expected: ReadonlySet<string>,
): boolean => {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
};

const isCanonicalRef = (value: unknown): value is NodeRefKey => {
  if (typeof value !== "string") return false;
  const parsed = parseNodeRef(value);
  return parsed.ok && nodeRefKey(parsed.value) === value;
};

const isHerdrAgent = (value: unknown): value is BrowserAutomationHerdrAgent =>
  typeof value === "string" && HERDR_AGENTS.has(value);

const decodeEnableInput = (value: unknown): BrowserAutomationEnableInput | undefined => {
  if (!isPlainRecord(value) || !isCanonicalRef(value.ref)) return undefined;
  if (value.kind === "hermes" && hasExactKeys(value, HERMES_INPUT_KEYS)) {
    return Object.freeze({ kind: "hermes", ref: value.ref });
  }
  if (
    value.kind === "herdr" &&
    hasExactKeys(value, HERDR_INPUT_KEYS) &&
    isHerdrAgent(value.agent)
  ) {
    return Object.freeze({ kind: "herdr", ref: value.ref, agent: value.agent });
  }
  return undefined;
};

const isAutomationId = (value: unknown): value is string =>
  typeof value === "string" && AUTOMATION_ID.test(value);

const isTimestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const decodeSummary = (value: unknown): BrowserAutomationSummary | undefined => {
  if (
    !isPlainRecord(value) ||
    !isAutomationId(value.automationId) ||
    !isCanonicalRef(value.ref) ||
    !isTimestamp(value.issuedAt) ||
    !isTimestamp(value.expiresAt) ||
    value.expiresAt <= value.issuedAt
  ) {
    return undefined;
  }
  if (value.kind === "hermes" && hasExactKeys(value, HERMES_SUMMARY_KEYS)) {
    return Object.freeze({
      automationId: value.automationId,
      kind: "hermes",
      ref: value.ref,
      issuedAt: value.issuedAt,
      expiresAt: value.expiresAt,
    });
  }
  if (
    value.kind === "herdr" &&
    hasExactKeys(value, HERDR_SUMMARY_KEYS) &&
    isHerdrAgent(value.agent)
  ) {
    return Object.freeze({
      automationId: value.automationId,
      kind: "herdr",
      ref: value.ref,
      agent: value.agent,
      issuedAt: value.issuedAt,
      expiresAt: value.expiresAt,
    });
  }
  return undefined;
};

const decodeSummaryList = (
  value: unknown,
): ReadonlyArray<BrowserAutomationSummary> | undefined => {
  if (!Array.isArray(value) || value.length > MAX_PUBLIC_SUMMARIES) return undefined;
  const summaries = value.map(decodeSummary);
  if (summaries.some((summary) => summary === undefined)) return undefined;
  return Object.freeze(summaries as BrowserAutomationSummary[]);
};

const decodeRevoked = (value: unknown): { readonly revoked: true } | undefined =>
  isPlainRecord(value) &&
  hasExactKeys(value, REVOKED_KEYS) &&
  value.revoked === true
    ? Object.freeze({ revoked: true as const })
    : undefined;

const decodeServiceResult = <T>(
  value: unknown,
  decodeData: (data: unknown) => T | undefined,
): SanitizedAutomationResult<T> | undefined => {
  if (!isPlainRecord(value)) return undefined;
  if (value.ok === false && hasExactKeys(value, FAILURE_KEYS)) {
    return typeof value.code === "string" &&
      ERROR_CODES.has(value.code as BrowserAutomationErrorCode)
      ? Object.freeze({ ok: false as const, code: value.code as BrowserAutomationErrorCode })
      : undefined;
  }
  if (value.ok !== true || !hasExactKeys(value, SUCCESS_KEYS)) return undefined;
  const data = decodeData(value.data);
  return data === undefined ? undefined : Object.freeze({ ok: true as const, data });
};

const invokeService = async <T>(
  operation: () => unknown,
  decodeData: (data: unknown) => T | undefined,
): Promise<SanitizedAutomationResult<T>> => {
  try {
    const result = await operation();
    return decodeServiceResult(result, decodeData) ?? DELIVERY_FAILED_RESULT;
  } catch {
    return DELIVERY_FAILED_RESULT;
  }
};

const isTrustedMainFrame = (
  event: IpcMainInvokeEvent,
  trustedSender: BrowserAutomationTrustedSender,
): boolean => {
  try {
    return (
      event.senderFrame !== null &&
      event.senderFrame === event.sender.mainFrame &&
      trustedSender(event) === true
    );
  } catch {
    return false;
  }
};

export const registerBrowserAgentIpc = (
  ipcMain: IpcMain,
  service: BrowserAutomationIpcService,
  trustedSender: BrowserAutomationTrustedSender,
): void => {
  ipcMain.handle(
    IPC_CHANNELS.browserAutomationEnable,
    async (event, ...args: ReadonlyArray<unknown>) => {
      if (!isTrustedMainFrame(event, trustedSender) || args.length !== 1) {
        return INVALID_RESULT;
      }
      let input: BrowserAutomationEnableInput | undefined;
      try {
        input = decodeEnableInput(args[0]);
      } catch {
        return INVALID_RESULT;
      }
      if (input === undefined) return INVALID_RESULT;
      return invokeService(() => service.enable(input), decodeSummary);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.browserAutomationList,
    async (event, ...args: ReadonlyArray<unknown>) => {
      if (!isTrustedMainFrame(event, trustedSender) || args.length !== 0) {
        return INVALID_RESULT;
      }
      return invokeService(() => service.list(), decodeSummaryList);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.browserAutomationRevoke,
    async (event, ...args: ReadonlyArray<unknown>) => {
      if (
        !isTrustedMainFrame(event, trustedSender) ||
        args.length !== 1 ||
        !isAutomationId(args[0])
      ) {
        return INVALID_RESULT;
      }
      const automationId = args[0];
      return invokeService(() => service.revoke(automationId), decodeRevoked);
    },
  );
};
