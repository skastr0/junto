/**
 * The process plane with the terminal process installed (phase 1): a
 * terminal lease answers at once with no pid, then names it; input and
 * output cross the port; terminate signals the PTY through the terminal
 * process; quit drains it; and a PTY spawned before the switch stays where it
 * started. Real PTYs over a real port.
 */
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import type { CoreMessage, CorePort } from "../src/main/core-process/port";
import { createAppProcessPlane, type AppTerminalLease } from "../src/main/junto/app-process-plane";
import { serveTerminals, type SpawnPty } from "../src/main/terminal-process/serve";
import { terminalClient } from "../src/main/terminal-process/client";
import { useTerminalProcess } from "../src/main/terminal-process/use";

const nodePty = createRequire(import.meta.url)("node-pty") as typeof import("node-pty");

const portOf = (port: MessagePort): CorePort => ({
  post: (message) => port.postMessage(message),
  listen: (handler) => {
    const on = (message: CoreMessage) => handler(message);
    port.on("message", on);
    return () => port.off("message", on);
  },
});

const opened: MessagePort[] = [];
afterEach(() => {
  useTerminalProcess(undefined);
  for (const port of opened.splice(0)) port.close();
});

const install = () => {
  const { port1, port2 } = new MessageChannel();
  opened.push(port1, port2);
  const spawned: number[] = [];
  const spawnPty: SpawnPty = (command, args, options) => {
    const pty = nodePty.spawn(command, [...args], options);
    spawned.push(pty.pid);
    return pty;
  };
  const served = serveTerminals(portOf(port2), spawnPty);
  useTerminalProcess(terminalClient(portOf(port1)));
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
