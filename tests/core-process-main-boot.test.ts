import { MessageChannel, type MessagePort } from "node:worker_threads";
import { Context, Effect, Exit, Layer, ManagedRuntime, Scope } from "effect";
import { RpcServer } from "effect/rpc";
import { expect, it, vi } from "vitest";
import type { CoreRunner } from "./support/in-process-core";
import { CoreLink } from "../src/contract/core/link";
import { portCore, type CorePort } from "../src/contract/core/port";
import { ShellEnvironmentCore, ShellEnvironmentRpcs } from "../src/contract/core/shell-environment";
import { ShellEnvironmentHandlers } from "../src/core/ops/shell-environment";
import { CorePushes } from "../src/core/push";
import { shellEnvironment } from "../src/core/shell-environment";
import { serverProtocol } from "../src/shared/rpc-port";
import type { ShellEnvironmentStatus } from "../src/shared/shell-environment";
import { runHostOp } from "../src/app/core-process/main-side/host-op-bodies";
import { serveCore } from "../src/core/serve";
import { subscribe } from "../src/app/core-process/main-side/core-pushes";
import { AGENT_SIGNAL_CHANGED, WORK_PREAMBLE } from "../src/contract/core/channels";
// The operations the served core answers: entry.ts imports this registry at boot.
import "../src/core/ops/index";

vi.mock("electron", () => ({ utilityProcess: { fork: () => { throw new Error("no utilityProcess in tests"); } } }));
vi.mock("../src/app/runtime", () => ({ AppRuntime: ManagedRuntime.make(Layer.empty) }));

const { startCoreProcessForMain } = await import("../src/app/core-process/main-boot");

const portOf = (port: MessagePort): CorePort => ({
  post: (message) => port.postMessage(message),
  listen: (handler) => {
    const on = (message: Parameters<typeof handler>[0]) => handler(message);
    port.on("message", on);
    return () => port.off("message", on);
  },
});

const BOOT = {
  home: "/home", build: "test", bundlesRoot: "/bundles", operatorCommands: false,
  app: { version: "0.0.0", packaged: false, resourcesPath: "/r", appPath: "/a" },
};

it("hooks main up to a core in its own process: calls go to it, its pushes reach main, its asks are answered", async () => {
  const runtime = ManagedRuntime.make(Layer.empty);
  const { port1, port2 } = new MessageChannel();
  const served = serveCore(portOf(port2), runtime as unknown as CoreRunner);
  let stopped = 0;
  const main = startCoreProcessForMain({
    boot: BOOT,
    pages: () => undefined,
    captureApplicationPage: async () => ({ ok: true, png: new Uint8Array([7]) }),
    clipboard: { readText: () => "", writeText: () => undefined, clear: () => undefined, availableFormats: () => [] },
    start: () => ({ ...portCore(portOf(port1), runHostOp), link: portOf(port1), hostLink: portOf(port1), stop: () => Effect.sync(() => { stopped += 1; }) }),
  });
  const seen: Array<[string, unknown]> = [];
  const offs = ([WORK_PREAMBLE, AGENT_SIGNAL_CHANGED] as const).map((channel) => subscribe(channel, (payload) => seen.push([channel, payload])));
  // The core's RPC server on its end of the port, and main's client on the link main's boot hands on.
  const status: ShellEnvironmentStatus = { _tag: "Inherited" };
  const asked = vi.spyOn(shellEnvironment, "status").mockResolvedValue(status);
  const scope = await Effect.runPromise(Scope.make());
  await Effect.runPromise(Layer.buildWithScope(
    RpcServer.layer(ShellEnvironmentRpcs).pipe(
      Layer.provide(ShellEnvironmentHandlers),
      Layer.provide(Layer.succeed(CorePushes, { publish: () => Effect.void })),
      Layer.provide(Layer.effect(RpcServer.Protocol, serverProtocol(portOf(port2)))),
    ),
    scope,
  ));
  const shell = Context.get(
    await Effect.runPromise(Layer.buildWithScope(ShellEnvironmentCore.layer.pipe(Layer.provide(Layer.succeed(CoreLink, main.link))), scope)),
    ShellEnvironmentCore,
  );
  try {
    // Main's call sites reach the core process through main's clients on the one link.
    expect(await Effect.runPromise(shell.ShellEnvironmentStatus())).toEqual(status);
    expect(asked).toHaveBeenCalledTimes(1);
    // The core's window pushes land on main's bus.
    served.push(WORK_PREAMBLE, { preambleId: "p1" });
    served.push(AGENT_SIGNAL_CHANGED, { signalId: "s1" });
    // What the core asks of Electron is answered by main.
    expect(await served.host.call("window.capturePage", {})).toEqual({ ok: true, png: new Uint8Array([7]) });
    expect(await served.host.call("overseer.pages.state", { owner: "o", sessionId: "s" })).toMatchObject({ ok: false, code: "failed" });
    // The clipboard is a host group now, proven over the host link in host-link-clipboard.test.ts.
    expect(seen).toEqual([[WORK_PREAMBLE, { preambleId: "p1" }], [AGENT_SIGNAL_CHANGED, { signalId: "s1" }]]);
    await Effect.runPromise(main.stop());
    expect(stopped).toBe(1);
    // Stopped, main no longer answers for the core.
    await expect(served.host.call("window.capturePage", {})).rejects.toMatchObject({ tag: "UnknownHostOp" });
  } finally {
    for (const off of offs) off();
    await Effect.runPromise(Scope.close(scope, Exit.void));
    asked.mockRestore();
    port1.close();
    await runtime.dispose();
  }
});
