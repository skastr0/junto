/**
 * The shell environment lives where the spawns are. The core's copy writes the
 * environment every harness launch reads, so the window's status, the operator
 * refresh and the change push must come from that copy; main asks by name and
 * relays, and keeps no instance of its own.
 */
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inProcessCore, type CoreRunner } from "./support/in-process-core";
import { useCoreClient } from "../src/main/core-process/main-client";
import "../src/main/core-process/ops/shell-environment";
import { SHELL_ENVIRONMENT_CHANGED } from "../src/main/core-process/channels";
import { publish, subscribe } from "../src/main/core-process/push";
import { shellEnvironment } from "../src/main/junto/shell-environment";
import { registerShellEnvironmentIpc } from "../src/main/junto/shell-environment/ipc";
import { resolvedSpawnEnv } from "../src/main/junto/adapters/exec";
import { CoreCallError } from "../src/main/core-process/client";
import { IPC_CHANNELS } from "../src/shared/ipc";

const STATUS = { _tag: "Applied", generation: 2, shell: "/bin/zsh", variables: [], failures: [] };
const CHANGED = { generation: 2, added: ["FOO"], removed: [], changed: [], pathAdded: [], pathRemoved: [] };

const runtimes: Array<ManagedRuntime.ManagedRuntime<never, never>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const runtime of runtimes.splice(0)) await Effect.runPromise(Effect.promise(() => runtime.dispose()));
});

describe("the shell environment over the core", () => {
  it("asks the core's own copy for a status and a refresh", async () => {
    const runtime = ManagedRuntime.make(Layer.empty);
    runtimes.push(runtime);
    const runner: CoreRunner = { runPromiseExit: (effect) => runtime.runPromiseExit(effect as never) };
    const core = inProcessCore(runner);
    const status = vi.spyOn(shellEnvironment, "status").mockResolvedValue(STATUS as never);
    const refresh = vi.spyOn(shellEnvironment, "refresh").mockResolvedValue(STATUS as never);
    expect(await core.call("ipc.shellEnvironment.status", {})).toEqual(STATUS);
    expect(await core.call("ipc.shellEnvironment.refresh", {})).toEqual(STATUS);
    expect(refresh).toHaveBeenCalledWith("operator");
    const ensure = vi.spyOn(shellEnvironment, "ensure").mockResolvedValue({ PATH: "/bin/zsh" } as never);
    expect(await core.call("ipc.shellEnvironment.env", {})).toEqual({ PATH: "/bin/zsh" });
    expect(ensure).toHaveBeenCalledTimes(1);
  });

  it("reads the env at spawn time, so a refresh reaches the next main-side spawn", async () => {
    let path = "/opt/a/bin";
    useCoreClient({ call: async (name: string) => (name === "ipc.shellEnvironment.env" ? { PATH: path, HOME: "/home/op" } : STATUS) } as never);
    expect((await resolvedSpawnEnv()).PATH).toBe("/opt/a/bin");
    // The operator refreshed; nothing is cached in main.
    path = "/opt/b/bin";
    expect((await resolvedSpawnEnv()).PATH).toBe("/opt/b/bin");
  });

  it("fails the spawn with the core's typed error, never with main's own env", async () => {
    useCoreClient({ call: async (name: string) => { throw new CoreCallError(name, "CoreRestarting", "the core is not answering"); } } as never);
    await expect(resolvedSpawnEnv()).rejects.toBeInstanceOf(CoreCallError);
  });

  it("lets main relay the core's answer and its change push", async () => {
    const handlers = new Map<string, (...args: never[]) => unknown>();
    const ipc = { handle: (channel: string, handler: never) => handlers.set(channel, handler) };
    const calls: string[] = [];
    useCoreClient({ call: async (name: string) => { calls.push(name); return STATUS; } } as never);
    const heard: unknown[] = [];
    const stop = subscribe(SHELL_ENVIRONMENT_CHANGED, (change) => heard.push(change));
    const broadcast = vi.fn();
    const unbind = registerShellEnvironmentIpc(ipc as never, broadcast);
    expect(await handlers.get(IPC_CHANNELS.shellEnvironmentStatus)!()).toEqual(STATUS);
    expect(calls).toEqual(["ipc.shellEnvironment.status"]);
    publish(SHELL_ENVIRONMENT_CHANGED, CHANGED as never);
    expect(broadcast).toHaveBeenCalledWith(IPC_CHANNELS.shellEnvironmentChanged, CHANGED);
    unbind();
    stop();
  });
});
