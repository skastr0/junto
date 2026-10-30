/**
 * The terminal process over a real port with real PTYs (phase 1): a spawn
 * answers at once and its input follows it in order, output and the exit
 * come back, a size change reaches the child, a signal stops it, and an
 * exited terminal takes no more input or signal. A spawn the child refuses
 * arrives as an error and then an exit, and a lost terminal process exits
 * every terminal it held.
 */
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import type { CoreMessage, CorePort } from "../src/main/core-process/port";
import { serveTerminals, type SpawnPty } from "../src/main/terminal-process/serve";
import { terminalClient, type RemoteTerminal, type RemoteTerminalExit } from "../src/main/terminal-process/client";

const nodePty = createRequire(import.meta.url)("node-pty") as typeof import("node-pty");
const realPty: SpawnPty = (command, args, options) => nodePty.spawn(command, [...args], options);

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
  for (const port of opened.splice(0)) port.close();
});

const pair = (spawnPty: SpawnPty = realPty) => {
  const { port1, port2 } = new MessageChannel();
  opened.push(port1, port2);
  const served = serveTerminals(portOf(port2), spawnPty);
  return { client: terminalClient(portOf(port1)), served };
};

const record = (terminal: RemoteTerminal) => {
  let output = "";
  const errors: string[] = [];
  terminal.onData((data) => {
    output += data;
  });
  terminal.onError((error) => errors.push(error.message));
  const exit = new Promise<RemoteTerminalExit>((resolve) => terminal.onExit(resolve));
  return { output: () => output, errors, exit };
};

const until = async (check: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const env = { PATH: process.env.PATH, TERM: "xterm-256color" };

describe("the terminal process", () => {
  it("echoes input written before the pid is known, and reports the exit", async () => {
    const { client, served } = pair();
    const cat = client.spawn({ command: "/bin/cat", args: [], cols: 80, rows: 24, env });
    const seen = record(cat);
    cat.write("typed before the pid\r");
    expect(await cat.pid).toBeGreaterThan(0);
    await until(() => seen.output().includes("typed before the pid"));
    cat.kill("SIGTERM");
    expect((await seen.exit).signal).toBe(15);
    expect(served.live()).toBe(0);
  });

  it("resizes the child", async () => {
    const { client } = pair();
    const shell = client.spawn({ command: "/bin/sh", args: ["-c", "read go; stty size"], cols: 80, rows: 24, env });
    const seen = record(shell);
    await shell.pid;
    shell.resize(132, 40);
    shell.write("go\r");
    await until(() => seen.output().includes("40 132"));
    expect((await seen.exit).code).toBe(0);
  });

  it("an exited terminal refuses input and ignores a signal", async () => {
    const { client } = pair();
    const echo = client.spawn({ command: "/bin/echo", args: ["done"], cols: 80, rows: 24, env });
    const seen = record(echo);
    expect((await seen.exit).code).toBe(0);
    const after = { errors: [] as string[] };
    // Listeners on an exited terminal are never called; the push names it.
    echo.onError((error) => after.errors.push(error.message));
    echo.write("too late");
    echo.kill("SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(after.errors).toEqual([]);
  });

  it("a kill after the child is reaped and before its exit is reported is dropped", async () => {
    let exit: ((event: { exitCode: number; signal?: number }) => void) | undefined;
    const kills: Array<string | undefined> = [];
    const reaped: SpawnPty = () => ({
      pid: 4242,
      onExit: (listener: typeof exit) => {
        exit = listener;
        return { dispose: () => undefined };
      },
      onData: () => ({ dispose: () => undefined }),
      kill: (signal?: string) => kills.push(signal),
      write: () => undefined,
      resize: () => undefined,
    }) as unknown as ReturnType<SpawnPty>;
    let alive = true;
    const { port1, port2 } = new MessageChannel();
    opened.push(port1, port2);
    serveTerminals(portOf(port2), reaped, {
      capture: async (pid) => ({ pid, startKey: "spawned" }),
      isCurrent: async () => alive,
    });
    const client = terminalClient(portOf(port1));
    const pty = client.spawn({ command: "/bin/true", args: [], cols: 80, rows: 24 });
    await pty.pid;
    pty.kill("SIGTERM");
    await until(() => kills.length === 1);
    // The child is reaped; node-pty has not reported the exit yet.
    alive = false;
    pty.kill("SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(kills).toEqual(["SIGTERM"]);
    exit?.({ exitCode: 0 });
  });

  it("a kill whose epoch check is still pending when the exit is reported is dropped", async () => {
    let exit: ((event: { exitCode: number; signal?: number }) => void) | undefined;
    const kills: Array<string | undefined> = [];
    const fake: SpawnPty = () => ({
      pid: 4243,
      onExit: (listener: typeof exit) => {
        exit = listener;
        return { dispose: () => undefined };
      },
      onData: () => ({ dispose: () => undefined }),
      kill: (signal?: string) => kills.push(signal),
      write: () => undefined,
      resize: () => undefined,
    }) as unknown as ReturnType<SpawnPty>;
    let answer: ((current: boolean) => void) | undefined;
    const { port1, port2 } = new MessageChannel();
    opened.push(port1, port2);
    serveTerminals(portOf(port2), fake, {
      capture: async (pid) => ({ pid, startKey: "spawned" }),
      isCurrent: () => new Promise<boolean>((resolve) => {
        answer = resolve;
      }),
    });
    const client = terminalClient(portOf(port1));
    const pty = client.spawn({ command: "/bin/true", args: [], cols: 80, rows: 24 });
    await pty.pid;
    pty.kill("SIGTERM");
    await until(() => answer !== undefined);
    // The exit lands while ps is still answering; the answer then says current.
    exit?.({ exitCode: 0 });
    answer?.(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(kills).toEqual([]);
  });

  it("a refused spawn arrives as an error, then an exit", async () => {
    const refusing: SpawnPty = () => {
      throw new Error("posix_spawnp failed");
    };
    const { client } = pair(refusing);
    const refused = client.spawn({ command: "/no/such", args: [], cols: 80, rows: 24 });
    const seen = record(refused);
    await expect(refused.pid).rejects.toThrow(/posix_spawnp failed/);
    expect(await seen.exit).toEqual({ code: undefined, signal: undefined });
    expect(seen.errors).toEqual(["posix_spawnp failed"]);
  });

  it("a lost terminal process exits every terminal it held", async () => {
    const { client } = pair();
    const cat = client.spawn({ command: "/bin/cat", args: [], cols: 80, rows: 24, env });
    const seen = record(cat);
    await cat.pid;
    client.fail("the terminal process exited");
    expect(await seen.exit).toEqual({ code: undefined, signal: undefined });
    expect(seen.errors).toEqual(["the terminal process exited"]);
    cat.kill("SIGKILL");
  });
});
