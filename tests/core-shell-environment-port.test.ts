/**
 * The shell environment lives where the spawns are. The core's copy writes the
 * environment every harness launch reads, so the window's status, the operator
 * refresh and the change push must come from that copy; main forwards the
 * window's shell environment group to the core's
 * (src/contract/core/shell-environment.ts), and keeps no instance of its own.
 */
import { Effect, Exit, Fiber, Layer, ManagedRuntime, Scope, Stream } from "effect";
import { RpcTest } from "effect/rpc";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SHELL_ENVIRONMENT_CHANGED } from "../src/contract/core/channels";
import { ShellEnvironmentCore, ShellEnvironmentRpcs } from "../src/contract/core/shell-environment";
import { ShellEnvironmentHandlers, spawnEnvironment } from "../src/core/ops/shell-environment";
import { CorePushes } from "../src/core/push";
import { shellEnvironment } from "../src/core/shell-environment";
import { deliverPush } from "../src/app/core-process/main-side/core-pushes";
import type { ShellEnvironmentChange, ShellEnvironmentStatus } from "../src/shared/shell-environment";

vi.mock("electron", () => ({ MessageChannelMain: class {} }));
vi.mock("../src/app/runtime", () => ({ AppRuntime: ManagedRuntime.make(Layer.empty) }));

const { ShellEnvironmentWindowHandlers } = await import("../src/app/shell-environment/ipc");
const { ShellEnvironmentWindowRpcs } = await import("../src/contract/window/shell-environment");

const STATUS: ShellEnvironmentStatus = {
  _tag: "Resolved", shell: "/bin/zsh", resolvedAt: 1, durationMs: 2, variableCount: 3, generation: 2, pathAdded: [],
};
const CHANGED: ShellEnvironmentChange = { generation: 2, added: ["FOO"], removed: [], changed: [], pathAdded: [], pathRemoved: [] };

/** The core's handlers on a scope of their own, pushing onto main's bus as the port does, and the group's client on them. */
const served = async () => {
  const scope = await Effect.runPromise(Scope.make());
  const handlers = await Effect.runPromise(
    Layer.buildWithScope(
      ShellEnvironmentHandlers.pipe(
        Layer.provide(Layer.succeed(CorePushes, { publish: (channel, payload) => Effect.sync(() => deliverPush(channel, payload)) })),
      ),
      scope,
    ),
  );
  const client = await Effect.runPromise(
    RpcTest.makeClient(ShellEnvironmentRpcs).pipe(Effect.provideContext(handlers), Effect.provideService(Scope.Scope, scope)),
  );
  return { client, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the shell environment over the core", () => {
  it("asks the core's own copy for a status and a refresh, and resolves a spawn's environment there", async () => {
    const status = vi.spyOn(shellEnvironment, "status").mockResolvedValue(STATUS);
    const refresh = vi.spyOn(shellEnvironment, "refresh").mockResolvedValue(STATUS);
    const { client, close } = await served();
    try {
      expect(await Effect.runPromise(client.ShellEnvironmentStatus())).toEqual(STATUS);
      expect(await Effect.runPromise(client.ShellEnvironmentRefresh())).toEqual(STATUS);
      expect(status).toHaveBeenCalledTimes(1);
      expect(refresh).toHaveBeenCalledWith("operator");
    } finally {
      await close();
    }
    const ensure = vi.spyOn(shellEnvironment, "ensure").mockResolvedValue({ PATH: "/bin/zsh" });
    expect(await Effect.runPromise(spawnEnvironment)).toEqual({ PATH: "/bin/zsh" });
    expect(ensure).toHaveBeenCalledTimes(1);
  });

  it("lets main forward the window's calls to the core and its change push to the window, for as long as the core's server lives", async () => {
    const listeners: Array<(change: ShellEnvironmentChange) => void> = [];
    let stopped = 0;
    vi.spyOn(shellEnvironment, "onChange").mockImplementation((listener) => {
      listeners.push(listener);
      return () => {
        stopped += 1;
        return true;
      };
    });
    const status = vi.spyOn(shellEnvironment, "status").mockResolvedValue(STATUS);
    const { client, close } = await served();
    // Main's handlers of the window's group over that client, and the window's client of them.
    const scope = await Effect.runPromise(Scope.make());
    const main = await Effect.runPromise(
      Layer.buildWithScope(ShellEnvironmentWindowHandlers.pipe(Layer.provide(Layer.succeed(ShellEnvironmentCore, client as never))), scope),
    );
    const page = await Effect.runPromise(
      RpcTest.makeClient(ShellEnvironmentWindowRpcs).pipe(Effect.provideContext(main), Effect.provideService(Scope.Scope, scope)),
    );
    try {
      expect(await Effect.runPromise(page.ShellEnvironmentStatus())).toEqual(STATUS);
      expect(status).toHaveBeenCalledTimes(1);
      // The core's copy changed: its push reaches the window's stream through main.
      expect(listeners).toHaveLength(1);
      const seen: Array<ShellEnvironmentChange> = [];
      const following = Effect.runFork(Stream.runForEach(page.ShellEnvironmentChanges(), (change) => Effect.sync(() => seen.push(change))));
      // The stream subscribes when its request lands: tell the change until it has.
      for (let tries = 0; tries < 200 && seen.length === 0; tries += 1) {
        listeners[0]?.(CHANGED);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(seen[0]).toEqual(CHANGED);
      await Effect.runPromise(Fiber.interrupt(following));
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await close();
    }
    expect(stopped).toBe(1);
  });
});
