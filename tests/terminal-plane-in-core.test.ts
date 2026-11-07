/**
 * One terminal plane, in the core (plan B). The core's terminals are the
 * `Terminals` service over the ports `TerminalPorts` gives it: its Layer is
 * built once the first port is here, one over a port carries input and
 * output, a port that closes exits its terminals and leaves a spawn refused,
 * and a new port serves again.
 */
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { createRequire } from "node:module";
import { Cause, Context, Effect, Exit, Layer, Queue, Scope, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { serveTerminals, type SpawnPty } from "../src/terminal/serve";
import { TerminalPorts, Terminals, type TerminalPortMain } from "../src/core/terminals/service";
import type { TerminalLinkMessage } from "../src/contract/terminal/protocol";
import type { TerminalClient } from "../src/node/terminals/client";

const nodePty = createRequire(import.meta.url)("node-pty") as typeof import("node-pty");
const realPty: SpawnPty = (command, args, options) => nodePty.spawn(command, [...args], options);

const opened: MessagePort[] = [];
const scopes: Scope.Closeable[] = [];
const served: Array<ReturnType<typeof serveTerminals>> = [];
afterEach(async () => {
  for (const scope of scopes.splice(0)) await Effect.runPromise(Scope.close(scope, Exit.void));
  // A PTY a closed port left running waits for a core to adopt it; none will.
  for (const server of served.splice(0)) await server.hangupAll();
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
  served.push(serveTerminals({
    post: (message) => port2.postMessage(message),
    listen: (handler) => {
      const on = (message: TerminalLinkMessage) => handler(message);
      port2.on("message", on);
      return () => port2.off("message", on);
    },
  }, realPty));
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

/** Builds `Terminals` over a stream of ports this test hands it one by one, for the test's life. */
const terminalsOver = async (ports: Queue.Queue<TerminalPortMain, Cause.Done>) => {
  const scope = await Effect.runPromise(Scope.make());
  scopes.push(scope);
  const layer = Terminals.overPort.pipe(Layer.provide(Layer.succeed(TerminalPorts, Stream.fromQueue(ports))));
  return Effect.runPromise(Layer.buildWithScope(layer, scope)).then((context) => Context.get(context, Terminals));
};

const env = { PATH: process.env.PATH, TERM: "xterm-256color" };

const refused = (terminals: TerminalClient): boolean => {
  try {
    terminals.spawn({ command: "/bin/true", args: [], cols: 80, rows: 24, env });
    return false;
  } catch (error) {
    return (error as Error).message === "the Junto terminal process is not connected";
  }
};

describe("one terminal plane, in the core", () => {
  it("the core's terminals run over the port main hands it, and only there", async () => {
    const ports = await Effect.runPromise(Queue.unbounded<TerminalPortMain, Cause.Done>());
    let built = false;
    const building = terminalsOver(ports).then((terminals) => {
      built = true;
      return terminals;
    });
    // No port yet: the service is not there to ask.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(built).toBe(false);

    const first = terminalPort();
    await Effect.runPromise(Queue.offer(ports, first.main));
    const terminals = await building;
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
    await until(() => refused(terminals));

    const second = terminalPort();
    await Effect.runPromise(Queue.offer(ports, second.main));
    await until(() => !refused(terminals));
    const again = terminals.spawn({ command: "/bin/echo", args: ["again"], cols: 80, rows: 24, env });
    let echoed = "";
    again.onData((data) => {
      echoed += data;
    });
    await until(() => echoed.includes("again"));
  });

  it("a new port fails every terminal the last one carried", async () => {
    const ports = await Effect.runPromise(Queue.unbounded<TerminalPortMain, Cause.Done>());
    await Effect.runPromise(Queue.offer(ports, terminalPort().main));
    const terminals = await terminalsOver(ports);
    const cat = terminals.spawn({ command: "/bin/cat", args: [], cols: 80, rows: 24, env });
    const errors: string[] = [];
    cat.onError((error) => errors.push(error.message));
    const exited = new Promise((resolve) => cat.onExit(resolve));

    await Effect.runPromise(Queue.offer(ports, terminalPort().main));
    expect(await exited).toEqual({ code: undefined, signal: undefined });
    expect(errors).toContain("the Junto terminal process was replaced");
  });

  it("ports that end with none still build it, and a spawn is refused", async () => {
    const ports = await Effect.runPromise(Queue.unbounded<TerminalPortMain, Cause.Done>());
    await Effect.runPromise(Queue.end(ports));
    const terminals = await terminalsOver(ports);
    expect(refused(terminals)).toBe(true);
    const adopted = await Effect.runPromise(Effect.flip(terminals.adopt()));
    expect(adopted).toMatchObject({ _tag: "TerminalAdoptFailed", message: "the Junto terminal process is not connected" });
  });

  it("here is the same Layer over one port", async () => {
    const scope = await Effect.runPromise(Scope.make());
    scopes.push(scope);
    const context = await Effect.runPromise(Layer.buildWithScope(Terminals.here(terminalPort().main), scope));
    const echo = Context.get(context, Terminals).spawn({ command: "/bin/echo", args: ["here"], cols: 80, rows: 24, env });
    let echoed = "";
    echo.onData((data) => {
      echoed += data;
    });
    await until(() => echoed.includes("here"));
  });
});
