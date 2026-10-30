/**
 * The terminal process dies (phase 1, fail open): every PTY it held is
 * reported exited, a write to one is refused, and the next spawn forks a new
 * terminal process whose PTY carries input and output. Main's host over a
 * stand-in utilityProcess that serves real PTYs.
 */
import { EventEmitter } from "node:events";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoreMessage } from "../src/main/core-process/port";
import { serveTerminals, type SpawnPty } from "../src/main/terminal-process/serve";

const nodePty = createRequire(import.meta.url)("node-pty") as typeof import("node-pty");

/** Each fork: a child that serves real PTYs over a port, and a way to crash it. */
const forks = vi.hoisted(() => [] as Array<{ crash: (code: number) => void; pids: number[] }>);
vi.mock("electron", () => {
  const electron = { utilityProcess: { fork: () => fakeFork() } };
  return { ...electron, default: electron };
});
vi.mock("../src/main/terminal-process/entry?modulePath", () => ({ default: "/terminal-entry.js" }));

const opened: MessagePort[] = [];
const fakeFork = () => {
  const child = new EventEmitter() as EventEmitter & { postMessage: (message: CoreMessage) => void; kill: () => boolean };
  const { port1, port2 } = new MessageChannel();
  opened.push(port1, port2);
  const pids: number[] = [];
  const spawnPty: SpawnPty = (command, args, options) => {
    const pty = nodePty.spawn(command, [...args], options);
    pids.push(pty.pid);
    return pty;
  };
  serveTerminals({
    post: (message) => port2.postMessage(message),
    listen: (handler) => {
      port2.on("message", handler);
      return () => port2.off("message", handler);
    },
  }, spawnPty);
  port1.on("message", (message: CoreMessage) => child.emit("message", message));
  let alive = true;
  child.postMessage = (message) => {
    if (alive) port1.postMessage(message);
  };
  const crash = (code: number) => {
    alive = false;
    port1.close();
    // Its PTYs go with it.
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    child.emit("exit", code);
  };
  child.kill = () => {
    crash(0);
    return true;
  };
  forks.push({ crash, pids });
  return child;
};

const { startTerminalProcess } = await import("../src/main/terminal-process/host");
const { createAppProcessPlane } = await import("../src/main/junto/app-process-plane");
const { useTerminalProcess } = await import("../src/main/terminal-process/use");

afterEach(() => {
  useTerminalProcess(undefined);
  for (const fork of forks.splice(0)) for (const pid of fork.pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  for (const port of opened.splice(0)) port.close();
});

const until = async (check: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const spec = {
  source: "test",
  purpose: "terminal process restart",
  command: "/bin/cat",
  args: [],
  env: { PATH: process.env.PATH, TERM: "xterm-256color" },
  cols: 80,
  rows: 24,
};

describe("a terminal process that dies", () => {
  it("exits every PTY it held, and the next spawn starts a new one that works", async () => {
    const terminals = startTerminalProcess();
    useTerminalProcess(terminals);
    const plane = createAppProcessPlane({ termGraceMs: 200, killGraceMs: 200 });
    const first = plane.spawnTerminal(spec);
    const second = plane.spawnTerminal(spec);
    await first.io.pidReady;
    await second.io.pidReady;
    expect(forks).toHaveLength(1);
    const errors: string[] = [];
    first.io.onError((error) => errors.push(error.message));

    forks[0]!.crash(9);
    expect(await first.io.exited).toEqual({ code: undefined, signal: undefined });
    expect(await second.io.exited).toEqual({ code: undefined, signal: undefined });
    expect(errors).toEqual(["the Junto terminal process exited with code 9"]);
    expect(() => first.io.write("after the crash")).toThrow("terminal process already exited");

    const again = plane.spawnTerminal(spec);
    let text = "";
    again.io.onData((data) => {
      text += data;
    });
    again.io.write("a new terminal process\r");
    expect(await again.io.pidReady).toBe(forks[1]?.pids[0]);
    expect(forks).toHaveLength(2);
    await until(() => text.includes("a new terminal process"));
    plane.terminate(again, "test stop");
    expect((await again.io.exited).signal).toBe(15);
    terminals.stop();
  });
});
