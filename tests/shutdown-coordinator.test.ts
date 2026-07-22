import { describe, expect, it } from "vitest";
import {
  createShutdownCoordinator,
  type ShutdownCleanReceipt,
  type ShutdownCoordinatorSteps,
} from "../src/main/vellum/shutdown-coordinator";

const deferred = <A>() => {
  let resolve!: (value: A) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<A>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const clean = (): ShutdownCleanReceipt => ({ clean: true });

const steps = (overrides: Partial<ShutdownCoordinatorSteps> = {}): ShutdownCoordinatorSteps => ({
  cutAdmission: () => undefined,
  drainDocument: () => ({ clean: true, durable: true, authoringCommitted: true }),
  finalizeRenderer: () => ({ clean: true, finalized: true }),
  drainLocalResources: () => ({ terminals: clean(), chat: clean() }),
  destroyRenderer: () => undefined,
  detachRuntimeIngress: () => undefined,
  disposeRuntime: clean,
  ...overrides,
});

describe("shutdown coordinator", () => {
  it("cuts admission synchronously, shares one generation, and records signal force intent", async () => {
    let cut = 0;
    const document = deferred<{ clean: boolean; durable: boolean; authoringCommitted: boolean }>();
    const coordinator = createShutdownCoordinator(steps({
      cutAdmission: () => { cut += 1; },
      drainDocument: () => document.promise,
    }));
    const first = coordinator.request("normal");
    expect(cut).toBe(1);
    expect(coordinator.snapshot()).toMatchObject({ admissionClosed: true, generation: 1 });
    const joined = coordinator.request("signal");
    expect(joined).toBe(first);
    expect(coordinator.snapshot()).toMatchObject({ forceRequested: true, generation: 1 });
    document.resolve({ clean: true, durable: true, authoringCommitted: true });
    await expect(first.safeToForce).resolves.toMatchObject({ safeToForce: true, generation: 1 });
    await expect(first.complete).resolves.toMatchObject({ complete: true, generation: 1 });
  });

  it("does not authorize force or disposal after an unclean pre-safe receipt, then retries without another cut", async () => {
    let documentCalls = 0;
    let cut = 0;
    let disposed = 0;
    const coordinator = createShutdownCoordinator(steps({
      cutAdmission: () => { cut += 1; },
      drainDocument: () => {
        documentCalls += 1;
        return documentCalls === 1
          ? { clean: false, durable: false, authoringCommitted: false }
          : { clean: true, durable: true, authoringCommitted: true };
      },
      disposeRuntime: () => { disposed += 1; return clean(); },
    }));
    const transaction = coordinator.request("direct");
    await expect(transaction.safeToForce).resolves.toMatchObject({ safeToForce: false, attempt: 1 });
    await expect(transaction.complete).resolves.toMatchObject({ complete: false, attempt: 1 });
    expect(disposed).toBe(0);
    expect(coordinator.snapshot()).toMatchObject({ admissionClosed: true, phase: "retryable" });
    transaction.retry();
    await expect(transaction.safeToForce).resolves.toMatchObject({ safeToForce: true, attempt: 2, generation: 1 });
    await expect(transaction.complete).resolves.toMatchObject({ complete: true, attempt: 2, generation: 1 });
    expect(cut).toBe(1);
    expect(disposed).toBe(1);
  });

  it("waits for every local resource and preserves named rejected causes", async () => {
    const resource = deferred<ShutdownCleanReceipt>();
    const failure = new Error("terminal retained");
    const coordinator = createShutdownCoordinator(steps({
      drainLocalResources: () => ({ terminal: resource.promise, chat: Promise.reject(failure) }),
    }));
    const transaction = coordinator.request("relaunch");
    let settled = false;
    void transaction.safeToForce.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    resource.resolve(clean());
    const receipt = await transaction.safeToForce;
    expect(receipt).toMatchObject({ safeToForce: false });
    expect(receipt.receipts).toContainEqual(expect.objectContaining({ name: "resource:chat", clean: false }));
    expect(receipt.receipts.find((entry) => entry.name === "resource:chat")?.cause?.error).toBe(failure);
  });

  it("contains synchronous throws and never runs later stages", async () => {
    let finalized = 0;
    const coordinator = createShutdownCoordinator(steps({
      drainDocument: () => { throw new Error("disk unavailable"); },
      finalizeRenderer: () => { finalized += 1; return { clean: true, finalized: true }; },
    }));
    const receipt = await coordinator.request("normal").complete;
    expect(receipt).toMatchObject({ complete: false, safeToForce: false });
    expect(receipt.receipts[0]).toMatchObject({ name: "document", clean: false });
    expect(finalized).toBe(0);
  });

  it("does not let a stale completion from a failed attempt satisfy a retry", async () => {
    const first = deferred<{ clean: boolean; durable: boolean; authoringCommitted: boolean }>();
    let calls = 0;
    const coordinator = createShutdownCoordinator(steps({
      drainDocument: () => {
        calls += 1;
        return calls === 1
          ? first.promise
          : { clean: true, durable: true, authoringCommitted: true };
      },
    }));
    const transaction = coordinator.request("normal");
    first.resolve({ clean: false, durable: false, authoringCommitted: false });
    await expect(transaction.complete).resolves.toMatchObject({ complete: false, attempt: 1 });
    transaction.retry();
    await expect(transaction.complete).resolves.toMatchObject({ complete: true, attempt: 2 });
    expect(coordinator.snapshot()).toMatchObject({ attempt: 2, complete: true });
  });

  it("does not retry irreversible teardown when disposal is unclean", async () => {
    let destroys = 0;
    let disposals = 0;
    const coordinator = createShutdownCoordinator(steps({
      destroyRenderer: () => { destroys += 1; },
      disposeRuntime: () => { disposals += 1; return { clean: false }; },
    }));
    const transaction = coordinator.request("signal");
    await expect(transaction.safeToForce).resolves.toMatchObject({ safeToForce: true });
    await expect(transaction.complete).resolves.toMatchObject({ complete: false });
    transaction.retry();
    await Promise.resolve();
    expect(destroys).toBe(1);
    expect(disposals).toBe(1);
    expect(coordinator.snapshot()).toMatchObject({ phase: "safe-to-force", safeToForce: true });
  });

  it("publishes its generation before a synchronous admission cut can re-enter", async () => {
    let coordinator!: ReturnType<typeof createShutdownCoordinator>;
    let joined: ReturnType<typeof coordinator.request> | undefined;
    coordinator = createShutdownCoordinator(steps({
      cutAdmission: () => { joined = coordinator.request("signal"); },
    }));
    const first = coordinator.request("normal");
    expect(joined).toBe(first);
    await expect(first.complete).resolves.toMatchObject({ complete: true, generation: 1 });
  });
});
