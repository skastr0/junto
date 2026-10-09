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
