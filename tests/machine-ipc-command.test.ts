import { Effect } from "effect";
import { expect, it } from "vitest";
import { dispatchMachineIpcCommand } from "../src/main/junto/hosts/machine-ipc-command";
import { OPERATOR_PROTOCOL_VERSION, type OperatorRequestEnvelope } from "../src/shared/operator-control";
import type { MachineInstallEvent } from "../src/shared/machine-install";
import type { MachineCommandProgress } from "../src/shared/machine-progress";

it("rejects extra command fields and companion calls before dispatch", async () => {
  let calls = 0;
  const actions = { dispatch: () => { calls++; return Effect.die("should not dispatch"); } };
  for (const input of [
    { protocol: OPERATOR_PROTOCOL_VERSION, id: "one", op: "machine.remove", args: { name: "mini", command: "shell" } },
    { protocol: OPERATOR_PROTOCOL_VERSION, id: "one", op: "companion.hello", args: { deviceId: "phone" } },
  ]) expect((await Effect.runPromise(dispatchMachineIpcCommand(actions, input, () => {}))).ok).toBe(false);
  expect(calls).toBe(0);
});

it("correlates bounded strict progress with its command and survives a detached window", async () => {
  const event: MachineInstallEvent = { event: "machine-install", juntoHome: "/home/probe", installRoot: "/home/probe/install", step: "selected" };
  const seen: MachineCommandProgress[] = [];
  let captured: ((event: MachineInstallEvent) => void) | undefined;
  const actions = { dispatch: (request: OperatorRequestEnvelope, observer?: (event: MachineInstallEvent) => void) => Effect.sync(() => {
    captured = observer;
    observer?.({ ...event, secretValue: "refuse" } as MachineInstallEvent);
    for (let i = 0; i < 7; i++) observer?.(event);
    return { protocol: OPERATOR_PROTOCOL_VERSION, id: request.id, op: request.op, ok: false as const,
      error: { type: "io" as const, message: "installed; setup refused", details: { retryable: false } } };
  }) };
  const response = await Effect.runPromise(dispatchMachineIpcCommand(actions, { protocol: OPERATOR_PROTOCOL_VERSION, id: "mini-send", op: "machine.send", args: { name: "mini" } }, progress => { seen.push(progress); throw new Error("window closed"); }));
  expect(response.ok).toBe(false);
  expect(seen).toHaveLength(5);
  expect(seen.every(progress => progress.id === "mini-send")).toBe(true);
  expect(JSON.stringify(seen)).not.toContain("secretValue");
  captured?.(event);
  expect(seen).toHaveLength(5);
});
