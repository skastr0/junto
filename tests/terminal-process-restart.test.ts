/**
 * The terminal process dies (phase 1, fail open): every PTY it held is
 * reported exited, a write to one is refused, and once main connects the core
 * to a new terminal process the next PTY carries input and output. The core's
 * terminals over ports (`over-ports.ts`), each port served by real PTYs.
 */
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { serveTerminals, type SpawnPty } from "../src/terminal/serve";
import { terminalsOverPorts, type TerminalPortMain } from "../src/core/terminals/over-ports";
import { createAppProcessPlane } from "../src/node/app-process-plane";
import { placeTerminals } from "../src/node/terminals/use";

const nodePty = createRequire(import.meta.url)("node-pty") as typeof import("node-pty");

const opened: MessagePort[] = [];
const forks: Array<{ crash: () => void; pids: number[] }> = [];

/** A node port as Electron's `MessagePortMain` hands one over: each message as `{ data }`. */
const asMain = (port: MessagePort): TerminalPortMain => {
  const wrapped = new Map<(event: { readonly data: unknown }) => void, (data: unknown) => void>();
  return {
    postMessage: (message) => port.postMessage(message),
    on: (event, listener) => {
      if (event === "close") return void port.on("close", () => listener({ data: undefined }));
      const on = (data: unknown) => listener({ data });
      wrapped.set(listener, on);
      port.on("message", on);
    },
    off: (_event, listener) => {
      const on = wrapped.get(listener);
      if (on !== undefined) port.off("message", on);
    },
    start: () => port.start(),
  };
};

/** One terminal process: real PTYs served on one end, the core's end returned, and a way to crash it. */
const fork = (): MessagePort => {
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
  const crash = () => {
    // Its PTYs go with it, and so does its end of the port.
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    port2.close();
  };
  forks.push({ crash, pids });
  return port1;
};

afterEach(() => {
  placeTerminals({ kind: "here" });
  for (const each of forks.splice(0)) for (const pid of each.pids) {
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
    const terminals = terminalsOverPorts();
    terminals.connect(asMain(fork()));
    placeTerminals({ kind: "process", client: terminals });
    const plane = createAppProcessPlane({ termGraceMs: 200, killGraceMs: 200 });
    const first = plane.spawnTerminal(spec);
    const second = plane.spawnTerminal(spec);
    await first.io.pidReady;
    await second.io.pidReady;
    expect(forks).toHaveLength(1);
    const errors: string[] = [];
    first.io.onError((error) => errors.push(error.message));

    forks[0]!.crash();
    expect(await first.io.exited).toEqual({ code: undefined, signal: undefined });
    expect(await second.io.exited).toEqual({ code: undefined, signal: undefined });
    expect(errors).toEqual(["the Junto terminal process exited"]);
    expect(() => first.io.write("after the crash")).toThrow("terminal process already exited");

    terminals.connect(asMain(fork()));
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
  });
});
