/**
 * One terminal plane, in the core (plan B). The core's terminals run over a
 * port main hands it: a spawn before a port is refused, one over a port
 * carries input and output, a port that closes exits its terminals, and a new
 * port serves again.
 */
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { serveTerminals, type SpawnPty } from "../src/main/terminal-process/serve";
import { terminalsOverPorts, type TerminalPortMain } from "../src/main/terminal-process/over-ports";
import type { CoreMessage } from "../src/main/core-process/port";

const nodePty = createRequire(import.meta.url)("node-pty") as typeof import("node-pty");
const realPty: SpawnPty = (command, args, options) => nodePty.spawn(command, [...args], options);

const opened: MessagePort[] = [];
afterEach(() => {
  for (const port of opened.splice(0)) port.close();
});

const until = async (check: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** A terminal process served on one end; the other end as Electron's MessagePortMain. */
const terminalPort = () => {
  const { port1, port2 } = new MessageChannel();
  opened.push(port1, port2);
  serveTerminals({
    post: (message) => port2.postMessage(message),
    listen: (handler) => {
      const on = (message: CoreMessage) => handler(message);
      port2.on("message", on);
      return () => port2.off("message", on);
    },
  }, realPty);
  const listeners = new Map<(event: { readonly data: unknown }) => void, (data: unknown) => void>();
  const main: TerminalPortMain = {
    postMessage: (message) => port1.postMessage(message),
    on: (event, listener) => {
      if (event === "close") return void port1.on("close", () => listener({ data: undefined }));
      const on = (data: unknown) => listener({ data });
      listeners.set(listener, on);
      port1.on("message", on);
    },
    off: (_event, listener) => {
      const on = listeners.get(listener);
      if (on !== undefined) port1.off("message", on);
    },
    start: () => undefined,
  };
  return { main, far: port2 };
};

const env = { PATH: process.env.PATH, TERM: "xterm-256color" };

describe("one terminal plane, in the core", () => {
  it("the core's terminals run over the port main hands it, and only there", async () => {
    const terminals = terminalsOverPorts();
    expect(() => terminals.spawn({ command: "/bin/cat", args: [], cols: 80, rows: 24, env })).toThrow("the Junto terminal process is not connected");

    const first = terminalPort();
    terminals.connect(first.main);
    const cat = terminals.spawn({ command: "/bin/cat", args: [], cols: 80, rows: 24, env });
    let text = "";
    cat.onData((data) => {
      text += data;
    });
    const exited = new Promise((resolve) => cat.onExit(resolve));
    cat.write("over the core's port\r");
    await until(() => text.includes("over the core's port"));

    // The terminal process is gone: its port closes, and its terminals exit.
    first.far.close();
    expect(await exited).toEqual({ code: undefined, signal: undefined });
    await until(() => {
      try {
        terminals.spawn({ command: "/bin/true", args: [], cols: 80, rows: 24, env });
        return false;
      } catch (error) {
        return (error as Error).message === "the Junto terminal process is not connected";
      }
    });

    const second = terminalPort();
    terminals.connect(second.main);
    const again = terminals.spawn({ command: "/bin/echo", args: ["again"], cols: 80, rows: 24, env });
    let echoed = "";
    again.onData((data) => {
      echoed += data;
    });
    await until(() => echoed.includes("again"));
  });
});
