/**
 * The process plane with the terminal process installed (phase 1): a
 * terminal lease answers at once with no pid, then names it; input and
 * output cross the port; terminate signals the PTY through the terminal
 * process; quit drains it; and a PTY spawned before the switch stays where it
 * started. Real PTYs over a real port.
 */
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { createRequire } from "node:module";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import type { TerminalLink, TerminalLinkMessage } from "../src/contract/terminal/protocol";
import { createAppProcessPlane, type AppTerminalLease } from "../src/node/app-process-plane";
import { CoreLink, PidEpochs, PtySpawner, TerminalServer, type SpawnPty } from "../src/terminal/serve";
import { terminalClient } from "../src/node/terminals/client";
import { placeTerminals } from "../src/node/terminals/use";

const nodePty = createRequire(import.meta.url)("node-pty") as typeof import("node-pty");

/** One end of the link over a node port. This plane opens no surface, so neither end moves a port. */
const linkOf = <P>(port: MessagePort): TerminalLink<P> => ({
  post: (message) => port.postMessage(message),
  transfer: () => {
    throw new Error("the plane test opens no surface");
  },
  listen: (handler) => {
    const on = (message: TerminalLinkMessage) => handler(message, undefined);
    port.on("message", on);
    return () => port.off("message", on);
  },
});

const opened: MessagePort[] = [];
const scopes: Scope.Closeable[] = [];
afterEach(async () => {
  placeTerminals({ kind: "here" });
  for (const scope of scopes.splice(0)) await Effect.runPromise(Scope.close(scope, Exit.void));
  for (const port of opened.splice(0)) port.close();
});

/** The real terminal server through its layer, with the parent stubbed. */
const boot = (spawnPty: SpawnPty) => {
  const scope = Effect.runSync(Scope.make());
  scopes.push(scope);
  const deps = Layer.mergeAll(
    Layer.succeed(PtySpawner, spawnPty),
    PidEpochs.live,
    Layer.succeed(CoreLink, { parentAsCore: undefined, listenParent: () => () => undefined }),
  );
  const context = Effect.runSync(Layer.buildWithScope(Layer.provideMerge(TerminalServer.layer, deps), scope));
  return Context.get(context, TerminalServer);
};

const install = () => {
  const { port1, port2 } = new MessageChannel();
  opened.push(port1, port2);
  const spawned: number[] = [];
  const spawnPty: SpawnPty = (command, args, options) => {
    const pty = nodePty.spawn(command, [...args], options);
    spawned.push(pty.pid);
    return pty;
  };
  const served = boot(spawnPty);
  served.attach(linkOf(port2), 1);
  placeTerminals({ kind: "process", client: terminalClient(linkOf(port1)) });
  return { served, spawned };
};

const spec = (command: string, args: readonly string[] = []) => ({
  source: "test",
  purpose: "terminal process plane",
  command,
  args,
  env: { PATH: process.env.PATH, TERM: "xterm-256color" },
  cols: 80,
  rows: 24,
});

const output = (lease: AppTerminalLease) => {
  let text = "";
  lease.io.onData((data) => {
    text += data;
  });
  return () => text;
};

const until = async (check: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("the process plane on the terminal process", () => {
  it("answers at once, names the pid later, and carries input and output", async () => {
    const { spawned } = install();
    const plane = createAppProcessPlane({ termGraceMs: 200, killGraceMs: 200 });
    const lease = plane.spawnTerminal(spec("/bin/cat"));
    expect(lease.io.pidForDiagnostics).toBeUndefined();
    const text = output(lease);
    lease.io.write("over the port\r");
    expect(await lease.io.pidReady).toBe(spawned[0]);
    await until(() => text().includes("over the port"));

    const receipt = plane.terminate(lease, "test stop");
    expect(receipt.attempted).toBe(true);
    expect((await lease.io.exited).signal).toBe(15);
  });

  it("quit drains a terminal held by the terminal process", async () => {
    const { served } = install();
    const plane = createAppProcessPlane({ termGraceMs: 200, killGraceMs: 200 });
    plane.spawnTerminal(spec("/bin/cat"));
    await until(() => served.live() === 1);
    plane.beginShutdown();
    expect(await plane.drainOnQuit()).toMatchObject({ clean: true });
    expect(served.live()).toBe(0);
  });

  it("a PTY spawned before the switch stays in this process", async () => {
    const plane = createAppProcessPlane({ termGraceMs: 200, killGraceMs: 200 });
    const local = plane.spawnTerminal(spec("/bin/cat"));
    expect(local.io.pidForDiagnostics).toBeGreaterThan(0);
    expect(local.io.pidReady).toBeUndefined();
    const { served } = install();
    expect(served.live()).toBe(0);
    plane.forceTerminate(local, "test stop");
    expect((await local.io.exited).signal).toBe(9);
  });
});
