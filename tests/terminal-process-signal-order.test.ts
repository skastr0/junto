/**
 * A signal is decided before the command after it applies. The plane writes
 * XON right after a SIGKILL (app-process-plane.ts releaseStoppedOutput); the
 * terminal process reads the PTY's epoch before it signals, so a write that
 * did not wait for that read reached a live process the kill had not, and
 * an offboarded seat's old process saw input after its offboard.
 */
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import type { TerminalLink, TerminalLinkMessage } from "../src/contract/terminal/protocol";
import type { ParentCommand } from "../src/contract/terminal/messages";
import { CoreLink, PidEpochs, PtySpawner, TerminalServer, type SpawnPty, type SurfacePort } from "../src/terminal/serve";
import { terminalClient } from "../src/node/terminals/client";

const opened: MessagePort[] = [];
const scopes: Scope.Closeable[] = [];
afterEach(async () => {
  for (const port of opened.splice(0)) port.close();
  for (const scope of scopes.splice(0)) await Effect.runPromise(Scope.close(scope, Exit.void));
});

const linkOf = (port: MessagePort): TerminalLink<SurfacePort> => ({
  post: (message) => port.postMessage(message),
  transfer: () => {
    throw new Error("the terminal process posts no port on the link");
  },
  listen: (handler) => {
    const on = (message: TerminalLinkMessage) => handler(message, undefined);
    port.on("message", on);
    port.start();
    return () => port.off("message", on);
  },
});

const clientLinkOf = (port: MessagePort): TerminalLink<MessagePort> => ({
  post: (message) => port.postMessage(message),
  transfer: (frame, surface) => port.postMessage({ ...frame, port: surface }, [surface]),
  listen: (handler) => {
    const on = (message: TerminalLinkMessage) => handler(message, undefined);
    port.on("message", on);
    port.start();
    return () => port.off("message", on);
  },
});

const boot = (spawnPty: SpawnPty, epochs: Layer.Layer<PidEpochs>) => {
  const scope = Effect.runSync(Scope.make());
  scopes.push(scope);
  const deps = Layer.mergeAll(
    Layer.succeed(PtySpawner, spawnPty),
    epochs,
    Layer.succeed(CoreLink, {
      parentAsCore: undefined,
      listenParent: (_handler: (command: ParentCommand, port: TerminalLink<SurfacePort> | undefined) => void) => () => undefined,
    }),
  );
  const context = Effect.runSync(Layer.buildWithScope(Layer.provideMerge(TerminalServer.layer, deps), scope));
  return Context.get(context, TerminalServer);
};

const until = async (check: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("the terminal process orders a signal", () => {
  it("applies the write after a SIGKILL only once the kill is decided", async () => {
    const reached: string[] = [];
    const fake: SpawnPty = () => ({
      pid: 4250,
      onExit: () => ({ dispose: () => undefined }),
      onData: () => ({ dispose: () => undefined }),
      kill: (signal?: string) => reached.push(`kill ${String(signal)}`),
      write: (data: string) => reached.push(`write ${JSON.stringify(data)}`),
      resize: () => undefined,
    }) as unknown as ReturnType<SpawnPty>;
    let answer: ((current: boolean) => void) | undefined;
    const { port1, port2 } = new MessageChannel();
    opened.push(port1, port2);
    const server = boot(fake, Layer.succeed(PidEpochs, {
      capture: async (pid) => ({ pid, startKey: "spawned" }),
      // Only the kill's check is held; the hangup at the scope's close answers at once.
      isCurrent: () => answer === undefined
        ? new Promise<boolean>((resolve) => {
          answer = resolve;
        })
        : Promise.resolve(true),
    }));
    server.attach(linkOf(port2), 1);
    const client = terminalClient(clientLinkOf(port1));
    const pty = client.spawn({ command: "/bin/true", args: [], cols: 80, rows: 24 });
    await pty.pid;
    pty.kill("SIGKILL");
    pty.write("\x11");
    pty.write("after");
    await until(() => answer !== undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The epoch check is out: nothing after the kill has reached the PTY.
    expect(reached).toEqual([]);
    answer?.(true);
    await until(() => reached.length === 3);
    expect(reached).toEqual(["kill SIGKILL", 'write "\\u0011"', 'write "after"']);
  });

  it("a dropped signal still lets the commands after it apply", async () => {
    const reached: string[] = [];
    const fake: SpawnPty = () => ({
      pid: 4251,
      onExit: () => ({ dispose: () => undefined }),
      onData: () => ({ dispose: () => undefined }),
      kill: (signal?: string) => reached.push(`kill ${String(signal)}`),
      write: (data: string) => reached.push(`write ${JSON.stringify(data)}`),
      resize: () => undefined,
    }) as unknown as ReturnType<SpawnPty>;
    const { port1, port2 } = new MessageChannel();
    opened.push(port1, port2);
    const server = boot(fake, Layer.succeed(PidEpochs, {
      capture: async (pid) => ({ pid, startKey: "spawned" }),
      isCurrent: async () => false,
    }));
    server.attach(linkOf(port2), 1);
    const client = terminalClient(clientLinkOf(port1));
    const pty = client.spawn({ command: "/bin/true", args: [], cols: 80, rows: 24 });
    await pty.pid;
    pty.kill("SIGTERM");
    pty.write("next");
    await until(() => reached.length === 1);
    expect(reached).toEqual(['write "next"']);
  });
});
