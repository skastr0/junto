import { describe, expect, it } from "vitest";
import {
  BROWSER_CAPABILITY_ACTIONS,
  BROWSER_CAPABILITY_MAX_RECENT_REQUEST_IDS,
  BROWSER_CAPABILITY_SECRET_BYTES,
  BrowserCapabilityDenied,
  BrowserCapabilityIssueDenied,
  BrowserCapabilityLeaseAbort,
  BrowserCapabilityRegistry,
  BrowserCapabilityStateDenied,
  type BrowserAutomationPrincipal,
  type BrowserCapabilityAction,
  type BrowserCapabilityDependencies,
  type BrowserCapabilityGrant,
  type BrowserCapabilityIssueSpec,
  type BrowserCapabilityProfileRevocationReason,
  type BrowserCapabilityTarget,
  type BrowserCapabilityTerminationNotice,
  type BrowserCapabilityUseTarget,
} from "../src/main/vellum/browser/capabilities";
import { BrowserProfileGate } from "../src/main/vellum/browser/profile-gate";

const REF_ONE = "vellum://canvas/work?node=n1";
const REF_TWO = "vellum://canvas/work?node=n2";
const REF_THREE = "vellum://canvas/work?node=n3";
const TARGET_ONE: BrowserCapabilityTarget = {
  ref: REF_ONE,
  profile: "personal",
  exactOrigins: ["https://example.com"],
};
const TARGET_TWO: BrowserCapabilityTarget = {
  ref: REF_TWO,
  profile: "work",
  exactOrigins: ["https://github.com", "https://www.github.com"],
};

const requestId = (value: number): string => value.toString(16).padStart(32, "0");

class ManualCapabilityRuntime {
  wall = 1_000;
  monotonic = 50;
  #randomSequence = 0;
  #timerSequence = 0;
  readonly timers = new Map<number, { readonly due: number; readonly callback: () => void }>();

  readonly dependencies: BrowserCapabilityDependencies = {
    wallNow: () => this.wall,
    monotonicNow: () => this.monotonic,
    randomBytes: (size) => {
      this.#randomSequence += 1;
      return Uint8Array.from(
        { length: size },
        (_, index) => (this.#randomSequence * 37 + index * 17) & 0xff,
      );
    },
    setTimer: (callback, delayMs) => {
      const id = ++this.#timerSequence;
      this.timers.set(id, { due: this.monotonic + delayMs, callback });
      return id;
    },
    clearTimer: (handle) => {
      if (typeof handle === "number") this.timers.delete(handle);
    },
  };

  get randomCalls(): number {
    return this.#randomSequence;
  }

  advanceBoth(milliseconds: number): void {
    this.wall += milliseconds;
    this.monotonic += milliseconds;
    this.runDueTimers();
  }

  advanceWallWhileSuspended(milliseconds: number): void {
    this.wall += milliseconds;
  }

  runDueTimers(): void {
    for (let pass = 0; pass < 100; pass += 1) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.due <= this.monotonic)
        .sort(([left], [right]) => left - right);
      if (due.length === 0) return;
      for (const [id, timer] of due) {
        this.timers.delete(id);
        timer.callback();
      }
    }
    throw new Error("manual timer loop did not settle");
  }
}

const makeRegistry = (
  runtime = new ManualCapabilityRuntime(),
  limits: {
    readonly maxCapabilities?: number;
    readonly maxCapabilitiesPerPrincipal?: number;
    readonly auditCapacity?: number;
    readonly profileGate?: BrowserProfileGate;
    readonly onTerminate?: (notice: BrowserCapabilityTerminationNotice) => void;
  } = {},
): { readonly registry: BrowserCapabilityRegistry; readonly runtime: ManualCapabilityRuntime } => ({
  registry: new BrowserCapabilityRegistry({ dependencies: runtime.dependencies, ...limits }),
  runtime,
});

const issue = (
  registry: BrowserCapabilityRegistry,
  principal = registry.createPrincipal(),
  overrides: Partial<BrowserCapabilityIssueSpec> = {},
): BrowserCapabilityGrant =>
  registry.issue(principal, {
    actions: ["profiles", "pages", "sessions", "open", "goto", "eval", "screenshot", "close"],
    targets: [TARGET_ONE, TARGET_TWO],
    ttlMs: 1_000,
    maxUses: 32,
    maxInFlight: 4,
    ...overrides,
  });

const useTarget = (
  target: BrowserCapabilityTarget = TARGET_ONE,
  generation?: string,
): BrowserCapabilityUseTarget => ({
  ...target,
  ...(generation === undefined ? {} : { generation }),
});

const captureDenial = (operation: () => unknown): BrowserCapabilityDenied => {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(BrowserCapabilityDenied);
    return error as BrowserCapabilityDenied;
  }
  throw new Error("expected capability denial");
};

const captureIssueDenial = (operation: () => unknown): BrowserCapabilityIssueDenied => {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(BrowserCapabilityIssueDenied);
    return error as BrowserCapabilityIssueDenied;
  }
  throw new Error("expected capability issuance denial");
};

describe("browser capability issuance", () => {
  it("mints one-time 256-bit bearer material while retaining only secret-free views", () => {
    const { registry } = makeRegistry();
    const principal = registry.createPrincipal();
    const grant = issue(registry, principal, {
      actions: ["eval", "open"],
      targets: [
        { ...TARGET_TWO, exactOrigins: [...TARGET_TWO.exactOrigins].reverse() },
        TARGET_ONE,
      ],
      maxUses: 9,
      maxInFlight: 2,
    });

    expect(grant.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(grant.secret, "base64url")).toHaveLength(BROWSER_CAPABILITY_SECRET_BYTES);
    expect(grant.ownerId).toBe(principal.ownerId);
    expect(grant.principalId).toBe(principal.principalId);
    expect(grant.jobId).toBe(principal.jobId);
    expect(grant.auditId).toMatch(/^audit_/);
    expect(grant.actions).toEqual(["open", "eval"]);
    expect(grant.targets.map((target) => target.ref)).toEqual([REF_ONE, REF_TWO]);
    expect(grant.targets[1]?.exactOrigins).toEqual(["https://github.com", "https://www.github.com"]);
    expect(Object.isFrozen(grant.actions)).toBe(true);
    expect(Object.isFrozen(grant.targets)).toBe(true);
    expect(Object.isFrozen(grant.targets[0]?.exactOrigins)).toBe(true);
    expect("secret" in grant.handle).toBe(false);

    const retained = JSON.stringify({ registry, stats: registry.stats(), audit: registry.auditSnapshot() });
    expect(retained).not.toContain(grant.secret);
    expect(retained).not.toContain(REF_ONE);
    expect(retained).not.toContain("https://example.com");
    expect(registry.auditSnapshot()[0]).toMatchObject({
      kind: "issued",
      outcome: "issued",
      ownerId: principal.ownerId,
      principalId: principal.principalId,
      jobId: principal.jobId,
      auditId: grant.auditId,
      revocationGeneration: 0,
    });
    expect(registry.auditSnapshot()[0]?.targetTags).toHaveLength(2);
  });

  it("rejects fabricated principals and all unbounded, duplicate, wildcard, or malformed scope", () => {
    const { registry } = makeRegistry();
    const principal = registry.createPrincipal();
    const base: BrowserCapabilityIssueSpec = {
      actions: ["open"],
      targets: [TARGET_ONE],
      ttlMs: 100,
      maxUses: 1,
      maxInFlight: 1,
    };
    const invalidSpecs: ReadonlyArray<BrowserCapabilityIssueSpec> = [
      { ...base, actions: [] },
      { ...base, actions: ["open", "open"] },
      { ...base, actions: ["wildcard" as BrowserCapabilityAction] },
      { ...base, targets: [] },
      { ...base, targets: [TARGET_ONE, TARGET_ONE] },
      { ...base, targets: [{ ...TARGET_ONE, ref: "vellum://canvas/work?node=%6e1" }] },
      { ...base, targets: [{ ...TARGET_ONE, profile: "*" }] },
      { ...base, targets: [{ ...TARGET_ONE, exactOrigins: ["*"] }] },
      { ...base, targets: [{ ...TARGET_ONE, exactOrigins: ["https://example.com/"] }] },
      { ...base, ttlMs: 0 },
      { ...base, ttlMs: Number.POSITIVE_INFINITY },
      { ...base, maxUses: 0 },
      { ...base, maxInFlight: 0 },
    ];
    for (const spec of invalidSpecs) {
      expect(() => registry.issue(principal, spec)).toThrowError(BrowserCapabilityIssueDenied);
    }
    const fakePrincipal: BrowserAutomationPrincipal = {
      ownerId: principal.ownerId,
      principalId: principal.principalId,
      jobId: principal.jobId,
    };
    expect(() => registry.issue(fakePrincipal, base)).toThrowError(BrowserCapabilityIssueDenied);

    const otherRegistry = makeRegistry().registry;
    expect(() => otherRegistry.issue(principal, base)).toThrowError(BrowserCapabilityIssueDenied);
  });

  it("gates every target profile atomically before minting or mutating registry state", () => {
    const profileGate = new BrowserProfileGate();
    const notices: BrowserCapabilityTerminationNotice[] = [];
    const { registry, runtime } = makeRegistry(undefined, {
      profileGate,
      onTerminate: (notice) => notices.push(notice),
    });
    const principal = registry.createPrincipal();
    const blocked = profileGate.begin(TARGET_ONE.profile);
    expect(blocked.ok).toBe(true);
    if (!blocked.ok) throw new Error("expected profile block");

    const snapshotState = () => ({
      randomCalls: runtime.randomCalls,
      timers: [...runtime.timers.entries()],
      stats: registry.stats(),
      audit: registry.auditSnapshot(),
      notices: [...notices],
    });
    const beforeQuiescingDenial = snapshotState();
    const quiescingDenial = captureIssueDenial(() =>
      issue(registry, principal, {
        actions: ["open"],
        targets: [TARGET_TWO, TARGET_ONE],
      }),
    );
    expect(quiescingDenial.reason).toBe("invalid");
    expect(quiescingDenial.message).toBe("browser capability issuance denied");
    expect(JSON.stringify(quiescingDenial)).not.toContain(TARGET_ONE.profile);
    expect(snapshotState()).toEqual(beforeQuiescingDenial);

    const unrelatedGrant = issue(registry, principal, {
      actions: ["open"],
      targets: [TARGET_TWO],
    });
    expect(unrelatedGrant.auditId).toMatch(/_4$/);
    expect(profileGate.commitDeleted(blocked.data)).toBe(true);

    const beforeDeletedDenial = snapshotState();
    const deletedDenial = captureIssueDenial(() =>
      issue(registry, principal, {
        actions: ["open"],
        targets: [TARGET_ONE],
      }),
    );
    expect(deletedDenial.reason).toBe("invalid");
    expect(snapshotState()).toEqual(beforeDeletedDenial);

    expect(profileGate.markCreated(TARGET_ONE.profile)).toMatchObject({ ok: true });
    const recreatedGrant = issue(registry, principal, {
      actions: ["open"],
      targets: [TARGET_ONE, TARGET_TWO],
    });
    expect(recreatedGrant.auditId).toMatch(/_5$/);
  });
});

describe("browser capability admission and exact scope", () => {
  it("preflights without consuming and exposes only unauthorized versus forbidden", () => {
    const { registry } = makeRegistry();
    const principal = registry.createPrincipal();
    const wrongPrincipal = registry.createPrincipal();
    const grant = issue(registry, principal, {
      actions: ["pages"],
      targets: [TARGET_ONE],
      maxUses: 1,
      maxInFlight: 1,
    });

    expect(registry.preflight(undefined, "pages")).toEqual({
      ok: false,
      denial: "unauthorized",
    });
    expect(registry.preflight("x".repeat(43), "pages")).toEqual({
      ok: false,
      denial: "unauthorized",
    });
    expect(registry.preflight(grant.secret, "eval")).toEqual({
      ok: false,
      denial: "forbidden",
    });
    expect(registry.preflight(grant.secret, "pages", wrongPrincipal)).toEqual({
      ok: false,
      denial: "forbidden",
    });
    for (let count = 0; count < 20; count += 1) {
      expect(registry.preflight(grant.secret, "pages", principal)).toEqual({ ok: true });
    }

    const lease = registry.authorize(
      grant.secret,
      { action: "pages" },
      { requestId: requestId(1), expectedPrincipal: principal },
    );
    expect(lease.remainingUses).toBe(0);
    lease.release();
    expect(registry.preflight(grant.secret, "pages")).toEqual({
      ok: false,
      denial: "unauthorized",
    });
  });

  it("reserves action-only, returns the registry owner, and binds exact target facts before use", () => {
    const { registry } = makeRegistry();
    const grant = issue(registry, undefined, {
      actions: ["open"],
      targets: [TARGET_ONE],
      maxUses: 2,
      maxInFlight: 1,
    });

    const deniedLease = registry.authorize(
      grant.secret,
      { action: "open" },
      { requestId: requestId(1) },
    );
    expect(deniedLease.ownerId).toBe(grant.ownerId);
    expect(deniedLease.scope).toEqual([TARGET_ONE]);
    expect(Object.isFrozen(deniedLease.scope)).toBe(true);
    const denial = captureDenial(() =>
      deniedLease.checkTarget({ ...useTarget(), exactOrigins: ["https://attacker.example"] }),
    );
    expect(denial.reason).toBe("scope");
    expect(registry.stats().activeLeases).toBe(0);

    const lease = registry.authorize(
      grant.secret,
      { action: "open" },
      { requestId: requestId(2) },
    );
    expect(lease.checkTarget(useTarget())).toEqual(useTarget());
    lease.bindGeneration(REF_ONE, "generation-1");
    lease.release("success");
    expect(registry.stats().activeCapabilities).toBe(0);
  });

  it("denies wrong action, ref, profile, origin, generation, and opaque principal handle", () => {
    const { registry } = makeRegistry();
    const principal = registry.createPrincipal();
    const otherPrincipal = registry.createPrincipal();
    const grant = issue(registry, principal, {
      actions: ["open", "eval"],
      targets: [TARGET_ONE],
      maxUses: 8,
    });

    expect(captureDenial(() => registry.authorize(
      grant.secret,
      { action: "goto" },
      { requestId: requestId(1) },
    )).reason).toBe("scope");
    expect(captureDenial(() => registry.authorize(
      grant.secret,
      { action: "open", target: { ...useTarget(), ref: REF_TWO } },
      { requestId: requestId(2) },
    )).reason).toBe("scope");
    expect(captureDenial(() => registry.authorize(
      grant.secret,
      { action: "open", target: { ...useTarget(), profile: "work" } },
      { requestId: requestId(3) },
    )).reason).toBe("scope");
    expect(captureDenial(() => registry.authorize(
      grant.secret,
      { action: "open", target: { ...useTarget(), exactOrigins: ["https://attacker.example"] } },
      { requestId: requestId(4) },
    )).reason).toBe("scope");
    expect(captureDenial(() => registry.authorize(
      grant.secret,
      { action: "open", target: useTarget(TARGET_ONE, "unbound-generation") },
      { requestId: requestId(5) },
    )).reason).toBe("scope");
    expect(captureDenial(() => registry.authorize(
      grant.secret,
      { action: "open" },
      { requestId: requestId(6), expectedPrincipal: otherPrincipal },
    )).reason).toBe("scope");

    const fakePrincipal: BrowserAutomationPrincipal = { ...principal };
    expect(captureDenial(() => registry.authorize(
      grant.secret,
      { action: "open" },
      { requestId: requestId(7), expectedPrincipal: fakePrincipal },
    )).reason).toBe("scope");
    expect(registry.stats().activeLeases).toBe(0);
  });

  it("binds, rolls, and unbinds generation with lease-scoped compare-and-set only", () => {
    const { registry } = makeRegistry();
    const grant = issue(registry, undefined, {
      actions: ["open", "goto", "eval", "close"],
      targets: [TARGET_ONE],
      maxUses: 10,
    });

    const open = registry.authorize(
      grant.secret,
      { action: "open", target: useTarget() },
      { requestId: requestId(1) },
    );
    expect(open.boundGeneration(REF_ONE)).toBeUndefined();
    open.bindGeneration(REF_ONE, "generation-1");
    expect(open.boundGeneration(REF_ONE)).toBe("generation-1");
    expect(() => open.bindGeneration(REF_ONE, "generation-1")).toThrowError(
      BrowserCapabilityStateDenied,
    );
    open.release();
    expect(() => open.boundGeneration(REF_ONE)).toThrowError(BrowserCapabilityStateDenied);

    expect(captureDenial(() => registry.authorize(
      grant.secret,
      { action: "eval", target: useTarget(TARGET_ONE, "generation-stale") },
      { requestId: requestId(2) },
    )).reason).toBe("scope");

    const navigate = registry.authorize(
      grant.secret,
      { action: "goto", target: useTarget(TARGET_ONE, "generation-1") },
      { requestId: requestId(3) },
    );
    expect(() => navigate.rollGeneration(REF_ONE, "wrong", "generation-2")).toThrowError(
      BrowserCapabilityStateDenied,
    );
    navigate.rollGeneration(REF_ONE, "generation-1", "generation-2");
    navigate.release();

    expect(captureDenial(() => registry.authorize(
      grant.secret,
      { action: "eval", target: useTarget(TARGET_ONE, "generation-1") },
      { requestId: requestId(4) },
    )).reason).toBe("scope");
    const evaluate = registry.authorize(
      grant.secret,
      { action: "eval", target: useTarget(TARGET_ONE, "generation-2") },
      { requestId: requestId(5) },
    );
    expect(() => evaluate.rollGeneration(REF_ONE, "generation-2", "generation-3")).toThrowError(
      BrowserCapabilityStateDenied,
    );
    evaluate.release();

    const close = registry.authorize(
      grant.secret,
      { action: "close", target: useTarget(TARGET_ONE, "generation-2") },
      { requestId: requestId(6) },
    );
    close.unbindGeneration(REF_ONE, "generation-2");
    close.release();
    const reopen = registry.authorize(
      grant.secret,
      { action: "open", target: useTarget() },
      { requestId: requestId(7) },
    );
    reopen.bindGeneration(REF_ONE, "generation-3");
    reopen.release();

    const auditJson = JSON.stringify(registry.auditSnapshot());
    expect(auditJson).not.toContain("generation-1");
    expect(auditJson).not.toContain("generation-2");
    expect(auditJson).not.toContain("generation-3");
    expect(registry.auditSnapshot().filter((event) => event.kind === "generation")).toHaveLength(4);
    expect(
      registry.auditSnapshot().filter((event) => event.kind === "generation")[0]?.generationTag,
    ).toMatch(/^g_[A-Za-z0-9_-]{22}$/);
  });

  it("lets active open and list leases read generations only for their immutable scope", () => {
    const { registry } = makeRegistry();
    const grant = issue(registry, undefined, {
      actions: ["open", "pages"],
      targets: [TARGET_ONE, TARGET_TWO],
      maxUses: 6,
    });
    const open = registry.authorize(
      grant.secret,
      { action: "open" },
      { requestId: requestId(1) },
    );
    expect(open.target).toBeUndefined();
    expect(open.boundGenerationInScope(REF_ONE)).toBeUndefined();
    open.checkTarget(useTarget());
    open.bindGeneration(REF_ONE, "generation-1");
    open.release();

    const pages = registry.authorize(
      grant.secret,
      { action: "pages" },
      { requestId: requestId(2) },
    );
    expect(pages.target).toBeUndefined();
    expect(pages.boundGenerationInScope(REF_ONE)).toBe("generation-1");
    expect(pages.boundGenerationInScope(REF_TWO)).toBeUndefined();
    expect(() => pages.boundGenerationInScope(REF_THREE)).toThrowError(
      BrowserCapabilityStateDenied,
    );
    expect(() => pages.boundGeneration(REF_ONE)).toThrowError(BrowserCapabilityStateDenied);
    expect(() => pages.bindGeneration(REF_TWO, "generation-2")).toThrowError(
      BrowserCapabilityStateDenied,
    );

    pages.release();
    expect(() => pages.boundGenerationInScope(REF_ONE)).toThrowError(
      BrowserCapabilityStateDenied,
    );
  });

  it("denies list generation reads after expiry", () => {
    const { registry, runtime } = makeRegistry();
    const grant = issue(registry, undefined, {
      actions: ["pages"],
      targets: [TARGET_ONE],
      ttlMs: 100,
      maxUses: 2,
    });
    const pages = registry.authorize(
      grant.secret,
      { action: "pages" },
      { requestId: requestId(1) },
    );
    expect(pages.boundGenerationInScope(REF_ONE)).toBeUndefined();

    runtime.advanceWallWhileSuspended(100);
    expect(() => pages.boundGenerationInScope(REF_ONE)).toThrowError(
      BrowserCapabilityStateDenied,
    );
    expect(pages.signal.aborted).toBe(true);
  });

  it("denies list generation reads after revocation", () => {
    const { registry } = makeRegistry();
    const grant = issue(registry, undefined, {
      actions: ["pages"],
      targets: [TARGET_ONE],
      maxUses: 2,
    });
    const pages = registry.authorize(
      grant.secret,
      { action: "pages" },
      { requestId: requestId(1) },
    );
    expect(pages.boundGenerationInScope(REF_ONE)).toBeUndefined();

    expect(registry.revoke(grant.handle)).toBe(true);
    expect(() => pages.boundGenerationInScope(REF_ONE)).toThrowError(
      BrowserCapabilityStateDenied,
    );
    expect(pages.signal.aborted).toBe(true);
  });

  it("rejects bounded duplicate request ids without consuming another use", () => {
    const { registry } = makeRegistry();
    const grant = issue(registry, undefined, {
      actions: ["pages"],
      targets: [TARGET_ONE],
      maxUses: 3,
    });
    const first = registry.authorize(
      grant.secret,
      { action: "pages" },
      { requestId: requestId(1) },
    );
    expect(first.remainingUses).toBe(2);
    first.release();

    const replay = captureDenial(() => registry.authorize(
      grant.secret,
      { action: "pages" },
      { requestId: requestId(1) },
    ));
    expect(replay.reason).toBe("replay");
    const second = registry.authorize(
      grant.secret,
      { action: "pages" },
      { requestId: requestId(2) },
    );
    expect(second.remainingUses).toBe(1);
    second.release();
    expect(
      registry.auditSnapshot().some((event) => event.outcome === "denied_replay"),
    ).toBe(true);
  });

  it("keeps the replay set bounded to recent ids", () => {
    const { registry } = makeRegistry();
    const grant = issue(registry, undefined, {
      actions: ["pages"],
      targets: [TARGET_ONE],
      maxUses: BROWSER_CAPABILITY_MAX_RECENT_REQUEST_IDS + 2,
      maxInFlight: 1,
    });
    for (let value = 1; value <= BROWSER_CAPABILITY_MAX_RECENT_REQUEST_IDS + 1; value += 1) {
      const lease = registry.authorize(
        grant.secret,
        { action: "pages" },
        { requestId: requestId(value) },
      );
      lease.release();
    }
    const oldest = registry.authorize(
      grant.secret,
      { action: "pages" },
      { requestId: requestId(1) },
    );
    expect(oldest.remainingUses).toBe(0);
    oldest.release();
  });

  it("consumes admitted attempts, not concurrency denials", () => {
    const { registry } = makeRegistry();
    const grant = issue(registry, undefined, {
      actions: ["pages"],
      targets: [TARGET_ONE],
      maxUses: 2,
      maxInFlight: 1,
    });
    const first = registry.authorize(
      grant.secret,
      { action: "pages" },
      { requestId: requestId(1) },
    );
    expect(registry.preflight(grant.secret, "pages")).toEqual({
      ok: false,
      denial: "forbidden",
    });
    expect(captureDenial(() => registry.authorize(
      grant.secret,
      { action: "pages" },
      { requestId: requestId(2) },
    )).reason).toBe("concurrency");
    first.release("failed");

    const second = registry.authorize(
      grant.secret,
      { action: "pages" },
      { requestId: requestId(2) },
    );
    expect(second.remainingUses).toBe(0);
    expect(registry.preflight(grant.secret, "pages")).toEqual({
      ok: false,
      denial: "forbidden",
    });
    second.release();
    expect(registry.stats().activeCapabilities).toBe(0);
  });
});

describe("browser capability lifetime and bounded state", () => {
  it("notifies the exact owner once for explicit revoke and use-capacity teardown", () => {
    const notices: BrowserCapabilityTerminationNotice[] = [];
    const { registry } = makeRegistry(undefined, {
      onTerminate: (notice) => notices.push(notice),
    });
    const revoked = issue(registry, undefined, {
      actions: ["pages"],
      targets: [TARGET_ONE],
    });
    const exhausted = issue(registry, undefined, {
      actions: ["pages"],
      targets: [TARGET_TWO],
      maxUses: 1,
    });

    expect(registry.revoke(revoked.handle, "operator")).toBe(true);
    expect(registry.revoke(revoked.handle, "operator")).toBe(false);
    const lastUse = registry.authorize(
      exhausted.secret,
      { action: "pages" },
      { requestId: requestId(1) },
    );
    lastUse.release();
    lastUse.release();

    expect(notices).toEqual([
      {
        ownerId: revoked.ownerId,
        principalId: revoked.principalId,
        jobId: revoked.jobId,
        auditId: revoked.auditId,
        reason: "revoked_operator",
        revocationGeneration: 0,
      },
      {
        ownerId: exhausted.ownerId,
        principalId: exhausted.principalId,
        jobId: exhausted.jobId,
        auditId: exhausted.auditId,
        reason: "exhausted",
        revocationGeneration: 0,
      },
    ]);
    expect(notices.every(Object.isFrozen)).toBe(true);
    const serialized = JSON.stringify(notices);
    for (const secretData of [
      revoked.secret,
      exhausted.secret,
      REF_ONE,
      REF_TWO,
      "https://example.com",
    ]) {
      expect(serialized).not.toContain(secretData);
    }
  });

  it("notifies expiry once when resume reaping observes a suspended wall-clock deadline", () => {
    const notices: BrowserCapabilityTerminationNotice[] = [];
    const { registry, runtime } = makeRegistry(undefined, {
      onTerminate: (notice) => notices.push(notice),
    });
    const grant = issue(registry, undefined, {
      actions: ["pages"],
      targets: [TARGET_ONE],
      ttlMs: 100,
    });
    runtime.advanceWallWhileSuspended(100);

    expect(registry.reapAfterResume()).toBe(1);
    expect(registry.reapAfterResume()).toBe(0);
    runtime.runDueTimers();
    expect(notices).toEqual([
      {
        ownerId: grant.ownerId,
        principalId: grant.principalId,
        jobId: grant.jobId,
        auditId: grant.auditId,
        reason: "expired",
        revocationGeneration: 0,
      },
    ]);
  });

  it("notifies once per record during principal revoke and app close", () => {
    const notices: BrowserCapabilityTerminationNotice[] = [];
    const { registry } = makeRegistry(undefined, {
      onTerminate: (notice) => notices.push(notice),
    });
    const principal = registry.createPrincipal();
    const principalGrants = [
      issue(registry, principal, { actions: ["pages"], targets: [TARGET_ONE] }),
      issue(registry, principal, { actions: ["pages"], targets: [TARGET_TWO] }),
    ];
    const closeGrants = [
      issue(registry, undefined, { actions: ["pages"], targets: [TARGET_ONE] }),
      issue(registry, undefined, { actions: ["pages"], targets: [TARGET_TWO] }),
    ];

    expect(registry.revokePrincipal(principal, "principal_closed")).toBe(2);
    expect(registry.revokePrincipal(principal, "principal_closed")).toBe(0);
    expect(registry.close()).toBe(2);
    expect(registry.close()).toBe(0);

    expect(notices).toHaveLength(4);
    expect(notices.slice(0, 2).map((notice) => notice.auditId).sort()).toEqual(
      principalGrants.map((grant) => grant.auditId).sort(),
    );
    expect(notices.slice(0, 2).every((notice) => notice.reason === "revoked_principal_closed")).toBe(
      true,
    );
    expect(notices.slice(2).map((notice) => notice.auditId).sort()).toEqual(
      closeGrants.map((grant) => grant.auditId).sort(),
    );
    expect(notices.slice(2).every((notice) => notice.reason === "app_closed")).toBe(true);
  });

  it("revokes only exact-profile grants while preserving work and same-principal siblings", () => {
    const notices: BrowserCapabilityTerminationNotice[] = [];
    const { registry } = makeRegistry(undefined, {
      onTerminate: (notice) => notices.push(notice),
    });
    const principal = registry.createPrincipal();
    const affected = issue(registry, principal, {
      actions: ["pages"],
      targets: [TARGET_ONE],
    });
    const samePrincipalSibling = issue(registry, principal, {
      actions: ["pages"],
      targets: [TARGET_TWO],
    });
    const mixed = issue(registry, undefined, {
      actions: ["pages"],
      targets: [TARGET_ONE, TARGET_TWO],
    });
    const workOnly = issue(registry, undefined, {
      actions: ["pages"],
      targets: [TARGET_TWO],
    });
    const nearMatch = issue(registry, undefined, {
      actions: ["pages"],
      targets: [{
        ref: REF_THREE,
        profile: "personal-archive",
        exactOrigins: ["https://archive.example.com"],
      }],
    });
    const grants = [affected, samePrincipalSibling, mixed, workOnly, nearMatch];
    const leases = grants.map((grant, index) => registry.authorize(
      grant.secret,
      { action: "pages" },
      { requestId: requestId(index + 1) },
    ));
    const aborts = grants.map(() => 0);
    leases.forEach((lease, index) => {
      lease.signal.addEventListener("abort", () => {
        aborts[index] = (aborts[index] ?? 0) + 1;
      });
    });

    expect(registry.revokeByProfile("personal", "profile_wipe")).toBe(2);
    expect(registry.revokeByProfile("personal", "profile_wipe")).toBe(0);
    expect(aborts).toEqual([1, 0, 1, 0, 0]);
    expect(leases[0]?.signal.reason).toBeInstanceOf(BrowserCapabilityLeaseAbort);
    expect((leases[0]?.signal.reason as BrowserCapabilityLeaseAbort).reason).toBe("revoked");
    expect(leases[2]?.signal.reason).toBeInstanceOf(BrowserCapabilityLeaseAbort);
    leases[0]?.release();
    leases[2]?.release();
    expect(aborts).toEqual([1, 0, 1, 0, 0]);

    expect(notices).toHaveLength(2);
    expect(notices.map((notice) => notice.auditId).sort()).toEqual(
      [affected.auditId, mixed.auditId].sort(),
    );
    expect(notices.every((notice) => notice.reason === "revoked_profile_wipe")).toBe(true);
    expect(notices.every(Object.isFrozen)).toBe(true);
    expect(registry.stats()).toMatchObject({ activeCapabilities: 3, activeLeases: 3 });
    expect(registry.preflight(affected.secret, "pages")).toEqual({
      ok: false,
      denial: "unauthorized",
    });
    expect(registry.preflight(mixed.secret, "pages")).toEqual({
      ok: false,
      denial: "unauthorized",
    });
    for (const survivor of [samePrincipalSibling, workOnly, nearMatch]) {
      expect(registry.preflight(survivor.secret, "pages")).toEqual({ ok: true });
    }

    leases[1]?.release();
    leases[3]?.release();
    leases[4]?.release();
    const siblingLease = registry.authorize(
      samePrincipalSibling.secret,
      { action: "pages" },
      { requestId: requestId(10), expectedPrincipal: principal },
    );
    siblingLease.release();

    const audit = registry.auditSnapshot();
    expect(
      audit
        .filter((event) => event.outcome === "revoked_profile_wipe")
        .map((event) => event.auditId)
        .sort(),
    ).toEqual([affected.auditId, mixed.auditId].sort());
    const serialized = JSON.stringify({ audit, notices });
    for (const forbidden of [
      ...grants.map((grant) => grant.secret),
      "personal",
      "work",
      "personal-archive",
      REF_ONE,
      REF_TWO,
      REF_THREE,
      "https://example.com",
      "https://github.com",
      "https://www.github.com",
      "https://archive.example.com",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("rejects malformed profile wipe requests without mutating authority", () => {
    const notices: BrowserCapabilityTerminationNotice[] = [];
    const { registry } = makeRegistry(undefined, {
      onTerminate: (notice) => notices.push(notice),
    });
    const grant = issue(registry, undefined, {
      actions: ["pages"],
      targets: [TARGET_ONE],
    });
    for (const invalid of ["", "*", "Personal", "../personal", "x".repeat(64), 1, null]) {
      expect(() => registry.revokeByProfile(
        invalid as string,
        "profile_wipe",
      )).toThrowError(BrowserCapabilityStateDenied);
    }
    expect(() => registry.revokeByProfile(
      "personal",
      "operator" as BrowserCapabilityProfileRevocationReason,
    )).toThrowError(BrowserCapabilityStateDenied);

    expect(notices).toEqual([]);
    expect(registry.stats().activeCapabilities).toBe(1);
    expect(registry.preflight(grant.secret, "pages")).toEqual({ ok: true });
  });

  it("finishes teardown when the termination observer throws", () => {
    let calls = 0;
    const { registry } = makeRegistry(undefined, {
      onTerminate: () => {
        calls += 1;
        throw new Error("observer failure must stay internal");
      },
    });
    const grant = issue(registry, undefined, {
      actions: ["pages"],
      targets: [TARGET_ONE],
    });
    const lease = registry.authorize(
      grant.secret,
      { action: "pages" },
      { requestId: requestId(1) },
    );
    let aborts = 0;
    lease.signal.addEventListener("abort", () => {
      aborts += 1;
    });

    expect(registry.revoke(grant.handle)).toBe(true);
    expect(registry.revoke(grant.handle)).toBe(false);
    expect(calls).toBe(1);
    expect(aborts).toBe(1);
    expect(registry.stats()).toMatchObject({ activeCapabilities: 0, activeLeases: 0 });
    expect(
      registry.auditSnapshot().filter((event) => event.outcome === "revoked_operator"),
    ).toHaveLength(1);
    expect(
      registry.auditSnapshot().filter((event) => event.outcome === "termination_callback_failed"),
    ).toHaveLength(1);
  });

  it("expires on the exact monotonic boundary and aborts one active lease exactly once", () => {
    const { registry, runtime } = makeRegistry();
    const grant = issue(registry, undefined, {
      actions: ["pages"],
      targets: [TARGET_ONE],
      ttlMs: 100,
      maxUses: 2,
    });
    const lease = registry.authorize(
      grant.secret,
      { action: "pages" },
      { requestId: requestId(1) },
    );
    let aborts = 0;
    lease.signal.addEventListener("abort", () => {
      aborts += 1;
      lease.release("cancelled");
    });

    runtime.advanceBoth(99);
    expect(aborts).toBe(0);
    expect(lease.signal.aborted).toBe(false);
    runtime.advanceBoth(1);
    expect(aborts).toBe(1);
    expect(lease.signal.aborted).toBe(true);
    expect(lease.signal.reason).toBeInstanceOf(BrowserCapabilityLeaseAbort);
    expect((lease.signal.reason as BrowserCapabilityLeaseAbort).reason).toBe("expired");
    runtime.advanceBoth(1_000);
    lease.release();
    expect(aborts).toBe(1);
    expect(registry.stats()).toMatchObject({ activeCapabilities: 0, activeLeases: 0 });
    expect(registry.preflight(grant.secret, "pages")).toEqual({
      ok: false,
      denial: "unauthorized",
    });
    expect(
      registry.auditSnapshot().filter((event) => event.outcome === "aborted_expired"),
    ).toHaveLength(1);
  });

  it("reaps wall-clock expiry after suspend even when the monotonic clock pauses", () => {
    const { registry, runtime } = makeRegistry();
    const grant = issue(registry, undefined, {
      actions: ["pages"],
      targets: [TARGET_ONE],
      ttlMs: 100,
    });
    const lease = registry.authorize(
      grant.secret,
      { action: "pages" },
      { requestId: requestId(1) },
    );
    let aborts = 0;
    lease.signal.addEventListener("abort", () => {
      aborts += 1;
    });
    runtime.advanceWallWhileSuspended(100);
    expect(runtime.timers.size).toBe(1);
    expect(registry.reapAfterResume()).toBe(1);
    expect(aborts).toBe(1);
    expect(registry.reapAfterResume()).toBe(0);
  });

  it("revokes only affected leases and makes repeated revoke/release idempotent", () => {
    const { registry } = makeRegistry();
    const principalOne = registry.createPrincipal();
    const principalTwo = registry.createPrincipal();
    const grantOne = issue(registry, principalOne, { actions: ["pages"], targets: [TARGET_ONE] });
    const grantTwo = issue(registry, principalTwo, { actions: ["pages"], targets: [TARGET_TWO] });
    const leaseOne = registry.authorize(
      grantOne.secret,
      { action: "pages" },
      { requestId: requestId(1) },
    );
    const leaseTwo = registry.authorize(
      grantTwo.secret,
      { action: "pages" },
      { requestId: requestId(2) },
    );
    let firstAborts = 0;
    let secondAborts = 0;
    leaseOne.signal.addEventListener("abort", () => {
      firstAborts += 1;
      leaseOne.release();
    });
    leaseTwo.signal.addEventListener("abort", () => {
      secondAborts += 1;
    });

    expect(registry.revoke(grantOne.handle, "operator")).toBe(true);
    expect(registry.revoke(grantOne.handle, "operator")).toBe(false);
    expect(firstAborts).toBe(1);
    expect(secondAborts).toBe(0);
    leaseOne.release();
    leaseTwo.release();
    expect(registry.stats().activeCapabilities).toBe(1);
    expect(captureDenial(() => registry.authorize(
      grantOne.secret,
      { action: "pages" },
      { requestId: requestId(3) },
    )).reason).toBe("credential");
  });

  it("increments principal revocation generation while allowing a later scoped grant", () => {
    const { registry } = makeRegistry();
    const principal = registry.createPrincipal();
    const first = issue(registry, principal, { actions: ["pages"], targets: [TARGET_ONE] });
    const second = issue(registry, principal, { actions: ["pages"], targets: [TARGET_ONE] });
    const lease = registry.authorize(
      first.secret,
      { action: "pages" },
      { requestId: requestId(1), expectedPrincipal: principal },
    );
    let aborts = 0;
    lease.signal.addEventListener("abort", () => {
      aborts += 1;
    });
    expect(registry.revokePrincipal(principal)).toBe(2);
    expect(aborts).toBe(1);
    expect(registry.preflight(second.secret, "pages")).toEqual({
      ok: false,
      denial: "unauthorized",
    });

    const replacement = issue(registry, principal, {
      actions: ["pages"],
      targets: [TARGET_ONE],
    });
    expect(replacement.revocationGeneration).toBe(1);
    const replacementLease = registry.authorize(
      replacement.secret,
      { action: "pages" },
      { requestId: requestId(2), expectedPrincipal: principal },
    );
    replacementLease.release();
  });

  it("enforces global and per-principal capacity and releases it on revoke", () => {
    const { registry } = makeRegistry(undefined, {
      maxCapabilities: 2,
      maxCapabilitiesPerPrincipal: 1,
    });
    const one = registry.createPrincipal();
    const two = registry.createPrincipal();
    const three = registry.createPrincipal();
    const grantOne = issue(registry, one, { actions: ["pages"], targets: [TARGET_ONE] });
    expect(() => issue(registry, one, { actions: ["pages"], targets: [TARGET_ONE] })).toThrowError(
      BrowserCapabilityIssueDenied,
    );
    issue(registry, two, { actions: ["pages"], targets: [TARGET_ONE] });
    expect(() => issue(registry, three, { actions: ["pages"], targets: [TARGET_ONE] })).toThrowError(
      BrowserCapabilityIssueDenied,
    );
    expect(registry.revoke(grantOne.handle)).toBe(true);
    expect(() => issue(registry, three, { actions: ["pages"], targets: [TARGET_ONE] })).not.toThrow();
  });

  it("closes the app registry once and aborts every active lease without cross-callback duplication", () => {
    const { registry } = makeRegistry();
    const first = issue(registry, undefined, { actions: ["pages"], targets: [TARGET_ONE] });
    const second = issue(registry, undefined, { actions: ["pages"], targets: [TARGET_TWO] });
    const leases = [
      registry.authorize(first.secret, { action: "pages" }, { requestId: requestId(1) }),
      registry.authorize(second.secret, { action: "pages" }, { requestId: requestId(2) }),
    ];
    const aborts = [0, 0];
    leases.forEach((lease, index) => {
      lease.signal.addEventListener("abort", () => {
        aborts[index] = (aborts[index] ?? 0) + 1;
        lease.release("cancelled");
      });
    });
    expect(registry.close()).toBe(2);
    expect(registry.close()).toBe(0);
    expect(aborts).toEqual([1, 1]);
    expect(registry.stats()).toMatchObject({
      closed: true,
      activeCapabilities: 0,
      activeLeases: 0,
    });
    expect(registry.preflight(first.secret, "pages")).toEqual({
      ok: false,
      denial: "unauthorized",
    });
    expect(() => issue(registry)).toThrowError(BrowserCapabilityIssueDenied);
  });

  it("retains a bounded, secret-free audit ring with opaque target and generation tags", () => {
    const { registry } = makeRegistry(undefined, { auditCapacity: 8 });
    const grant = issue(registry, undefined, {
      actions: ["open", "goto", "close"],
      targets: [TARGET_ONE],
      maxUses: 4,
    });
    const open = registry.authorize(
      grant.secret,
      { action: "open", target: useTarget() },
      { requestId: requestId(1) },
    );
    open.bindGeneration(REF_ONE, "audit-generation-secret");
    open.release();
    const navigate = registry.authorize(
      grant.secret,
      { action: "goto", target: useTarget(TARGET_ONE, "audit-generation-secret") },
      { requestId: requestId(2) },
    );
    navigate.rollGeneration(REF_ONE, "audit-generation-secret", "audit-generation-next");
    navigate.release("failed");
    captureDenial(() => registry.authorize(
      grant.secret,
      { action: "close", target: useTarget(TARGET_ONE, "wrong-generation") },
      { requestId: requestId(3) },
    ));
    captureDenial(() => registry.authorize(
      grant.secret,
      { action: "eval" },
      { requestId: requestId(4) },
    ));

    const audit = registry.auditSnapshot();
    expect(audit).toHaveLength(8);
    expect(audit[0]?.sequence).toBeGreaterThan(1);
    const serialized = JSON.stringify(audit);
    for (const forbidden of [
      grant.secret,
      REF_ONE,
      "https://example.com",
      "audit-generation-secret",
      "audit-generation-next",
      "wrong-generation",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(audit.some((event) => event.targetTag?.startsWith("t_") === true)).toBe(true);
    expect(audit.some((event) => event.generationTag?.startsWith("g_") === true)).toBe(true);
    expect(Object.isFrozen(audit)).toBe(true);
  });
});

describe("browser capability injected dependencies", () => {
  it("rejects malformed RNG and non-finite clocks instead of issuing weak material", () => {
    expect(() => new BrowserCapabilityRegistry({
      dependencies: { randomBytes: (size) => new Uint8Array(Math.max(0, size - 1)) },
    })).toThrowError(BrowserCapabilityIssueDenied);
    expect(() => new BrowserCapabilityRegistry({
      dependencies: { wallNow: () => Number.NaN },
    })).toThrowError(BrowserCapabilityIssueDenied);
    expect(() => new BrowserCapabilityRegistry({
      dependencies: { monotonicNow: () => Number.POSITIVE_INFINITY },
    })).toThrowError(BrowserCapabilityIssueDenied);
  });

  it("uses both injected clocks so a backward wall jump cannot extend monotonic lifetime", () => {
    const { registry, runtime } = makeRegistry();
    const grant = issue(registry, undefined, {
      actions: ["pages"],
      targets: [TARGET_ONE],
      ttlMs: 100,
    });
    runtime.wall -= 10_000;
    runtime.monotonic += 100;
    expect(registry.reapExpired()).toBe(1);
    expect(registry.preflight(grant.secret, "pages")).toEqual({
      ok: false,
      denial: "unauthorized",
    });
  });
});
