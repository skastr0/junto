/**
 * The window's one way to a machine: a closed owner command in, an answer
 * decoded before anything reads it. An answer that is not the owner's
 * envelope, or is for another question, is a refusal, never data.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPERATOR_PROTOCOL_VERSION } from "../src/shared/operator-control";
import { machineCommand, onMachineCommandProgress } from "../src/renderer/lib/machine-commands";
import { OTHER_MACHINE } from "./support/machines";

type Sent = { readonly protocol: string; readonly id: string; readonly op: string; readonly args: unknown };

const withMain = (answer: (request: Sent) => unknown) => {
  const machineCommand = vi.fn(async (request: Sent) => answer(request));
  vi.stubGlobal("window", { junto: { machineCommand } });
  return machineCommand;
};

afterEach(() => vi.unstubAllGlobals());

describe("an owner machine command from the window", () => {
  it("goes out as the closed envelope and comes back as data", async () => {
    const main = withMain((request) => ({
      protocol: OPERATOR_PROTOCOL_VERSION, id: request.id, op: request.op, ok: true,
      data: { machineName: OTHER_MACHINE, removed: true },
    }));
    const answer = await machineCommand("machine.remove", { name: OTHER_MACHINE }, "window-1");
    expect(main).toHaveBeenCalledExactlyOnceWith({
      protocol: OPERATOR_PROTOCOL_VERSION, id: "window-1", op: "machine.remove", args: { name: OTHER_MACHINE },
    });
    expect(answer).toEqual({ ok: true, data: { machineName: OTHER_MACHINE, removed: true } });
  });

  it("returns the owner's refusal with its plain reason and how far an install got", async () => {
    withMain((request) => ({
      protocol: OPERATOR_PROTOCOL_VERSION, id: request.id, op: request.op, ok: false,
      error: { type: "io", message: "SSH refused the connection", details: { retryable: false, disposition: "staged", transitions: [{ step: "verified" }] } },
    }));
    expect(await machineCommand("machine.send", { name: OTHER_MACHINE })).toEqual({
      ok: false, type: "io", message: "SSH refused the connection", retryable: false, transitions: [{ step: "verified" }],
      disposition: "staged",
    });
  });

  it("keeps where the owner said a failed install left the machine", async () => {
    for (const disposition of ["staged", "activated", "uncertain"] as const) {
      withMain((request) => ({
        protocol: OPERATOR_PROTOCOL_VERSION, id: request.id, op: request.op, ok: false,
        error: { type: "io", message: "candidate readiness unconfirmed", details: { retryable: false, disposition, transitions: [{ step: "verified" }, { step: "selected" }] } },
      }));
      expect(await machineCommand("machine.update", { name: OTHER_MACHINE })).toMatchObject({
        ok: false, disposition, transitions: [{ step: "verified" }, { step: "selected" }],
      });
    }
  });

  it("keeps the receipt of an install that finished when what came after it failed", async () => {
    const installed = {
      build: "a".repeat(64), juntoHome: "/home/op/.junto", installRoot: "/home/op/.junto-install", directory: "/home/op/.junto-install/builds/a",
      serviceLabel: "com.junto.core", provider: "systemd-user", updated: false, disposition: "ready",
      installationId: "inst-atlas", machineName: OTHER_MACHINE, pid: 77, transitions: [{ step: "verified" }, { step: "ready" }],
    };
    withMain((request) => ({
      protocol: OPERATOR_PROTOCOL_VERSION, id: request.id, op: request.op, ok: false,
      error: { type: "io", message: "the machine did not answer its setup", details: { retryable: false, installed } },
    }));
    const answer = await machineCommand("machine.send", { name: OTHER_MACHINE });
    expect(answer).toMatchObject({ ok: false, message: "the machine did not answer its setup", installed });
    expect(answer).not.toHaveProperty("disposition");
  });

  it("takes nothing from a refusal meant for another command", async () => {
    // It says the machine was left as it was and that asking again is safe.
    // It is not this command's, so none of that is this command's either.
    const foreign = { type: "io", message: "nothing was copied", details: { retryable: true, disposition: "staged", transitions: [{ step: "selected" }] } };
    const taken = { ok: false, type: "protocol_error", message: "Junto answered a different question.", retryable: false, transitions: [] };
    withMain((request) => ({ protocol: OPERATOR_PROTOCOL_VERSION, id: "window-other", op: request.op, ok: false, error: foreign }));
    expect(await machineCommand("machine.send", { name: OTHER_MACHINE }, "window-1")).toEqual(taken);
    withMain((request) => ({ protocol: OPERATOR_PROTOCOL_VERSION, id: request.id, op: "machine.list", ok: false, error: foreign }));
    expect(await machineCommand("machine.send", { name: OTHER_MACHINE }, "window-1")).toEqual(taken);
    // Half a name is not a name.
    withMain((request) => ({ protocol: OPERATOR_PROTOCOL_VERSION, id: request.id, ok: false, error: foreign }));
    expect(await machineCommand("machine.send", { name: OTHER_MACHINE }, "window-1")).toEqual(taken);
  });

  it("shows the reason of a refusal that names no command, and takes no fact from it", async () => {
    // Main refuses this way before it has read the command.
    withMain(() => ({
      protocol: OPERATOR_PROTOCOL_VERSION, ok: false,
      error: { type: "runtime_down", message: "Machine control is not ready", details: { retryable: true, disposition: "staged", transitions: [{ step: "ready" }] } },
    }));
    expect(await machineCommand("machine.send", { name: OTHER_MACHINE })).toEqual({
      ok: false, type: "runtime_down", message: "Machine control is not ready", retryable: false, transitions: [],
    });
  });

  it("refuses an answer that is not the owner's envelope", async () => {
    withMain((request) => ({ id: request.id, op: request.op, ok: true, data: { machineName: OTHER_MACHINE, removed: true } }));
    expect(await machineCommand("machine.remove", { name: OTHER_MACHINE })).toMatchObject({ ok: false, type: "protocol_error" });
  });

  it("refuses data with anything riding along", async () => {
    withMain((request) => ({
      protocol: OPERATOR_PROTOCOL_VERSION, id: request.id, op: request.op, ok: true,
      data: { machineName: OTHER_MACHINE, removed: true, secret: "value" },
    }));
    expect(await machineCommand("machine.remove", { name: OTHER_MACHINE })).toMatchObject({ ok: false, type: "protocol_error" });
  });

  it("refuses an answer to a different question", async () => {
    withMain((request) => ({
      protocol: OPERATOR_PROTOCOL_VERSION, id: "window-other", op: request.op, ok: true,
      data: { machineName: OTHER_MACHINE, removed: true },
    }));
    expect(await machineCommand("machine.remove", { name: OTHER_MACHINE }, "window-1")).toMatchObject({
      ok: false, type: "protocol_error", message: "Junto answered a different question.",
    });
  });

  it("is a refusal, not a throw, when main never answers", async () => {
    withMain(() => { throw new Error("junto: backend did not respond"); });
    // A send may have reached the machine: it is not safe to send again unasked.
    expect(await machineCommand("machine.send", { name: OTHER_MACHINE })).toEqual({
      ok: false, type: "unavailable", message: "junto: backend did not respond", retryable: false, transitions: [],
    });
    // A read changed nothing.
    expect(await machineCommand("machine.list", {})).toMatchObject({ ok: false, retryable: true });
  });

  it("says machines are not available when this Junto has no such command", async () => {
    vi.stubGlobal("window", { junto: {} });
    expect(await machineCommand("machine.list", {})).toMatchObject({ ok: false, type: "unavailable" });
  });
});

describe("the steps of a command in flight", () => {
  it("reach the listener decoded, and a payload that is not a step is dropped", () => {
    let push: (payload: unknown) => void = () => {};
    const off = vi.fn();
    vi.stubGlobal("window", { junto: { onMachineProgress: (listener: (payload: unknown) => void) => { push = listener; return off; } } });
    const seen: unknown[] = [];
    const stop = onMachineCommandProgress((progress) => seen.push(progress));
    const step = { id: "window-1", event: { event: "machine-install", juntoHome: "/home/op/.junto", installRoot: "/home/op/i", step: "started" } };
    push(step);
    push({ ...step, env: { TOKEN: "value" } });
    push("started");
    expect(seen).toEqual([step]);
    stop();
    expect(off).toHaveBeenCalledOnce();
  });
});
