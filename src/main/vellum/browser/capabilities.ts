import {
  createHash,
  createHmac,
  randomBytes as nodeRandomBytes,
} from "node:crypto";
import { performance } from "node:perf_hooks";
import { isValidProfileId } from "@shared/browser";
import { isValidControlRequestId } from "@shared/browser-control";
import {
  BROWSER_MAX_REF_BYTES,
  BROWSER_MAX_SESSION_ID_BYTES,
  BROWSER_MAX_URL_BYTES,
  isUtf8WithinLimit,
  isValidBrowserSessionId,
} from "@shared/browser-limits";
import type { NodeRefKey } from "@shared/node-ref";
import { parseNodeRef } from "@shared/node-ref";

export const BROWSER_CAPABILITY_ACTIONS = [
  "profiles",
  "pages",
  "sessions",
  "open",
  "goto",
  "eval",
  "screenshot",
  "close",
] as const;
export type BrowserCapabilityAction = (typeof BROWSER_CAPABILITY_ACTIONS)[number];

export const BROWSER_CAPABILITY_SECRET_BYTES = 32;
export const BROWSER_CAPABILITY_MAX_TTL_MS = 24 * 60 * 60 * 1_000;
export const BROWSER_CAPABILITY_MAX_USES = 1_000_000;
export const BROWSER_CAPABILITY_MAX_IN_FLIGHT = 32;
export const BROWSER_CAPABILITY_MAX_TARGETS = 512;
export const BROWSER_CAPABILITY_MAX_ORIGINS_PER_TARGET = 32;
export const BROWSER_CAPABILITY_MAX_REGISTRY_SIZE = 1_024;
export const BROWSER_CAPABILITY_MAX_PER_PRINCIPAL = 16;
export const BROWSER_CAPABILITY_MAX_AUDIT_EVENTS = 4_096;
export const BROWSER_CAPABILITY_MAX_RECENT_REQUEST_IDS = 2_048;

const DEFAULT_REGISTRY_SIZE = 256;
const DEFAULT_PER_PRINCIPAL = 8;
const DEFAULT_AUDIT_EVENTS = 1_024;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ACTIONS = new Set<string>(BROWSER_CAPABILITY_ACTIONS);
const LIST_ACTIONS = new Set<BrowserCapabilityAction>([
  "profiles",
  "pages",
  "sessions",
]);
const COMPLETION_OUTCOMES = new Set<BrowserCapabilityCompletionOutcome>([
  "success",
  "failed",
  "cancelled",
]);
const REVOCATION_REASONS = new Set<BrowserCapabilityRevocationReason>([
  "operator",
  "job_complete",
  "principal_closed",
  "superseded",
]);

export interface BrowserCapabilityTarget {
  readonly ref: NodeRefKey;
  readonly profile: string;
  readonly exactOrigins: ReadonlyArray<string>;
}

export interface BrowserAutomationPrincipal {
  readonly ownerId: string;
  readonly principalId: string;
  readonly jobId: string;
}

export interface BrowserCapabilityHandle {
  readonly ownerId: string;
  readonly principalId: string;
  readonly jobId: string;
  readonly auditId: string;
}

export interface BrowserCapabilityIssueSpec {
  readonly actions: ReadonlyArray<BrowserCapabilityAction>;
  readonly targets: ReadonlyArray<BrowserCapabilityTarget>;
  readonly ttlMs: number;
  readonly maxUses: number;
  readonly maxInFlight: number;
}

export interface BrowserCapabilityGrant extends BrowserCapabilityHandle {
  /** The only return of bearer material. Keep the accompanying handle in main. */
  readonly secret: string;
  readonly handle: BrowserCapabilityHandle;
  readonly actions: ReadonlyArray<BrowserCapabilityAction>;
  readonly targets: ReadonlyArray<BrowserCapabilityTarget>;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly revocationGeneration: number;
  readonly maxUses: number;
  readonly maxInFlight: number;
}

export interface BrowserCapabilityUseTarget {
  readonly ref: NodeRefKey;
  readonly profile: string;
  readonly exactOrigins: ReadonlyArray<string>;
  readonly generation?: string;
}

export interface BrowserCapabilityUseRequest {
  readonly action: BrowserCapabilityAction;
  readonly target?: BrowserCapabilityUseTarget;
}

export interface BrowserCapabilityAuthorizationContext {
  readonly requestId: string;
  /** Must be a registry-created object held by trusted main-process code. */
  readonly expectedPrincipal?: BrowserAutomationPrincipal;
}

export type BrowserCapabilityPreflightResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly denial: "unauthorized" | "forbidden" };

export type BrowserCapabilityCompletionOutcome = "success" | "failed" | "cancelled";
export type BrowserCapabilityRevocationReason =
  | "operator"
  | "job_complete"
  | "principal_closed"
  | "superseded";
export type BrowserCapabilityAbortReason = "expired" | "revoked" | "app_close";

export interface BrowserCapabilityLease extends BrowserCapabilityHandle {
  readonly action: BrowserCapabilityAction;
  readonly target?: BrowserCapabilityUseTarget;
  readonly scope: ReadonlyArray<BrowserCapabilityTarget>;
  readonly expiresAt: number;
  readonly remainingUses: number;
  readonly signal: AbortSignal;
  readonly checkTarget: (target: BrowserCapabilityUseTarget) => BrowserCapabilityUseTarget;
  readonly boundGeneration: (ref: NodeRefKey) => string | undefined;
  readonly bindGeneration: (ref: NodeRefKey, generation: string) => void;
  readonly rollGeneration: (
    ref: NodeRefKey,
    expectedGeneration: string,
    nextGeneration: string,
  ) => void;
  readonly unbindGeneration: (ref: NodeRefKey, expectedGeneration: string) => void;
  readonly release: (outcome?: BrowserCapabilityCompletionOutcome) => void;
}

export type BrowserCapabilityDenialReason =
  | "credential"
  | "scope"
  | "expired"
  | "exhausted"
  | "concurrency"
  | "replay"
  | "closed";

/** Fixed-message authorization denial: never contains secret, target, or page data. */
export class BrowserCapabilityDenied extends Error {
  readonly name = "BrowserCapabilityDenied";

  constructor(readonly reason: BrowserCapabilityDenialReason) {
    super("browser capability denied");
  }
}

export type BrowserCapabilityIssueDenialReason = "invalid" | "capacity" | "closed";

/** Fixed-message minting denial for the trusted main-process issuance seam. */
export class BrowserCapabilityIssueDenied extends Error {
  readonly name = "BrowserCapabilityIssueDenied";

  constructor(readonly reason: BrowserCapabilityIssueDenialReason) {
    super("browser capability issuance denied");
  }
}

/** Fixed-message generation state denial: values never enter the error. */
export class BrowserCapabilityStateDenied extends Error {
  readonly name = "BrowserCapabilityStateDenied";

  constructor() {
    super("browser capability state transition denied");
  }
}

export class BrowserCapabilityLeaseAbort extends Error {
  readonly name = "BrowserCapabilityLeaseAbort";

  constructor(readonly reason: BrowserCapabilityAbortReason) {
    super("browser capability lease aborted");
  }
}

export type BrowserCapabilityAuditEventKind =
  | "issued"
  | "admission"
  | "completion"
  | "generation"
  | "lifecycle";

export type BrowserCapabilityAuditOutcome =
  | "issued"
  | "admitted"
  | "success"
  | "failed"
  | "cancelled"
  | "denied_credential"
  | "denied_scope"
  | "denied_expired"
  | "denied_exhausted"
  | "denied_concurrency"
  | "denied_replay"
  | "denied_closed"
  | "generation_bound"
  | "generation_rolled"
  | "generation_unbound"
  | "aborted_expired"
  | "aborted_revoked"
  | "aborted_app_close"
  | "revoked_operator"
  | "revoked_job_complete"
  | "revoked_principal_closed"
  | "revoked_superseded"
  | "expired"
  | "exhausted"
  | "app_closed";

export interface BrowserCapabilityAuditEvent {
  readonly sequence: number;
  readonly at: number;
  readonly kind: BrowserCapabilityAuditEventKind;
  readonly outcome: BrowserCapabilityAuditOutcome;
  readonly ownerId?: string;
  readonly principalId?: string;
  readonly jobId?: string;
  readonly auditId?: string;
  readonly useId?: string;
  readonly revocationGeneration?: number;
  readonly action?: BrowserCapabilityAction;
  readonly targetTag?: string;
  readonly targetTags?: ReadonlyArray<string>;
  readonly generationTag?: string;
}

export interface BrowserCapabilityRegistryStats {
  readonly closed: boolean;
  readonly activeCapabilities: number;
  readonly activeLeases: number;
  readonly principalsWithCapabilities: number;
  readonly auditEvents: number;
}

export interface BrowserCapabilityDependencies {
  readonly wallNow: () => number;
  readonly monotonicNow: () => number;
  readonly randomBytes: (size: number) => Uint8Array;
  readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
}

export interface BrowserCapabilityRegistryOptions {
  readonly maxCapabilities?: number;
  readonly maxCapabilitiesPerPrincipal?: number;
  readonly auditCapacity?: number;
  readonly dependencies?: Partial<BrowserCapabilityDependencies>;
}

interface PrincipalRecord {
  readonly publicValue: BrowserAutomationPrincipal;
  revocationGeneration: number;
  liveCapabilities: number;
}

interface CapabilityRecord {
  readonly digest: string;
  readonly handle: BrowserCapabilityHandle;
  readonly principal: PrincipalRecord;
  readonly actions: ReadonlySet<BrowserCapabilityAction>;
  readonly actionList: ReadonlyArray<BrowserCapabilityAction>;
  readonly targets: ReadonlyArray<BrowserCapabilityTarget>;
  readonly targetsByRef: ReadonlyMap<NodeRefKey, BrowserCapabilityTarget>;
  readonly generations: Map<NodeRefKey, string>;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly monotonicDeadline: number;
  readonly revocationGeneration: number;
  readonly maxUses: number;
  readonly maxInFlight: number;
  remainingUses: number;
  timer: unknown;
  readonly active: Map<string, LeaseRecord>;
  readonly recentRequestIds: Set<string>;
  readonly requestIdOrder: string[];
}

interface LeaseRecord {
  readonly useId: string;
  readonly action: BrowserCapabilityAction;
  target?: BrowserCapabilityUseTarget;
  readonly controller: AbortController;
  settled: boolean;
}

const isFinitePositiveInteger = (value: unknown, maximum: number): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value > 0 &&
  value <= maximum;

const isCapabilityAction = (value: unknown): value is BrowserCapabilityAction =>
  typeof value === "string" && ACTIONS.has(value);

const isCanonicalRef = (value: unknown): value is NodeRefKey =>
  typeof value === "string" &&
  isUtf8WithinLimit(value, BROWSER_MAX_REF_BYTES) &&
  parseNodeRef(value).ok;

const canonicalOrigin = (value: unknown): string | undefined => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !isUtf8WithinLimit(value, BROWSER_MAX_URL_BYTES)
  ) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.origin === "null" ||
      parsed.origin !== value
    ) {
      return undefined;
    }
    return parsed.origin;
  } catch {
    return undefined;
  }
};

const normalizeOrigins = (input: unknown): ReadonlyArray<string> | undefined => {
  if (
    !Array.isArray(input) ||
    input.length === 0 ||
    input.length > BROWSER_CAPABILITY_MAX_ORIGINS_PER_TARGET
  ) {
    return undefined;
  }
  const origins = input.map(canonicalOrigin);
  if (origins.some((origin) => origin === undefined)) return undefined;
  const unique = [...new Set(origins as ReadonlyArray<string>)].sort();
  return unique.length === input.length ? Object.freeze(unique) : undefined;
};

const normalizeTarget = (input: unknown): BrowserCapabilityTarget | undefined => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const candidate = input as Partial<BrowserCapabilityTarget>;
  if (!isCanonicalRef(candidate.ref) || typeof candidate.profile !== "string") return undefined;
  if (!isValidProfileId(candidate.profile)) return undefined;
  const exactOrigins = normalizeOrigins(candidate.exactOrigins);
  return exactOrigins === undefined
    ? undefined
    : Object.freeze({ ref: candidate.ref, profile: candidate.profile, exactOrigins });
};

const normalizeUseTarget = (input: unknown): BrowserCapabilityUseTarget | undefined => {
  const target = normalizeTarget(input);
  if (target === undefined || typeof input !== "object" || input === null) return undefined;
  const generation = (input as { readonly generation?: unknown }).generation;
  if (
    generation !== undefined &&
    (typeof generation !== "string" ||
      !isUtf8WithinLimit(generation, BROWSER_MAX_SESSION_ID_BYTES) ||
      !isValidBrowserSessionId(generation))
  ) {
    return undefined;
  }
  return Object.freeze({
    ...target,
    ...(generation === undefined ? {} : { generation }),
  });
};

const normalizeTargets = (input: unknown): ReadonlyArray<BrowserCapabilityTarget> | undefined => {
  if (
    !Array.isArray(input) ||
    input.length === 0 ||
    input.length > BROWSER_CAPABILITY_MAX_TARGETS
  ) {
    return undefined;
  }
  const targets = input.map(normalizeTarget);
  if (targets.some((target) => target === undefined)) return undefined;
  const typed = targets as ReadonlyArray<BrowserCapabilityTarget>;
  if (new Set(typed.map((target) => target.ref)).size !== typed.length) return undefined;
  return Object.freeze([...typed].sort((left, right) => left.ref.localeCompare(right.ref)));
};

const normalizeActions = (input: unknown): ReadonlyArray<BrowserCapabilityAction> | undefined => {
  if (!Array.isArray(input) || input.length === 0 || input.length > BROWSER_CAPABILITY_ACTIONS.length) {
    return undefined;
  }
  if (!input.every(isCapabilityAction)) return undefined;
  const unique = [...new Set(input as ReadonlyArray<BrowserCapabilityAction>)];
  if (unique.length !== input.length) return undefined;
  return Object.freeze(
    BROWSER_CAPABILITY_ACTIONS.filter((action) => unique.includes(action)),
  );
};

const digestSecret = (secret: string): string =>
  createHash("sha256").update(secret, "utf8").digest("base64url");

const isCanonicalSecret = (secret: unknown): secret is string => {
  if (typeof secret !== "string" || !TOKEN_PATTERN.test(secret)) return false;
  try {
    const decoded = Buffer.from(secret, "base64url");
    return (
      decoded.byteLength === BROWSER_CAPABILITY_SECRET_BYTES &&
      decoded.toString("base64url") === secret
    );
  } catch {
    return false;
  }
};

const defaultDependencies: BrowserCapabilityDependencies = {
  wallNow: Date.now,
  monotonicNow: () => performance.now(),
  randomBytes: (size) => nodeRandomBytes(size),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const validateRegistryLimit = (
  value: number | undefined,
  fallback: number,
  maximum: number,
): number => {
  const candidate = value ?? fallback;
  if (!isFinitePositiveInteger(candidate, maximum)) {
    throw new BrowserCapabilityIssueDenied("invalid");
  }
  return candidate;
};

const denialOutcome = (reason: BrowserCapabilityDenialReason): BrowserCapabilityAuditOutcome => {
  switch (reason) {
    case "credential":
      return "denied_credential";
    case "scope":
      return "denied_scope";
    case "expired":
      return "denied_expired";
    case "exhausted":
      return "denied_exhausted";
    case "concurrency":
      return "denied_concurrency";
    case "replay":
      return "denied_replay";
    case "closed":
      return "denied_closed";
  }
};

export class BrowserCapabilityRegistry {
  readonly #maxCapabilities: number;
  readonly #maxCapabilitiesPerPrincipal: number;
  readonly #auditCapacity: number;
  readonly #dependencies: BrowserCapabilityDependencies;
  readonly #auditKey: Uint8Array;
  readonly #principals = new WeakMap<BrowserAutomationPrincipal, PrincipalRecord>();
  readonly #handles = new WeakMap<BrowserCapabilityHandle, string>();
  readonly #records = new Map<string, CapabilityRecord>();
  readonly #audit: BrowserCapabilityAuditEvent[] = [];
  #closed = false;
  #idSequence = 0;
  #auditSequence = 0;

  constructor(options: BrowserCapabilityRegistryOptions = {}) {
    this.#maxCapabilities = validateRegistryLimit(
      options.maxCapabilities,
      DEFAULT_REGISTRY_SIZE,
      BROWSER_CAPABILITY_MAX_REGISTRY_SIZE,
    );
    this.#maxCapabilitiesPerPrincipal = validateRegistryLimit(
      options.maxCapabilitiesPerPrincipal,
      DEFAULT_PER_PRINCIPAL,
      BROWSER_CAPABILITY_MAX_PER_PRINCIPAL,
    );
    this.#auditCapacity = validateRegistryLimit(
      options.auditCapacity,
      DEFAULT_AUDIT_EVENTS,
      BROWSER_CAPABILITY_MAX_AUDIT_EVENTS,
    );
    this.#dependencies = {
      ...defaultDependencies,
      ...options.dependencies,
    };
    this.#auditKey = this.#randomExact(BROWSER_CAPABILITY_SECRET_BYTES);
    this.#readClock(this.#dependencies.wallNow);
    this.#readClock(this.#dependencies.monotonicNow);
  }

  createPrincipal(): BrowserAutomationPrincipal {
    if (this.#closed) throw new BrowserCapabilityIssueDenied("closed");
    const publicValue: BrowserAutomationPrincipal = Object.freeze({
      ownerId: this.#nextId("owner"),
      principalId: this.#nextId("principal"),
      jobId: this.#nextId("job"),
    });
    const record: PrincipalRecord = {
      publicValue,
      revocationGeneration: 0,
      liveCapabilities: 0,
    };
    this.#principals.set(publicValue, record);
    return publicValue;
  }

  issue(
    principal: BrowserAutomationPrincipal,
    spec: BrowserCapabilityIssueSpec,
  ): BrowserCapabilityGrant {
    if (this.#closed) throw new BrowserCapabilityIssueDenied("closed");
    this.reapExpired();
    const principalRecord = this.#principals.get(principal);
    if (principalRecord === undefined) throw new BrowserCapabilityIssueDenied("invalid");

    const actions = normalizeActions(spec?.actions);
    const targets = normalizeTargets(spec?.targets);
    if (
      actions === undefined ||
      targets === undefined ||
      !isFinitePositiveInteger(spec?.ttlMs, BROWSER_CAPABILITY_MAX_TTL_MS) ||
      !isFinitePositiveInteger(spec?.maxUses, BROWSER_CAPABILITY_MAX_USES) ||
      !isFinitePositiveInteger(spec?.maxInFlight, BROWSER_CAPABILITY_MAX_IN_FLIGHT)
    ) {
      throw new BrowserCapabilityIssueDenied("invalid");
    }
    if (
      this.#records.size >= this.#maxCapabilities ||
      principalRecord.liveCapabilities >= this.#maxCapabilitiesPerPrincipal
    ) {
      throw new BrowserCapabilityIssueDenied("capacity");
    }

    const { secret, digest } = this.#uniqueSecret();
    const issuedAt = this.#readClock(this.#dependencies.wallNow);
    const monotonicNow = this.#readClock(this.#dependencies.monotonicNow);
    const expiresAt = issuedAt + spec.ttlMs;
    const auditId = this.#nextId("audit");
    const handle: BrowserCapabilityHandle = Object.freeze({
      ...principalRecord.publicValue,
      auditId,
    });
    const targetsByRef = new Map(targets.map((target) => [target.ref, target]));
    const record: CapabilityRecord = {
      digest,
      handle,
      principal: principalRecord,
      actions: new Set(actions),
      actionList: actions,
      targets,
      targetsByRef,
      generations: new Map(),
      issuedAt,
      expiresAt,
      monotonicDeadline: monotonicNow + spec.ttlMs,
      revocationGeneration: principalRecord.revocationGeneration,
      maxUses: spec.maxUses,
      maxInFlight: spec.maxInFlight,
      remainingUses: spec.maxUses,
      timer: undefined,
      active: new Map(),
      recentRequestIds: new Set(),
      requestIdOrder: [],
    };

    this.#records.set(digest, record);
    this.#handles.set(handle, digest);
    principalRecord.liveCapabilities += 1;
    try {
      this.#scheduleExpiry(record);
    } catch {
      this.#records.delete(digest);
      this.#handles.delete(handle);
      principalRecord.liveCapabilities -= 1;
      throw new BrowserCapabilityIssueDenied("invalid");
    }
    this.#appendAudit({
      ...this.#auditIdentity(record),
      kind: "issued",
      outcome: "issued",
      targetTags: Object.freeze(targets.map((target) => this.#targetTag(target))),
      revocationGeneration: record.revocationGeneration,
    });

    return Object.freeze({
      ...handle,
      secret,
      handle,
      actions,
      targets,
      issuedAt,
      expiresAt,
      revocationGeneration: record.revocationGeneration,
      maxUses: record.maxUses,
      maxInFlight: record.maxInFlight,
    });
  }

  /**
   * Non-consuming admission before a request body is read. This intentionally
   * returns no capability metadata; authorize repeats every check after decode.
   */
  preflight(
    presentedSecret: unknown,
    action: unknown,
    expectedPrincipal?: BrowserAutomationPrincipal,
  ): BrowserCapabilityPreflightResult {
    const unauthorized = Object.freeze({ ok: false, denial: "unauthorized" } as const);
    const forbidden = Object.freeze({ ok: false, denial: "forbidden" } as const);
    if (this.#closed) {
      this.#recordDenial(undefined, "closed", undefined);
      return unauthorized;
    }
    if (!isCanonicalSecret(presentedSecret)) {
      this.#recordDenial(undefined, "credential", undefined);
      return unauthorized;
    }
    const record = this.#records.get(digestSecret(presentedSecret));
    if (record === undefined) {
      this.#recordDenial(undefined, "credential", undefined);
      return unauthorized;
    }
    const request = isCapabilityAction(action) ? { action } : undefined;
    if (this.#isExpired(record)) {
      this.#recordDenial(record, "expired", request);
      this.#terminateRecord(record, "expired", "expired");
      return unauthorized;
    }
    if (record.revocationGeneration !== record.principal.revocationGeneration) {
      this.#recordDenial(record, "credential", request);
      this.#terminateRecord(record, "revoked_principal_closed", "revoked");
      return unauthorized;
    }
    if (
      !isCapabilityAction(action) ||
      !record.actions.has(action) ||
      (expectedPrincipal !== undefined &&
        this.#principals.get(expectedPrincipal) !== record.principal)
    ) {
      this.#recordDenial(record, "scope", request);
      return forbidden;
    }
    if (record.remainingUses <= 0) {
      this.#recordDenial(record, "exhausted", request);
      return forbidden;
    }
    if (record.active.size >= record.maxInFlight) {
      this.#recordDenial(record, "concurrency", request);
      return forbidden;
    }
    return Object.freeze({ ok: true });
  }

  authorize(
    presentedSecret: unknown,
    request: BrowserCapabilityUseRequest,
    context: BrowserCapabilityAuthorizationContext,
  ): BrowserCapabilityLease {
    if (this.#closed) {
      this.#recordDenial(undefined, "closed", request);
      throw new BrowserCapabilityDenied("closed");
    }
    if (!isCanonicalSecret(presentedSecret)) {
      this.#recordDenial(undefined, "credential", request);
      throw new BrowserCapabilityDenied("credential");
    }
    const record = this.#records.get(digestSecret(presentedSecret));
    if (record === undefined) {
      this.#recordDenial(undefined, "credential", request);
      throw new BrowserCapabilityDenied("credential");
    }
    if (this.#isExpired(record)) {
      this.#recordDenial(record, "expired", request);
      this.#terminateRecord(record, "expired", "expired");
      throw new BrowserCapabilityDenied("expired");
    }
    if (record.revocationGeneration !== record.principal.revocationGeneration) {
      this.#recordDenial(record, "credential", request);
      this.#terminateRecord(record, "revoked_principal_closed", "revoked");
      throw new BrowserCapabilityDenied("credential");
    }
    if (
      context?.expectedPrincipal !== undefined &&
      this.#principals.get(context.expectedPrincipal) !== record.principal
    ) {
      this.#recordDenial(record, "scope", request);
      throw new BrowserCapabilityDenied("scope");
    }

    const normalized = this.#normalizeAndAuthorizeUse(record, request);
    if (normalized === undefined) {
      this.#recordDenial(record, "scope", request);
      throw new BrowserCapabilityDenied("scope");
    }
    if (typeof context?.requestId !== "string" || !isValidControlRequestId(context.requestId)) {
      this.#recordDenial(record, "scope", normalized);
      throw new BrowserCapabilityDenied("scope");
    }
    if (record.recentRequestIds.has(context.requestId)) {
      this.#recordDenial(record, "replay", normalized);
      throw new BrowserCapabilityDenied("replay");
    }
    if (record.active.size >= record.maxInFlight) {
      this.#recordDenial(record, "concurrency", normalized);
      throw new BrowserCapabilityDenied("concurrency");
    }
    if (record.remainingUses <= 0) {
      this.#recordDenial(record, "exhausted", normalized);
      throw new BrowserCapabilityDenied("exhausted");
    }

    this.#rememberRequestId(record, context.requestId);
    record.remainingUses -= 1;
    const useId = this.#nextId("use");
    const leaseRecord: LeaseRecord = {
      useId,
      action: normalized.action,
      target: normalized.target,
      controller: new AbortController(),
      settled: false,
    };
    record.active.set(useId, leaseRecord);
    this.#appendAudit({
      ...this.#auditIdentity(record),
      kind: "admission",
      outcome: "admitted",
      useId,
      action: normalized.action,
      ...this.#auditTarget(normalized.target),
    });

    const lease: BrowserCapabilityLease = Object.freeze({
      ...record.handle,
      action: normalized.action,
      ...(normalized.target === undefined ? {} : { target: normalized.target }),
      scope: record.targets,
      expiresAt: record.expiresAt,
      remainingUses: record.remainingUses,
      signal: leaseRecord.controller.signal,
      checkTarget: (target: BrowserCapabilityUseTarget) =>
        this.#checkLeaseTarget(record, leaseRecord, target),
      boundGeneration: (ref: NodeRefKey) => this.#boundGeneration(record, leaseRecord, ref),
      bindGeneration: (ref: NodeRefKey, generation: string) =>
        this.#bindGeneration(record, leaseRecord, ref, generation),
      rollGeneration: (ref: NodeRefKey, expectedGeneration: string, nextGeneration: string) =>
        this.#rollGeneration(record, leaseRecord, ref, expectedGeneration, nextGeneration),
      unbindGeneration: (ref: NodeRefKey, expectedGeneration: string) =>
        this.#unbindGeneration(record, leaseRecord, ref, expectedGeneration),
      release: (outcome: BrowserCapabilityCompletionOutcome = "success") =>
        this.#releaseLease(record, leaseRecord, outcome),
    });
    return lease;
  }

  revoke(
    handle: BrowserCapabilityHandle,
    reason: BrowserCapabilityRevocationReason = "operator",
  ): boolean {
    if (!REVOCATION_REASONS.has(reason)) return false;
    const digest = this.#handles.get(handle);
    const record = digest === undefined ? undefined : this.#records.get(digest);
    if (record === undefined || record.handle !== handle) return false;
    this.#terminateRecord(record, `revoked_${reason}`, "revoked");
    return true;
  }

  revokePrincipal(
    principal: BrowserAutomationPrincipal,
    reason: BrowserCapabilityRevocationReason = "principal_closed",
  ): number {
    if (!REVOCATION_REASONS.has(reason)) return 0;
    const principalRecord = this.#principals.get(principal);
    if (principalRecord === undefined) return 0;
    principalRecord.revocationGeneration =
      principalRecord.revocationGeneration === Number.MAX_SAFE_INTEGER
        ? 0
        : principalRecord.revocationGeneration + 1;
    const records = [...this.#records.values()].filter(
      (record) => record.principal === principalRecord,
    );
    for (const record of records) {
      this.#terminateRecord(record, `revoked_${reason}`, "revoked");
    }
    return records.length;
  }

  /** Re-check both clocks after machine resume; returns the number reaped. */
  reapAfterResume(): number {
    return this.reapExpired();
  }

  reapExpired(): number {
    if (this.#closed) return 0;
    const expired = [...this.#records.values()].filter((record) => this.#isExpired(record));
    for (const record of expired) this.#terminateRecord(record, "expired", "expired");
    return expired.length;
  }

  close(): number {
    if (this.#closed) return 0;
    this.#closed = true;
    const records = [...this.#records.values()];
    for (const record of records) this.#terminateRecord(record, "app_closed", "app_close");
    return records.length;
  }

  auditSnapshot(): ReadonlyArray<BrowserCapabilityAuditEvent> {
    return Object.freeze(
      this.#audit.map((event) =>
        Object.freeze({
          ...event,
          ...(event.targetTags === undefined
            ? {}
            : { targetTags: Object.freeze([...event.targetTags]) }),
        }),
      ),
    );
  }

  stats(): BrowserCapabilityRegistryStats {
    let activeLeases = 0;
    const principals = new Set<PrincipalRecord>();
    for (const record of this.#records.values()) {
      activeLeases += record.active.size;
      principals.add(record.principal);
    }
    return Object.freeze({
      closed: this.#closed,
      activeCapabilities: this.#records.size,
      activeLeases,
      principalsWithCapabilities: principals.size,
      auditEvents: this.#audit.length,
    });
  }

  #normalizeAndAuthorizeUse(
    record: CapabilityRecord,
    request: BrowserCapabilityUseRequest,
  ): BrowserCapabilityUseRequest | undefined {
    if (typeof request !== "object" || request === null || !isCapabilityAction(request.action)) {
      return undefined;
    }
    if (!record.actions.has(request.action)) return undefined;
    if (LIST_ACTIONS.has(request.action)) {
      return request.target === undefined ? Object.freeze({ action: request.action }) : undefined;
    }
    if (request.target === undefined) return Object.freeze({ action: request.action });
    const target = this.#authorizeTarget(record, request.action, request.target);
    return target === undefined ? undefined : Object.freeze({ action: request.action, target });
  }

  #authorizeTarget(
    record: CapabilityRecord,
    action: BrowserCapabilityAction,
    input: unknown,
  ): BrowserCapabilityUseTarget | undefined {
    if (LIST_ACTIONS.has(action)) return undefined;
    const target = normalizeUseTarget(input);
    if (target === undefined) return undefined;
    const allowed = record.targetsByRef.get(target.ref);
    if (
      allowed === undefined ||
      allowed.profile !== target.profile ||
      target.exactOrigins.some((origin) => !allowed.exactOrigins.includes(origin))
    ) {
      return undefined;
    }
    const currentGeneration = record.generations.get(target.ref);
    if (currentGeneration === undefined) {
      if (action !== "open" || target.generation !== undefined) return undefined;
    } else if (target.generation !== currentGeneration) {
      return undefined;
    }
    return target;
  }

  #checkLeaseTarget(
    record: CapabilityRecord,
    lease: LeaseRecord,
    input: BrowserCapabilityUseTarget,
  ): BrowserCapabilityUseTarget {
    if (lease.settled || this.#records.get(record.digest) !== record) {
      throw new BrowserCapabilityDenied("scope");
    }
    if (this.#isExpired(record)) {
      this.#recordDenial(record, "expired", { action: lease.action, target: input });
      this.#terminateRecord(record, "expired", "expired");
      throw new BrowserCapabilityDenied("expired");
    }
    const target = this.#authorizeTarget(record, lease.action, input);
    const matchesExisting =
      lease.target === undefined ||
      (target !== undefined &&
        lease.target.ref === target.ref &&
        lease.target.profile === target.profile &&
        lease.target.generation === target.generation &&
        lease.target.exactOrigins.length === target.exactOrigins.length &&
        lease.target.exactOrigins.every((origin, index) => origin === target.exactOrigins[index]));
    if (target === undefined || !matchesExisting) {
      this.#recordDenial(record, "scope", { action: lease.action, target: input });
      this.#releaseLease(record, lease, "failed");
      throw new BrowserCapabilityDenied("scope");
    }
    lease.target = target;
    return target;
  }

  #rememberRequestId(record: CapabilityRecord, requestId: string): void {
    record.recentRequestIds.add(requestId);
    record.requestIdOrder.push(requestId);
    if (record.requestIdOrder.length <= BROWSER_CAPABILITY_MAX_RECENT_REQUEST_IDS) return;
    const oldest = record.requestIdOrder.shift();
    if (oldest !== undefined) record.recentRequestIds.delete(oldest);
  }

  #boundGeneration(
    record: CapabilityRecord,
    lease: LeaseRecord,
    ref: NodeRefKey,
  ): string | undefined {
    this.#assertLeaseTarget(record, lease, ref);
    return record.generations.get(ref);
  }

  #bindGeneration(
    record: CapabilityRecord,
    lease: LeaseRecord,
    ref: NodeRefKey,
    generation: string,
  ): void {
    this.#assertLeaseTarget(record, lease, ref);
    if (
      lease.action !== "open" ||
      record.generations.has(ref) ||
      !isValidBrowserSessionId(generation)
    ) {
      throw new BrowserCapabilityStateDenied();
    }
    record.generations.set(ref, generation);
    this.#appendGenerationAudit(record, lease, "generation_bound", ref, generation);
  }

  #rollGeneration(
    record: CapabilityRecord,
    lease: LeaseRecord,
    ref: NodeRefKey,
    expectedGeneration: string,
    nextGeneration: string,
  ): void {
    this.#assertLeaseTarget(record, lease, ref);
    if (
      (lease.action !== "goto" && lease.action !== "open") ||
      !isValidBrowserSessionId(expectedGeneration) ||
      !isValidBrowserSessionId(nextGeneration) ||
      expectedGeneration === nextGeneration ||
      record.generations.get(ref) !== expectedGeneration
    ) {
      throw new BrowserCapabilityStateDenied();
    }
    record.generations.set(ref, nextGeneration);
    this.#appendGenerationAudit(record, lease, "generation_rolled", ref, nextGeneration);
  }

  #unbindGeneration(
    record: CapabilityRecord,
    lease: LeaseRecord,
    ref: NodeRefKey,
    expectedGeneration: string,
  ): void {
    this.#assertLeaseTarget(record, lease, ref);
    if (
      lease.action !== "close" ||
      !isValidBrowserSessionId(expectedGeneration) ||
      record.generations.get(ref) !== expectedGeneration
    ) {
      throw new BrowserCapabilityStateDenied();
    }
    record.generations.delete(ref);
    this.#appendGenerationAudit(record, lease, "generation_unbound", ref, expectedGeneration);
  }

  #assertLeaseTarget(
    record: CapabilityRecord,
    lease: LeaseRecord,
    ref: NodeRefKey,
  ): void {
    if (
      lease.settled ||
      this.#records.get(record.digest) !== record ||
      lease.target?.ref !== ref ||
      !record.targetsByRef.has(ref)
    ) {
      throw new BrowserCapabilityStateDenied();
    }
    if (this.#isExpired(record)) {
      this.#terminateRecord(record, "expired", "expired");
      throw new BrowserCapabilityStateDenied();
    }
  }

  #releaseLease(
    record: CapabilityRecord,
    lease: LeaseRecord,
    requestedOutcome: BrowserCapabilityCompletionOutcome,
  ): void {
    if (lease.settled) return;
    const outcome = COMPLETION_OUTCOMES.has(requestedOutcome) ? requestedOutcome : "failed";
    this.#settleLease(record, lease, outcome);
    if (
      record.remainingUses === 0 &&
      record.active.size === 0 &&
      this.#records.get(record.digest) === record
    ) {
      this.#terminateRecord(record, "exhausted");
    }
  }

  #settleLease(
    record: CapabilityRecord,
    lease: LeaseRecord,
    outcome: Extract<
      BrowserCapabilityAuditOutcome,
      | "success"
      | "failed"
      | "cancelled"
      | "aborted_expired"
      | "aborted_revoked"
      | "aborted_app_close"
    >,
  ): void {
    if (lease.settled) return;
    lease.settled = true;
    record.active.delete(lease.useId);
    this.#appendAudit({
      ...this.#auditIdentity(record),
      kind: "completion",
      outcome,
      useId: lease.useId,
      action: lease.action,
      ...this.#auditTarget(lease.target),
    });
  }

  #terminateRecord(
    record: CapabilityRecord,
    outcome: Extract<
      BrowserCapabilityAuditOutcome,
      | "revoked_operator"
      | "revoked_job_complete"
      | "revoked_principal_closed"
      | "revoked_superseded"
      | "expired"
      | "exhausted"
      | "app_closed"
    >,
    abortReason?: BrowserCapabilityAbortReason,
  ): void {
    if (this.#records.get(record.digest) !== record) return;
    this.#records.delete(record.digest);
    this.#handles.delete(record.handle);
    record.principal.liveCapabilities = Math.max(0, record.principal.liveCapabilities - 1);
    if (record.timer !== undefined) {
      try {
        this.#dependencies.clearTimer(record.timer);
      } catch {
        // Timer ownership is already invalidated by the record deletion.
      }
      record.timer = undefined;
    }
    this.#appendAudit({
      ...this.#auditIdentity(record),
      kind: "lifecycle",
      outcome,
      revocationGeneration: record.revocationGeneration,
    });
    if (abortReason === undefined) return;
    const completion = `aborted_${abortReason}` as Extract<
      BrowserCapabilityAuditOutcome,
      "aborted_expired" | "aborted_revoked" | "aborted_app_close"
    >;
    for (const lease of [...record.active.values()]) {
      this.#settleLease(record, lease, completion);
      lease.controller.abort(new BrowserCapabilityLeaseAbort(abortReason));
    }
  }

  #scheduleExpiry(record: CapabilityRecord): void {
    const wallRemaining = record.expiresAt - this.#readClock(this.#dependencies.wallNow);
    const monotonicRemaining =
      record.monotonicDeadline - this.#readClock(this.#dependencies.monotonicNow);
    const delay = Math.max(0, Math.ceil(Math.min(wallRemaining, monotonicRemaining)));
    record.timer = this.#dependencies.setTimer(() => {
      if (this.#records.get(record.digest) !== record) return;
      record.timer = undefined;
      if (this.#isExpired(record)) {
        this.#terminateRecord(record, "expired", "expired");
      } else {
        this.#scheduleExpiry(record);
      }
    }, delay);
  }

  #isExpired(record: CapabilityRecord): boolean {
    return (
      this.#readClock(this.#dependencies.wallNow) >= record.expiresAt ||
      this.#readClock(this.#dependencies.monotonicNow) >= record.monotonicDeadline
    );
  }

  #recordDenial(
    record: CapabilityRecord | undefined,
    reason: BrowserCapabilityDenialReason,
    request: BrowserCapabilityUseRequest | undefined,
  ): void {
    const action = isCapabilityAction(request?.action) ? request.action : undefined;
    const target = normalizeUseTarget(request?.target);
    this.#appendAudit({
      ...(record === undefined ? {} : this.#auditIdentity(record)),
      kind: "admission",
      outcome: denialOutcome(reason),
      ...(action === undefined ? {} : { action }),
      ...this.#auditTarget(target),
    });
  }

  #appendGenerationAudit(
    record: CapabilityRecord,
    lease: LeaseRecord,
    outcome: Extract<
      BrowserCapabilityAuditOutcome,
      "generation_bound" | "generation_rolled" | "generation_unbound"
    >,
    ref: NodeRefKey,
    generation: string,
  ): void {
    const target = record.targetsByRef.get(ref);
    if (target === undefined) throw new BrowserCapabilityStateDenied();
    this.#appendAudit({
      ...this.#auditIdentity(record),
      kind: "generation",
      outcome,
      useId: lease.useId,
      action: lease.action,
      targetTag: this.#targetTag(target),
      generationTag: this.#fingerprint("generation", [generation]),
    });
  }

  #auditIdentity(record: CapabilityRecord): Pick<
    BrowserCapabilityAuditEvent,
    "ownerId" | "principalId" | "jobId" | "auditId"
  > {
    return record.handle;
  }

  #auditTarget(
    target: BrowserCapabilityUseTarget | undefined,
  ): Pick<BrowserCapabilityAuditEvent, "targetTag" | "generationTag"> {
    if (target === undefined) return {};
    return {
      targetTag: this.#targetTag(target),
      ...(target.generation === undefined
        ? {}
        : { generationTag: this.#fingerprint("generation", [target.generation]) }),
    };
  }

  #targetTag(target: BrowserCapabilityTarget): string {
    return this.#fingerprint("target", [target.ref, target.profile, ...target.exactOrigins]);
  }

  #fingerprint(domain: "target" | "generation", fields: ReadonlyArray<string>): string {
    const hmac = createHmac("sha256", this.#auditKey);
    hmac.update(domain, "utf8");
    for (const field of fields) {
      const encoded = Buffer.from(field, "utf8");
      const length = Buffer.allocUnsafe(4);
      length.writeUInt32BE(encoded.byteLength);
      hmac.update(length);
      hmac.update(encoded);
    }
    return `${domain === "target" ? "t" : "g"}_${hmac.digest("base64url").slice(0, 22)}`;
  }

  #appendAudit(
    event: Omit<BrowserCapabilityAuditEvent, "sequence" | "at">,
  ): void {
    const next: BrowserCapabilityAuditEvent = Object.freeze({
      sequence: ++this.#auditSequence,
      at: this.#readClock(this.#dependencies.wallNow),
      ...event,
    });
    if (this.#audit.length >= this.#auditCapacity) this.#audit.shift();
    this.#audit.push(next);
  }

  #uniqueSecret(): { readonly secret: string; readonly digest: string } {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const secret = Buffer.from(this.#randomExact(BROWSER_CAPABILITY_SECRET_BYTES)).toString(
        "base64url",
      );
      const digest = digestSecret(secret);
      if (!this.#records.has(digest)) return { secret, digest };
    }
    throw new BrowserCapabilityIssueDenied("capacity");
  }

  #nextId(prefix: "owner" | "principal" | "job" | "audit" | "use"): string {
    this.#idSequence += 1;
    const entropy = Buffer.from(this.#randomExact(12)).toString("base64url");
    return `${prefix}_${entropy}_${this.#idSequence.toString(36)}`;
  }

  #randomExact(size: number): Uint8Array {
    const value = this.#dependencies?.randomBytes?.(size) ?? defaultDependencies.randomBytes(size);
    if (!(value instanceof Uint8Array) || value.byteLength !== size) {
      throw new BrowserCapabilityIssueDenied("invalid");
    }
    return Uint8Array.from(value);
  }

  #readClock(clock: () => number): number {
    const value = clock();
    if (!Number.isFinite(value)) throw new BrowserCapabilityIssueDenied("invalid");
    return value;
  }
}

export const makeBrowserCapabilityRegistry = (
  options: BrowserCapabilityRegistryOptions = {},
): BrowserCapabilityRegistry => new BrowserCapabilityRegistry(options);
