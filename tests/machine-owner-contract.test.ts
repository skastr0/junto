import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { OPERATOR_COMPANION_OPS, OPERATOR_PROTOCOL_VERSION, decodeOperatorRequest, decodeOperatorResponse } from "../src/shared/operator-control";
import { MachineHarnesses, MachineOwnStatus, MachinePeerStatus } from "../src/shared/machine-control";

const frame = (op: string, args: unknown) => ({ protocol: OPERATOR_PROTOCOL_VERSION, id: "machine-test", op, args });
describe("closed machine owner contract", () => {
  it("accepts the 3363 own-status shape without inventing keychain state", () => {
    const status = { build: "a".repeat(64), form: "mac-mini", installationId: "install-one", machineName: "mini", juntoHome: "/home/operator/junto", pid: 71, ready: true };
    const decode = Schema.decodeUnknownSync(MachineOwnStatus, { onExcessProperty: "error" });
    expect(decode(status)).toEqual(status);
    expect(decode(status).keychain).toBeUndefined();
    expect(Result.isSuccess(decodeOperatorResponse({ protocol: OPERATOR_PROTOCOL_VERSION, id: "machine-test", op: "machine.status", ok: true, data: status }))).toBe(true);
    for (const field of Object.keys(status)) {
      const missing = { ...status };
      delete missing[field as keyof typeof missing];
      expect(() => decode(missing)).toThrow();
    }
  });

  it("accepts older link and window harness status with unknown sign-in state", () => {
    const harnesses = { machineName: "mini", reachable: true, harnesses: [{ harness: "claude", installed: true }, { harness: "codex", installed: false }] };
    const peer = { ...harnesses, form: "mac-mini", installationId: "install-one", missingSecrets: [] };
    expect(Schema.decodeUnknownSync(MachineHarnesses, { onExcessProperty: "error" })(harnesses)).toEqual(harnesses);
    expect(Schema.decodeUnknownSync(MachinePeerStatus, { onExcessProperty: "error" })(peer)).toEqual(peer);
    for (const [op, data] of [["machine.status", peer], ["machine.harnesses", harnesses]]) {
      expect(Result.isSuccess(decodeOperatorResponse({ protocol: OPERATOR_PROTOCOL_VERSION, id: "machine-test", op, ok: true, data }))).toBe(true);
    }
  });

  it("admits route selection and rejects extra execution authority", () => {
    const input = { name: "mini", sshTarget: "user@gateway", sshPort: 19049, sshKnownHostsFile: "/home/operator/.ssh/pin", sshHostKeyAlias: "sandbox-one" };
    expect(Result.isSuccess(decodeOperatorRequest(frame("machine.add", input)))).toBe(true);
    for (const args of [{ ...input, command: "arbitrary" }, { ...input, env: { SECRET: "value" } }, { ...input, sshPort: 65536 }, { ...input, sshKnownHostsFile: "/tmp/%h" }, { ...input, name: "local" }]) {
      expect(Result.isFailure(decodeOperatorRequest(frame("machine.add", args)))).toBe(true);
    }
    expect(OPERATOR_COMPANION_OPS.has("machine.add")).toBe(false);
  });

  it("separates own configuration from a peer pin and rejects a shell operation", () => {
    expect(Result.isSuccess(decodeOperatorRequest(frame("machine.configure", { name: "mini" })))).toBe(true);
    expect(Result.isSuccess(decodeOperatorRequest(frame("machine.setup", { machineName: "macbook", installationId: "installation-one" })))).toBe(true);
    expect(Result.isFailure(decodeOperatorRequest(frame("machine.setup", { name: "mini" })))).toBe(true);
    expect(Result.isFailure(decodeOperatorRequest(frame("machine.shell", { command: "anything" })))).toBe(true);
  });

  it("keeps peer status metadata bounded and refuses paths or secret values", () => {
    const status = { machineName: "mini", reachable: true, keychain: "unavailable", harnesses: [{ harness: "codex", installed: true, signIn: "keychain-login-unavailable" }], missingSecrets: ["API_KEY"] };
    const decode = Schema.decodeUnknownResult(MachinePeerStatus, { onExcessProperty: "error" });
    expect(Result.isSuccess(decode(status))).toBe(true);
    for (const extra of [{ juntoHome: "/home/user" }, { pid: 71 }, { secrets: { API_KEY: "value" } }, { keychain: "unknown" }, { harnesses: [{ harness: "codex", installed: true, signIn: "keychain-login-unavailable", binary: "/usr/bin/codex" }] }]) {
      expect(Result.isFailure(decode({ ...status, ...extra }))).toBe(true);
    }
    expect(Result.isFailure(decodeOperatorResponse({ protocol: OPERATOR_PROTOCOL_VERSION, id: "machine-test", op: "machine.status", ok: true, data: { ...status, secretValue: "value" } }))).toBe(true);
  });
});
