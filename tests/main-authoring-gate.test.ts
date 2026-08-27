import { describe, expect, it } from "vitest";
import {
  ProductLicenseAuthoringRefused,
  productLicenseAdmission,
} from "../src/main/vellum/license/admission";
import {
  MainAuthoringRefused,
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
  it("retains the exact admitted promise until it settles", async () => {
    const gate = createMainAuthoringGate();
    const pending = deferred<string>();
    const admitted = gate.run("ipc.canvas.write", () => pending.promise);

    expect(admitted).toBe(pending.promise);
    expect(gate.snapshot()).toMatchObject({
      phase: "open",
      activeLabels: ["ipc.canvas.write"],
    });

    pending.resolve("durable");
    await expect(admitted).resolves.toBe("durable");
    expect(gate.snapshot().activeLabels).toEqual([]);
  });

  it("keeps the renderer flush admitted while ordinary authoring closes", async () => {
    const gate = createMainAuthoringGate();
    gate.beginFinalFlush();
    expect(gate.snapshot().phase).toBe("final-flush");

    await expect(gate.run("ipc.canvas.write", async () => "draft")).resolves.toBe("draft");
    await expect(gate.run("ipc.canvas.create", async () => "recovery")).resolves.toBe(
      "recovery",
    );

    let invoked = false;
    await expect(
      gate.run("ipc.work.task-create", async () => {
        invoked = true;
        return undefined;
      }),
    ).rejects.toMatchObject({
      _tag: "MainAuthoringRefused",
      code: "main_authoring_closed",
      phase: "final-flush",
      label: "ipc.work.task-create",
    });
    expect(invoked).toBe(false);
  });

  it("admits the renderer flush under license maintenance", async () => {
    productLicenseAdmission.admit("development", "maintenance");
    try {
      const gate = createMainAuthoringGate();

      // Maintenance keeps the canvas readable and refuses authorial mutations.
      await expect(gate.run("ipc.canvas.write", async () => "edit")).rejects.toBeInstanceOf(
        ProductLicenseAuthoringRefused,
      );

      // The quit flush is exempt: refusing it would answer the renderer
      // ok:false and block quit forever on an expired entitlement.
      gate.beginFinalFlush();
      await expect(gate.run("ipc.canvas.write", async () => "draft")).resolves.toBe("draft");
      await expect(gate.run("ipc.canvas.create", async () => "recovery")).resolves.toBe(
        "recovery",
      );
    } finally {
      productLicenseAdmission.revoke();
    }
  });

  it("refuses every authorial label once closed", async () => {
    const gate = createMainAuthoringGate();
    gate.close();

    for (const label of [
      "ipc.canvas.write",
      "ipc.canvas.create",
      "kernel.flag-mirror",
      "control.work.msg-send",
    ] as const) {
      await expect(gate.run(label, async () => undefined)).rejects.toBeInstanceOf(
        MainAuthoringRefused,
      );
    }
    expect(gate.snapshot().phase).toBe("closed");
  });

  it("treats both close transitions as idempotent so a second quit attempt works", async () => {
    const gate = createMainAuthoringGate();
    gate.beginFinalFlush();
    gate.beginFinalFlush();
    expect(gate.snapshot().phase).toBe("final-flush");
    await expect(gate.run("ipc.canvas.write", async () => "retry")).resolves.toBe("retry");

    gate.close();
    gate.close();
    expect(gate.snapshot().phase).toBe("closed");
    // A closed gate never falls back to the wider final-flush admission.
    gate.beginFinalFlush();
    expect(gate.snapshot().phase).toBe("closed");
  });

  it("drains in-flight work and reports it honestly", async () => {
    const gate = createMainAuthoringGate();
    const write = deferred<void>();
    const stamp = deferred<void>();
    void gate.run("ipc.canvas.write", () => write.promise);
    const rejected = gate.run("delivery.message-stamp", () => stamp.promise);
    void rejected.catch(() => undefined);

    gate.beginFinalFlush();
    write.resolve();
    stamp.reject(new Error("disk full"));

    // A rejected operation is settled work, not retained work.
    await expect(gate.drain(1_000)).resolves.toEqual({
      settled: 2,
      remaining: [],
      timedOut: false,
    });
  });

  it("honors the drain deadline instead of waiting forever", async () => {
    const gate = createMainAuthoringGate();
    const stuck = deferred<void>();
    void gate.run("ipc.canvas.portfolio", () => stuck.promise);
    gate.beginFinalFlush();

    const started = Date.now();
    const report = await gate.drain(20);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(report).toEqual({
      settled: 0,
      remaining: ["ipc.canvas.portfolio"],
      timedOut: true,
    });

    stuck.resolve();
    await expect(gate.drain(1_000)).resolves.toEqual({
      settled: 1,
      remaining: [],
      timedOut: false,
    });
  });

  it("sees work admitted by a task that re-enters the gate synchronously", async () => {
    const gate = createMainAuthoringGate();
    const pending = deferred<string>();
    const admitted = gate.run("ipc.canvas.write", () => {
      // A factory may drive quit preparation before it returns its promise.
      expect(gate.snapshot().activeLabels).toEqual(["ipc.canvas.write"]);
      gate.beginFinalFlush();
      return pending.promise;
    });

    const drain = gate.drain(1_000);
    pending.resolve("late");
    await expect(admitted).resolves.toBe("late");
    await expect(drain).resolves.toEqual({
      settled: 1,
      remaining: [],
      timedOut: false,
    });
  });
});

describe("work-control main authoring classification", () => {
  it("classifies every wire operation explicitly", () => {
    const expected = {
      ping: "read",
      doctor: "read",
      capabilities: "read",
      onboard: "read",
      preamble: "read",
      "tasks.list": "read",
      "tasks.create": "authorial",
      "tasks.claim": "authorial",
      "tasks.update": "authorial",
      "tasks.show": "read",
      "tasks.claims": "read",
      rulings: "read",
      "tasks.board": "authorial",
      "content.path": "read",
      "content.stat": "read",
      "content.materialize": "read",
      "msg.list": "authorial",
      "msg.send": "authorial",
      "msg.read": "authorial",
      "msg.reply": "authorial",
      "msg.react": "authorial",
      "request.escalate": "authorial",
      "artifact.publish": "authorial",
      "board.list": "read",
      "board.tags": "read",
      "board.create_topic": "authorial",
      "board.post": "authorial",
      "board.mark_read": "authorial",
      "pad.read": "read",
      "sheet.read": "read",
      "pad.patch": "authorial",
      "relay.trigger": "authorial",
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
    expect(mainAuthoringLabelForWorkOperation("msg.list")).toBe("control.work.msg-send");
    expect(mainAuthoringLabelForWorkOperation("msg.send")).toBe("control.work.msg-send");
    expect(mainAuthoringLabelForWorkOperation("msg.read")).toBe("control.work.msg-send");
    expect(mainAuthoringLabelForWorkOperation("request.escalate")).toBe(
      "control.work.request-escalate",
    );
    expect(mainAuthoringLabelForWorkOperation("artifact.publish")).toBe(
      "control.work.artifact-publish",
    );
  });
});
