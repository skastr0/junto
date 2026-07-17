import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import {
  initialBrowserSession,
  isAllowedBrowserUrl,
  isValidProfileId,
  isWarmBrowserSession,
  reduceBrowserSession,
  warmPoolEvictions,
  type BrowserSessionMachine,
} from "@shared/browser";
import {
  BROWSER_CAPTURE_TIMEOUT_MS,
  BROWSER_EVAL_TIMEOUT_MS,
  BROWSER_MAX_ACTIVE_OPERATIONS,
  BROWSER_MAX_ACTIVE_OPERATIONS_PER_SESSION,
  BROWSER_MAX_ERROR_BYTES,
  BROWSER_MAX_EVAL_CODE_BYTES,
  BROWSER_MAX_EVAL_RESULT_BYTES,
  BROWSER_MAX_EVAL_RESULT_DEPTH,
  BROWSER_MAX_EVAL_RESULT_NODES,
  BROWSER_MAX_METADATA_BYTES,
  BROWSER_MAX_REF_BYTES,
  BROWSER_MAX_SCREENSHOT_BYTES,
  BROWSER_MAX_TITLE_BYTES,
  BROWSER_MAX_URL_BYTES,
  BROWSER_MAX_WARM_SESSIONS_HARD,
  BROWSER_NAVIGATION_TIMEOUT_MS,
  clampUtf8Bytes,
  isUtf8WithinLimit,
  isValidBrowserSessionId,
} from "@shared/browser-limits";
import type { BrowserSessionInfo, BrowserSurfaceBounds } from "@shared/ipc";
import { parseNodeRef } from "@shared/node-ref";
import type { ResolvedPageTarget } from "./page-target";
import {
  makeBrowserProfileService,
  type BrowserProfileServiceApi,
} from "./profiles";
import {
  makeBrowserProfileGate,
  type BrowserProfileBlock,
  type BrowserProfileGate,
  type BrowserProfileSnapshot,
} from "./profile-gate";

/**
 * Thin Electron seam. The real adapter creates a partitioned
 * WebContentsView parented under the BrowserWindow contentView. Tests inject
 * a spy. destroy() releases only the runtime view; profile storage persists.
 */
export interface BrowserViewHandle {
  loadUrl(url: string, expectedSessionId: string): void;
  setTopLevelOriginGuard?(origin: string): void;
  attach(bounds: BrowserSurfaceBounds): void;
  setBounds(bounds: BrowserSurfaceBounds): void;
  detach(): void;
  destroy(): void;
  /** Production resolves this only after Electron emits `destroyed`. */
  whenDestroyed?(): Promise<void>;
  executeJavaScript?(code: string): Promise<unknown>;
  capturePagePng?(): Promise<Uint8Array>;
}

export interface BrowserViewEvents {
  readonly onNavigationStart: (event: {
    readonly url: string;
    readonly isSameDocument: boolean;
    readonly expectedSessionId?: string;
  }) => string | undefined;
  readonly onNavigationAmbiguous: (sessionId: string) => void;
  readonly onLoadOk: (sessionId: string, title?: string) => void;
  readonly onLoadFail: (sessionId: string, message: string) => void;
  readonly onNavigationUrl: (sessionId: string, url: string) => void;
}

export interface BrowserViewOptions {
  /**
   * Main-frame navigation is pinned to this exact origin. UI-owned views omit
   * the option and retain the ordinary public-target browser policy.
   */
  readonly exactTopLevelOrigin?: string;
}

export type BrowserViewAdapter = (
  partition: string,
  events: BrowserViewEvents,
  options?: BrowserViewOptions,
) => BrowserViewHandle;

export type BrowserTargetAdmission = (url: string) => boolean;

export type BrowserErrorCode =
  | "invalid"
  | "not_found"
  | "forbidden"
  | "failed"
  | "timeout"
  | "cancelled"
  | "resource_exhausted"
  | "unsupported_result"
  | "result_too_large";

export interface BrowserResultOk<T> {
  readonly ok: true;
  readonly data: T;
}
export interface BrowserResultErr {
  readonly ok: false;
  readonly code: BrowserErrorCode;
  readonly message: string;
}
export type BrowserResult<T> = BrowserResultOk<T> | BrowserResultErr;

export const BROWSER_PROFILE_VIEW_DESTROY_TIMEOUT_MS = 5_000;

export interface BrowserProfileQuiescenceSummary {
  readonly pendingOpensInvalidated: number;
  readonly sessionsDestroyed: number;
  readonly viewsDestroyed: number;
}

export interface BrowserProfileQuiescence {
  readonly block: BrowserProfileBlock;
  readonly completion: Promise<BrowserResult<BrowserProfileQuiescenceSummary>>;
}

type PowerfulOperationKind = "navigation" | "eval" | "screenshot";

class BrowserOperationFailure extends Error {
  constructor(
    readonly code: Extract<BrowserErrorCode, "timeout" | "cancelled" | "not_found">,
    message: string,
  ) {
    super(message);
    this.name = "BrowserOperationFailure";
  }
}

interface ActiveOperation {
  readonly kind: PowerfulOperationKind;
  sessionId: string;
  readonly timeoutMs: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  readonly signal?: AbortSignal;
  abortListener: (() => void) | undefined;
  reject: ((failure: BrowserOperationFailure) => void) | undefined;
}

interface SessionEntry {
  readonly owner: string;
  sessionId: string;
  readonly ref: string;
  readonly nodeId: string;
  readonly profile: string;
  readonly targetUrl: string;
  currentUrl: string | undefined;
  currentOrigin: string | undefined;
  url: string;
  machine: BrowserSessionMachine;
  attached: boolean;
  navigationInFlight: string | undefined;
  activeOperation: ActiveOperation | undefined;
  lastActiveAt: number;
  view: BrowserViewHandle;
  readonly navigationWaiters: Set<NavigationWaiter>;
}

interface PendingOpen {
  readonly target: ResolvedPageTarget;
  readonly ownerEpoch: number;
  readonly profileSnapshot: BrowserProfileSnapshot;
  readonly promise: Promise<BrowserResult<BrowserSessionInfo>>;
}

interface NavigationWaiter {
  readonly sessionId: string;
  readonly signal?: AbortSignal;
  abortListener: (() => void) | undefined;
  readonly resolve: (result: BrowserResult<BrowserSessionInfo>) => void;
}

/** Main-process-only view used by capability authorization. */
export interface BrowserSessionAuthorizationSnapshot {
  readonly owner: string;
  readonly sessionId: string;
  readonly generation: string;
  readonly ref: string;
  readonly profile: string;
  readonly origin?: string;
  readonly navigationInFlight: boolean;
}

export const BROWSER_UI_SESSION_OWNER = "vellum-ui";

const err = (code: BrowserErrorCode, message: string): BrowserResultErr => ({
  ok: false,
  code,
  message: clampUtf8Bytes(message, BROWSER_MAX_ERROR_BYTES),
});

type EvalJsonValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "unsupported_result" | "result_too_large" };

const validateEvalJson = (root: unknown): EvalJsonValidation => {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [
    { value: root, depth: 0 },
  ];
  let nodeCount = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    nodeCount += 1;
    if (nodeCount > BROWSER_MAX_EVAL_RESULT_NODES) {
      return { ok: false, code: "result_too_large" };
    }

    const { value, depth } = current;
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    ) {
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return { ok: false, code: "unsupported_result" };
      continue;
    }
    if (typeof value !== "object") {
      return { ok: false, code: "unsupported_result" };
    }
    if (depth >= BROWSER_MAX_EVAL_RESULT_DEPTH) {
      return { ok: false, code: "result_too_large" };
    }

    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        return { ok: false, code: "unsupported_result" };
      }
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      if (
        lengthDescriptor === undefined ||
        !("value" in lengthDescriptor) ||
        typeof lengthDescriptor.value !== "number" ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0 ||
        lengthDescriptor.value > BROWSER_MAX_EVAL_RESULT_NODES - nodeCount
      ) {
        return { ok: false, code: "result_too_large" };
      }
      const length = lengthDescriptor.value;
      const keys = Reflect.ownKeys(value);
      if (keys.length !== length + 1) {
        return { ok: false, code: "unsupported_result" };
      }
      for (const key of keys) {
        if (key === "length") continue;
        if (typeof key !== "string") return { ok: false, code: "unsupported_result" };
        const index = Number(key);
        if (
          !Number.isSafeInteger(index) ||
          index < 0 ||
          index >= length ||
          String(index) !== key
        ) {
          return { ok: false, code: "unsupported_result" };
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
          descriptor === undefined ||
          descriptor.enumerable !== true ||
          !("value" in descriptor)
        ) {
          return { ok: false, code: "unsupported_result" };
        }
        pending.push({ value: descriptor.value, depth: depth + 1 });
      }
      continue;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return { ok: false, code: "unsupported_result" };
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return { ok: false, code: "unsupported_result" };
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !("value" in descriptor)
      ) {
        return { ok: false, code: "unsupported_result" };
      }
      pending.push({ value: descriptor.value, depth: depth + 1 });
    }
  }

  return { ok: true };
};

const decodeEvalEnvelope = (value: unknown): BrowserResult<{ result: unknown }> => {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return err("unsupported_result", "eval returned a malformed result envelope");
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return err("unsupported_result", "eval returned a foreign result envelope");
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) {
      return err("unsupported_result", "eval returned a malformed result envelope");
    }
    const readData = (key: string): unknown => {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !("value" in descriptor)
      ) {
        throw new Error("malformed eval envelope");
      }
      return descriptor.value;
    };
    if (readData("__vellumEval") !== 1) {
      return err("unsupported_result", "eval returned a foreign result envelope");
    }

    const status = readData("status");
    if (status === "ok") {
      if (
        keys.length !== 3 ||
        !keys.includes("__vellumEval") ||
        !keys.includes("status") ||
        !keys.includes("json")
      ) {
        return err("unsupported_result", "eval returned a malformed success envelope");
      }
      const json = readData("json");
      if (typeof json !== "string") {
        return err("unsupported_result", "eval returned a malformed JSON payload");
      }
      if (!isUtf8WithinLimit(json, BROWSER_MAX_EVAL_RESULT_BYTES)) {
        return err("result_too_large", "eval result exceeds the hard byte limit");
      }

      let result: unknown;
      try {
        result = JSON.parse(json) as unknown;
      } catch {
        return err("unsupported_result", "eval returned invalid JSON");
      }
      const validation = validateEvalJson(result);
      if (!validation.ok) {
        return err(
          validation.code,
          validation.code === "result_too_large"
            ? "eval result exceeds a hard structural limit"
            : "eval result is not finite plain JSON",
        );
      }
      return { ok: true, data: { result } };
    }

    if (status === "unsupported_result" || status === "result_too_large") {
      if (
        keys.length !== 3 ||
        !keys.includes("__vellumEval") ||
        !keys.includes("status") ||
        !keys.includes("message")
      ) {
        return err("unsupported_result", "eval returned a malformed error envelope");
      }
      const message = readData("message");
      if (typeof message !== "string") {
        return err("unsupported_result", "eval returned a malformed error message");
      }
      return err(status, message);
    }

    return err("unsupported_result", "eval returned an unknown result status");
  } catch {
    return err("unsupported_result", "eval returned a malformed result envelope");
  }
};

const sameTarget = (left: ResolvedPageTarget, right: ResolvedPageTarget): boolean =>
  left.ref === right.ref &&
  left.nodeId === right.nodeId &&
  left.url === right.url &&
  left.profile === right.profile;

const exactBrowserUrl = (url: string): string | undefined => {
  if (!isUtf8WithinLimit(url, BROWSER_MAX_URL_BYTES)) return undefined;
  try {
    const parsed = new URL(url);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username !== "" ||
      parsed.password !== ""
    ) {
      return undefined;
    }
    return parsed.href;
  } catch {
    return undefined;
  }
};

const exactBrowserOrigin = (url: string): string | undefined => {
  const exactUrl = exactBrowserUrl(url);
  return exactUrl === undefined ? undefined : new URL(exactUrl).origin;
};

const isAborted = (signal?: AbortSignal): boolean => signal?.aborted ?? false;

const validateTarget = (
  target: ResolvedPageTarget,
  targetAdmission: BrowserTargetAdmission,
): BrowserResultErr | undefined => {
  if (!isUtf8WithinLimit(target.ref, BROWSER_MAX_REF_BYTES)) {
    return err("invalid", "resolved page target ref exceeds the hard limit");
  }
  const parsed = parseNodeRef(target.ref);
  if (!parsed.ok || parsed.value.nodeId !== target.nodeId) {
    return err("invalid", "resolved page target does not match its canonical ref");
  }
  if (!isUtf8WithinLimit(target.url, BROWSER_MAX_URL_BYTES)) {
    return err("invalid", "resolved page target URL exceeds the hard limit");
  }
  if (!targetAdmission(target.url)) {
    return err("forbidden", `url not allowed (http/https only): ${target.url}`);
  }
  if (!isValidProfileId(target.profile)) {
    return err("invalid", "resolved page target has an invalid browser profile");
  }
  return undefined;
};

/**
 * Warm browser pool. Runtime authority is a fresh opaque sessionId. A
 * canonical page ref is only the secondary key used for warm reuse; nodeId is
 * display metadata and is never accepted by an existing-session operation.
 */
/** User-facing browser pool limits. Production wires this to SettingsService. */
export type BrowserPoolLimits = {
  readonly maxVisibleSurfaces: number;
  readonly maxWarmSessions: number;
};

export class BrowserSessionService {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly sessionIdByOwnerRef = new Map<string, Map<string, string>>();
  private readonly pendingOpenByOwnerRef = new Map<string, Map<string, PendingOpen>>();
  private readonly ownerEpochs = new Map<string, number>();
  private activeOperationCount = 0;
  private sink: ((session: BrowserSessionInfo) => void) | undefined;
  private readonly viewDestroyTimeoutMs: number;
  // Sole durable SoT for these numbers is Settings.browser; profiles.config
  // remains fallback for tests that never install a limits provider.
  private poolLimits: (() => Promise<BrowserPoolLimits>) | undefined;

  constructor(
    private readonly adapter: BrowserViewAdapter,
    private readonly profiles: BrowserProfileServiceApi = makeBrowserProfileService(),
    private readonly now: () => number = Date.now,
    private readonly generateSessionId: () => string = randomUUID,
    private readonly targetAdmission: BrowserTargetAdmission = isAllowedBrowserUrl,
    private readonly profileGate: BrowserProfileGate = makeBrowserProfileGate(),
    viewDestroyTimeoutMs: number = BROWSER_PROFILE_VIEW_DESTROY_TIMEOUT_MS,
  ) {
    this.viewDestroyTimeoutMs =
      Number.isFinite(viewDestroyTimeoutMs) && viewDestroyTimeoutMs > 0
        ? Math.min(Math.floor(viewDestroyTimeoutMs), BROWSER_PROFILE_VIEW_DESTROY_TIMEOUT_MS)
        : BROWSER_PROFILE_VIEW_DESTROY_TIMEOUT_MS;
  }

  setSink(sink: (session: BrowserSessionInfo) => void): void {
    this.sink = sink;
  }

  /** Install Settings (or test fake) as the pool-limits authority. */
  setPoolLimitsProvider(provider: () => Promise<BrowserPoolLimits>): void {
    this.poolLimits = provider;
  }

  private ownerRefSessions(owner: string, create: true): Map<string, string>;
  private ownerRefSessions(owner: string, create?: false): Map<string, string> | undefined;
  private ownerRefSessions(
    owner: string,
    create = false,
  ): Map<string, string> | undefined {
    const existing = this.sessionIdByOwnerRef.get(owner);
    if (existing !== undefined || !create) return existing;
    const created = new Map<string, string>();
    this.sessionIdByOwnerRef.set(owner, created);
    return created;
  }

  private ownerPendingOpens(owner: string, create: true): Map<string, PendingOpen>;
  private ownerPendingOpens(owner: string, create?: false): Map<string, PendingOpen> | undefined;
  private ownerPendingOpens(
    owner: string,
    create = false,
  ): Map<string, PendingOpen> | undefined {
    const existing = this.pendingOpenByOwnerRef.get(owner);
    if (existing !== undefined || !create) return existing;
    const created = new Map<string, PendingOpen>();
    this.pendingOpenByOwnerRef.set(owner, created);
    return created;
  }

  private ownerEpoch(owner: string): number {
    return this.ownerEpochs.get(owner) ?? 0;
  }

  private isOpenAttemptCurrent(
    owner: string,
    ownerEpoch: number,
    profileSnapshot: BrowserProfileSnapshot,
    signal?: AbortSignal,
  ): boolean {
    return (
      this.ownerEpoch(owner) === ownerEpoch &&
      this.profileGate.isCurrent(profileSnapshot) &&
      !isAborted(signal)
    );
  }

  private async awaitOwnerOpen(
    owner: string,
    record: PendingOpen,
  ): Promise<BrowserResult<BrowserSessionInfo>> {
    const result = await record.promise;
    if (!this.isOpenAttemptCurrent(owner, record.ownerEpoch, record.profileSnapshot)) {
      return err("cancelled", "navigation cancelled");
    }
    if (result.ok && this.entryForOwner(owner, result.data.sessionId) === undefined) {
      return err("not_found", `no session for ${result.data.sessionId}`);
    }
    return result;
  }

  private async resolvePoolLimits(): Promise<BrowserPoolLimits> {
    if (this.poolLimits) return this.poolLimits();
    const config = await Effect.runPromise(this.profiles.readConfig);
    return {
      maxVisibleSurfaces: config.maxVisibleSurfaces,
      maxWarmSessions: config.maxWarmSessions,
    };
  }

  private releaseOperation(
    entry: SessionEntry,
    operation: ActiveOperation,
    failure?: BrowserOperationFailure,
  ): void {
    if (entry.activeOperation !== operation) return;
    entry.activeOperation = undefined;
    if (operation.timer !== undefined) {
      clearTimeout(operation.timer);
      operation.timer = undefined;
    }
    if (operation.signal !== undefined && operation.abortListener !== undefined) {
      operation.signal.removeEventListener("abort", operation.abortListener);
      operation.abortListener = undefined;
    }
    this.activeOperationCount = Math.max(0, this.activeOperationCount - 1);
    const reject = operation.reject;
    operation.reject = undefined;
    if (failure !== undefined) reject?.(failure);
  }

  private armOperationDeadline(entry: SessionEntry, operation: ActiveOperation): void {
    if (operation.timer !== undefined) clearTimeout(operation.timer);
    const timer = setTimeout(() => {
      if (
        entry.activeOperation !== operation ||
        operation.timer !== timer ||
        !this.isCurrent(entry)
      ) {
        return;
      }
      this.destroySession(
        entry.sessionId,
        new BrowserOperationFailure(
          "timeout",
          `${operation.kind} timed out after ${operation.timeoutMs}ms`,
        ),
      );
    }, operation.timeoutMs);
    operation.timer = timer;
  }

  private acquireOperation(
    entry: SessionEntry,
    kind: PowerfulOperationKind,
    sessionId: string,
    timeoutMs: number,
    signal?: AbortSignal,
    reject?: (failure: BrowserOperationFailure) => void,
  ): BrowserResult<ActiveOperation> {
    if (!this.isCurrent(entry) || entry.sessionId !== sessionId) {
      return err("not_found", `no session for ${sessionId}`);
    }
    if (signal?.aborted === true) {
      this.destroySession(
        entry.sessionId,
        new BrowserOperationFailure("cancelled", `${kind} cancelled`),
      );
      return err("cancelled", `${kind} cancelled`);
    }
    if (entry.activeOperation !== undefined) {
      return err(
        "resource_exhausted",
        `session already has ${BROWSER_MAX_ACTIVE_OPERATIONS_PER_SESSION} powerful operation in flight`,
      );
    }
    if (this.activeOperationCount >= BROWSER_MAX_ACTIVE_OPERATIONS) {
      return err(
        "resource_exhausted",
        `browser operation capacity reached (${BROWSER_MAX_ACTIVE_OPERATIONS})`,
      );
    }

    const operation: ActiveOperation = {
      kind,
      sessionId,
      timeoutMs,
      timer: undefined,
      ...(signal !== undefined ? { signal } : {}),
      abortListener: undefined,
      reject,
    };
    entry.activeOperation = operation;
    this.activeOperationCount += 1;
    this.armOperationDeadline(entry, operation);
    if (signal !== undefined) {
      operation.abortListener = () => {
        if (entry.activeOperation !== operation || !this.isCurrent(entry)) return;
        this.destroySession(
          entry.sessionId,
          new BrowserOperationFailure("cancelled", `${kind} cancelled`),
        );
      };
      signal.addEventListener("abort", operation.abortListener, { once: true });
    }
    return { ok: true, data: operation };
  }

  private retargetNavigation(
    entry: SessionEntry,
    operation: ActiveOperation,
    sessionId: string,
  ): void {
    operation.sessionId = sessionId;
    this.armOperationDeadline(entry, operation);
  }

  private async runPowerfulOperation<T>(input: {
    readonly owner: string;
    readonly entry: SessionEntry;
    readonly sessionId: string;
    readonly kind: "eval" | "screenshot";
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
    readonly run: () => Promise<T>;
  }): Promise<BrowserResult<T>> {
    let rejectFailure!: (failure: BrowserOperationFailure) => void;
    const failed = new Promise<never>((_resolve, reject) => {
      rejectFailure = reject;
    });
    const admitted = this.acquireOperation(
      input.entry,
      input.kind,
      input.sessionId,
      input.timeoutMs,
      input.signal,
      rejectFailure,
    );
    if (!admitted.ok) return admitted;
    const operation = admitted.data;

    try {
      const value = await Promise.race([Promise.resolve().then(input.run), failed]);
      if (
        !this.isCurrent(input.entry) ||
        input.entry.owner !== input.owner ||
        input.entry.sessionId !== input.sessionId ||
        input.entry.activeOperation !== operation
      ) {
        return err("not_found", `no session for ${input.sessionId}`);
      }
      this.releaseOperation(input.entry, operation);
      return { ok: true, data: value };
    } catch (error) {
      if (error instanceof BrowserOperationFailure) {
        return err(error.code, error.message);
      }
      if (
        !this.isCurrent(input.entry) ||
        input.entry.owner !== input.owner ||
        input.entry.sessionId !== input.sessionId
      ) {
        return err("not_found", `no session for ${input.sessionId}`);
      }
      this.releaseOperation(input.entry, operation);
      return err("failed", error instanceof Error ? error.message : String(error));
    }
  }

  private info(entry: SessionEntry): BrowserSessionInfo {
    return {
      sessionId: entry.sessionId,
      ref: entry.ref,
      nodeId: entry.nodeId,
      url: clampUtf8Bytes(entry.url, BROWSER_MAX_METADATA_BYTES),
      profile: entry.profile,
      state: entry.machine.state,
      attached: entry.attached,
      ...(entry.machine.title !== undefined
        ? { title: clampUtf8Bytes(entry.machine.title, BROWSER_MAX_TITLE_BYTES) }
        : {}),
      ...(entry.machine.lastError !== undefined
        ? { lastError: clampUtf8Bytes(entry.machine.lastError, BROWSER_MAX_ERROR_BYTES) }
        : {}),
    };
  }

  private entryForOwner(owner: string, sessionId: string): SessionEntry | undefined {
    const entry = this.sessions.get(sessionId);
    return entry !== undefined && entry.owner === owner && this.isCurrent(entry)
      ? entry
      : undefined;
  }

  private isCurrent(entry: SessionEntry): boolean {
    return (
      this.sessions.get(entry.sessionId) === entry &&
      this.ownerRefSessions(entry.owner)?.get(entry.ref) === entry.sessionId
    );
  }

  private emit(entry: SessionEntry): void {
    if (entry.owner === BROWSER_UI_SESSION_OWNER && this.isCurrent(entry)) {
      this.sink?.(this.info(entry));
    }
  }

  private settleNavigationWaiters(
    entry: SessionEntry,
    sessionId: string,
    result: BrowserResult<BrowserSessionInfo>,
  ): void {
    for (const waiter of [...entry.navigationWaiters]) {
      if (waiter.sessionId !== sessionId) continue;
      entry.navigationWaiters.delete(waiter);
      if (waiter.signal !== undefined && waiter.abortListener !== undefined) {
        waiter.signal.removeEventListener("abort", waiter.abortListener);
        waiter.abortListener = undefined;
      }
      waiter.resolve(result);
    }
  }

  private reduceCurrent(
    entry: SessionEntry,
    event: Parameters<typeof reduceBrowserSession>[1],
  ): void {
    if (!this.isCurrent(entry)) return;
    const next = reduceBrowserSession(entry.machine, event);
    if (next === entry.machine) return;
    entry.machine = next;
    this.emit(entry);
  }

  private finishGeneration(
    entry: SessionEntry,
    sessionId: string,
    event: Parameters<typeof reduceBrowserSession>[1],
  ): void {
    if (
      entry.sessionId !== sessionId ||
      entry.navigationInFlight !== sessionId ||
      !this.isCurrent(entry)
    ) {
      return;
    }
    const operation = entry.activeOperation;
    if (
      operation === undefined ||
      operation.kind !== "navigation" ||
      operation.sessionId !== sessionId
    ) {
      return;
    }
    this.releaseOperation(entry, operation);
    entry.navigationInFlight = undefined;
    const boundedEvent =
      event.type === "load_ok" && event.title !== undefined
        ? { ...event, title: clampUtf8Bytes(event.title, BROWSER_MAX_TITLE_BYTES) }
        : event.type === "load_fail"
          ? { ...event, message: clampUtf8Bytes(event.message, BROWSER_MAX_ERROR_BYTES) }
          : event;
    this.reduceCurrent(entry, boundedEvent);
    this.settleNavigationWaiters(
      entry,
      sessionId,
      boundedEvent.type === "load_fail"
        ? err("failed", boundedEvent.message)
        : { ok: true, data: this.info(entry) },
    );
  }

  private updateGenerationUrl(entry: SessionEntry, sessionId: string, url: string): void {
    if (entry.sessionId !== sessionId || !this.isCurrent(entry)) return;
    entry.currentUrl = exactBrowserUrl(url);
    entry.currentOrigin = exactBrowserOrigin(url);
    entry.url = clampUtf8Bytes(url, BROWSER_MAX_METADATA_BYTES);
    this.emit(entry);
  }

  private register(entry: SessionEntry): void {
    this.sessions.set(entry.sessionId, entry);
    this.ownerRefSessions(entry.owner, true).set(entry.ref, entry.sessionId);
  }

  private unregister(entry: SessionEntry): void {
    if (this.sessions.get(entry.sessionId) === entry) this.sessions.delete(entry.sessionId);
    const refs = this.ownerRefSessions(entry.owner);
    if (refs?.get(entry.ref) === entry.sessionId) {
      refs.delete(entry.ref);
      if (refs.size === 0) this.sessionIdByOwnerRef.delete(entry.owner);
    }
  }

  private mintSessionId(): BrowserResult<string> {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      let candidate: string;
      try {
        candidate = this.generateSessionId();
      } catch (error) {
        return err("failed", error instanceof Error ? error.message : String(error));
      }
      if (isValidBrowserSessionId(candidate) && !this.sessions.has(candidate)) {
        return { ok: true, data: candidate };
      }
    }
    return err("failed", "could not mint a unique browser session id");
  }

  private rotateGeneration(
    entry: SessionEntry,
    url: string,
  ): BrowserResult<string> {
    if (!this.isCurrent(entry)) return err("not_found", `no session for ${entry.sessionId}`);
    const minted = this.mintSessionId();
    if (!minted.ok) return minted;
    this.sessions.delete(entry.sessionId);
    entry.sessionId = minted.data;
    entry.currentUrl = exactBrowserUrl(url);
    entry.currentOrigin = exactBrowserOrigin(url);
    entry.url = clampUtf8Bytes(url, BROWSER_MAX_METADATA_BYTES);
    this.sessions.set(entry.sessionId, entry);
    this.ownerRefSessions(entry.owner, true).set(entry.ref, entry.sessionId);
    return minted;
  }

  private navigationStarted(
    entry: SessionEntry,
    event: {
      readonly url: string;
      readonly isSameDocument: boolean;
      readonly expectedSessionId?: string;
    },
  ): string | undefined {
    if (!this.isCurrent(entry)) return undefined;
    if (event.isSameDocument) {
      this.updateGenerationUrl(entry, entry.sessionId, event.url);
      return entry.sessionId;
    }
    if (event.expectedSessionId !== undefined) {
      if (event.expectedSessionId !== entry.sessionId) return undefined;
      const operation = entry.activeOperation;
      if (
        operation === undefined ||
        operation.kind !== "navigation" ||
        operation.sessionId !== entry.sessionId
      ) {
        this.destroySession(entry.sessionId);
        return undefined;
      }
      entry.currentUrl = exactBrowserUrl(event.url);
      entry.currentOrigin = exactBrowserOrigin(event.url);
      entry.url = clampUtf8Bytes(event.url, BROWSER_MAX_METADATA_BYTES);
      entry.navigationInFlight = entry.sessionId;
      this.reduceCurrent(entry, { type: "load_start" });
      return entry.sessionId;
    }
    const active = entry.activeOperation;
    if (active !== undefined && active.kind !== "navigation") {
      this.destroySession(entry.sessionId);
      return undefined;
    }
    const rotated = this.rotateGeneration(entry, event.url);
    if (!rotated.ok) {
      this.destroySession(entry.sessionId);
      return undefined;
    }
    if (active !== undefined) {
      this.retargetNavigation(entry, active, rotated.data);
    } else {
      const admitted = this.acquireOperation(
        entry,
        "navigation",
        rotated.data,
        BROWSER_NAVIGATION_TIMEOUT_MS,
      );
      if (!admitted.ok) {
        this.destroySession(entry.sessionId);
        return undefined;
      }
    }
    entry.navigationInFlight = rotated.data;
    this.reduceCurrent(entry, { type: "load_start" });
    return rotated.data;
  }

  private navigationAmbiguous(entry: SessionEntry, sessionId: string): void {
    if (entry.sessionId !== sessionId || !this.isCurrent(entry)) return;
    this.destroySession(sessionId);
  }

  async listProfiles(): Promise<
    BrowserResult<ReadonlyArray<{ id: string; label?: string; default?: boolean }>>
  > {
    try {
      const config = await Effect.runPromise(this.profiles.readConfig);
      return {
        ok: true,
        data: config.profiles.map((profile) => ({
          id: profile.id,
          ...(profile.label !== undefined ? { label: profile.label } : {}),
          ...(profile.id === config.defaultProfile ? { default: true } : {}),
        })),
      };
    } catch (error) {
      return err("failed", error instanceof Error ? error.message : String(error));
    }
  }

  async surfaceConfig(): Promise<
    BrowserResult<{ maxVisibleSurfaces: number; maxWarmSessions: number }>
  > {
    try {
      const limits = await this.resolvePoolLimits();
      return {
        ok: true,
        data: {
          maxVisibleSurfaces: limits.maxVisibleSurfaces,
          maxWarmSessions: limits.maxWarmSessions,
        },
      };
    } catch (error) {
      return err("failed", error instanceof Error ? error.message : String(error));
    }
  }

  /** Same-ref callers share exactly one creation attempt and one sessionId. */
  async open(
    target: ResolvedPageTarget,
    signal?: AbortSignal,
  ): Promise<BrowserResult<BrowserSessionInfo>> {
    return this.openForOwner(BROWSER_UI_SESSION_OWNER, target, signal);
  }

  /** Same owner+ref callers share one creation attempt; owners never share a view. */
  async openForOwner(
    owner: string,
    target: ResolvedPageTarget,
    signal?: AbortSignal,
  ): Promise<BrowserResult<BrowserSessionInfo>> {
    const invalid = validateTarget(target, this.targetAdmission);
    if (invalid !== undefined) return invalid;
    if (
      owner !== BROWSER_UI_SESSION_OWNER &&
      exactBrowserOrigin(target.url) === undefined
    ) {
      return err("forbidden", "automation target has no exact browser origin");
    }
    if (isAborted(signal)) return err("cancelled", "navigation cancelled");
    const profileSnapshot = this.profileGate.snapshot(target.profile);
    if (profileSnapshot === undefined) {
      return err("forbidden", "browser profile is unavailable");
    }

    const epoch = this.ownerEpoch(owner);
    const pendingByRef = this.ownerPendingOpens(owner, true);
    const pending = pendingByRef.get(target.ref);
    if (pending !== undefined) {
      return sameTarget(pending.target, target)
        ? this.awaitOwnerOpen(owner, pending)
        : err("invalid", "canonical page ref resolved to conflicting page metadata");
    }

    const promise = this.openResolved(owner, epoch, profileSnapshot, target, signal);
    const record: PendingOpen = {
      target,
      ownerEpoch: epoch,
      profileSnapshot,
      promise,
    };
    pendingByRef.set(target.ref, record);
    try {
      return await this.awaitOwnerOpen(owner, record);
    } finally {
      if (pendingByRef.get(target.ref) === record) {
        pendingByRef.delete(target.ref);
        if (pendingByRef.size === 0 && this.pendingOpenByOwnerRef.get(owner) === pendingByRef) {
          this.pendingOpenByOwnerRef.delete(owner);
        }
      }
    }
  }

  private async openResolved(
    owner: string,
    ownerEpoch: number,
    profileSnapshot: BrowserProfileSnapshot,
    target: ResolvedPageTarget,
    signal?: AbortSignal,
  ): Promise<BrowserResult<BrowserSessionInfo>> {
    if (!this.isOpenAttemptCurrent(owner, ownerEpoch, profileSnapshot, signal)) {
      return err("cancelled", "navigation cancelled");
    }
    const ownerRefs = this.ownerRefSessions(owner);
    const existingId = ownerRefs?.get(target.ref);
    const existing = existingId === undefined ? undefined : this.sessions.get(existingId);
    if (existingId !== undefined && existing === undefined) ownerRefs?.delete(target.ref);
    if (existing !== undefined && isWarmBrowserSession(existing.machine.state)) {
      const currentTarget: ResolvedPageTarget = {
        ref: existing.ref,
        nodeId: existing.nodeId,
        url: existing.targetUrl,
        profile: existing.profile,
      };
      if (!sameTarget(currentTarget, target)) {
        return err("invalid", "canonical page ref changed while its session is warm");
      }
      existing.lastActiveAt = this.now();
      return { ok: true, data: this.info(existing) };
    }

    let partition: string;
    let maxWarmSessions: number;
    try {
      partition = await Effect.runPromise(this.profiles.partitionName(target.profile));
      if (!this.isOpenAttemptCurrent(owner, ownerEpoch, profileSnapshot, signal)) {
        return err("cancelled", "navigation cancelled");
      }
      const limits = await this.resolvePoolLimits();
      if (!this.isOpenAttemptCurrent(owner, ownerEpoch, profileSnapshot, signal)) {
        return err("cancelled", "navigation cancelled");
      }
      maxWarmSessions = Math.min(
        BROWSER_MAX_WARM_SESSIONS_HARD,
        Number.isFinite(limits.maxWarmSessions)
          ? Math.max(1, Math.floor(limits.maxWarmSessions))
          : 1,
      );
      await Effect.runPromise(this.profiles.touchProfile(target.profile));
    } catch (error) {
      return err("invalid", error instanceof Error ? error.message : String(error));
    }
    if (!this.isOpenAttemptCurrent(owner, ownerEpoch, profileSnapshot, signal)) {
      return err("cancelled", "navigation cancelled");
    }

    const minted = this.mintSessionId();
    if (!minted.ok) return minted;
    for (const sessionId of warmPoolEvictions(
      [...this.sessions.values()].filter((entry) => entry.owner === owner).map((entry) => ({
        key: entry.sessionId,
        attached: entry.attached,
        lastActiveAt: entry.lastActiveAt,
      })),
      minted.data,
      maxWarmSessions,
    )) {
      this.destroySession(sessionId);
    }
    if (this.sessions.size >= maxWarmSessions) {
      return err(
        "resource_exhausted",
        `warm browser session capacity reached (${maxWarmSessions}); detach a surface before opening another page`,
      );
    }

    const entry: SessionEntry = {
      owner,
      sessionId: minted.data,
      ref: target.ref,
      nodeId: target.nodeId,
      profile: target.profile,
      targetUrl: target.url,
      currentUrl: exactBrowserUrl(target.url),
      currentOrigin: exactBrowserOrigin(target.url),
      url: clampUtf8Bytes(target.url, BROWSER_MAX_METADATA_BYTES),
      machine: initialBrowserSession(),
      attached: false,
      navigationInFlight: undefined,
      activeOperation: undefined,
      lastActiveAt: this.now(),
      view: undefined as unknown as BrowserViewHandle,
      navigationWaiters: new Set(),
    };

    try {
      entry.view = this.adapter(
        partition,
        {
          onNavigationStart: (event) => this.navigationStarted(entry, event),
          onNavigationAmbiguous: (sessionId) => this.navigationAmbiguous(entry, sessionId),
          onLoadOk: (sessionId, title) =>
            this.finishGeneration(entry, sessionId, {
              type: "load_ok",
              ...(title !== undefined ? { title } : {}),
            }),
          onLoadFail: (sessionId, message) =>
            this.finishGeneration(entry, sessionId, { type: "load_fail", message }),
          onNavigationUrl: (sessionId, url) => this.updateGenerationUrl(entry, sessionId, url),
        },
        owner === BROWSER_UI_SESSION_OWNER || entry.currentOrigin === undefined
          ? undefined
          : { exactTopLevelOrigin: entry.currentOrigin },
      );
      if (!this.isOpenAttemptCurrent(owner, ownerEpoch, profileSnapshot, signal)) {
        entry.view.destroy();
        return err("cancelled", "navigation cancelled");
      }
      this.register(entry);
      const admitted = this.acquireOperation(
        entry,
        "navigation",
        entry.sessionId,
        BROWSER_NAVIGATION_TIMEOUT_MS,
        signal,
      );
      if (!admitted.ok) {
        if (this.isCurrent(entry)) this.destroySession(entry.sessionId);
        return admitted;
      }
      entry.navigationInFlight = entry.sessionId;
      this.reduceCurrent(entry, { type: "open" });
      entry.view.loadUrl(target.url, entry.sessionId);
    } catch (error) {
      if (this.isCurrent(entry)) {
        this.destroySession(entry.sessionId);
      } else {
        this.unregister(entry);
        try {
          entry.view?.destroy();
        } catch {
          // Runtime construction already failed; cleanup remains best effort.
        }
      }
      return err("failed", error instanceof Error ? error.message : String(error));
    }
    if (!this.isCurrent(entry) || entry.owner !== owner) {
      return err("not_found", `no session for ${entry.sessionId}`);
    }
    return { ok: true, data: this.info(entry) };
  }

  goto(
    sessionId: string,
    url: string,
    signal?: AbortSignal,
  ): BrowserResult<BrowserSessionInfo> {
    return this.gotoForOwner(BROWSER_UI_SESSION_OWNER, sessionId, url, signal);
  }

  gotoForOwner(
    owner: string,
    sessionId: string,
    url: string,
    signal?: AbortSignal,
  ): BrowserResult<BrowserSessionInfo> {
    const entry = this.entryForOwner(owner, sessionId);
    if (entry === undefined) return err("not_found", `no session for ${sessionId}`);
    if (!isUtf8WithinLimit(url, BROWSER_MAX_URL_BYTES)) {
      return err("invalid", "navigation URL exceeds the hard limit");
    }
    if (!this.targetAdmission(url)) {
      return err("forbidden", `url not allowed (http/https only): ${url}`);
    }
    const nextExactUrl = exactBrowserUrl(url);
    const nextOrigin = exactBrowserOrigin(url);
    if (nextExactUrl === undefined || nextOrigin === undefined) {
      return err("forbidden", `url has no exact browser origin: ${url}`);
    }
    if (entry.navigationInFlight !== undefined) {
      return err("invalid", "a top-level navigation is already in flight");
    }
    entry.lastActiveAt = this.now();
    let sameDocument = false;
    try {
      const currentUrl = new URL(entry.currentUrl ?? "");
      const nextUrl = new URL(nextExactUrl);
      sameDocument =
        currentUrl.origin === nextUrl.origin &&
        currentUrl.pathname === nextUrl.pathname &&
        currentUrl.search === nextUrl.search &&
        currentUrl.hash !== nextUrl.hash;
    } catch {
      // A page-controlled URL that exceeds the internal bound cannot be used
      // as authorization state; fail into a new guarded generation.
    }
    const admitted = this.acquireOperation(
      entry,
      "navigation",
      sessionId,
      BROWSER_NAVIGATION_TIMEOUT_MS,
      signal,
    );
    if (!admitted.ok) return admitted;
    const operation = admitted.data;
    if (sameDocument) {
      try {
        entry.currentUrl = nextExactUrl;
        entry.currentOrigin = nextOrigin;
        entry.url = clampUtf8Bytes(url, BROWSER_MAX_METADATA_BYTES);
        entry.view.loadUrl(url, entry.sessionId);
        this.releaseOperation(entry, operation);
        return { ok: true, data: this.info(entry) };
      } catch (error) {
        this.releaseOperation(entry, operation);
        return err("failed", error instanceof Error ? error.message : String(error));
      }
    }

    const rotated = this.rotateGeneration(entry, url);
    if (!rotated.ok) {
      this.releaseOperation(entry, operation);
      return rotated;
    }
    this.retargetNavigation(entry, operation, rotated.data);
    entry.navigationInFlight = rotated.data;
    try {
      if (owner !== BROWSER_UI_SESSION_OWNER) {
        entry.view.setTopLevelOriginGuard?.(nextOrigin);
      }
      this.reduceCurrent(entry, { type: "reload" });
      entry.view.loadUrl(url, entry.sessionId);
      if (!this.isCurrent(entry)) return err("not_found", `no session for ${sessionId}`);
      return { ok: true, data: this.info(entry) };
    } catch (error) {
      this.destroySession(entry.sessionId);
      return err("failed", error instanceof Error ? error.message : String(error));
    }
  }

  setBounds(
    sessionId: string,
    bounds: BrowserSurfaceBounds,
  ): BrowserResult<BrowserSessionInfo> {
    const entry = this.entryForOwner(BROWSER_UI_SESSION_OWNER, sessionId);
    if (entry === undefined) return err("not_found", `no session for ${sessionId}`);
    entry.lastActiveAt = this.now();
    try {
      if (!entry.attached) {
        entry.attached = true;
        entry.view.attach(bounds);
        this.reduceCurrent(entry, { type: "reattach" });
        this.emit(entry);
      } else {
        entry.view.setBounds(bounds);
      }
      return { ok: true, data: this.info(entry) };
    } catch (error) {
      return err("failed", error instanceof Error ? error.message : String(error));
    }
  }

  /** Detach only. The warm view and its profile storage remain alive. */
  close(sessionId: string): BrowserResult<BrowserSessionInfo> {
    return this.closeForOwner(BROWSER_UI_SESSION_OWNER, sessionId);
  }

  closeForOwner(owner: string, sessionId: string): BrowserResult<BrowserSessionInfo> {
    const entry = this.entryForOwner(owner, sessionId);
    if (entry === undefined) return err("not_found", `no session for ${sessionId}`);
    try {
      if (entry.attached) {
        entry.attached = false;
        entry.view.detach();
      }
      entry.lastActiveAt = this.now();
      this.reduceCurrent(entry, { type: "detach" });
      return { ok: true, data: this.info(entry) };
    } catch (error) {
      return err("failed", error instanceof Error ? error.message : String(error));
    }
  }

  async eval(
    sessionId: string,
    code: string,
    signal?: AbortSignal,
  ): Promise<BrowserResult<{ result: unknown }>> {
    return this.evalForOwner(BROWSER_UI_SESSION_OWNER, sessionId, code, signal);
  }

  async evalForOwner(
    owner: string,
    sessionId: string,
    code: string,
    signal?: AbortSignal,
  ): Promise<BrowserResult<{ result: unknown }>> {
    const entry = this.entryForOwner(owner, sessionId);
    if (entry === undefined) return err("not_found", `no session for ${sessionId}`);
    if (entry.navigationInFlight !== undefined) {
      return err("invalid", "cannot evaluate while top-level navigation is in flight");
    }
    if (!isUtf8WithinLimit(code, BROWSER_MAX_EVAL_CODE_BYTES)) {
      return err("invalid", "eval source exceeds the hard limit");
    }
    if (entry.view.executeJavaScript === undefined) {
      return err("failed", "adapter does not support eval");
    }
    entry.lastActiveAt = this.now();
    const executed = await this.runPowerfulOperation({
      owner,
      entry,
      sessionId,
      kind: "eval",
      timeoutMs: BROWSER_EVAL_TIMEOUT_MS,
      ...(signal !== undefined ? { signal } : {}),
      run: () => entry.view.executeJavaScript!(code),
    });
    return executed.ok ? decodeEvalEnvelope(executed.data) : executed;
  }

  async screenshot(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<BrowserResult<{ png: Uint8Array }>> {
    return this.screenshotForOwner(BROWSER_UI_SESSION_OWNER, sessionId, signal);
  }

  async screenshotForOwner(
    owner: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<BrowserResult<{ png: Uint8Array }>> {
    const entry = this.entryForOwner(owner, sessionId);
    if (entry === undefined) return err("not_found", `no session for ${sessionId}`);
    if (entry.navigationInFlight !== undefined) {
      return err("invalid", "cannot capture while top-level navigation is in flight");
    }
    if (entry.view.capturePagePng === undefined) {
      return err("failed", "adapter does not support screenshot");
    }
    entry.lastActiveAt = this.now();
    const captured = await this.runPowerfulOperation({
      owner,
      entry,
      sessionId,
      kind: "screenshot",
      timeoutMs: BROWSER_CAPTURE_TIMEOUT_MS,
      ...(signal !== undefined ? { signal } : {}),
      run: () => entry.view.capturePagePng!(),
    });
    if (!captured.ok) return captured;
    if (captured.data.byteLength > BROWSER_MAX_SCREENSHOT_BYTES) {
      return err("result_too_large", "screenshot exceeds the hard result limit");
    }
    if (captured.data.byteLength === 0) {
      return err(
        "failed",
        `capture produced no pixels — session ${sessionId} is detached; open its surface and retry`,
      );
    }
    return { ok: true, data: { png: captured.data } };
  }

  state(sessionId: string): BrowserResult<BrowserSessionInfo> {
    return this.stateForOwner(BROWSER_UI_SESSION_OWNER, sessionId);
  }

  stateForOwner(owner: string, sessionId: string): BrowserResult<BrowserSessionInfo> {
    const entry = this.entryForOwner(owner, sessionId);
    return entry === undefined
      ? err("not_found", `no session for ${sessionId}`)
      : { ok: true, data: this.info(entry) };
  }

  list(): BrowserResult<ReadonlyArray<BrowserSessionInfo>> {
    return this.listForOwner(BROWSER_UI_SESSION_OWNER);
  }

  listForOwner(owner: string): BrowserResult<ReadonlyArray<BrowserSessionInfo>> {
    return {
      ok: true,
      data: [...this.sessions.values()]
        .filter((entry) => entry.owner === owner && this.isCurrent(entry))
        .map((entry) => this.info(entry)),
    };
  }

  sessionIdForRef(ref: string): string | undefined {
    return this.sessionIdForRefForOwner(BROWSER_UI_SESSION_OWNER, ref);
  }

  sessionIdForRefForOwner(owner: string, ref: string): string | undefined {
    const sessionId = this.ownerRefSessions(owner)?.get(ref);
    return sessionId !== undefined && this.entryForOwner(owner, sessionId) !== undefined
      ? sessionId
      : undefined;
  }

  authorizationSnapshotForOwner(
    owner: string,
    sessionId: string,
  ): BrowserResult<BrowserSessionAuthorizationSnapshot> {
    const entry = this.entryForOwner(owner, sessionId);
    if (entry === undefined) return err("not_found", `no session for ${sessionId}`);
    return {
      ok: true,
      data: {
        owner,
        sessionId: entry.sessionId,
        generation: entry.sessionId,
        ref: entry.ref,
        profile: entry.profile,
        ...(entry.currentOrigin !== undefined ? { origin: entry.currentOrigin } : {}),
        navigationInFlight: entry.navigationInFlight === entry.sessionId,
      },
    };
  }

  awaitNavigationTerminalForOwner(
    owner: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<BrowserResult<BrowserSessionInfo>> {
    if (isAborted(signal)) {
      return Promise.resolve(err("cancelled", "navigation cancelled"));
    }
    const entry = this.entryForOwner(owner, sessionId);
    if (entry === undefined) {
      return Promise.resolve(err("not_found", `no session for ${sessionId}`));
    }
    if (entry.navigationInFlight !== sessionId) {
      if (entry.machine.state === "failed") {
        return Promise.resolve(err("failed", entry.machine.lastError ?? "navigation failed"));
      }
      if (entry.machine.state === "loading") {
        return Promise.resolve(err("failed", "navigation has no active completion lane"));
      }
      return Promise.resolve({ ok: true, data: this.info(entry) });
    }

    return new Promise((resolve) => {
      const waiter: NavigationWaiter = {
        sessionId,
        ...(signal !== undefined ? { signal } : {}),
        abortListener: undefined,
        resolve,
      };
      if (signal !== undefined) {
        waiter.abortListener = () => {
          if (!entry.navigationWaiters.has(waiter)) return;
          const current = this.entryForOwner(owner, sessionId);
          if (current === entry && entry.navigationInFlight === sessionId) {
            this.destroySession(
              sessionId,
              new BrowserOperationFailure("cancelled", "navigation cancelled"),
            );
            return;
          }
          entry.navigationWaiters.delete(waiter);
          waiter.abortListener = undefined;
          resolve(err("cancelled", "navigation cancelled"));
        };
        signal.addEventListener("abort", waiter.abortListener, { once: true });
      }
      entry.navigationWaiters.add(waiter);

      // Recheck after installing the waiter so synchronous lifecycle progress
      // cannot land between the state read and subscription.
      const current = this.entryForOwner(owner, sessionId);
      if (current !== entry || entry.navigationInFlight !== sessionId) {
        this.settleNavigationWaiters(
          entry,
          sessionId,
          current === entry
            ? entry.machine.state === "failed"
              ? err("failed", entry.machine.lastError ?? "navigation failed")
              : { ok: true, data: this.info(entry) }
            : err("not_found", `no session for ${sessionId}`),
        );
      }
    });
  }

  /**
   * Synchronously closes admission for one profile, invalidates matching
   * pending opens, and logically destroys every matching UI/automation view.
   * The returned completion is the bounded physical WebContents barrier that
   * storage deletion must await.
   */
  beginProfileQuiescence(
    profile: string,
    reason = "browser profile quiesced",
  ): BrowserResult<BrowserProfileQuiescence> {
    const blocked = this.profileGate.begin(profile);
    if (!blocked.ok) {
      switch (blocked.code) {
        case "invalid":
          return err("invalid", "browser profile is invalid");
        case "busy":
          return err("resource_exhausted", "browser profile is already quiescing");
        case "deleted":
          return err("forbidden", "browser profile is unavailable");
      }
    }

    const pendingOpensInvalidated = this.invalidatePendingProfileOpens(profile);
    const entries = [...this.sessions.values()].filter(
      (entry) => entry.profile === profile && this.isCurrent(entry),
    );
    const acknowledgements: Promise<void>[] = [];
    let teardownFailures = 0;
    const failure = new BrowserOperationFailure(
      "cancelled",
      clampUtf8Bytes(reason, BROWSER_MAX_ERROR_BYTES),
    );

    for (const entry of entries) {
      try {
        if (entry.view.whenDestroyed === undefined) {
          teardownFailures += 1;
        } else {
          acknowledgements.push(Promise.resolve(entry.view.whenDestroyed()));
        }
      } catch {
        teardownFailures += 1;
      }
      try {
        this.destroySession(entry.sessionId, failure);
      } catch {
        // Logical invalidation must continue across every matching view.
        teardownFailures += 1;
      }
    }

    const completion = this.awaitProfileViewDestruction(
      acknowledgements,
      teardownFailures,
      Object.freeze({
        pendingOpensInvalidated,
        sessionsDestroyed: entries.length,
        viewsDestroyed: entries.length,
      }),
    );
    return {
      ok: true,
      data: Object.freeze({ block: blocked.data, completion }),
    };
  }

  private invalidatePendingProfileOpens(profile: string): number {
    let invalidated = 0;
    for (const [owner, pendingByRef] of this.pendingOpenByOwnerRef) {
      for (const [ref, pending] of pendingByRef) {
        if (pending.target.profile !== profile) continue;
        if (pendingByRef.delete(ref)) invalidated += 1;
      }
      if (pendingByRef.size === 0) this.pendingOpenByOwnerRef.delete(owner);
    }
    return invalidated;
  }

  private async awaitProfileViewDestruction(
    acknowledgements: ReadonlyArray<Promise<void>>,
    teardownFailures: number,
    summary: BrowserProfileQuiescenceSummary,
  ): Promise<BrowserResult<BrowserProfileQuiescenceSummary>> {
    const settled = Promise.allSettled(acknowledgements);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<undefined>((resolve) => {
      timeout = setTimeout(() => resolve(undefined), this.viewDestroyTimeoutMs);
    });
    const result = await Promise.race([settled, deadline]);
    if (timeout !== undefined) clearTimeout(timeout);
    if (result === undefined) {
      return err(
        "timeout",
        `browser views did not terminate within ${this.viewDestroyTimeoutMs}ms`,
      );
    }
    if (
      teardownFailures > 0 ||
      acknowledgements.length !== summary.viewsDestroyed ||
      result.some((entry) => entry.status === "rejected")
    ) {
      return err("failed", "browser view teardown did not complete cleanly");
    }
    return { ok: true, data: summary };
  }

  /** Revoke one owner namespace without touching UI or sibling-job views. */
  destroyOwnerSessions(owner: string, reason = "browser authority revoked"): number {
    this.ownerEpochs.set(owner, this.ownerEpoch(owner) + 1);
    this.pendingOpenByOwnerRef.delete(owner);
    const ownedSessionIds = [...this.sessions.values()]
      .filter((entry) => entry.owner === owner)
      .map((entry) => entry.sessionId);
    for (const sessionId of ownedSessionIds) {
      this.destroySession(
        sessionId,
        new BrowserOperationFailure("cancelled", clampUtf8Bytes(reason, BROWSER_MAX_ERROR_BYTES)),
      );
    }
    return ownedSessionIds.length;
  }

  /** Warm-pool eviction only. Profile partition data persists. */
  private destroySession(sessionId: string, failure?: BrowserOperationFailure): void {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) return;
    const operation = entry.activeOperation;
    if (operation !== undefined) {
      this.releaseOperation(
        entry,
        operation,
        failure ?? new BrowserOperationFailure("not_found", `no session for ${sessionId}`),
      );
    }
    this.settleNavigationWaiters(
      entry,
      sessionId,
      err(failure?.code ?? "not_found", failure?.message ?? `no session for ${sessionId}`),
    );
    try {
      this.reduceCurrent(entry, { type: "destroy" });
    } finally {
      this.unregister(entry);
      try {
        if (entry.attached) entry.view.detach();
      } finally {
        entry.view.destroy();
      }
    }
  }

  /** Quit detaches views only; profile partitions are never touched. */
  detachAllOnQuit(reason: string): void {
    for (const entry of this.sessions.values()) {
      try {
        const operation = entry.activeOperation;
        if (operation !== undefined) {
          const operationSessionId = operation.sessionId;
          this.releaseOperation(
            entry,
            operation,
            new BrowserOperationFailure("cancelled", `${operation.kind} cancelled during quit`),
          );
          entry.navigationInFlight = undefined;
          if (operation.kind === "navigation") {
            this.settleNavigationWaiters(
              entry,
              operationSessionId,
              err("cancelled", "navigation cancelled during quit"),
            );
          }
        }
        if (entry.attached) {
          entry.attached = false;
          entry.view.detach();
        }
        this.reduceCurrent(entry, { type: "detach" });
      } catch (error) {
        console.error(`[browser] detach on quit failed (${reason}, ${entry.sessionId}):`, error);
      }
    }
  }
}
