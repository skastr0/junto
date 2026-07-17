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

/**
 * Thin Electron seam. The real adapter creates a partitioned
 * WebContentsView parented under the BrowserWindow contentView. Tests inject
 * a spy. destroy() releases only the runtime view; profile storage persists.
 */
export interface BrowserViewHandle {
  loadUrl(url: string, expectedSessionId: string): void;
  attach(bounds: BrowserSurfaceBounds): void;
  setBounds(bounds: BrowserSurfaceBounds): void;
  detach(): void;
  destroy(): void;
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

export type BrowserViewAdapter = (
  partition: string,
  events: BrowserViewEvents,
) => BrowserViewHandle;

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
  sessionId: string;
  readonly ref: string;
  readonly nodeId: string;
  readonly profile: string;
  readonly targetUrl: string;
  url: string;
  machine: BrowserSessionMachine;
  attached: boolean;
  navigationInFlight: string | undefined;
  activeOperation: ActiveOperation | undefined;
  lastActiveAt: number;
  view: BrowserViewHandle;
}

interface PendingOpen {
  readonly target: ResolvedPageTarget;
  readonly promise: Promise<BrowserResult<BrowserSessionInfo>>;
}

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

const validateTarget = (target: ResolvedPageTarget): BrowserResultErr | undefined => {
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
  if (!isAllowedBrowserUrl(target.url)) {
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
  private readonly sessionIdByRef = new Map<string, string>();
  private readonly pendingOpenByRef = new Map<string, PendingOpen>();
  private activeOperationCount = 0;
  private sink: ((session: BrowserSessionInfo) => void) | undefined;
  // Sole durable SoT for these numbers is Settings.browser; profiles.config
  // remains fallback for tests that never install a limits provider.
  private poolLimits: (() => Promise<BrowserPoolLimits>) | undefined;

  constructor(
    private readonly adapter: BrowserViewAdapter,
    private readonly profiles: BrowserProfileServiceApi = makeBrowserProfileService(),
    private readonly now: () => number = Date.now,
    private readonly generateSessionId: () => string = randomUUID,
  ) {}

  setSink(sink: (session: BrowserSessionInfo) => void): void {
    this.sink = sink;
  }

  /** Install Settings (or test fake) as the pool-limits authority. */
  setPoolLimitsProvider(provider: () => Promise<BrowserPoolLimits>): void {
    this.poolLimits = provider;
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
      if (!this.isCurrent(input.entry) || input.entry.sessionId !== input.sessionId) {
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

  private isCurrent(entry: SessionEntry): boolean {
    return (
      this.sessions.get(entry.sessionId) === entry &&
      this.sessionIdByRef.get(entry.ref) === entry.sessionId
    );
  }

  private emit(entry: SessionEntry): void {
    if (this.isCurrent(entry)) this.sink?.(this.info(entry));
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
  }

  private updateGenerationUrl(entry: SessionEntry, sessionId: string, url: string): void {
    if (entry.sessionId !== sessionId || !this.isCurrent(entry)) return;
    entry.url = clampUtf8Bytes(url, BROWSER_MAX_METADATA_BYTES);
    this.emit(entry);
  }

  private register(entry: SessionEntry): void {
    this.sessions.set(entry.sessionId, entry);
    this.sessionIdByRef.set(entry.ref, entry.sessionId);
  }

  private unregister(entry: SessionEntry): void {
    if (this.sessions.get(entry.sessionId) === entry) this.sessions.delete(entry.sessionId);
    if (this.sessionIdByRef.get(entry.ref) === entry.sessionId) {
      this.sessionIdByRef.delete(entry.ref);
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
    entry.url = clampUtf8Bytes(url, BROWSER_MAX_METADATA_BYTES);
    this.sessions.set(entry.sessionId, entry);
    this.sessionIdByRef.set(entry.ref, entry.sessionId);
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
    const invalid = validateTarget(target);
    if (invalid !== undefined) return invalid;

    const pending = this.pendingOpenByRef.get(target.ref);
    if (pending !== undefined) {
      return sameTarget(pending.target, target)
        ? pending.promise
        : err("invalid", "canonical page ref resolved to conflicting page metadata");
    }

    const promise = this.openResolved(target, signal);
    const record: PendingOpen = { target, promise };
    this.pendingOpenByRef.set(target.ref, record);
    try {
      return await promise;
    } finally {
      if (this.pendingOpenByRef.get(target.ref) === record) {
        this.pendingOpenByRef.delete(target.ref);
      }
    }
  }

  private async openResolved(
    target: ResolvedPageTarget,
    signal?: AbortSignal,
  ): Promise<BrowserResult<BrowserSessionInfo>> {
    const existingId = this.sessionIdByRef.get(target.ref);
    const existing = existingId === undefined ? undefined : this.sessions.get(existingId);
    if (existingId !== undefined && existing === undefined) this.sessionIdByRef.delete(target.ref);
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
      const limits = await this.resolvePoolLimits();
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

    const minted = this.mintSessionId();
    if (!minted.ok) return minted;
    for (const sessionId of warmPoolEvictions(
      [...this.sessions.values()].map((entry) => ({
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
      sessionId: minted.data,
      ref: target.ref,
      nodeId: target.nodeId,
      profile: target.profile,
      targetUrl: target.url,
      url: clampUtf8Bytes(target.url, BROWSER_MAX_METADATA_BYTES),
      machine: initialBrowserSession(),
      attached: false,
      navigationInFlight: undefined,
      activeOperation: undefined,
      lastActiveAt: this.now(),
      view: undefined as unknown as BrowserViewHandle,
    };

    try {
      entry.view = this.adapter(partition, {
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
      });
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
    return { ok: true, data: this.info(entry) };
  }

  goto(
    sessionId: string,
    url: string,
    signal?: AbortSignal,
  ): BrowserResult<BrowserSessionInfo> {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) return err("not_found", `no session for ${sessionId}`);
    if (!isUtf8WithinLimit(url, BROWSER_MAX_URL_BYTES)) {
      return err("invalid", "navigation URL exceeds the hard limit");
    }
    if (!isAllowedBrowserUrl(url)) {
      return err("forbidden", `url not allowed (http/https only): ${url}`);
    }
    if (entry.navigationInFlight !== undefined) {
      return err("invalid", "a top-level navigation is already in flight");
    }
    entry.lastActiveAt = this.now();
    let sameDocument = false;
    try {
      const currentUrl = new URL(entry.url);
      const nextUrl = new URL(url);
      sameDocument =
        currentUrl.origin === nextUrl.origin &&
        currentUrl.pathname === nextUrl.pathname &&
        currentUrl.search === nextUrl.search &&
        currentUrl.hash !== nextUrl.hash;
    } catch {
      // Bounded display metadata can truncate a page-controlled URL. Treat an
      // unparseable current value as a cross-document navigation.
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
    const entry = this.sessions.get(sessionId);
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
    const entry = this.sessions.get(sessionId);
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
    const entry = this.sessions.get(sessionId);
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
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) return err("not_found", `no session for ${sessionId}`);
    if (entry.navigationInFlight !== undefined) {
      return err("invalid", "cannot capture while top-level navigation is in flight");
    }
    if (entry.view.capturePagePng === undefined) {
      return err("failed", "adapter does not support screenshot");
    }
    entry.lastActiveAt = this.now();
    const captured = await this.runPowerfulOperation({
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
    const entry = this.sessions.get(sessionId);
    return entry === undefined
      ? err("not_found", `no session for ${sessionId}`)
      : { ok: true, data: this.info(entry) };
  }

  list(): BrowserResult<ReadonlyArray<BrowserSessionInfo>> {
    return { ok: true, data: [...this.sessions.values()].map((entry) => this.info(entry)) };
  }

  sessionIdForRef(ref: string): string | undefined {
    const sessionId = this.sessionIdByRef.get(ref);
    return sessionId !== undefined && this.sessions.has(sessionId) ? sessionId : undefined;
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
    this.reduceCurrent(entry, { type: "destroy" });
    this.unregister(entry);
    try {
      if (entry.attached) entry.view.detach();
    } finally {
      entry.view.destroy();
    }
  }

  /** Quit detaches views only; profile partitions are never touched. */
  detachAllOnQuit(reason: string): void {
    for (const entry of this.sessions.values()) {
      try {
        const operation = entry.activeOperation;
        if (operation !== undefined) {
          this.releaseOperation(
            entry,
            operation,
            new BrowserOperationFailure("cancelled", `${operation.kind} cancelled during quit`),
          );
          entry.navigationInFlight = undefined;
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
