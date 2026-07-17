import { describe, expect, it, vi } from "vitest";
import {
  BROWSER_AGENT_AUTHORITY_MAX_ACTIVE,
  BROWSER_AGENT_AUTHORITY_MAX_TARGETS,
  BROWSER_AGENT_AUTHORITY_MAX_USES,
  BROWSER_AGENT_AUTHORITY_TTL_MS,
  BrowserAgentAuthority,
  type BrowserAutomationConfirmation,
  type BrowserAutomationDelivery,
} from "../src/main/vellum/browser/agent-authority";
import {
  BrowserCapabilityDenied,
  BrowserCapabilityRegistry,
  type BrowserCapabilityTerminationNotice,
} from "../src/main/vellum/browser/capabilities";
import type { ResolvedPageTarget } from "../src/main/vellum/browser/page-target";
import { BrowserProfileGate } from "../src/main/vellum/browser/profile-gate";

const PAGE = (
  nodeId = "n1",
  url = "https://example.com/inbox",
  profile = "default",
): ResolvedPageTarget => ({
  ref: `vellum://canvas/work?node=${nodeId}`,
  nodeId,
  url,
  profile,
});

const SUBJECT = { id: "local:default", kind: "hermes" as const, label: "Hermes default" };

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const setup = (options?: {
  readonly approve?: boolean;
  readonly confirm?: (confirmation: BrowserAutomationConfirmation) => Promise<boolean>;
  readonly deliver?: (delivery: BrowserAutomationDelivery) => Promise<unknown>;
  readonly makeGrantId?: () => string;
  readonly profileGate?: BrowserProfileGate;
}) => {
  let authority: BrowserAgentAuthority | undefined;
  const notices: BrowserCapabilityTerminationNotice[] = [];
  const registry = new BrowserCapabilityRegistry({
    onTerminate: (notice) => {
      notices.push(notice);
      authority?.handleTermination(notice);
    },
  });
  const confirmations: BrowserAutomationConfirmation[] = [];
  const deliveries: BrowserAutomationDelivery[] = [];
  const cleanup = vi.fn();
  authority = new BrowserAgentAuthority(registry, {
    controlHome: "/Users/tester",
    makeGrantId: options?.makeGrantId ?? (() => "grant-1"),
    ...(options?.profileGate === undefined ? {} : { profileGate: options.profileGate }),
    confirm: async (request) => {
      confirmations.push(request);
      return options?.confirm?.(request) ?? options?.approve ?? true;
    },
    deliver: async (delivery) => {
      deliveries.push(delivery);
      const custom = await options?.deliver?.(delivery);
      return (custom as { cleanup?: () => void } | undefined) ?? { cleanup };
    },
  });
  return { authority, registry, notices, confirmations, deliveries, cleanup };
};

describe("BrowserAgentAuthority", () => {
  it("requires native confirmation before minting or delivering", async () => {
    const { authority, registry, confirmations, deliveries } = setup({ approve: false });
    await expect(authority.issue(SUBJECT, [PAGE()])).resolves.toEqual({
      ok: false,
      code: "cancelled",
      message: "browser authority was not approved",
    });
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]).toMatchObject({
      subject: SUBJECT,
      targetCount: 1,
      targets: [
        {
          ref: "vellum://canvas/work?node=n1",
          profile: "default",
          exactOrigins: ["https://example.com"],
        },
      ],
      ttlMs: BROWSER_AGENT_AUTHORITY_TTL_MS,
      maxUses: BROWSER_AGENT_AUTHORITY_MAX_USES,
    });
    expect(Object.isFrozen(confirmations[0]?.targets)).toBe(true);
    expect(Object.isFrozen(confirmations[0]?.targets[0]?.exactOrigins)).toBe(true);
    expect(deliveries).toHaveLength(0);
    expect(registry.stats().activeCapabilities).toBe(0);
  });

  it("snapshots each exact target profile once and ignores unrelated profile blocks", async () => {
    const profileGate = new BrowserProfileGate();
    const snapshot = vi.spyOn(profileGate, "snapshot");
    const test = setup({
      profileGate,
      confirm: async () => {
        expect(profileGate.begin("unrelated")).toMatchObject({ ok: true });
        return true;
      },
    });

    await expect(test.authority.issue(SUBJECT, [
      PAGE("n1", "https://one.example.com", "default"),
      PAGE("n2", "https://two.example.com", "default"),
      PAGE("n3", "https://three.example.com", "work"),
    ])).resolves.toMatchObject({ ok: true, data: { targetCount: 3 } });

    expect(snapshot.mock.calls.map(([profile]) => profile)).toEqual(["default", "work"]);
    expect(test.confirmations).toHaveLength(1);
    expect(test.deliveries).toHaveLength(1);
    expect(test.registry.stats().activeCapabilities).toBe(1);
  });

  it("denies a profile already blocked before confirmation without minting", async () => {
    const profileGate = new BrowserProfileGate();
    expect(profileGate.begin("default")).toMatchObject({ ok: true });
    const test = setup({ profileGate });
    const createPrincipal = vi.spyOn(test.registry, "createPrincipal");
    const issue = vi.spyOn(test.registry, "issue");

    await expect(test.authority.issue(SUBJECT, [PAGE()])).resolves.toEqual({
      ok: false,
      code: "cancelled",
      message: "browser authority profiles changed during confirmation",
    });
    expect(test.confirmations).toHaveLength(0);
    expect(createPrincipal).not.toHaveBeenCalled();
    expect(issue).not.toHaveBeenCalled();
    expect(test.deliveries).toHaveLength(0);
    expect(test.registry.stats().activeCapabilities).toBe(0);
  });

  it.each([
    {
      name: "block",
      mutate: (gate: BrowserProfileGate) => {
        expect(gate.begin("work")).toMatchObject({ ok: true });
      },
    },
    {
      name: "block then cancel",
      mutate: (gate: BrowserProfileGate) => {
        const blocked = gate.begin("work");
        expect(blocked.ok).toBe(true);
        if (blocked.ok) expect(gate.cancelBeforeMutation(blocked.data)).toBe(true);
      },
    },
    {
      name: "delete then recreate",
      mutate: (gate: BrowserProfileGate) => {
        const blocked = gate.begin("work");
        expect(blocked.ok).toBe(true);
        if (!blocked.ok) return;
        expect(gate.commitDeleted(blocked.data)).toBe(true);
        expect(gate.markCreated("work")).toMatchObject({ ok: true });
      },
    },
  ])("denies stale profile snapshots after $name during confirmation", async ({ mutate }) => {
    const profileGate = new BrowserProfileGate();
    const approval = deferred<boolean>();
    const test = setup({ profileGate, confirm: () => approval.promise });
    const createPrincipal = vi.spyOn(test.registry, "createPrincipal");
    const issue = vi.spyOn(test.registry, "issue");
    const issuing = test.authority.issue(SUBJECT, [
      PAGE("n1", "https://one.example.com", "default"),
      PAGE("n2", "https://two.example.com", "work"),
    ]);
    await vi.waitFor(() => expect(test.confirmations).toHaveLength(1));

    mutate(profileGate);
    approval.resolve(true);

    await expect(issuing).resolves.toEqual({
      ok: false,
      code: "cancelled",
      message: "browser authority profiles changed during confirmation",
    });
    expect(createPrincipal).not.toHaveBeenCalled();
    expect(issue).not.toHaveBeenCalled();
    expect(test.deliveries).toHaveLength(0);
    expect(test.registry.stats().activeCapabilities).toBe(0);
  });

  it("delivers the bearer once but exposes only a bounded non-secret summary", async () => {
    const { authority, registry, deliveries } = setup();
    const result = await authority.issue(SUBJECT, [PAGE("n1"), PAGE("n2", "https://github.com")]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data).toMatchObject({
      id: "grant-1",
      subject: SUBJECT,
      targetCount: 2,
      maxUses: BROWSER_AGENT_AUTHORITY_MAX_USES,
    });
    expect(JSON.stringify(result)).not.toContain(deliveries[0]?.secret);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(deliveries[0]?.controlHome).toBe("/Users/tester");
    expect(authority.list()).toEqual([result.data]);
    expect(registry.stats().activeCapabilities).toBe(1);
  });

  it("builds immutable per-ref exact-origin scope and preserves a broad finite grant", async () => {
    const captured: BrowserAutomationDelivery[] = [];
    const { authority, registry } = setup({
      deliver: async (delivery) => {
        captured.push(delivery);
      },
    });
    const pages = Array.from({ length: BROWSER_AGENT_AUTHORITY_MAX_TARGETS }, (_, index) =>
      PAGE(`p${index}`, `https://host-${index}.example.com/path?q=secret#fragment`),
    );
    const result = await authority.issue(SUBJECT, pages);
    expect(result.ok).toBe(true);
    const secret = captured[0]?.secret;
    expect(secret).toBeDefined();

    const allowed = registry.authorize(
      secret!,
      {
        action: "open",
        target: {
          ref: pages[5]!.ref,
          profile: "default",
          exactOrigins: ["https://host-5.example.com"],
        },
      },
      { requestId: "11111111-1111-4111-8111-111111111111" },
    );
    allowed.release();
    expect(() =>
      registry.authorize(
        secret!,
        {
          action: "open",
          target: {
            ref: pages[5]!.ref,
            profile: "default",
            exactOrigins: ["https://host-6.example.com"],
          },
        },
        { requestId: "22222222-2222-4222-8222-222222222222" },
      ),
    ).toThrow(BrowserCapabilityDenied);
  });

  it.each([
    [[], "empty targets"],
    [[PAGE("n1"), PAGE("n1")], "duplicate refs"],
    [[PAGE("n1", "http://127.0.0.1/private")], "non-public URL"],
    [[PAGE("n1", "https://user:pass@example.com")], "credential URL"],
    [[{ ...PAGE("n1"), nodeId: "substituted" }], "ref and node mismatch"],
    [
      Array.from({ length: BROWSER_AGENT_AUTHORITY_MAX_TARGETS + 1 }, (_, index) => PAGE(`p${index}`)),
      "over target cap",
    ],
  ])("rejects invalid target snapshots: %s", async (targets) => {
    const { authority, confirmations, deliveries } = setup();
    await expect(authority.issue(SUBJECT, targets as ResolvedPageTarget[])).resolves.toMatchObject({
      ok: false,
      code: "invalid",
    });
    expect(confirmations).toHaveLength(0);
    expect(deliveries).toHaveLength(0);
  });

  it("rejects duplicate live authority for one main-process subject", async () => {
    let sequence = 0;
    let authority: BrowserAgentAuthority | undefined;
    const registry = new BrowserCapabilityRegistry({
      onTerminate: (notice) => authority?.handleTermination(notice),
    });
    authority = new BrowserAgentAuthority(registry, {
      controlHome: "/Users/tester",
      makeGrantId: () => `grant-${++sequence}`,
      confirm: async () => true,
      deliver: async () => undefined,
    });
    expect((await authority.issue(SUBJECT, [PAGE()])).ok).toBe(true);
    await expect(authority.issue(SUBJECT, [PAGE()])).resolves.toMatchObject({
      ok: false,
      code: "invalid",
    });
    expect(registry.stats().activeCapabilities).toBe(1);
  });

  it("reserves one subject across confirmation, mint, and delivery", async () => {
    const confirmation = deferred<boolean>();
    const delivery = deferred<void>();
    const confirm = vi.fn(() => confirmation.promise);
    const deliver = vi.fn(() => delivery.promise);
    const { authority, registry } = setup({ confirm, deliver });
    const mint = vi.spyOn(registry, "issue");

    const first = authority.issue(SUBJECT, [PAGE()]);
    expect(confirm).toHaveBeenCalledTimes(1);
    await expect(authority.issue(SUBJECT, [PAGE()])).resolves.toMatchObject({
      ok: false,
      code: "invalid",
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(mint).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();

    confirmation.resolve(true);
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    expect(mint).toHaveBeenCalledTimes(1);
    await expect(authority.issue(SUBJECT, [PAGE()])).resolves.toMatchObject({
      ok: false,
      code: "invalid",
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(mint).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledTimes(1);

    delivery.resolve();
    await expect(first).resolves.toMatchObject({ ok: true });
  });

  it("releases the subject reservation after confirmation cancellation", async () => {
    let confirmationAttempt = 0;
    const { authority, registry, confirmations, deliveries } = setup({
      confirm: async () => {
        confirmationAttempt += 1;
        return confirmationAttempt > 1;
      },
    });
    const mint = vi.spyOn(registry, "issue");

    await expect(authority.issue(SUBJECT, [PAGE()])).resolves.toMatchObject({
      ok: false,
      code: "cancelled",
    });
    await expect(authority.issue(SUBJECT, [PAGE()])).resolves.toMatchObject({ ok: true });

    expect(confirmations).toHaveLength(2);
    expect(mint).toHaveBeenCalledTimes(1);
    expect(deliveries).toHaveLength(1);
  });

  it("releases the subject reservation after delivery failure", async () => {
    let deliveryAttempt = 0;
    const { authority, registry, confirmations, deliveries } = setup({
      deliver: async () => {
        deliveryAttempt += 1;
        if (deliveryAttempt === 1) throw new Error("delivery failed");
      },
    });
    const mint = vi.spyOn(registry, "issue");

    await expect(authority.issue(SUBJECT, [PAGE()])).resolves.toMatchObject({
      ok: false,
      code: "delivery_failed",
    });
    await expect(authority.issue(SUBJECT, [PAGE()])).resolves.toMatchObject({ ok: true });

    expect(confirmations).toHaveLength(2);
    expect(mint).toHaveBeenCalledTimes(2);
    expect(deliveries).toHaveLength(2);
    expect(registry.stats().activeCapabilities).toBe(1);
  });

  it("bounds pending reservations and prevents mint after close", async () => {
    const gates: Array<ReturnType<typeof deferred<boolean>>> = [];
    const confirm = vi.fn(() => {
      const gate = deferred<boolean>();
      gates.push(gate);
      return gate.promise;
    });
    const deliver = vi.fn(async () => undefined);
    const { authority, registry } = setup({ confirm, deliver });
    const mint = vi.spyOn(registry, "issue");
    const pending = Array.from({ length: BROWSER_AGENT_AUTHORITY_MAX_ACTIVE }, (_, index) =>
      authority.issue(
        { ...SUBJECT, id: `subject-${index}`, label: `Subject ${index}` },
        [PAGE(`n${index}`)],
      ),
    );

    expect(confirm).toHaveBeenCalledTimes(BROWSER_AGENT_AUTHORITY_MAX_ACTIVE);
    await expect(
      authority.issue(
        { ...SUBJECT, id: "subject-overflow", label: "Subject overflow" },
        [PAGE("overflow")],
      ),
    ).resolves.toMatchObject({ ok: false, code: "capacity" });
    expect(confirm).toHaveBeenCalledTimes(BROWSER_AGENT_AUTHORITY_MAX_ACTIVE);

    expect(authority.close()).toBe(0);
    for (const gate of gates) gate.resolve(true);
    const results = await Promise.all(pending);
    expect(results.every((result) => !result.ok && result.code === "closed")).toBe(true);
    expect(mint).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(registry.stats().activeCapabilities).toBe(0);
  });

  it("revokes, removes, and cleans up exactly once through registry lifecycle", async () => {
    const { authority, registry, notices, cleanup } = setup();
    const issued = await authority.issue(SUBJECT, [PAGE()]);
    expect(issued.ok).toBe(true);
    expect(authority.revoke("grant-1")).toEqual({ ok: true, data: { revoked: true } });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(authority.list()).toEqual([]);
    expect(registry.stats().activeCapabilities).toBe(0);
    expect(notices).toHaveLength(1);
    authority.handleTermination(notices[0]!);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(authority.revoke("grant-1")).toMatchObject({ ok: false, code: "not_found" });
  });

  it("revokes a failed delivery and never leaves a live registry record", async () => {
    const { authority, registry, notices } = setup({
      deliver: async () => {
        throw new Error("sentinel secret must not escape");
      },
    });
    await expect(authority.issue(SUBJECT, [PAGE()])).resolves.toEqual({
      ok: false,
      code: "delivery_failed",
      message: "browser authority delivery failed",
    });
    expect(registry.stats().activeCapabilities).toBe(0);
    expect(authority.list()).toEqual([]);
    expect(notices).toHaveLength(1);
  });

  it("revokes when public grant-id generation fails before delivery", async () => {
    let authority: BrowserAgentAuthority | undefined;
    const registry = new BrowserCapabilityRegistry({
      onTerminate: (notice) => authority?.handleTermination(notice),
    });
    const deliver = vi.fn();
    authority = new BrowserAgentAuthority(registry, {
      controlHome: "/Users/tester",
      makeGrantId: () => {
        throw new Error("entropy unavailable");
      },
      confirm: async () => true,
      deliver,
    });
    await expect(authority.issue(SUBJECT, [PAGE()])).resolves.toMatchObject({
      ok: false,
      code: "delivery_failed",
    });
    expect(deliver).not.toHaveBeenCalled();
    expect(registry.stats().activeCapabilities).toBe(0);
  });

  it("closes every grant, tolerates cleanup failure, and refuses later issuance", async () => {
    let authority: BrowserAgentAuthority | undefined;
    const registry = new BrowserCapabilityRegistry({
      onTerminate: (notice) => authority?.handleTermination(notice),
    });
    authority = new BrowserAgentAuthority(registry, {
      controlHome: "/Users/tester",
      makeGrantId: () => "grant-close",
      confirm: async () => true,
      deliver: async () => ({
        cleanup: () => {
          throw new Error("cleanup failure");
        },
      }),
    });
    expect((await authority.issue(SUBJECT, [PAGE()])).ok).toBe(true);
    expect(authority.close()).toBe(1);
    expect(authority.close()).toBe(0);
    expect(authority.list()).toEqual([]);
    await expect(authority.issue(SUBJECT, [PAGE()])).resolves.toMatchObject({
      ok: false,
      code: "closed",
    });
  });
});
