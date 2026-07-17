import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, normalize } from "node:path";
import { isValidProfileId } from "@shared/browser";
import { classifyBrowserTarget } from "@shared/browser-policy";
import { parseNodeRef } from "@shared/node-ref";
import {
  BROWSER_CAPABILITY_ACTIONS,
  BrowserCapabilityIssueDenied,
  type BrowserCapabilityAction,
  type BrowserCapabilityGrant,
  type BrowserCapabilityHandle,
  type BrowserCapabilityTarget,
  type BrowserCapabilityRegistry,
} from "./capabilities";
import type { ResolvedPageTarget } from "./page-target";
import {
  makeBrowserProfileGate,
  type BrowserProfileGate,
  type BrowserProfileSnapshot,
} from "./profile-gate";

export const BROWSER_AGENT_AUTHORITY_TTL_MS = 60 * 60 * 1_000;
export const BROWSER_AGENT_AUTHORITY_MAX_USES = 4_096;
export const BROWSER_AGENT_AUTHORITY_MAX_IN_FLIGHT = 4;
export const BROWSER_AGENT_AUTHORITY_MAX_TARGETS = 64;
export const BROWSER_AGENT_AUTHORITY_MAX_ACTIVE = 32;

const MAX_IDENTITY_BYTES = 256;
const MAX_LABEL_BYTES = 256;
const MAX_HOME_BYTES = 4_096;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const PRODUCT_ACTIONS: ReadonlyArray<BrowserCapabilityAction> = Object.freeze([
  ...BROWSER_CAPABILITY_ACTIONS,
]);

export type BrowserAutomationDeliveryKind = "hermes" | "herdr";

export interface BrowserAutomationSubject {
  /** Main-process-selected stable key for duplicate-grant prevention. */
  readonly id: string;
  readonly kind: BrowserAutomationDeliveryKind;
  /** Human-readable only. It is never used as the authorization principal. */
  readonly label: string;
}

export interface BrowserAutomationConfirmation {
  readonly subject: BrowserAutomationSubject;
  readonly targetCount: number;
  /** Exact, main-derived scope rendered by the native approval prompt. */
  readonly targets: ReadonlyArray<BrowserCapabilityTarget>;
  readonly actions: ReadonlyArray<BrowserCapabilityAction>;
  readonly ttlMs: number;
  readonly maxUses: number;
  readonly maxInFlight: number;
}

export interface BrowserAutomationDelivery {
  readonly subject: BrowserAutomationSubject;
  readonly secret: string;
  readonly controlHome: string;
  readonly expiresAt: number;
}

export interface BrowserAutomationDeliveryReceipt {
  /** Runs on expiry/revocation/app close. It receives no bearer material. */
  readonly cleanup?: () => void | Promise<void>;
}

export interface BrowserAutomationGrantSummary {
  readonly id: string;
  readonly subject: BrowserAutomationSubject;
  readonly targetCount: number;
  readonly actions: ReadonlyArray<BrowserCapabilityAction>;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly maxUses: number;
  readonly maxInFlight: number;
}

export type BrowserAutomationAuthorityErrorCode =
  | "invalid"
  | "cancelled"
  | "capacity"
  | "delivery_failed"
  | "closed"
  | "not_found";

export type BrowserAutomationAuthorityResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly code: BrowserAutomationAuthorityErrorCode;
      readonly message: string;
    };

export interface BrowserAutomationAuthorityDependencies {
  readonly confirm: (request: BrowserAutomationConfirmation) => Promise<boolean>;
  readonly deliver: (
    request: BrowserAutomationDelivery,
  ) => Promise<BrowserAutomationDeliveryReceipt | void>;
  readonly controlHome?: string;
  readonly makeGrantId?: () => string;
  /** Production injects the main-process gate shared with profile/session lifecycle. */
  readonly profileGate?: BrowserProfileGate;
}

interface ActiveGrant {
  readonly summary: BrowserAutomationGrantSummary;
  readonly handle: BrowserCapabilityHandle;
  cleanup?: () => void | Promise<void>;
  terminated: boolean;
  cleanupStarted: boolean;
}

const fail = (
  code: BrowserAutomationAuthorityErrorCode,
  message: string,
): BrowserAutomationAuthorityResult<never> => ({ ok: false, code, message });

const boundedText = (value: unknown, maximum: number): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  !CONTROL_CHARACTER.test(value) &&
  Buffer.byteLength(value, "utf8") <= maximum;

const validSubject = (subject: unknown): subject is BrowserAutomationSubject => {
  if (typeof subject !== "object" || subject === null || Array.isArray(subject)) return false;
  const candidate = subject as Partial<BrowserAutomationSubject>;
  return (
    (candidate.kind === "hermes" || candidate.kind === "herdr") &&
    boundedText(candidate.id, MAX_IDENTITY_BYTES) &&
    boundedText(candidate.label, MAX_LABEL_BYTES)
  );
};

const validControlHome = (value: string): boolean =>
  isAbsolute(value) &&
  Buffer.byteLength(value, "utf8") <= MAX_HOME_BYTES &&
  !CONTROL_CHARACTER.test(value);

const immutableSubject = (subject: BrowserAutomationSubject): BrowserAutomationSubject =>
  Object.freeze({ id: subject.id, kind: subject.kind, label: subject.label });

const authorityTarget = (target: ResolvedPageTarget): BrowserCapabilityTarget | undefined => {
  const parsedRef = typeof target?.ref === "string" ? parseNodeRef(target.ref) : undefined;
  if (
    typeof target !== "object" ||
    target === null ||
    typeof target.ref !== "string" ||
    parsedRef === undefined ||
    !parsedRef.ok ||
    typeof target.nodeId !== "string" ||
    parsedRef.value.nodeId !== target.nodeId ||
    typeof target.profile !== "string" ||
    !isValidProfileId(target.profile)
  ) {
    return undefined;
  }
  const classified = classifyBrowserTarget(target.url);
  if (!classified.allowed) return undefined;
  try {
    const parsed = new URL(classified.normalizedUrl);
    if (parsed.username !== "" || parsed.password !== "" || parsed.origin === "null") {
      return undefined;
    }
    return Object.freeze({
      ref: target.ref,
      profile: target.profile,
      exactOrigins: Object.freeze([parsed.origin]),
    });
  } catch {
    return undefined;
  }
};

const normalizeTargets = (
  input: ReadonlyArray<ResolvedPageTarget>,
): ReadonlyArray<BrowserCapabilityTarget> | undefined => {
  if (
    !Array.isArray(input) ||
    input.length === 0 ||
    input.length > BROWSER_AGENT_AUTHORITY_MAX_TARGETS
  ) {
    return undefined;
  }
  const targets = input.map(authorityTarget);
  if (targets.some((target) => target === undefined)) return undefined;
  const typed = targets as ReadonlyArray<BrowserCapabilityTarget>;
  if (new Set(typed.map((target) => target.ref)).size !== typed.length) return undefined;
  return Object.freeze([...typed].sort((left, right) => left.ref.localeCompare(right.ref)));
};

const mapIssueFailure = (error: unknown): BrowserAutomationAuthorityResult<never> => {
  if (error instanceof BrowserCapabilityIssueDenied) {
    if (error.reason === "capacity") return fail("capacity", "browser authority capacity reached");
    if (error.reason === "closed") return fail("closed", "browser authority is closed");
    return fail("invalid", "browser authority request is invalid");
  }
  return fail("delivery_failed", "browser authority issuance failed");
};

const PROFILE_EPOCH_DENIAL = "browser authority profiles changed during confirmation";

const captureProfileSnapshots = (
  gate: BrowserProfileGate,
  targets: ReadonlyArray<BrowserCapabilityTarget>,
): ReadonlyArray<BrowserProfileSnapshot> | undefined => {
  const snapshots: BrowserProfileSnapshot[] = [];
  for (const profile of new Set(targets.map((target) => target.profile))) {
    const snapshot = gate.snapshot(profile);
    if (snapshot === undefined) return undefined;
    snapshots.push(snapshot);
  }
  return Object.freeze(snapshots);
};

const profileSnapshotsCurrent = (
  gate: BrowserProfileGate,
  snapshots: ReadonlyArray<BrowserProfileSnapshot>,
): boolean => snapshots.every((snapshot) => gate.isCurrent(snapshot));

/**
 * Main-process-only trusted issuance coordinator. It never returns or retains
 * bearer material after the delivery callback completes. Renderer-provided
 * labels are display data only; the registry-created principal owns authority.
 */
export class BrowserAgentAuthority {
  readonly #controlHome: string;
  readonly #makeGrantId: () => string;
  readonly #profileGate: BrowserProfileGate;
  readonly #active = new Map<string, ActiveGrant>();
  readonly #activeBySubject = new Map<string, string>();
  readonly #pendingBySubject = new Map<string, symbol>();
  #closed = false;

  constructor(
    private readonly registry: BrowserCapabilityRegistry,
    private readonly dependencies: BrowserAutomationAuthorityDependencies,
  ) {
    const controlHome = normalize(dependencies.controlHome ?? homedir());
    if (!validControlHome(controlHome)) throw new BrowserCapabilityIssueDenied("invalid");
    this.#controlHome = controlHome;
    this.#makeGrantId = dependencies.makeGrantId ?? randomUUID;
    this.#profileGate = dependencies.profileGate ?? makeBrowserProfileGate();
  }

  async issue(
    subjectInput: BrowserAutomationSubject,
    resolvedTargets: ReadonlyArray<ResolvedPageTarget>,
  ): Promise<BrowserAutomationAuthorityResult<BrowserAutomationGrantSummary>> {
    if (this.#closed) return fail("closed", "browser authority is closed");
    if (!validSubject(subjectInput)) return fail("invalid", "browser authority subject is invalid");
    const subject = immutableSubject(subjectInput);
    const subjectKey = `${subject.kind}\u0000${subject.id}`;
    if (this.#activeBySubject.has(subjectKey) || this.#pendingBySubject.has(subjectKey)) {
      return fail("invalid", "browser automation is already active for this subject");
    }
    const targets = normalizeTargets(resolvedTargets);
    if (targets === undefined) return fail("invalid", "browser authority targets are invalid");
    if (this.#active.size + this.#pendingBySubject.size >= BROWSER_AGENT_AUTHORITY_MAX_ACTIVE) {
      return fail("capacity", "browser authority capacity reached");
    }

    const reservation = Symbol(subjectKey);
    this.#pendingBySubject.set(subjectKey, reservation);
    try {
      return await this.#issueReserved(subject, subjectKey, targets);
    } finally {
      if (this.#pendingBySubject.get(subjectKey) === reservation) {
        this.#pendingBySubject.delete(subjectKey);
      }
    }
  }

  async #issueReserved(
    subject: BrowserAutomationSubject,
    subjectKey: string,
    targets: ReadonlyArray<BrowserCapabilityTarget>,
  ): Promise<BrowserAutomationAuthorityResult<BrowserAutomationGrantSummary>> {
    const profileSnapshots = captureProfileSnapshots(this.#profileGate, targets);
    if (profileSnapshots === undefined) return fail("cancelled", PROFILE_EPOCH_DENIAL);
    const confirmation: BrowserAutomationConfirmation = Object.freeze({
      subject,
      targetCount: targets.length,
      targets,
      actions: PRODUCT_ACTIONS,
      ttlMs: BROWSER_AGENT_AUTHORITY_TTL_MS,
      maxUses: BROWSER_AGENT_AUTHORITY_MAX_USES,
      maxInFlight: BROWSER_AGENT_AUTHORITY_MAX_IN_FLIGHT,
    });
    let approved: boolean;
    try {
      approved = (await this.dependencies.confirm(confirmation)) === true;
    } catch {
      return fail("delivery_failed", "browser authority confirmation failed");
    }
    if (!approved) return fail("cancelled", "browser authority was not approved");
    if (this.#closed) return fail("closed", "browser authority is closed");
    if (!profileSnapshotsCurrent(this.#profileGate, profileSnapshots)) {
      return fail("cancelled", PROFILE_EPOCH_DENIAL);
    }

    let grant: BrowserCapabilityGrant;
    try {
      const principal = this.registry.createPrincipal();
      grant = this.registry.issue(principal, {
        actions: PRODUCT_ACTIONS,
        targets,
        ttlMs: BROWSER_AGENT_AUTHORITY_TTL_MS,
        maxUses: BROWSER_AGENT_AUTHORITY_MAX_USES,
        maxInFlight: BROWSER_AGENT_AUTHORITY_MAX_IN_FLIGHT,
      });
    } catch (error) {
      return mapIssueFailure(error);
    }

    let id: string;
    try {
      id = this.#makeGrantId();
    } catch {
      this.registry.revoke(grant.handle, "superseded");
      return fail("delivery_failed", "browser authority delivery failed");
    }
    if (!boundedText(id, MAX_IDENTITY_BYTES) || this.#active.has(id)) {
      this.registry.revoke(grant.handle, "superseded");
      return fail("delivery_failed", "browser authority delivery failed");
    }
    const summary: BrowserAutomationGrantSummary = Object.freeze({
      id,
      subject,
      targetCount: targets.length,
      actions: PRODUCT_ACTIONS,
      issuedAt: grant.issuedAt,
      expiresAt: grant.expiresAt,
      maxUses: grant.maxUses,
      maxInFlight: grant.maxInFlight,
    });
    const active: ActiveGrant = {
      summary,
      handle: grant.handle,
      terminated: false,
      cleanupStarted: false,
    };
    this.#active.set(id, active);
    this.#activeBySubject.set(subjectKey, id);

    try {
      const receipt = await this.dependencies.deliver(Object.freeze({
        subject,
        secret: grant.secret,
        controlHome: this.#controlHome,
        expiresAt: grant.expiresAt,
      }));
      if (receipt?.cleanup !== undefined && typeof receipt.cleanup !== "function") {
        throw new Error("invalid browser authority delivery receipt");
      }
      active.cleanup = receipt?.cleanup;
      if (active.terminated) this.#startCleanup(active);
      return active.terminated
        ? fail("delivery_failed", "browser authority ended during delivery")
        : { ok: true, data: summary };
    } catch {
      this.registry.revoke(grant.handle, "superseded");
      this.#removeActive(active);
      this.#startCleanup(active);
      return fail("delivery_failed", "browser authority delivery failed");
    }
  }

  revoke(id: string): BrowserAutomationAuthorityResult<{ readonly revoked: true }> {
    const active = this.#active.get(id);
    if (active === undefined) return fail("not_found", "browser authority grant not found");
    return this.registry.revoke(active.handle, "operator")
      ? { ok: true, data: { revoked: true } }
      : fail("not_found", "browser authority grant not found");
  }

  complete(id: string): BrowserAutomationAuthorityResult<{ readonly revoked: true }> {
    const active = this.#active.get(id);
    if (active === undefined) return fail("not_found", "browser authority grant not found");
    return this.registry.revoke(active.handle, "job_complete")
      ? { ok: true, data: { revoked: true } }
      : fail("not_found", "browser authority grant not found");
  }

  list(): ReadonlyArray<BrowserAutomationGrantSummary> {
    return Object.freeze(
      [...this.#active.values()]
        .map((active) => active.summary)
        .sort((left, right) => left.issuedAt - right.issuedAt || left.id.localeCompare(right.id)),
    );
  }

  /** Registry onTerminate callback target; handle equality is checked in full. */
  handleTermination(notice: BrowserCapabilityHandle): void {
    const active = [...this.#active.values()].find(
      (candidate) =>
        candidate.handle.auditId === notice.auditId &&
        candidate.handle.ownerId === notice.ownerId &&
        candidate.handle.principalId === notice.principalId &&
        candidate.handle.jobId === notice.jobId,
    );
    if (active === undefined || active.terminated) return;
    active.terminated = true;
    this.#removeActive(active);
    this.#startCleanup(active);
  }

  close(): number {
    if (this.#closed) return 0;
    this.#closed = true;
    this.#pendingBySubject.clear();
    return this.registry.close();
  }

  #removeActive(active: ActiveGrant): void {
    if (this.#active.get(active.summary.id) === active) this.#active.delete(active.summary.id);
    const subjectKey = `${active.summary.subject.kind}\u0000${active.summary.subject.id}`;
    if (this.#activeBySubject.get(subjectKey) === active.summary.id) {
      this.#activeBySubject.delete(subjectKey);
    }
  }

  #startCleanup(active: ActiveGrant): void {
    if (active.cleanupStarted || active.cleanup === undefined) return;
    active.cleanupStarted = true;
    try {
      const result = active.cleanup();
      if (result instanceof Promise) void result.catch(() => undefined);
    } catch {
      // Authority teardown must not depend on a delivery cleanup observer.
    }
  }
}
