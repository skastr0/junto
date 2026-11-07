import { PassThrough } from "node:stream";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { expect, it, vi } from "vitest";
import { MachineCoreStatus, machineCoreStatusLayer } from "../src/core/core-runtime";
import { linkClient } from "../src/core/link/contract";
import { LinkHelloSchema } from "../src/core/link/protocol";
import { MachineLink } from "../src/core/link/service";
import { makeLinkSession } from "../src/core/link/session";
import { StatusLink, makeStatusChannel } from "../src/core/link/status";
import type { LinkChannelBinding } from "../src/core/link/types";
import { MachineRepository } from "../src/core/machines/repository";
import { ModelRecords } from "../src/core/model/records";
import { InstallationId } from "../src/shared/installation-id";
import { MachineHarnesses, MachineOwnStatus } from "../src/shared/machine-control";
import { makeTestLog } from "./support/test-log";

const testLog = makeTestLog();

const probe = vi.hoisted(() => vi.fn());
vi.mock("../src/core/hosts/machine-form", async () => {
  const { Effect } = await import("effect");
  return { detectMachineForm: () => Effect.succeed("mac-mini") };
});
vi.mock("../src/core/hosts/machine-keychain", async () => {
  const { Effect } = await import("effect");
  return { detectMachineKeychain: () => Effect.sync(() => { probe(); return "unavailable"; }) };
});
vi.mock("../src/core/term/templates/harness-install", () => ({
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
    home: "/tmp/status-home", build: "a".repeat(64), bundles: {}, ready: () => true, log: testLog.log,
  }).pipe(Layer.provideMerge(testLog.log.loggerLayer), Layer.provide(machines), Layer.provide(Layer.succeed(ModelRecords, {
    listCanvases: () => Effect.succeed([]),
  } as unknown as ModelRecords["Service"]))));
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
    // "book" asks this machine ("mini") over a real session pair, with the channel's typed client.
    const hello = (machineName: string, id: string) => Schema.decodeUnknownSync(LinkHelloSchema)({ build: "a".repeat(64), installationId: id, machineName });
    const ab = new PassThrough(); const ba = new PassThrough();
    const run = <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect);
    const asking: LinkChannelBinding = makeStatusChannel({ machine: Effect.die("the asking end answers nothing"), logs: () => Effect.die("the asking end answers nothing") });
    const book = makeLinkSession({ readable: ba, writable: ab, self: hello("book", installationId), admit: async () => {}, channels: { status: asking }, run });
    const mini = makeLinkSession({ readable: ab, writable: ba, self: hello("mini", "mini-installation"), admit: async () => {}, channels: { status: status.handler }, run });
    const unused = Effect.die("unused");
    const link = MachineLink.of({
      setChannels: () => unused, listen: () => unused, connect: () => unused, connectSetup: () => unused, disconnect: () => unused, peerBuild: () => unused,
      request: (_machine, channel, payload, options) => Effect.promise(() => book.request(channel, payload, options?.operationId, options?.tag)),
      sendEvent: () => unused,
    });
    const ask = <A>(use: (client: Effect.Success<ReturnType<typeof linkClient<typeof StatusLink>>>) => Effect.Effect<A, unknown>) =>
      runtime.runPromise(Effect.flatMap(linkClient(StatusLink), use).pipe(Effect.provideService(MachineLink, link)));
    const peer = await ask((client) => client.Machine("mini"));
    expect(peer).toEqual({
      ...harnesses, installationId, form: "mac-mini", missingSecrets: [],
    });
    expect(JSON.stringify(peer)).not.toContain("local-only-path");
    expect(peer).not.toHaveProperty("juntoHome");
    expect(peer).not.toHaveProperty("pid");
    expect(probe).toHaveBeenCalledOnce();
    // The same channel answers this machine's log, scoped to the asking peer.
    expect(await ask((client) => client.Logs("mini", { query: { level: "error" } }))).toEqual({ machine: "mini", rows: [], cut: false, unreadable: 0 });
    // A query outside the contract never leaves the asking end.
    await expect(ask((client) => client.Logs("mini", { query: { level: "loud" as "error" } }))).rejects.toThrow("does not match its schema");
    await Promise.all([book.close(), mini.close()]);
  } finally { await runtime.dispose(); }
});
