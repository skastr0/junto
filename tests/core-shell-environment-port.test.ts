/**
 * The shell environment lives where the spawns are. The core's copy writes the
 * environment every harness launch reads, so the window's status, the operator
 * refresh and the change push must come from that copy; main asks the shell
 * environment group (src/contract/core/shell-environment.ts) and relays, and
 * keeps no instance of its own.
 */
import type { IpcMainInvokeEvent } from "electron";
import { Context, Effect, Exit, Layer, ManagedRuntime, Scope } from "effect";
import { RpcTest } from "effect/rpc";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SHELL_ENVIRONMENT_CHANGED } from "../src/contract/core/channels";
import { ShellEnvironmentCore, ShellEnvironmentRpcs } from "../src/contract/core/shell-environment";
import { ShellEnvironmentHandlers, spawnEnvironment } from "../src/core/ops/shell-environment";
import { CorePushes } from "../src/core/push";
import { shellEnvironment } from "../src/core/shell-environment";
import { deliverPush } from "../src/app/core-process/main-side/core-pushes";
import { IPC_CHANNELS } from "../src/shared/ipc";
import type { ShellEnvironmentChange, ShellEnvironmentStatus } from "../src/shared/shell-environment";

vi.mock("../src/app/runtime", () => ({ AppRuntime: ManagedRuntime.make(Layer.empty) }));

const { registerShellEnvironmentIpc } = await import("../src/app/shell-environment/ipc");

/** A listener as Electron's `ipcMain.handle` takes it. */
type Listener = (event: IpcMainInvokeEvent, ...args: ReadonlyArray<unknown>) => unknown;
/** Electron's event, which the registrar under test never reads. */
const event = {} as IpcMainInvokeEvent;

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

  it("lets main relay the core's answer and its change push, for as long as the core's server lives", async () => {
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
    const handlers = new Map<string, Listener>();
    const ipc = {
      handle: (channel: string, listener: Listener): void => {
        handlers.set(channel, listener);
      },
    };
    const broadcast = vi.fn();
    const unbind = registerShellEnvironmentIpc(ipc, broadcast, Context.make(ShellEnvironmentCore, client));
    try {
      expect(await handlers.get(IPC_CHANNELS.shellEnvironmentStatus)?.(event)).toEqual(STATUS);
      expect(status).toHaveBeenCalledTimes(1);
      // The core's copy changed: its push reaches every window through main.
      expect(listeners).toHaveLength(1);
      listeners[0]?.(CHANGED);
      expect(broadcast).toHaveBeenCalledWith(IPC_CHANNELS.shellEnvironmentChanged, CHANGED);
    } finally {
      unbind();
      await close();
    }
    expect(stopped).toBe(1);
  });
});
