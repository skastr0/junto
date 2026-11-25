/**
 * A core whose socket path no longer names its socket stops (src/node/
 * socket-path-watch.ts). On Darwin the control lease follows the resolved
 * directory only, so a relinked home could start a second core there; the
 * first one notices and stops, and the home ends with one reachable core.
 * Nothing here is Linux only: symlinks, the Darwin flock and the Linux
 * abstract lease all run the same cases.
 */
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireControlListenerLease,
  captureControlSocketPathIdentity,
  controlSocketPathOwnedByLease,
  prepareControlDirectory,
  releaseControlListenerLease,
  removeObservedSocket,
} from "../src/node/control-filesystem";
import { watchSocketPathOwned } from "../src/node/socket-path-watch";
import { machineLinkLayer } from "../src/core/link/live";
import { MachineLink } from "../src/core/link/service";
import { MachineRepository, makeMachineRepositoryLive } from "../src/core/machines/repository";
import { SshTransport } from "../src/core/ssh/service";
import { makeStateEngineLive } from "../src/core/state/engine";
import { InstallationId } from "../src/shared/installation-id";
import { allChannels } from "./support/link-channels";
import { noBoatRoutesLayer } from "./support/no-boat";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const root = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), "junto-path-watch-"));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
};
const eventually = async (check: () => void, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { return check(); } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A listener on `<home>/.junto/operator/control.sock`, watched every 10 ms; counts each time it is lost. */
const watched = async (home: string) => {
  const dir = join(home, ".junto", "operator");
  const path = join(dir, "control.sock");
  prepareControlDirectory(dir);
  const lease = await acquireControlListenerLease(path);
  await removeObservedSocket(lease);
  const server: Server = createServer((socket) => socket.end());
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen({ path }, resolve); });
  const identity = captureControlSocketPathIdentity(lease);
  let lost = 0;
  const stop = watchSocketPathOwned(() => controlSocketPathOwnedByLease(lease, identity), () => { lost += 1; }, 10);
  cleanups.push(async () => {
    stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await releaseControlListenerLease(lease);
  });
  return { lost: () => lost };
};

describe("a core's socket path watch", () => {
  it("says nothing while the path names the listener's socket", async () => {
    const listener = await watched(join(await root(), "far"));
    await pause(80);
    expect(listener.lost()).toBe(0);
  });

  it("says once that the socket is lost when its symlinked home is relinked to a fresh directory", async () => {
    const base = await root();
    mkdirSync(join(base, "real"));
    symlinkSync(join(base, "real"), join(base, "far"));
    const listener = await watched(join(base, "far"));
    rmSync(join(base, "far"), { recursive: true, force: true });
    mkdirSync(join(base, "far"));
    await eventually(() => expect(listener.lost()).toBe(1));
    await pause(50);
    expect(listener.lost()).toBe(1);
  });

  it("says the socket is lost when its home is deleted", async () => {
    const base = await root();
    const listener = await watched(join(base, "far"));
    rmSync(join(base, "far"), { recursive: true, force: true });
    await eventually(() => expect(listener.lost()).toBe(1));
  });

  it("takes a check that throws for no loss, and stops checking once told", async () => {
    let calls = 0;
    let lost = 0;
    const stop = watchSocketPathOwned(() => { calls += 1; throw new Error("EACCES"); }, () => { lost += 1; }, 5);
    await eventually(() => expect(calls).toBeGreaterThan(2));
    stop();
    const seen = calls;
    await pause(30);
    expect({ lost, calls }).toEqual({ lost: 0, calls: seen });
  });
});

describe("the machine link listener", () => {
  it("owns its path until its home is relinked", async () => {
    const base = await root();
    mkdirSync(join(base, "real"));
    symlinkSync(join(base, "real"), join(base, "home"));
    const home = join(base, "home");
    const ssh = SshTransport.of({
      run: () => Effect.die("no one-shot commands"), transfer: () => Effect.die("no transfers"),
      forward: () => Effect.die("no forwards"), warm: () => Effect.void, teardown: () => Effect.void,
      connect: () => Effect.die(new Error("no dials in this test")),
    } as never);
    const runtime = ManagedRuntime.make(Layer.provideMerge(machineLinkLayer("b".repeat(64)), Layer.mergeAll(
      noBoatRoutesLayer, Layer.succeed(SshTransport, ssh),
      Layer.provide(makeMachineRepositoryLive({ defaultName: () => "mini" }), makeStateEngineLive(join(base, "junto.db"))),
    )));
    cleanups.push(() => runtime.dispose());
    const listener = await runtime.runPromise(Effect.gen(function* () {
      yield* (yield* MachineRepository).pinPeer({ machineName: "book", installationId: Schema.decodeUnknownSync(InstallationId)("book-install") });
      const link = yield* MachineLink;
      yield* link.setChannels(allChannels());
      return yield* link.listen(home);
    }));
    cleanups.push(() => listener.close());
    expect(listener.ownsPath()).toBe(true);
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home);
    expect(listener.ownsPath()).toBe(false);
  });
});
