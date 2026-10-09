import { Effect, Result, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { detectMachineKeychain } from "../src/main/junto/hosts/machine-keychain";
import { machineHarnessSignIn } from "../src/shared/machine-harness-status";
import { MachineHarness, MachineHarnessSignIn, MachineKeychainStatus } from "../src/shared/machine-control";
import { HARNESS_IDS } from "../src/shared/managed-terminal-templates";

describe("machine keychain metadata", () => {
  it("does not spawn a query on Linux", async () => {
    const run = vi.fn();
    expect(await Effect.runPromise(detectMachineKeychain({ platform: "linux", run }))).toBe("not-applicable");
    expect(run).not.toHaveBeenCalled();
  });

  it("uses only a bounded metadata command and discards its output", async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: "local keychain metadata", stderr: "" }));
    expect(await Effect.runPromise(detectMachineKeychain({ platform: "darwin", run }))).toBe("available");
    expect(run).toHaveBeenCalledExactlyOnceWith("/usr/bin/security", ["show-keychain-info"], {
      timeoutMs: 2_000, maxOutputBytes: 8_192,
    });
  });

  it.each([36, 1, null])("reports an unavailable context after exit %s", async code => {
    const run = vi.fn(async () => ({ code, stdout: "", stderr: "local diagnostic" }));
    expect(await Effect.runPromise(detectMachineKeychain({ platform: "darwin", run }))).toBe("unavailable");
  });

  it("degrades a bounded timeout or refused spawn to unavailable", async () => {
    const run = vi.fn(async () => { throw new Error("query timed out"); });
    expect(await Effect.runPromise(detectMachineKeychain({ platform: "darwin", run }))).toBe("unavailable");
  });
});

describe("detect-only harness sign-in", () => {
  it.each(["available", "unavailable", "not-applicable"] as const)("keeps every missing harness not-installed with keychain %s", keychain => {
    for (const harness of HARNESS_IDS) expect(machineHarnessSignIn(harness, false, keychain)).toBe("not-installed");
  });

  it.each(HARNESS_IDS)("does not infer a valid sign-in for installed %s", harness => {
    expect(machineHarnessSignIn(harness, true, "available")).toBe("sign-in-unverified");
    expect(machineHarnessSignIn(harness, true, "not-applicable")).toBe("sign-in-unverified");
  });

  it("identifies only the unavailable keychain login route", () => {
    for (const harness of HARNESS_IDS) {
      expect(machineHarnessSignIn(harness, true, "unavailable")).toBe(
        harness === "claude" || harness === "codex" ? "keychain-login-unavailable" : "sign-in-unverified",
      );
    }
  });

  it("refuses authentication claims and contradictory install state at the boundary", () => {
    for (const claim of ["signed-in", "signed-out", "unknown"]) {
      expect(Result.isFailure(Schema.decodeUnknownResult(MachineHarnessSignIn)(claim))).toBe(true);
    }
    expect(Result.isFailure(Schema.decodeUnknownResult(MachineKeychainStatus)("unknown"))).toBe(true);
    for (const row of [
      { harness: "claude", installed: false, signIn: "sign-in-unverified" },
      { harness: "codex", installed: true, signIn: "not-installed" },
    ]) expect(Result.isFailure(Schema.decodeUnknownResult(MachineHarness)(row))).toBe(true);
  });
});
