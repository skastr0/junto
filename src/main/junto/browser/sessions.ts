import { randomUUID } from "node:crypto";
import { Effect, Result } from "effect";
import { runClosedBrowserEffect } from "./run-closed";
import {
  initialBrowserSession,
  isAllowedBrowserUrl,
  isValidProfileId,
  isWarmBrowserSession,
  reduceBrowserSession,
  warmPoolEvictions,
  type BrowserProfileWipeReceipt,
  type BrowserSessionMachine,
  type BrowserStopReceipt,
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
import {
  mergePageLoadStatus,
  pageLoadMapKey,
  type PageLoadStatus,
} from "@shared/scheduler-effects";
import { parseNodeRef } from "@shared/node-ref";
import type { PageTargetResult, ResolvedPageTarget } from "./page-target";
import {
  admitBrowserHostCapability,
  type BrowserHostCapabilityAdmission,
  type BrowserHostCapabilityAuthority,
} from "./host-capability";
import type { BrowserProfileServiceApi } from "./profiles";
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
  /** Resolves only when Electron's load request itself settles. */
  loadUrl(url: string, expectedSessionId: string): Promise<void>;
  setTopLevelOriginGuard?(origin: string): void;
  attach(bounds: BrowserSurfaceBounds): void;
  setBounds(bounds: BrowserSurfaceBounds): void;
  detach(): void;
  /** Synchronously asks Electron to abort any provisional/network load. */
  stopLoading?(): void;
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
  /**
   * Electron reports an unplanned WebContents loss through either
   * `render-process-gone` or `destroyed`. The adapter coalesces both signals
   * before crossing this seam.
   */
  readonly onUnexpectedTermination: () => void;
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
) => BrowserViewHandle | Promise<BrowserViewHandle>;

export type BrowserTargetAdmission = (url: string) => boolean;

export type BrowserErrorCode =
  | "invalid"
  | "not_found"
  | "forbidden"
  | "failed"
  | "timeout"
  | "cancelled"
  | "resource_exhausted"
  | "unsupported_capability"
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
export const BROWSER_UI_SHUTDOWN_DRAIN_TIMEOUT_MS = 50_000;

export type BrowserUiOperationKind =
  | "open"
  | "goto"
  | "eval"
  | "screenshot"
  | "stop"
  | "profile-wipe"
  | "view-destroy"
  | "page-resolve"
  | "host-activation"
  | "profile-wipe-confirmation"
  | "profiles-read"
  | "surface-config";

export interface BrowserUiAdmissionSnapshot {
  readonly epoch: number;
}

export interface BrowserUiShutdownPrecommitReceipt {
  readonly epoch: number;
  readonly closedAt: number;
  readonly activeOperations: ReadonlyArray<BrowserUiOperationKind>;
}

export interface BrowserUiShutdownDrainReceipt {
  readonly epoch: number;
  readonly clean: boolean;
  readonly operations: ReadonlyArray<BrowserUiOperationKind>;
  readonly settled: number;
  readonly fulfilled: number;
  readonly rejected: number;
  readonly rounds: number;
  readonly timedOut: boolean;
  readonly activeOperations: ReadonlyArray<BrowserUiOperationKind>;
  readonly sessionsDestroyed: number;
  readonly teardownWitnessFailures: number;
}

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
    readonly code: Extract<
      BrowserErrorCode,
      "timeout" | "cancelled" | "not_found" | "failed"
    >,
    message: string,
  ) {
    super(message);
    this.name = "BrowserOperationFailure";
  }
}

/**
 * Fixed, aggregate failure surfaced only after every owned session has been
 * logically invalidated and physical teardown has been attempted. Adapter
 * errors are intentionally not retained as a cause or copied into the message.
 */
export class BrowserOwnerSessionTeardownFailure extends Error {
  readonly code = "browser_owner_session_teardown_failed";

  constructor(readonly failureCount: number) {
    super("browser owner session teardown did not complete cleanly");
    this.name = "BrowserOwnerSessionTeardownFailure";
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
  readonly hostId: string;
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
  readonly refEpoch: number;
  readonly refSignal: AbortSignal;
  readonly profileSnapshot: BrowserProfileSnapshot;
  readonly promise: Promise<BrowserResult<BrowserSessionInfo>>;
}

interface NavigationWaiter {
  readonly sessionId: string;
  readonly signal?: AbortSignal;
  abortListener: (() => void) | undefined;
  readonly resolve: (result: BrowserResult<BrowserSessionInfo>) => void;
}

interface BrowserStopRecord {
  readonly owner: string;
  readonly snapshot: BrowserSessionAuthorizationSnapshot;
  readonly receipt: BrowserStopReceipt;
  readonly acknowledgement: Promise<void> | undefined;
  completion: Promise<BrowserResult<BrowserStopReceipt>> | undefined;
  lastResult: BrowserResult<BrowserStopReceipt> | undefined;
}

interface BrowserUiOperation {
  readonly id: number;
  readonly kind: BrowserUiOperationKind;
  readonly promise: Promise<unknown>;
}

const MISSING_VIEW_DESTROY_WITNESS = Symbol("missing-view-destroy-witness");
type RetainedViewDestroyWitness =
  | Promise<void>
  | typeof MISSING_VIEW_DESTROY_WITNESS;

interface PendingViewTeardown {
  readonly view: BrowserViewHandle;
  readonly witness: Promise<void>;
}

/** Main-process-only view used by capability authorization. */
export interface BrowserSessionAuthorizationSnapshot {
  readonly owner: string;
  readonly sessionId: string;
  readonly generation: string;
  readonly ref: string;
  readonly hostId: string;
  readonly profile: string;
  readonly origin?: string;
  readonly navigationInFlight: boolean;
}

export const BROWSER_UI_SESSION_OWNER = "junto-ui";

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
  left.hostId === right.hostId &&
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

export type BrowserTargetRevalidator = () => Promise<PageTargetResult>;

export class BrowserSessionService {
  private static readonly MAX_STOP_RECEIPTS = 1_024;
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly sessionIdByOwnerRef = new Map<string, Map<string, string>>();
  private readonly pendingOpenByOwnerRef = new Map<string, Map<string, PendingOpen>>();
  private readonly ownerEpochs = new Map<string, number>();
  private readonly refEpochs = new Map<string, number>();
  private readonly refAborts = new Map<string, AbortController>();
  private readonly refDeleteLeases = new Map<string, Set<string>>();
  private readonly pendingStops = new Map<string, BrowserStopRecord>();
  private readonly stoppedSessions = new Map<string, BrowserStopRecord>();
  private readonly activeUiOperations = new Map<number, BrowserUiOperation>();
  private readonly closedUiAdmissions = new Map<number, BrowserUiOperation>();
  private readonly uiDetachFailures = new Set<string>();
  private readonly viewDestroyWitnesses = new WeakMap<
    BrowserViewHandle,
    RetainedViewDestroyWitness
  >();
  private readonly pendingViewTeardowns = new Set<PendingViewTeardown>();
  private activeOperationCount = 0;
  private nextUiOperationId = 0;
  private uiShutdownEpoch = 0;
  private uiShutdownClosedAt: number | undefined;
  private uiShutdownDrainFlight: Promise<BrowserUiShutdownDrainReceipt> | undefined;
  private teardownWitnessFailures = 0;
  private pendingViewCreations = 0;
  private sink: ((session: BrowserSessionInfo) => void) | undefined;
  private readonly sessionListeners = new Set<
    (session: BrowserSessionInfo) => void
  >();
  private readonly viewDestroyTimeoutMs: number;
  private readonly uiShutdownDrainTimeoutMs: number;
  // Sole durable SoT for these numbers is Settings.browser; profiles.config
  // remains fallback for tests that never install a limits provider.
  private poolLimits: (() => Promise<BrowserPoolLimits>) | undefined;

  constructor(
    private readonly adapter: BrowserViewAdapter,
    private readonly hostAuthority: BrowserHostCapabilityAuthority,
    private readonly profiles: BrowserProfileServiceApi,
    private readonly now: () => number = Date.now,
    private readonly generateSessionId: () => string = randomUUID,
    private readonly targetAdmission: BrowserTargetAdmission = isAllowedBrowserUrl,
    private readonly profileGate: BrowserProfileGate = makeBrowserProfileGate(),
    viewDestroyTimeoutMs: number = BROWSER_PROFILE_VIEW_DESTROY_TIMEOUT_MS,
    uiShutdownDrainTimeoutMs: number = BROWSER_UI_SHUTDOWN_DRAIN_TIMEOUT_MS,
  ) {
    this.viewDestroyTimeoutMs =
      Number.isFinite(viewDestroyTimeoutMs) && viewDestroyTimeoutMs > 0
        ? Math.min(Math.floor(viewDestroyTimeoutMs), BROWSER_PROFILE_VIEW_DESTROY_TIMEOUT_MS)
        : BROWSER_PROFILE_VIEW_DESTROY_TIMEOUT_MS;
    this.uiShutdownDrainTimeoutMs =
      Number.isFinite(uiShutdownDrainTimeoutMs) && uiShutdownDrainTimeoutMs > 0
        ? Math.min(
            Math.floor(uiShutdownDrainTimeoutMs),
            BROWSER_UI_SHUTDOWN_DRAIN_TIMEOUT_MS,
          )
        : BROWSER_UI_SHUTDOWN_DRAIN_TIMEOUT_MS;
  }

  private uiShutdownRefusal(): BrowserResultErr {
    return err("cancelled", "browser runtime is shutting down");
  }

  uiAdmissionSnapshot(): BrowserUiAdmissionSnapshot | undefined {
    return this.uiShutdownClosedAt === undefined
      ? Object.freeze({ epoch: this.uiShutdownEpoch })
      : undefined;
  }

  isUiAdmissionCurrent(snapshot: BrowserUiAdmissionSnapshot): boolean {
    return (
      this.uiShutdownClosedAt === undefined &&
      snapshot.epoch === this.uiShutdownEpoch
    );
  }

  /**
   * Read-only physical-station seam for local control admission. The control
   * socket is hosted by this same BrowserSessionService, so edge grants can
   * reject a foreign page before minting a capability instead of discovering
   * the mismatch only while opening its view.
   */
  stationIdentity(): ReturnType<BrowserHostCapabilityAuthority["station"]> {
    return this.hostAuthority.station();
  }

  /** Validate a document-derived page host against this process's station. */
  admitAutomationHost(hostId: string): BrowserHostCapabilityAdmission {
    return admitBrowserHostCapability(hostId, this.hostAuthority);
  }

  private retainUiOperation<A>(
    kind: BrowserUiOperationKind,
    operation: () => Promise<A>,
  ): Promise<A> {
    const id = ++this.nextUiOperationId;
    let promise: Promise<A>;
    try {
      // Preserve the actual domain promise. Renderer IPC timeouts or abandoned
      // caller continuations cannot retire work that remains live in main.
      promise = Promise.resolve(operation());
    } catch (error) {
      promise = Promise.reject(error);
    }
    const record: BrowserUiOperation = { id, kind, promise };
    this.activeUiOperations.set(id, record);
    if (this.uiShutdownClosedAt !== undefined) {
      this.closedUiAdmissions.set(id, record);
    }
    const retire = (): void => {
      if (this.activeUiOperations.get(id)?.promise === promise) {
        this.activeUiOperations.delete(id);
      }
    };
    void promise.then(retire, retire);
    return promise;
  }

  private runUiOperation<A>(
    kind: BrowserUiOperationKind,
    operation: () => Promise<BrowserResult<A>>,
  ): Promise<BrowserResult<A>> {
    if (this.uiShutdownClosedAt !== undefined) {
      return Promise.resolve(this.uiShutdownRefusal());
    }
    return this.retainUiOperation(kind, operation);
  }

  /** Retain an already-started IPC preflight across a concurrent gate close. */
  retainUiIngress<A>(
    kind: Extract<
      BrowserUiOperationKind,
      "page-resolve" | "host-activation" | "profile-wipe-confirmation"
    >,
    operation: Promise<A>,
  ): Promise<A> {
    return this.retainUiOperation(kind, () => operation);
  }

  private activeUiOperationKinds(): ReadonlyArray<BrowserUiOperationKind> {
    return [...this.activeUiOperations.values()]
      .sort((left, right) => left.id - right.id)
      .map((operation) => operation.kind);
  }

  setSink(sink: (session: BrowserSessionInfo) => void): void {
    this.sink = sink;
  }

  /**
   * Extra listeners for live session transitions (load ok/fail, destroy).
   * Kernel page→relay watch wakes here; IPC uses setSink.
   */
  subscribeSessionChanges(
    listener: (session: BrowserSessionInfo) => void,
  ): () => void {
    this.sessionListeners.add(listener);
    return () => {
      this.sessionListeners.delete(listener);
    };
  }

  /**
   * Thin readiness map for kernel watch: `${canvasName}::${nodeId}` → load
   * status from every current warm session (all owners). ready/failed from
   * onLoadOk/onLoadFail satisfy page completes equals.
   */
  pageLoadSnapshot(): ReadonlyMap<string, PageLoadStatus> {
    const out = new Map<string, PageLoadStatus>();
    for (const entry of this.sessions.values()) {
      if (!this.isCurrent(entry)) continue;
      const state = entry.machine.state;
      if (state === "destroyed") continue;
      const parsed = parseNodeRef(entry.ref);
      if (!parsed.ok) continue;
      const key = pageLoadMapKey(parsed.value.canvasName, parsed.value.nodeId);
      out.set(key, mergePageLoadStatus(out.get(key), state));
    }
    return out;
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

  private refEpoch(ref: string): number {
    return this.refEpochs.get(ref) ?? 0;
  }

  private refDeleteActive(ref: string): boolean {
    return (this.refDeleteLeases.get(ref)?.size ?? 0) > 0;
  }

  private refAbortSignal(ref: string): AbortSignal {
    const existing = this.refAborts.get(ref);
    if (existing !== undefined) return existing.signal;
    const created = new AbortController();
    this.refAborts.set(ref, created);
    return created.signal;
  }

  private bumpRefGeneration(ref: string): void {
    this.refEpochs.set(ref, this.refEpoch(ref) + 1);
    const previous = this.refAborts.get(ref);
    previous?.abort();
    this.refAborts.set(ref, new AbortController());
  }

  private isOpenAttemptCurrent(
    owner: string,
    ownerEpoch: number,
    profileSnapshot: BrowserProfileSnapshot,
    ref: string,
    refEpoch: number,
    signal?: AbortSignal,
  ): boolean {
    return (
      this.uiShutdownClosedAt === undefined &&
      this.ownerEpoch(owner) === ownerEpoch &&
      this.refEpoch(ref) === refEpoch &&
      !this.refDeleteActive(ref) &&
      this.profileGate.isCurrent(profileSnapshot) &&
      !isAborted(signal)
    );
  }

  private async awaitOwnerOpen(
    owner: string,
    record: PendingOpen,
  ): Promise<BrowserResult<BrowserSessionInfo>> {
    const result = await record.promise;
    if (
      !this.isOpenAttemptCurrent(
        owner,
        record.ownerEpoch,
        record.profileSnapshot,
        record.target.ref,
        record.refEpoch,
        record.refSignal,
      )
    ) {
      if (result.ok) {
        const sessionId = result.data.sessionId;
        if (this.entryForOwner(owner, sessionId) !== undefined) {
          this.destroySession(sessionId, new BrowserOperationFailure("cancelled", "navigation cancelled"));
        }
      }
      return err("cancelled", "navigation cancelled");
    }
    if (result.ok && this.entryForOwner(owner, result.data.sessionId) === undefined) {
      return err("not_found", `no session for ${result.data.sessionId}`);
    }
    return result;
  }

  private async resolvePoolLimits(): Promise<BrowserPoolLimits> {
    if (this.poolLimits) return this.poolLimits();
    const state = await runClosedBrowserEffect(this.profiles.readState);
    return {
      maxVisibleSurfaces: state.maxVisibleSurfaces,
      maxWarmSessions: state.maxWarmSessions,
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
    const running = Promise.resolve().then(input.run);
    // The adapter promise is the actual Electron operation. Retain it for UI
    // and automation owners independently of the bounded/raced public result,
    // so neither renderer IPC nor control-socket cancellation can fabricate a
    // settled browser domain during quit.
    void this.retainUiOperation(input.kind, () => running);

    try {
      const value = await Promise.race([running, failed]);
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
      hostId: entry.hostId,
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

  private authorizationSnapshot(entry: SessionEntry): BrowserSessionAuthorizationSnapshot {
    return {
      owner: entry.owner,
      sessionId: entry.sessionId,
      generation: entry.sessionId,
      ref: entry.ref,
      hostId: entry.hostId,
      profile: entry.profile,
      ...(entry.currentOrigin !== undefined ? { origin: entry.currentOrigin } : {}),
      navigationInFlight: entry.navigationInFlight === entry.sessionId,
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
    const info = this.info(entry);
    // UI surface: only the UI-owned warm session (renderer dock).
    if (entry.owner === BROWSER_UI_SESSION_OWNER && this.isCurrent(entry)) {
      this.sink?.(info);
    }
    // Kernel page→relay watch and other internal listeners: every owner.
    if (this.sessionListeners.size > 0) {
      for (const listener of this.sessionListeners) {
        listener(info);
      }
    }
  }

  private settleNavigationWaiters(
    entry: SessionEntry,
    filter: (waiter: NavigationWaiter) => boolean,
    result: BrowserResult<BrowserSessionInfo>,
  ): void {
    for (const waiter of [...entry.navigationWaiters]) {
      if (!filter(waiter)) continue;
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
      (waiter) => waiter.sessionId === sessionId,
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
      if (
        isValidBrowserSessionId(candidate) &&
        !this.sessions.has(candidate) &&
        !this.pendingStops.has(candidate) &&
        !this.stoppedSessions.has(candidate)
      ) {
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
    // Superseded generations can never complete: their exact handle stops
    // existing here. Settle their waiters now so retained UI/automation
    // navigations cannot hang the quit drain on a replaced load.
    this.settleNavigationWaiters(
      entry,
      (waiter) => waiter.sessionId !== minted.data,
      err("cancelled", "superseded by a newer navigation"),
    );
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
    if (this.uiShutdownClosedAt !== undefined) {
      return undefined;
    }
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
    if (entry.owner === BROWSER_UI_SESSION_OWNER && active === undefined) {
      this.trackUiNavigation("goto", rotated.data);
    }
    return rotated.data;
  }

  private navigationAmbiguous(entry: SessionEntry, sessionId: string): void {
    if (entry.sessionId !== sessionId || !this.isCurrent(entry)) return;
    this.destroySession(sessionId);
  }

  private viewTerminatedUnexpectedly(entry: SessionEntry): void {
    if (!this.isCurrent(entry)) return;
    try {
      this.destroySession(
        entry.sessionId,
        new BrowserOperationFailure("failed", "browser renderer terminated unexpectedly"),
      );
    } catch {
      // destroySession unregisters before invoking fallible adapter teardown.
      // An Electron lifecycle callback must never escalate that physical
      // cleanup failure into an uncaught main-process exception.
    }
  }

  listProfiles(): Promise<
    BrowserResult<ReadonlyArray<{ id: string; label?: string; default?: boolean }>>
  > {
    return this.runUiOperation("profiles-read", () => this.listProfilesAdmitted());
  }

  private async listProfilesAdmitted(): Promise<
    BrowserResult<ReadonlyArray<{ id: string; label?: string; default?: boolean }>>
  > {
    try {
      const state = await runClosedBrowserEffect(this.profiles.readState);
      return {
        ok: true,
        data: state.profiles.map((profile) => ({
          id: profile.id,
          ...(profile.label !== undefined ? { label: profile.label } : {}),
          ...(profile.id === state.defaultProfile ? { default: true } : {}),
        })),
      };
    } catch (error) {
      return err("failed", error instanceof Error ? error.message : String(error));
    }
  }

  wipeProfile(profileId: string): Promise<BrowserResult<BrowserProfileWipeReceipt>> {
    if (!isValidProfileId(profileId)) {
      return Promise.resolve(err("invalid", "invalid browser profile id"));
    }
    return this.runUiOperation("profile-wipe", () => this.wipeProfileAdmitted(profileId));
  }

  private async wipeProfileAdmitted(
    profileId: string,
  ): Promise<BrowserResult<BrowserProfileWipeReceipt>> {
    if (!isValidProfileId(profileId)) return err("invalid", "invalid browser profile id");
    try {
      const outcome = await runClosedBrowserEffect(Effect.result(this.profiles.wipeProfile(profileId)));
      if (Result.isFailure(outcome)) {
        const error = outcome.failure;
        const code = error.code === "invalid" || error.code === "not_found" || error.code === "forbidden"
          ? error.code
          : error.code === "pending_wipe"
            ? "resource_exhausted"
            : "failed";
        return err(code, error.message);
      }
      const receipt = outcome.success;
      return receipt.status === "complete"
        ? {
            ok: true,
            data: Object.freeze({
              profileId,
              status: "complete",
              recovery: "complete",
            }),
          }
        : {
            ok: true,
            data: Object.freeze({
              profileId,
              status: "restart_required",
              recovery: "pending_restart",
            }),
          };
    } catch {
      return err("failed", "browser profile wipe failed");
    }
  }

  surfaceConfig(): Promise<
    BrowserResult<{ maxVisibleSurfaces: number; maxWarmSessions: number }>
  > {
    return this.runUiOperation("surface-config", () => this.surfaceConfigAdmitted());
  }

  private async surfaceConfigAdmitted(): Promise<
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
    revalidateTarget?: BrowserTargetRevalidator,
  ): Promise<BrowserResult<BrowserSessionInfo>> {
    return this.openForOwner(
      BROWSER_UI_SESSION_OWNER,
      target,
      signal,
      revalidateTarget,
    );
  }

  /** Same owner+ref callers share one creation attempt; owners never share a view. */
  openForOwner(
    owner: string,
    target: ResolvedPageTarget,
    signal?: AbortSignal,
    revalidateTarget?: BrowserTargetRevalidator,
  ): Promise<BrowserResult<BrowserSessionInfo>> {
    return this.runUiOperation("open", () =>
      this.openForOwnerAdmitted(owner, target, signal, revalidateTarget),
    );
  }

  private async openForOwnerAdmitted(
    owner: string,
    target: ResolvedPageTarget,
    signal?: AbortSignal,
    revalidateTarget?: BrowserTargetRevalidator,
  ): Promise<BrowserResult<BrowserSessionInfo>> {
    const invalid = validateTarget(target, this.targetAdmission);
    if (invalid !== undefined) return invalid;
    const hostAdmission = admitBrowserHostCapability(
      target.hostId,
      this.hostAuthority,
    );
    if (!hostAdmission.ok) {
      return err(hostAdmission.code, hostAdmission.message);
    }
    if (
      owner !== BROWSER_UI_SESSION_OWNER &&
      exactBrowserOrigin(target.url) === undefined
    ) {
      return err("forbidden", "automation target has no exact browser origin");
    }
    if (isAborted(signal) || this.refDeleteActive(target.ref)) {
      return err("cancelled", "navigation cancelled");
    }
    const profileSnapshot = this.profileGate.snapshot(target.profile);
    if (profileSnapshot === undefined) {
      return err("forbidden", "browser profile is unavailable");
    }

    const epoch = this.ownerEpoch(owner);
    const currentRefEpoch = this.refEpoch(target.ref);
    const refSignal = this.refAbortSignal(target.ref);
    const pendingByRef = this.ownerPendingOpens(owner, true);
    const pending = pendingByRef.get(target.ref);
    if (pending !== undefined) {
      return sameTarget(pending.target, target)
        ? this.awaitOwnerOpen(owner, pending)
        : err("invalid", "canonical page ref resolved to conflicting page metadata");
    }

    const promise = this.openResolved(
      owner,
      epoch,
      profileSnapshot,
      target,
      currentRefEpoch,
      signal,
      revalidateTarget,
    );
    const record: PendingOpen = {
      target,
      ownerEpoch: epoch,
      refEpoch: currentRefEpoch,
      refSignal,
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
    refEpoch: number,
    signal?: AbortSignal,
    revalidateTarget?: BrowserTargetRevalidator,
  ): Promise<BrowserResult<BrowserSessionInfo>> {
    if (!this.isOpenAttemptCurrent(owner, ownerEpoch, profileSnapshot, target.ref, refEpoch, signal)) {
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
        hostId: existing.hostId,
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
      partition = await runClosedBrowserEffect(this.profiles.partitionName(target.profile));
      if (!this.isOpenAttemptCurrent(owner, ownerEpoch, profileSnapshot, target.ref, refEpoch, signal)) {
        return err("cancelled", "navigation cancelled");
      }
      const limits = await this.resolvePoolLimits();
      if (!this.isOpenAttemptCurrent(owner, ownerEpoch, profileSnapshot, target.ref, refEpoch, signal)) {
        return err("cancelled", "navigation cancelled");
      }
      maxWarmSessions = Math.min(
        BROWSER_MAX_WARM_SESSIONS_HARD,
        Number.isFinite(limits.maxWarmSessions)
          ? Math.max(1, Math.floor(limits.maxWarmSessions))
          : 1,
      );
      await runClosedBrowserEffect(this.profiles.touchProfile(target.profile));
    } catch (error) {
      return err("invalid", error instanceof Error ? error.message : String(error));
    }
    if (!this.isOpenAttemptCurrent(owner, ownerEpoch, profileSnapshot, target.ref, refEpoch, signal)) {
      return err("cancelled", "navigation cancelled");
    }
    if (revalidateTarget !== undefined) {
      const refreshed = await revalidateTarget().catch(() => ({
        ok: false as const,
        code: "failed" as const,
        message: "page ref resolution failed",
      }));
      if (!refreshed.ok) return err(refreshed.code, refreshed.message);
      if (!sameTarget(target, refreshed.data)) {
        return err("invalid", "canonical page target changed before browser session creation");
      }
    }
    const currentHostAdmission = admitBrowserHostCapability(
      target.hostId,
      this.hostAuthority,
    );
    if (!currentHostAdmission.ok) {
      return err(currentHostAdmission.code, currentHostAdmission.message);
    }
    if (!this.isOpenAttemptCurrent(owner, ownerEpoch, profileSnapshot, target.ref, refEpoch, signal)) {
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
    if (this.sessions.size + this.pendingViewCreations >= maxWarmSessions) {
      return err(
        "resource_exhausted",
        `warm browser session capacity reached (${maxWarmSessions}); stop pages or automation to free capacity`,
      );
    }

    const entry: SessionEntry = {
      owner,
      sessionId: minted.data,
      ref: target.ref,
      nodeId: target.nodeId,
      hostId: target.hostId,
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

    this.pendingViewCreations += 1;
    try {
      entry.view = await this.adapter(
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
          onUnexpectedTermination: () => this.viewTerminatedUnexpectedly(entry),
        },
        owner === BROWSER_UI_SESSION_OWNER || entry.currentOrigin === undefined
          ? undefined
          : { exactTopLevelOrigin: entry.currentOrigin },
      );
      if (!this.isOpenAttemptCurrent(owner, ownerEpoch, profileSnapshot, target.ref, refEpoch, signal)) {
        this.requestViewDestruction(entry);
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
      const loading = entry.view.loadUrl(target.url, entry.sessionId);
      this.trackViewLoad("open", loading);
      if (owner === BROWSER_UI_SESSION_OWNER) {
        this.trackUiNavigation("open", entry.sessionId);
      }
    } catch (error) {
      if (this.isCurrent(entry)) {
        this.destroySession(entry.sessionId);
      } else {
        this.unregister(entry);
        try {
          if (entry.view !== undefined) {
            this.requestViewDestruction(entry);
          }
        } catch {
          // The retained physical witness, rather than this fallible callback,
          // remains authoritative for shutdown convergence.
        }
      }
      return err("failed", error instanceof Error ? error.message : String(error));
    } finally {
      this.pendingViewCreations = Math.max(0, this.pendingViewCreations - 1);
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
    if (this.uiShutdownClosedAt !== undefined) {
      return this.uiShutdownRefusal();
    }
    const result = this.gotoForOwnerAdmitted(owner, sessionId, url, signal);
    if (owner === BROWSER_UI_SESSION_OWNER && result.ok) {
      const entry = this.entryForOwner(owner, result.data.sessionId);
      if (entry?.navigationInFlight !== undefined) {
        this.trackUiNavigation("goto", entry.navigationInFlight);
      }
    }
    return result;
  }

  private gotoForOwnerAdmitted(
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
        const loading = entry.view.loadUrl(url, entry.sessionId);
        this.trackViewLoad("goto", loading);
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
      const loading = entry.view.loadUrl(url, entry.sessionId);
      this.trackViewLoad("goto", loading);
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
    if (this.uiShutdownClosedAt !== undefined) return this.uiShutdownRefusal();
    const entry = this.entryForOwner(BROWSER_UI_SESSION_OWNER, sessionId);
    if (entry === undefined) return err("not_found", `no session for ${sessionId}`);
    entry.lastActiveAt = this.now();
    // A zero-bounds push from a surface that is gone (Close already detached
    // the session, then the slot cleanup echoed park) must never resurrect
    // logical attachment: Close owns detach, and only a real rect remounts.
    const parking = bounds.width < 1 || bounds.height < 1;
    try {
      if (!entry.attached) {
        if (parking) return { ok: true, data: this.info(entry) };
        entry.view.attach(bounds);
        // Commit attachment only after the fallible adapter seam accepted it,
        // so a failed attach cannot leave `attached` claiming a view that
        // never composited.
        entry.attached = true;
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
        entry.view.detach();
        // Commit detachment only after the fallible adapter seam accepted it;
        // a failed detach must keep reporting the session as still attached.
        entry.attached = false;
      }
      entry.lastActiveAt = this.now();
      this.reduceCurrent(entry, { type: "detach" });
      return { ok: true, data: this.info(entry) };
    } catch (error) {
      return err("failed", error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Explicitly terminate one page runtime. The persistent profile partition is
   * never touched; completion is returned only after physical view teardown is
   * acknowledged. Concurrent and repeated calls share one bounded receipt.
   */
  async stop(sessionId: string): Promise<BrowserResult<BrowserStopReceipt>> {
    return this.stopForOwner(BROWSER_UI_SESSION_OWNER, sessionId);
  }

  stopForOwner(
    owner: string,
    sessionId: string,
  ): Promise<BrowserResult<BrowserStopReceipt>> {
    return this.runUiOperation("stop", () =>
      this.stopForOwnerAdmitted(owner, sessionId),
    );
  }

  private async stopForOwnerAdmitted(
    owner: string,
    sessionId: string,
  ): Promise<BrowserResult<BrowserStopReceipt>> {
    const pending = this.pendingStops.get(sessionId);
    if (pending !== undefined) {
      if (pending.owner !== owner) return err("not_found", `no session for ${sessionId}`);
      const completion = pending.completion;
      if (completion === undefined) return err("failed", "browser stop state is unavailable");
      return this.repeatStopResult(await completion);
    }
    const completed = this.stoppedSessions.get(sessionId);
    if (completed !== undefined) {
      if (completed.owner !== owner) return err("not_found", `no session for ${sessionId}`);
      if (completed.lastResult?.ok === true) {
        return this.repeatStopResult(completed.lastResult);
      }
      // A timed-out acknowledgement remains live. Re-waiting permits a later
      // physical WebContents destruction to become authoritative without ever
      // reusing the retired opaque session id.
      return this.runStopAttempt(completed, true);
    }

    const entry = this.entryForOwner(owner, sessionId);
    if (entry === undefined) return err("not_found", `no session for ${sessionId}`);
    const snapshot = this.authorizationSnapshot(entry);
    const receipt: BrowserStopReceipt = Object.freeze({
      sessionId,
      ref: entry.ref,
      profile: entry.profile,
      stopped: true,
      alreadyStopped: false,
    });
    // The bounded stop receipt may time out while Electron's destruction
    // witness is still live. The shared view witness remains in the shutdown
    // set independently of the public Stop Page result.
    const acknowledgement = this.retainViewDestroyWitness(entry);
    const record: BrowserStopRecord = {
      owner,
      snapshot,
      receipt,
      acknowledgement,
      completion: undefined,
      lastResult: undefined,
    };
    return this.runStopAttempt(record, false, entry);
  }

  private async runStopAttempt(
    record: BrowserStopRecord,
    repeated: boolean,
    entry?: SessionEntry,
  ): Promise<BrowserResult<BrowserStopReceipt>> {
    const completion = this.stopEntry(record, entry);
    record.completion = completion;
    this.pendingStops.set(record.receipt.sessionId, record);
    const result = await completion;
    if (this.pendingStops.get(record.receipt.sessionId) === record) {
      this.pendingStops.delete(record.receipt.sessionId);
    }
    record.completion = undefined;
    record.lastResult = result;
    // Retire the authority even while teardown is unacknowledged: the logical
    // session is gone, but its still-live acknowledgement can make a retry
    // authoritative after physical destruction occurs.
    this.rememberStoppedSession(record);
    return repeated ? this.repeatStopResult(result) : result;
  }

  private async stopEntry(
    record: BrowserStopRecord,
    entry?: SessionEntry,
  ): Promise<BrowserResult<BrowserStopReceipt>> {
    if (entry !== undefined) {
      try {
        this.destroySession(entry.sessionId);
      } catch {
        // The adapter's physical destruction acknowledgement is authoritative.
        // Reducer/detach teardown may throw after destroy() has already closed
        // the WebContents, so those errors cannot override a positive receipt.
      }
    }
    const destroyed = await this.awaitProfileViewDestruction(
      record.acknowledgement === undefined ? [] : [record.acknowledgement],
      0,
      Object.freeze({ pendingOpensInvalidated: 0, sessionsDestroyed: 1, viewsDestroyed: 1 }),
    );
    return destroyed.ok
      ? { ok: true, data: record.receipt }
      : destroyed;
  }

  private repeatStopResult(
    result: BrowserResult<BrowserStopReceipt>,
  ): BrowserResult<BrowserStopReceipt> {
    return result.ok
      ? {
          ok: true,
          data: Object.freeze({ ...result.data, alreadyStopped: true }),
        }
      : result;
  }

  private rememberStoppedSession(record: BrowserStopRecord): void {
    this.stoppedSessions.delete(record.receipt.sessionId);
    this.stoppedSessions.set(record.receipt.sessionId, record);
    // Unacknowledged identities stay until a later stopForOwner retry gets an
    // exact destruction receipt. Only successful receipts are FIFO-bounded.
    const acknowledged: string[] = [];
    for (const [sessionId, record] of this.stoppedSessions) {
      if (record.lastResult?.ok === true) acknowledged.push(sessionId);
    }
    for (const sessionId of acknowledged.slice(0, Math.max(
      0,
      acknowledged.length - BrowserSessionService.MAX_STOP_RECEIPTS,
    ))) {
      this.stoppedSessions.delete(sessionId);
    }
  }

  async eval(
    sessionId: string,
    code: string,
    signal?: AbortSignal,
  ): Promise<BrowserResult<{ result: unknown }>> {
    return this.evalForOwner(BROWSER_UI_SESSION_OWNER, sessionId, code, signal);
  }

  evalForOwner(
    owner: string,
    sessionId: string,
    code: string,
    signal?: AbortSignal,
  ): Promise<BrowserResult<{ result: unknown }>> {
    return this.runUiOperation("eval", () =>
      this.evalForOwnerAdmitted(owner, sessionId, code, signal),
    );
  }

  private async evalForOwnerAdmitted(
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

  screenshotForOwner(
    owner: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<BrowserResult<{ png: Uint8Array }>> {
    return this.runUiOperation("screenshot", () =>
      this.screenshotForOwnerAdmitted(owner, sessionId, signal),
    );
  }

  private async screenshotForOwnerAdmitted(
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

  /**
   * Live overseer may operate an existing session for a page ref without
   * impersonating the UI sender. Ordinary owner checks stay intact.
   * First match only — deletion must use `overseerDeleteSessionsForRef`.
   */
  overseerSessionForRef(ref: string):
    | { readonly owner: string; readonly sessionId: string }
    | undefined {
    return this.overseerSessionsForRef(ref)[0];
  }

  /**
   * Every current live (owner, session) bound to a page ref. UI and distinct
   * automation owners are all included. Node id is never a session id.
   */
  overseerSessionsForRef(
    ref: string,
  ): ReadonlyArray<{ readonly owner: string; readonly sessionId: string }> {
    const live: Array<{ readonly owner: string; readonly sessionId: string }> = [];
    const seen = new Set<string>();
    const push = (owner: string, sessionId: string): void => {
      const key = `${owner}\0${sessionId}`;
      if (seen.has(key)) return;
      seen.add(key);
      live.push({ owner, sessionId });
    };
    for (const [owner, refs] of this.sessionIdByOwnerRef) {
      const sessionId = refs.get(ref);
      if (sessionId === undefined) continue;
      const entry = this.entryForOwner(owner, sessionId);
      if (entry !== undefined) push(owner, sessionId);
    }
    for (const entry of this.sessions.values()) {
      if (!this.isCurrent(entry) || entry.ref !== ref) continue;
      push(entry.owner, entry.sessionId);
    }
    return live;
  }

  /**
   * Deletion discovery: live sessions plus pending or unacknowledged stops
   * for this exact page ref. List/get stay live-only via overseerSessionsForRef.
   * Callers must wait on stopForOwner — never treat an unacknowledged
   * teardown as absence.
   */
  overseerDeleteSessionsForRef(
    ref: string,
  ): ReadonlyArray<{ readonly owner: string; readonly sessionId: string }> {
    const discovered = [...this.overseerSessionsForRef(ref)];
    const seen = new Set(discovered.map((row) => `${row.owner}\0${row.sessionId}`));
    const push = (owner: string, sessionId: string): void => {
      const key = `${owner}\0${sessionId}`;
      if (seen.has(key)) return;
      seen.add(key);
      discovered.push({ owner, sessionId });
    };
    const consider = (record: BrowserStopRecord): void => {
      if (record.receipt.ref !== ref) return;
      if (record.lastResult?.ok === true) return;
      push(record.owner, record.receipt.sessionId);
    };
    for (const record of this.pendingStops.values()) consider(record);
    for (const record of this.stoppedSessions.values()) consider(record);
    return discovered;
  }

  /**
   * Fence a page ref from prepare through finish. Bumps the ref generation and
   * aborts in-flight opens so they cannot create/navigate after deletion.
   * Sibling refs and owners stay live.
   */
  beginOverseerPageDelete(ref: string, leaseId: string): void {
    const id = leaseId.trim();
    if (id.length === 0) return;
    const holders = this.refDeleteLeases.get(ref) ?? new Set<string>();
    holders.add(id);
    this.refDeleteLeases.set(ref, holders);
    this.bumpRefGeneration(ref);
    for (const [owner, pendingByRef] of this.pendingOpenByOwnerRef) {
      if (!pendingByRef.delete(ref)) continue;
      if (pendingByRef.size === 0) this.pendingOpenByOwnerRef.delete(owner);
    }
  }

  finishOverseerPageDelete(ref: string, leaseId: string): void {
    const id = leaseId.trim();
    const holders = this.refDeleteLeases.get(ref);
    if (holders === undefined) return;
    holders.delete(id);
    if (holders.size === 0) this.refDeleteLeases.delete(ref);
  }

  overseerSessionOwner(sessionId: string): string | undefined {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined || !this.isCurrent(entry)) return undefined;
    return entry.owner;
  }

  authorizationSnapshotForOwner(
    owner: string,
    sessionId: string,
  ): BrowserResult<BrowserSessionAuthorizationSnapshot> {
    const entry = this.entryForOwner(owner, sessionId);
    if (entry === undefined) return err("not_found", `no session for ${sessionId}`);
    return { ok: true, data: this.authorizationSnapshot(entry) };
  }

  stoppedAuthorizationSnapshotForOwner(
    owner: string,
    sessionId: string,
  ): BrowserResult<BrowserSessionAuthorizationSnapshot> {
    const record = this.pendingStops.get(sessionId) ?? this.stoppedSessions.get(sessionId);
    return record !== undefined && record.owner === owner
      ? { ok: true, data: record.snapshot }
      : err("not_found", `no stopped session for ${sessionId}`);
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
          (waiter) => waiter.sessionId === sessionId,
          current === entry
            ? entry.machine.state === "failed"
              ? err("failed", entry.machine.lastError ?? "navigation failed")
              : { ok: true, data: this.info(entry) }
            : err("not_found", `no session for ${sessionId}`),
        );
      }
    });
  }

  private trackUiNavigation(
    kind: Extract<BrowserUiOperationKind, "open" | "goto">,
    sessionId: string,
  ): void {
    const completion = this.awaitNavigationTerminalForOwner(
      BROWSER_UI_SESSION_OWNER,
      sessionId,
    );
    void this.retainUiOperation(kind, () => completion);
  }

  private trackViewLoad(
    kind: Extract<BrowserUiOperationKind, "open" | "goto">,
    loading: Promise<void>,
  ): void {
    void this.retainUiOperation(kind, () => loading);
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
    const lingeringStopsBySessionId = new Map<string, BrowserStopRecord>();
    for (const record of this.stoppedSessions.values()) {
      if (record.receipt.profile === profile && record.lastResult?.ok !== true) {
        lingeringStopsBySessionId.set(record.receipt.sessionId, record);
      }
    }
    for (const record of this.pendingStops.values()) {
      if (record.receipt.profile === profile) {
        lingeringStopsBySessionId.set(record.receipt.sessionId, record);
      }
    }
    const lingeringStops = [...lingeringStopsBySessionId.values()];
    const acknowledgements: Promise<void>[] = [];
    let teardownFailures = 0;
    const failure = new BrowserOperationFailure(
      "cancelled",
      clampUtf8Bytes(reason, BROWSER_MAX_ERROR_BYTES),
    );

    for (const entry of entries) {
      const acknowledgement = this.retainViewDestroyWitness(entry);
      if (acknowledgement === undefined) teardownFailures += 1;
      else acknowledgements.push(acknowledgement);
      try {
        this.destroySession(entry.sessionId, failure);
      } catch {
        // The retained physical witness decides whether deletion may proceed.
      }
    }

    // Stop Page unregisters logical authority before awaiting Electron's
    // physical `destroyed` event. A profile wipe begun during that bounded
    // wait must inherit the same acknowledgement; otherwise disk deletion
    // could race a still-live WebContents that no longer appears in sessions.
    for (const record of lingeringStops) {
      if (record.acknowledgement === undefined) teardownFailures += 1;
      else acknowledgements.push(record.acknowledgement);
    }

    const completion = this.awaitProfileViewDestruction(
      acknowledgements,
      teardownFailures,
      Object.freeze({
        pendingOpensInvalidated,
        sessionsDestroyed: entries.length,
        viewsDestroyed: entries.length + lingeringStops.length,
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
    return this.destroyOwnerSessionIds(ownedSessionIds, reason);
  }

  /**
   * Edge-delete teardown: revoke only the (owner, page-ref) pair.
   * Sibling targets under the same owner stay alive. Does not bump the owner
   * epoch — that would strand remaining pages' open attempts.
   */
  destroyOwnerTargetSessions(
    owner: string,
    ref: string,
    reason = "browser edge revoked",
  ): number {
    const pending = this.pendingOpenByOwnerRef.get(owner);
    if (pending !== undefined) {
      pending.delete(ref);
      if (pending.size === 0) this.pendingOpenByOwnerRef.delete(owner);
    }
    const ownedSessionIds = [...this.sessions.values()]
      .filter((entry) => entry.owner === owner && entry.ref === ref)
      .map((entry) => entry.sessionId);
    return this.destroyOwnerSessionIds(ownedSessionIds, reason);
  }

  private destroyOwnerSessionIds(
    ownedSessionIds: ReadonlyArray<string>,
    reason: string,
  ): number {
    const failure = new BrowserOperationFailure(
      "cancelled",
      clampUtf8Bytes(reason, BROWSER_MAX_ERROR_BYTES),
    );
    let teardownFailures = 0;
    for (const sessionId of ownedSessionIds) {
      const entry = this.sessions.get(sessionId);
      if (entry === undefined || this.retainViewDestroyWitness(entry) === undefined) {
        teardownFailures += 1;
      }
      try {
        this.destroySession(sessionId, failure);
      } catch {
        // Continue through the exact owner snapshot. The physical witness is
        // authoritative: an adapter may close successfully and then throw.
      }
    }
    if (teardownFailures > 0) {
      throw new BrowserOwnerSessionTeardownFailure(teardownFailures);
    }
    return ownedSessionIds.length;
  }

  private retainViewDestroyWitness(entry: SessionEntry): Promise<void> | undefined {
    if (this.viewDestroyWitnesses.has(entry.view)) {
      const retained = this.viewDestroyWitnesses.get(entry.view);
      return retained === MISSING_VIEW_DESTROY_WITNESS ? undefined : retained;
    }
    let acknowledgement: Promise<void> | undefined;
    try {
      const observed = entry.view.whenDestroyed?.();
      if (observed !== undefined) acknowledgement = Promise.resolve(observed);
    } catch {
      acknowledgement = undefined;
    }
    if (acknowledgement === undefined) {
      this.viewDestroyWitnesses.set(entry.view, MISSING_VIEW_DESTROY_WITNESS);
      this.teardownWitnessFailures += 1;
      return undefined;
    }
    const witnessed = acknowledgement.catch((error) => {
      this.teardownWitnessFailures += 1;
      throw error;
    });
    this.viewDestroyWitnesses.set(entry.view, witnessed);
    const teardown: PendingViewTeardown = { view: entry.view, witness: witnessed };
    this.pendingViewTeardowns.add(teardown);
    const retireTeardown = (): void => {
      this.pendingViewTeardowns.delete(teardown);
    };
    void witnessed.then(retireTeardown, retireTeardown);
    // Every physical view termination is retained, including warm eviction,
    // navigation failure, and pre-shutdown capability revocation. A view that
    // leaves the logical registry one tick before quit therefore cannot vanish
    // from the aggregate receipt.
    void this.retainUiOperation("view-destroy", () => witnessed);
    return witnessed;
  }

  private retryPendingViewDestructions(): void {
    for (const teardown of this.pendingViewTeardowns) {
      try {
        teardown.view.stopLoading?.();
      } catch {
        // The next explicit drain may retry while the witness remains pending.
      }
      try {
        teardown.view.destroy();
      } catch {
        // Keep the teardown tombstone until its physical witness settles.
      }
    }
  }

  private requestViewDestruction(entry: SessionEntry): void {
    this.retainViewDestroyWitness(entry);
    try {
      entry.view.stopLoading?.();
    } catch {
      // Destruction is still mandatory and its witness remains authoritative.
    }
    try {
      entry.view.destroy();
    } catch {
      // The retained destroyed-event promise is the teardown authority.
    }
  }

  /** Warm-pool eviction only. Profile partition data persists. */
  private destroySession(sessionId: string, failure?: BrowserOperationFailure): void {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) return;
    this.retainViewDestroyWitness(entry);
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
      // The entry is dying: every remaining waiter, including any whose
      // generation was rotated away earlier, must settle now or the quit
      // drain waits on a completion that can never happen.
      () => true,
      err(failure?.code ?? "not_found", failure?.message ?? `no session for ${sessionId}`),
    );
    try {
      this.reduceCurrent(entry, { type: "destroy" });
    } catch {
      // Logical state publication cannot prevent physical teardown.
    }
    this.unregister(entry);
    try {
      if (entry.attached) entry.view.detach();
    } catch {
      // Detach is best-effort; destroy remains mandatory.
    }
    this.requestViewDestruction(entry);
    this.uiDetachFailures.delete(sessionId);
  }

  private destroyAllSessionsOnQuit(reason: string): number {
    const sessionIds = [...this.sessions.values()]
      .map((entry) => entry.sessionId);
    const failure = new BrowserOperationFailure(
      "cancelled",
      clampUtf8Bytes(reason, BROWSER_MAX_ERROR_BYTES),
    );
    let destroyed = 0;
    for (const sessionId of sessionIds) {
      const entry = this.sessions.get(sessionId);
      if (entry === undefined) continue;
      this.retainViewDestroyWitness(entry);
      try {
        this.destroySession(sessionId, failure);
      } catch (error) {
        // destroySession invalidates logical authority before crossing the
        // fallible adapter seam. The retained destroyed-event promise decides
        // whether shutdown can report clean.
        console.error(`[browser] runtime teardown on quit failed (${reason}):`, error);
      }
      if (!this.isCurrent(entry)) destroyed += 1;
    }
    return destroyed;
  }

  /**
   * Close browser session admission synchronously and invalidate every delayed
   * UI or automation opener. The transition is monotonic: a failed quit
   * remains fail-closed and can retry its drain without making browser work
   * reachable again.
   */
  beginUiShutdown(_reason = "browser UI shutdown"): BrowserUiShutdownPrecommitReceipt {
    if (this.uiShutdownClosedAt === undefined) {
      this.uiShutdownEpoch += 1;
      this.uiShutdownClosedAt = Date.now();
      this.ownerEpochs.set(
        BROWSER_UI_SESSION_OWNER,
        this.ownerEpoch(BROWSER_UI_SESSION_OWNER) + 1,
      );
      this.pendingOpenByOwnerRef.clear();
      for (const [id, operation] of this.activeUiOperations) {
        this.closedUiAdmissions.set(id, operation);
      }
    }
    return Object.freeze({
      epoch: this.uiShutdownEpoch,
      closedAt: this.uiShutdownClosedAt!,
      activeOperations: Object.freeze([...this.activeUiOperationKinds()]),
    });
  }

  private detachUiSessionsOnQuit(reason: string): {
    readonly sessionsDetached: number;
    readonly detachFailures: number;
  } {
    let sessionsDetached = 0;
    for (const entry of [...this.sessions.values()]) {
      if (entry.owner !== BROWSER_UI_SESSION_OWNER) continue;
      try {
        const operation = entry.activeOperation;
        if (operation !== undefined) {
          this.releaseOperation(
            entry,
            operation,
            new BrowserOperationFailure("cancelled", `${operation.kind} cancelled during quit`),
          );
          entry.navigationInFlight = undefined;
          if (operation.kind === "navigation") {
            this.settleNavigationWaiters(
              entry,
              // The entry is being torn down for quit; no waiter can complete.
              () => true,
              err("cancelled", "navigation cancelled during quit"),
            );
          }
        }
        const physicalDetachRequired = entry.attached || this.uiDetachFailures.has(entry.sessionId);
        entry.attached = false;
        if (physicalDetachRequired) entry.view.detach();
        this.reduceCurrent(entry, { type: "detach" });
        this.uiDetachFailures.delete(entry.sessionId);
        sessionsDetached += 1;
      } catch (error) {
        this.uiDetachFailures.add(entry.sessionId);
        console.error(`[browser] detach on quit failed (${reason}, ${entry.sessionId}):`, error);
      }
    }
    return Object.freeze({
      sessionsDetached,
      detachFailures: this.uiDetachFailures.size,
    });
  }

  /**
   * Await the real promises admitted before the UI gate closed. A timeout
   * returns an unclean receipt without dropping strong references; a retry can
   * later observe convergence.
   */
  drainUiOnQuit(reason = "browser UI shutdown"): Promise<BrowserUiShutdownDrainReceipt> {
    const precommit = this.beginUiShutdown(reason);
    if (this.uiShutdownDrainFlight !== undefined) return this.uiShutdownDrainFlight;

    let resolveFlight!: (receipt: BrowserUiShutdownDrainReceipt) => void;
    let rejectFlight!: (error: unknown) => void;
    const flight = new Promise<BrowserUiShutdownDrainReceipt>((resolve, reject) => {
      resolveFlight = resolve;
      rejectFlight = reject;
    });
    // Publish before invoking adapter destroy(), whose implementation is an
    // external seam and may synchronously re-enter shutdown.
    this.uiShutdownDrainFlight = flight;
    void flight.then(
      () => {
        if (this.uiShutdownDrainFlight === flight) this.uiShutdownDrainFlight = undefined;
      },
      () => {
        if (this.uiShutdownDrainFlight === flight) this.uiShutdownDrainFlight = undefined;
      },
    );

    let sessionsDestroyed: number;
    try {
      this.retryPendingViewDestructions();
      sessionsDestroyed = this.destroyAllSessionsOnQuit(reason);
    } catch (error) {
      rejectFlight(error);
      return flight;
    }
    const work = (async (): Promise<BrowserUiShutdownDrainReceipt> => {
      const deadline = performance.now() + this.uiShutdownDrainTimeoutMs;
      const observed = new Set<number>();
      const operations: BrowserUiOperationKind[] = [];
      let settled = 0;
      let fulfilled = 0;
      let rejected = 0;
      let rounds = 0;
      let timedOut = false;

      while (true) {
        // A delayed opener that crossed its final synchronous seam just before
        // the epoch bump is still caught here. Destroying it can itself add a
        // new physical witness to this fixed-point round.
        sessionsDestroyed += this.destroyAllSessionsOnQuit(reason);
        const round = [...this.closedUiAdmissions.values()]
          .filter((operation) => !observed.has(operation.id))
          .sort((left, right) => left.id - right.id);
        if (round.length === 0) {
          await Promise.resolve();
          if (
            ![...this.closedUiAdmissions.values()].some(
              (operation) => !observed.has(operation.id),
            )
          ) {
            break;
          }
          continue;
        }
        rounds += 1;
        for (const operation of round) {
          observed.add(operation.id);
          operations.push(operation.kind);
        }

        const remainingMs = Math.max(0, deadline - performance.now());
        if (remainingMs === 0) {
          timedOut = true;
          break;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), remainingMs);
        });
        const outcomes = await Promise.race([
          Promise.allSettled(round.map((operation) => operation.promise)),
          timeout,
        ]);
        if (timer !== undefined) clearTimeout(timer);
        if (outcomes === undefined) {
          timedOut = true;
          break;
        }
        settled += outcomes.length;
        for (const outcome of outcomes) {
          if (outcome.status === "fulfilled") fulfilled += 1;
          else rejected += 1;
        }
        for (const operation of round) this.closedUiAdmissions.delete(operation.id);
      }

      const activeOperations = this.activeUiOperationKinds();
      return Object.freeze({
        epoch: precommit.epoch,
        clean:
          !timedOut &&
          activeOperations.length === 0 &&
          this.teardownWitnessFailures === 0,
        operations: Object.freeze(operations),
        settled,
        fulfilled,
        rejected,
        rounds,
        timedOut,
        activeOperations: Object.freeze([...activeOperations]),
        sessionsDestroyed,
        teardownWitnessFailures: this.teardownWitnessFailures,
      });
    })();
    void work.then(resolveFlight, rejectFlight);
    return flight;
  }

  /** Quit detaches views only; profile partitions are never touched. */
  detachAllOnQuit(reason: string): void {
    this.beginUiShutdown(reason);
    this.detachUiSessionsOnQuit(reason);
    for (const entry of [...this.sessions.values()]) {
      if (entry.owner === BROWSER_UI_SESSION_OWNER) continue;
      try {
        const operation = entry.activeOperation;
        if (operation !== undefined) {
          this.releaseOperation(
            entry,
            operation,
            new BrowserOperationFailure("cancelled", `${operation.kind} cancelled during quit`),
          );
          entry.navigationInFlight = undefined;
          if (operation.kind === "navigation") {
            this.settleNavigationWaiters(
              entry,
              // The entry is being torn down for quit; no waiter can complete.
              () => true,
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
