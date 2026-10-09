import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { OPERATOR_COMPANION_OPS, OPERATOR_PROTOCOL_VERSION, decodeOperatorRequest, decodeOperatorResponse } from "../src/shared/operator-control";
import { MachinePeerStatus } from "../src/shared/machine-control";

const frame = (op: string, args: unknown) => ({ protocol: OPERATOR_PROTOCOL_VERSION, id: "machine-test", op, args });
describe("closed machine owner contract", () => {
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
