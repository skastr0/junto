import { describe, expect, it } from "vitest";
import {
  MainAuthoringRefused,
  MainAuthoringTransitionError,
  classifyMainAuthoringWorkOperation,
  createMainAuthoringGate,
  mainAuthoringLabelForWorkOperation,
} from "../src/main/vellum/main-authoring-gate";
import type { WorkOpName } from "../src/shared/work-control";

const deferred = <A>() => {
  let resolve!: (value: A) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<A>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe("main authoring gate", () => {
  it("closes admission synchronously and retains the exact admitted promise", async () => {
    const gate = createMainAuthoringGate();
    const pending = deferred<string>();
    const admitted = gate.run("ipc.canvas.write", () => pending.promise);
    expect(admitted).toBe(pending.promise);

    const precommit = gate.beginPrecommit();
    expect(precommit.phase).toBe("precommit-closed");
    expect(precommit.activeLabels).toEqual(["ipc.canvas.write"]);

    let invoked = false;
    const refused = gate.run("ipc.canvas.delete", async () => {
      invoked = true;
      return undefined;
    });
    await expect(refused).rejects.toMatchObject({
      _tag: "MainAuthoringRefused",
      code: "main_authoring_closed",
      epoch: precommit.epoch,
      label: "ipc.canvas.delete",
    });
    expect(invoked).toBe(false);

    const drain = gate.drain(precommit.epoch);
    let drained = false;
    void drain.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    pending.resolve("durable");
    await expect(admitted).resolves.toBe("durable");
    await expect(drain).resolves.toMatchObject({
      clean: true,
      labels: ["ipc.canvas.write"],
      settled: 1,
      fulfilled: 1,
      rejected: 0,
      activeLabels: [],
      epoch: precommit.epoch,
    });
  });

  it("publishes the lifetime before a task can re-enter close and commit", async () => {
    const gate = createMainAuthoringGate();
    const pending = deferred<string>();
    let precommitEpoch = 0;

    const admitted = gate.run("ipc.canvas.write", () => {
      const precommit = gate.beginPrecommit();
      precommitEpoch = precommit.epoch;
      expect(precommit.activeLabels).toEqual(["ipc.canvas.write"]);
      expect(gate.snapshot().activeLabels).toEqual(["ipc.canvas.write"]);
      expect(() => gate.commit(precommit.epoch)).toThrowError(
        expect.objectContaining<Partial<MainAuthoringTransitionError>>({
          code: "active_operations",
        }),
      );
      return pending.promise;
    });

    expect(precommitEpoch).toBe(1);
    pending.resolve("done");
    await expect(admitted).resolves.toBe("done");
    await expect(gate.drain(precommitEpoch)).resolves.toMatchObject({
      clean: true,
      labels: ["ipc.canvas.write"],
    });
    expect(gate.commit(precommitEpoch).phase).toBe("committed-closed");
  });

  it("does not let a settlement continuation outrun its drain receipt", async () => {
    const gate = createMainAuthoringGate();
    const pending = deferred<void>();
    const admitted = gate.run("ipc.canvas.delete", () => pending.promise);
    const precommit = gate.beginPrecommit();
    const sibling = admitted.then(() => {
      expect(gate.snapshot().activeLabels).toEqual([]);
      expect(() => gate.recover(precommit.epoch)).toThrowError(
        expect.objectContaining<Partial<MainAuthoringTransitionError>>({
          code: "drain_required",
        }),
      );
    });
    const drain = gate.drain(precommit.epoch);

    pending.resolve();
    await sibling;
    await expect(drain).resolves.toMatchObject({ clean: true, settled: 1 });
    expect(gate.recover(precommit.epoch).phase).toBe("open");
  });

  it("does not reuse a completed drain while its cleanup microtask is pending", async () => {
    const gate = createMainAuthoringGate();
    const precommit = gate.beginPrecommit();
    const firstDrain = gate.drain(precommit.epoch);
    const binding = { senderId: 55, requestId: "flush-after-drain" } as const;
    const pending = deferred<string>();
    let secondDrain: Promise<Awaited<typeof firstDrain>> | undefined;

    // The empty drain continuation runs first and completes its receipt. This
    // queued microtask then admits new work before the old flight's `.then`
    // cleanup has had a chance to remove its published entry.
    await new Promise<void>((resolve) => {
      queueMicrotask(() => {
        gate.mintFinalWritePermit(precommit.epoch, binding);
        void gate.runFinalWrite(
          binding,
          "canvas.write",
          "ipc.canvas.write",
          () => pending.promise,
        );
        secondDrain = gate.drain(precommit.epoch);
        gate.revokeFinalWritePermit(precommit.epoch, binding);
        resolve();
      });
    });

    expect(secondDrain).toBeDefined();
    expect(secondDrain).not.toBe(firstDrain);
    await expect(firstDrain).resolves.toMatchObject({ clean: true, settled: 0 });
    pending.resolve("saved");
    await expect(secondDrain!).resolves.toMatchObject({
      clean: true,
      labels: ["ipc.canvas.write"],
      settled: 1,
    });
  });

  it("uses allSettled fixed-point drainage, including a fast permit write between rounds", async () => {
    const gate = createMainAuthoringGate();
    const initial = deferred<void>();
    const admitted = gate.run("ipc.canvas.portfolio", () => initial.promise);
    const precommit = gate.beginPrecommit();
    const binding = { senderId: 41, requestId: "flush-1" } as const;
    gate.mintFinalWritePermit(precommit.epoch, binding);

    let finalWrite: Promise<string> | undefined;
    void admitted.then(() => {
      finalWrite = gate.runFinalWrite(
        binding,
        "canvas.write",
        "ipc.canvas.write",
        () => Promise.resolve("saved"),
      );
    });

    const drain = gate.drain(precommit.epoch);
    initial.resolve();
    const receipt = await drain;
    await expect(finalWrite).resolves.toBe("saved");
    expect(receipt).toMatchObject({
      labels: ["ipc.canvas.portfolio", "ipc.canvas.write"],
      settled: 2,
      fulfilled: 2,
      rejected: 0,
      rounds: 2,
      activeLabels: [],
      finalPermitsActive: 1,
      clean: false,
    });

    gate.revokeFinalWritePermit(precommit.epoch, binding);
    await expect(gate.drain(precommit.epoch)).resolves.toMatchObject({
      clean: true,
      labels: [],
      finalPermitsActive: 0,
    });
    expect(() => gate.recover(precommit.epoch)).toThrowError(
      expect.objectContaining<Partial<MainAuthoringTransitionError>>({
        code: "final_permit_used",
      }),
    );
  });

  it("settles rejected writes without losing their receipt", async () => {
    const gate = createMainAuthoringGate();
    const failure = new Error("disk full");
    const operation = gate.run("delivery.message-stamp", () => Promise.reject(failure));
    void operation.catch(() => undefined);
    const precommit = gate.beginPrecommit();
    await expect(gate.drain(precommit.epoch)).resolves.toMatchObject({
      clean: true,
      labels: ["delivery.message-stamp"],
      settled: 1,
      fulfilled: 0,
      rejected: 1,
    });
    await expect(operation).rejects.toBe(failure);
  });

  it("recovers only a drained precommit with no active or used final authority", async () => {
    const gate = createMainAuthoringGate();
    const pending = deferred<void>();
    void gate.run("ipc.canvas.create", () => pending.promise);
    const precommit = gate.beginPrecommit();

    expect(() => gate.recover(precommit.epoch)).toThrowError(
      expect.objectContaining<Partial<MainAuthoringTransitionError>>({
        code: "active_operations",
      }),
    );
    pending.resolve();
    await gate.drain(precommit.epoch);

    const binding = { senderId: 9, requestId: "unused-final" } as const;
    gate.mintFinalWritePermit(precommit.epoch, binding);
    expect(() => gate.recover(precommit.epoch)).toThrowError(
      expect.objectContaining<Partial<MainAuthoringTransitionError>>({
        code: "final_permit_active",
      }),
    );
    gate.revokeFinalWritePermit(precommit.epoch, binding);
    await gate.drain(precommit.epoch);
    expect(gate.recover(precommit.epoch)).toMatchObject({
      epoch: precommit.epoch,
      phase: "open",
    });

    await expect(gate.run("ipc.canvas.create", async () => "open again")).resolves.toBe(
      "open again",
    );
  });

  it("commits an already-closed drained epoch irreversibly", async () => {
    const gate = createMainAuthoringGate();
    const precommit = gate.beginPrecommit();
    expect(() => gate.commit(precommit.epoch)).toThrowError(
      expect.objectContaining<Partial<MainAuthoringTransitionError>>({
        code: "drain_required",
      }),
    );
    await gate.drain(precommit.epoch);
    expect(gate.commit(precommit.epoch)).toMatchObject({
      epoch: precommit.epoch,
      phase: "committed-closed",
    });
    expect(() => gate.recover(precommit.epoch)).toThrowError(
      expect.objectContaining<Partial<MainAuthoringTransitionError>>({
        code: "already_committed",
      }),
    );
    await expect(gate.run("kernel.flag-mirror", async () => undefined)).rejects.toBeInstanceOf(
      MainAuthoringRefused,
    );
    expect(() => gate.beginPrecommit()).toThrowError(
      expect.objectContaining<Partial<MainAuthoringTransitionError>>({
        code: "already_committed",
      }),
    );
  });

  it("binds reusable final authority to one sender/request until revocation", async () => {
    const gate = createMainAuthoringGate();
    const precommit = gate.beginPrecommit();
    const binding = { senderId: 7, requestId: "flush-exact" } as const;
    gate.mintFinalWritePermit(precommit.epoch, binding);

    await expect(
      gate.runFinalWrite(
        { ...binding, senderId: 8 },
        "canvas.write",
        "ipc.canvas.write",
        async () => "wrong sender",
      ),
    ).rejects.toMatchObject({ code: "invalid_final_permit" });
    await expect(
      gate.runFinalWrite(
        { ...binding, requestId: "other" },
        "canvas.write",
        "ipc.canvas.write",
        async () => "wrong request",
      ),
    ).rejects.toMatchObject({ code: "invalid_final_permit" });
    await expect(
      gate.runFinalWrite(
        { senderId: binding.senderId, requestId: [binding.requestId] } as unknown as typeof binding,
        "canvas.write",
        "ipc.canvas.write",
        async () => "coerced request",
      ),
    ).rejects.toMatchObject({ code: "invalid_final_permit" });
    await expect(
      gate.runFinalWrite(
        binding,
        "canvas.create",
        "ipc.canvas.write",
        async () => "mismatched operation",
      ),
    ).rejects.toMatchObject({ code: "unsupported_final_operation" });
    await expect(
      gate.runFinalWrite(
        binding,
        "canvas.write",
        "ipc.canvas.write",
        async () => "saved",
      ),
    ).resolves.toBe("saved");
    // One flush may need rebase, or create+populate a recovery canvas.
    await expect(
      gate.runFinalWrite(
        binding,
        "canvas.create",
        "ipc.canvas.create",
        async () => "created recovery",
      ),
    ).resolves.toBe("created recovery");
    await expect(
      gate.runFinalWrite(
        binding,
        "canvas.write",
        "ipc.canvas.write",
        async () => "populated recovery",
      ),
    ).resolves.toBe("populated recovery");

    gate.revokeFinalWritePermit(precommit.epoch, binding);
    await expect(
      gate.runFinalWrite(
        binding,
        "canvas.write",
        "ipc.canvas.write",
        async () => "too late",
      ),
    ).rejects.toMatchObject({ code: "invalid_final_permit" });
  });
});

describe("work-control main authoring classification", () => {
  it("classifies every wire operation explicitly", () => {
    const expected = {
      ping: "read",
      doctor: "read",
      capabilities: "read",
      onboard: "read",
      "tasks.list": "read",
      "tasks.claim": "authorial",
      "tasks.update": "authorial",
      "msg.list": "read",
      "msg.send": "authorial",
      "request.create": "authorial",
      "request.escalate": "authorial",
      "artifact.publish": "authorial",
    } as const satisfies Record<
      WorkOpName,
      ReturnType<typeof classifyMainAuthoringWorkOperation>
    >;

    for (const [operation, classification] of Object.entries(expected)) {
      expect(classifyMainAuthoringWorkOperation(operation as WorkOpName)).toBe(classification);
    }
    expect(mainAuthoringLabelForWorkOperation("ping")).toBeUndefined();
    expect(mainAuthoringLabelForWorkOperation("tasks.claim")).toBe(
      "control.work.tasks-claim",
    );
    expect(mainAuthoringLabelForWorkOperation("tasks.update")).toBe(
      "control.work.tasks-update",
    );
    expect(mainAuthoringLabelForWorkOperation("msg.send")).toBe("control.work.msg-send");
    expect(mainAuthoringLabelForWorkOperation("request.create")).toBe(
      "control.work.request-create",
    );
    expect(mainAuthoringLabelForWorkOperation("request.escalate")).toBe(
      "control.work.request-escalate",
    );
    expect(mainAuthoringLabelForWorkOperation("artifact.publish")).toBe(
      "control.work.artifact-publish",
    );
  });
});
