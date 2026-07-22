import { describe, expect, it } from "vitest";
import {
  createShutdownCoordinator,
  type ShutdownCleanReceipt,
  type ShutdownCoordinatorSteps,
} from "../src/main/vellum/shutdown-coordinator";

const deferred = <A>() => {
  let resolve!: (value: A) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<A>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const clean = (): ShutdownCleanReceipt => ({ clean: true });
const steps = (overrides: Partial<ShutdownCoordinatorSteps> = {}): ShutdownCoordinatorSteps => ({
  cutAdmission: { main: clean },
  drainDocument: () => ({ clean: true, durable: true, authoringCommitted: true }),
  finalizeRenderer: () => ({ clean: true, finalized: true }),
  drainLocalResources: () => ({ terminals: clean() }),
  destroyRenderer: () => undefined,
  detachRuntimeIngress: () => undefined,
  disposeRuntime: clean,
  ...overrides,
});

describe("shutdown coordinator", () => {
  it("cuts synchronously, publishes stable promises before reentry, and joins signal force", async () => {
    let coordinator!: ReturnType<typeof createShutdownCoordinator>;
    let reentrant: ReturnType<typeof coordinator.request> | undefined;
    coordinator = createShutdownCoordinator(steps({
      cutAdmission: { main: () => { reentrant = coordinator.request("signal"); return clean(); } },
    }));
    const first = coordinator.request("normal");
    expect(reentrant).toBe(first);
    expect(reentrant!.safeToForce).toBe(first.safeToForce);
    expect(reentrant!.complete).toBe(first.complete);
    expect(coordinator.snapshot()).toMatchObject({ admissionClosed: true, forceRequested: true });
    await expect(first.complete).resolves.toMatchObject({ complete: true, intents: ["normal", "signal"] });
  });

  it("records a failed attempt without replacing public promises, then retries the same generation", async () => {
    let calls = 0;
    const coordinator = createShutdownCoordinator(steps({
      drainDocument: () => ++calls === 1
        ? { clean: false, durable: false, authoringCommitted: false }
        : { clean: true, durable: true, authoringCommitted: true },
    }));
    const transaction = coordinator.request("direct");
    const safe = transaction.safeToForce;
    const complete = transaction.complete;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(transaction.snapshot()).toMatchObject({ phase: "retryable", attempt: 1, safeToForce: false });
    transaction.retry();
    expect(transaction.safeToForce).toBe(safe);
    expect(transaction.complete).toBe(complete);
    await expect(complete).resolves.toMatchObject({ generation: 1, attempt: 2, complete: true });
  });

  it("checkpoints renderer destruction when later ingress detachment fails", async () => {
    let destroys = 0;
    let detaches = 0;
    const coordinator = createShutdownCoordinator(steps({
      destroyRenderer: () => { destroys += 1; },
      detachRuntimeIngress: () => { detaches += 1; if (detaches === 1) throw new Error("detach"); },
    }));
    const transaction = coordinator.request("normal");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    transaction.retry();
    await expect(transaction.complete).resolves.toMatchObject({ complete: true, attempt: 2 });
    expect(destroys).toBe(1);
    expect(detaches).toBe(2);
  });

  it("returns a retryable resource failure without awaiting a hung sibling and observes rejection", async () => {
    const hung = deferred<ShutdownCleanReceipt>();
    const failure = new Error("chat retained");
    const coordinator = createShutdownCoordinator(steps({
      drainLocalResources: () => ({ hung: hung.promise, failed: Promise.reject(failure) }),
    }));
    const transaction = coordinator.request("normal");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(transaction.snapshot()).toMatchObject({ phase: "retryable" });
    expect(transaction.snapshot().lastAttempt?.receipts).toContainEqual(expect.objectContaining({ name: "resource:failed", clean: false }));
    hung.resolve(clean());
    transaction.retry();
    // This retry starts a new resource drain; it remains intentionally pending
    // only if its own injected resource does.
  });

  it("keeps late intents in the completion audit receipt", async () => {
    const disposal = deferred<ShutdownCleanReceipt>();
    const coordinator = createShutdownCoordinator(steps({ disposeRuntime: () => disposal.promise }));
    const transaction = coordinator.request("normal");
    await transaction.safeToForce;
    coordinator.request("signal");
    disposal.resolve(clean());
    await expect(transaction.complete).resolves.toMatchObject({ complete: true, intents: ["normal", "signal"] });
  });

  it("snapshots nested mutable receipts", async () => {
    const source = deferred<{ clean: boolean; durable: boolean; authoringCommitted: boolean; nested: { value: number } }>();
    const receipt = { clean: true, durable: true, authoringCommitted: true, nested: { value: 1 } };
    const coordinator = createShutdownCoordinator(steps({ drainDocument: () => source.promise }));
    const transaction = coordinator.request("normal");
    source.resolve(receipt);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    receipt.nested.value = 2;
    const completed = await transaction.complete;
    const document = completed.receipts.find((entry) => entry.name === "document")?.receipt as { nested: { value: number } };
    expect(document.nested.value).toBe(1);
    expect(Object.isFrozen(document.nested)).toBe(true);
  });

  it("makes partial, throwing, malformed, and thenable cuts terminal", async () => {
    const malformed = { get clean(): boolean { throw new Error("getter"); } };
    const thenable = { clean: true, then: () => undefined };
    for (const cutAdmission of [
      { one: clean, two: () => ({ clean: false }) },
      { bad: () => { throw new Error("cut"); } },
      { bad: () => malformed },
      { bad: () => thenable },
    ] as ReadonlyArray<ShutdownCoordinatorSteps["cutAdmission"]>) {
      const transaction = createShutdownCoordinator(steps({ cutAdmission })).request("normal");
      await expect(transaction.complete).resolves.toMatchObject({ complete: false, safeToForce: false });
      transaction.retry();
      expect(transaction.snapshot()).toMatchObject({ attempt: 0, phase: "complete" });
    }
  });
});
