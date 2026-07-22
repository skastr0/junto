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

  it("binds final authority to the exact sender, request, and write kind", async () => {
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
    expect(mainAuthoringLabelForWorkOperation("artifact.publish")).toBe(
      "control.work.artifact-publish",
    );
  });
});
