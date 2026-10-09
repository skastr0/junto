import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { expect, it, vi } from "vitest";
import { MachineCoreStatus, machineCoreStatusLayer } from "../src/main/core-runtime";
import { MachineRepository } from "../src/main/junto/machines/repository";
import { InstallationId } from "../src/shared/installation-id";
import { MachineHarnesses, MachineOwnStatus, MachinePeerStatus } from "../src/shared/machine-control";

const probe = vi.hoisted(() => vi.fn());
vi.mock("../src/main/junto/hosts/machine-form", async () => {
  const { Effect } = await import("effect");
  return { detectMachineForm: () => Effect.succeed("mac-mini") };
});
vi.mock("../src/main/junto/hosts/machine-keychain", async () => {
  const { Effect } = await import("effect");
  return { detectMachineKeychain: () => Effect.sync(() => { probe(); return "unavailable"; }) };
});
vi.mock("../src/main/junto/term/templates/harness-install", () => ({
  probeManagedHarnessInstalls: async () => [
    { harness: "claude", installed: true, binary: "local-only-path" },
    { harness: "codex", installed: false, binary: "local-only-path" },
    { harness: "amp", installed: true, binary: "local-only-path" },
  ],
}));

it("reports the same bounded facts to the owner and the linked machine, once per core lifetime", async () => {
  const installationId = Schema.decodeUnknownSync(InstallationId)("status-installation");
  const machines = Layer.succeed(MachineRepository, MachineRepository.of({
    installationId: Effect.succeed(installationId), machineName: Effect.succeed("mini"),
    configuration: Effect.die("unused"), configureName: () => Effect.die("unused"),
    pinPeer: () => Effect.die("unused"), peer: () => Effect.die("unused"),
    peers: Effect.die("unused"), retirePeer: () => Effect.die("unused"),
  }));
  const runtime = ManagedRuntime.make(machineCoreStatusLayer({
    home: "/tmp/status-home", build: "a".repeat(64), bundles: {}, ready: () => true,
  }).pipe(Layer.provide(machines)));
  try {
    const status = await runtime.runPromise(MachineCoreStatus);
    const own = Schema.decodeUnknownSync(MachineOwnStatus)(await runtime.runPromise(status.own));
    expect(own.keychain).toBe("unavailable");
    const harnesses = Schema.decodeUnknownSync(MachineHarnesses)(await runtime.runPromise(status.harnesses));
    expect(harnesses).toEqual({ machineName: "mini", reachable: true, keychain: "unavailable", harnesses: [
      { harness: "claude", installed: true, signIn: "keychain-login-unavailable" },
      { harness: "codex", installed: false, signIn: "not-installed" },
      { harness: "amp", installed: true, signIn: "sign-in-unverified" },
    ] });
    const peer = await runtime.runPromise(status.handler.handleRequest!({
      peer: { machineName: "book", installationId, build: "a".repeat(64) },
      sessionId: "status-session", signal: new AbortController().signal,
      sendEvent: () => Effect.void, request: () => Effect.die("unused"),
    }, status.handler.decodeRequest({ kind: "machine" })));
    expect(Schema.decodeUnknownSync(MachinePeerStatus)(peer)).toEqual({
      ...harnesses, installationId, form: "mac-mini", missingSecrets: [],
    });
    expect(JSON.stringify(peer)).not.toContain("local-only-path");
    expect(peer).not.toHaveProperty("juntoHome");
    expect(peer).not.toHaveProperty("pid");
    expect(probe).toHaveBeenCalledOnce();
  } finally { await runtime.dispose(); }
});
