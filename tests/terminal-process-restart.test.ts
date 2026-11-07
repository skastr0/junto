/**
 * The terminal process and the cores it outlives: a core whose port closes
 * is detached — its PTYs keep running — and a `connect` at a higher
 * generation attaches the next one, which adopts them with their screens and
 * names the id its spawns count from. A `connect` at a generation not higher
 * than the attached one is refused. The parent's `shutdown` is the process's
 * orderly quit: every PTY gets its epoch-guarded hangup and the program may
 * leave. Real PTYs over real ports.
 */
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { RpcClient } from "effect/rpc";
import { clientProtocol, type RpcPort } from "../src/shared/rpc-port";
import { TerminalRpcs } from "../src/contract/terminal/rpcs";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import type { TerminalLink, TerminalLinkMessage, TerminalLinkPort } from "../src/contract/terminal/protocol";
import type { Command, Event, ParentCommand } from "../src/contract/terminal/messages";
import {
  CoreLink,
  PidEpochs,
  PtySpawner,
  TerminalServer,
  type SpawnPty,
  type SurfacePort,
} from "../src/terminal/serve";
import { terminalClient } from "../src/node/terminals/client";

const nodePty = createRequire(import.meta.url)("node-pty") as typeof import("node-pty");
const realPty: SpawnPty = (command, args, options) => nodePty.spawn(command, [...args], options);

const opened: MessagePort[] = [];
const scopes: Scope.Closeable[] = [];
afterEach(async () => {
  for (const port of opened.splice(0)) port.close();
  for (const scope of scopes.splice(0)) await Effect.runPromise(Scope.close(scope, Exit.void));
});

const surfacePortOf = (port: MessagePort): SurfacePort => ({
  post: (message) => port.postMessage(message),
  listen: (handler) => {
    port.on("message", handler);
    port.start();
    return () => port.off("message", handler);
  },
  close: () => port.close(),
});

/** The served end of a core link: a node port hands a transferred port inside the message value. */
const linkOf = (port: MessagePort): TerminalLink<SurfacePort> => ({
  post: (message) => port.postMessage(message),
  transfer: () => {
    throw new Error("the terminal process posts no port on the link");
  },
  listen: (handler) => {
    const on = (message: TerminalLinkMessage & { readonly port?: MessagePort }) =>
      handler(message, message.port === undefined ? undefined : surfacePortOf(message.port));
    const down = () => handler({ kind: "down", reason: "the port closed" }, undefined);
    port.on("message", on);
    port.on("close", down);
    port.start();
    return () => {
      port.off("message", on);
      port.off("close", down);
    };
  },
});

const portOf = (port: MessagePort): TerminalLinkPort => ({
  post: (message) => port.postMessage(message),
  listen: (handler) => {
    port.on("message", handler);
    port.start();
    return () => port.off("message", handler);
  },
});

/** A raw core end: events collected, commands posted, the RPC group answered through the port. */
const coreOf = (port: MessagePort) => {
  const events: Event[] = [];
  port.on("message", (message: TerminalLinkMessage) => {
    if (message.kind === "event") events.push(message.message);
  });
  port.start();
  const scope = Effect.runSync(Scope.make());
  scopes.push(scope);
  const rpc: RpcPort = {
    post: (message) => port.postMessage(message),
    listen: (handler) => {
      port.on("message", handler);
      return () => port.off("message", handler);
    },
  };
  const calls = Effect.runSync(
    RpcClient.make(TerminalRpcs).pipe(
      Effect.provideServiceEffect(RpcClient.Protocol, clientProtocol(rpc)),
      Effect.provideService(Scope.Scope, scope),
    ),
  );
  return {
    events,
    calls,
    command: (message: Command) => port.postMessage({ kind: "command", message }),
  };
};

/** The real server through its layer, with the parent stubbed so the tests post its commands. */
const boot = (spawnPty: SpawnPty = realPty) => {
  const scope = Effect.runSync(Scope.make());
  scopes.push(scope);
  const listeners = new Set<(command: ParentCommand, port: TerminalLink<SurfacePort> | undefined) => void>();
  const deps = Layer.mergeAll(
    Layer.succeed(PtySpawner, spawnPty),
    PidEpochs.live,
    Layer.succeed(CoreLink, {
      parentAsCore: undefined,
      listenParent: (handler) => {
        listeners.add(handler);
        return () => listeners.delete(handler);
      },
    }),
  );
  const context = Effect.runSync(Layer.buildWithScope(Layer.provideMerge(TerminalServer.layer, deps), scope));
  const server = Context.get(context, TerminalServer);
  return {
    server,
    scope,
    connect: (link: TerminalLink<SurfacePort>, generation: number) =>
      listeners.forEach((listener) => listener({ _tag: "connect", generation }, link)),
    shutdown: () => listeners.forEach((listener) => listener({ _tag: "shutdown" }, undefined)),
  };
};

/** A core and its port, connected to the terminal process at `generation`. */
const coreAt = (connected: ReturnType<typeof boot>, generation: number) => {
  const { port1, port2 } = new MessageChannel();
  opened.push(port1, port2);
  connected.connect(linkOf(port2), generation);
  return { client: terminalClient(portOf(port1)), core: coreOf(port1), port: port2 };
};

const until = async (check: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const running = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const env = { PATH: process.env.PATH, TERM: "xterm-256color" };

describe("a terminal process and the cores it outlives", () => {
  it("a core whose port closes is detached; a higher-generation connect adopts its PTYs and the next spawn works", async () => {
    const connected = boot();
    const first = coreAt(connected, 1);
    const cat = first.client.spawn({ command: "/bin/cat", args: [], cols: 80, rows: 24, env });
    const pid = (await cat.pid)!;
    let echoed = "";
    cat.onData((data) => {
      echoed += data;
    });
    cat.write("before the crash\r");
    await until(() => echoed.includes("before the crash"));

    // The core is gone; its port closing detaches it and nothing is killed.
    first.port.close();
    await until(() => running(pid));
    expect(connected.server.live()).toBe(1);

    // The next generation connects and adopts what was running.
    const next = coreAt(connected, 2);
    const [taken] = await Effect.runPromise(next.client.adopt());
    expect(taken).not.toBeUndefined();
    expect(taken!.adopted.pid).toBe(pid);
    expect(taken!.adopted.history).toContain("before the crash");
    // An adopted handle applies nothing until it has both a data and an exit
    // listener, as the client's `ready` gate wants.
    const again: string[] = [];
    taken!.terminal.onData((data) => again.push(data));
    taken!.terminal.onExit(() => undefined);
    taken!.terminal.write("after the restart\r");
    await until(() => again.join("").includes("after the restart"));

    // And a fresh spawn on the new core works, with a new id.
    const fresh = next.client.spawn({ command: "/bin/cat", args: [], cols: 80, rows: 24, env });
    expect(fresh.id).toBeGreaterThan(taken!.terminal.id);
    let text = "";
    fresh.onData((data) => {
      text += data;
    });
    fresh.write("a new terminal\r");
    expect(await fresh.pid).toBeGreaterThan(0);
    await until(() => text.includes("a new terminal"));
    fresh.kill("SIGKILL");
    taken!.terminal.kill("SIGKILL");
    await until(() => connected.server.live() === 0);
  });

  it("a connect at a generation not higher than the attached one is refused", async () => {
    const connected = boot();
    const first = coreAt(connected, 3);
    const cat = first.client.spawn({ command: "/bin/cat", args: [], cols: 80, rows: 24, env });
    await cat.pid;

    // An older and an equal generation both refuse: the first core still serves.
    const { port1: a1, port2: a2 } = new MessageChannel();
    opened.push(a1, a2);
    expect(connected.server.attach(linkOf(a2), 2)).toBe(false);
    expect(connected.server.attach(linkOf(a2), 3)).toBe(false);
    a1.postMessage({ kind: "command", message: { _tag: "kill", id: cat.id, n: 2, signal: "SIGKILL" } });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(running((await cat.pid)!)).toBe(true);

    // The first core's commands still apply.
    let echoed = "";
    cat.onData((data) => {
      echoed += data;
    });
    cat.write("still the core\r");
    await until(() => echoed.includes("still the core"));
    cat.kill("SIGKILL");
    await until(() => connected.server.live() === 0);
  });

  it("the parent's `shutdown` is the orderly quit: every PTY gets its hangup, then the program may leave", async () => {
    const connected = boot();
    const first = coreAt(connected, 1);
    const cat = first.client.spawn({ command: "/bin/cat", args: [], cols: 80, rows: 24, env });
    const pid = (await cat.pid)!;

    const quit = Effect.runPromise(connected.server.quit);
    connected.shutdown();
    // Every hangup was decided when quit settled; the signal itself lands next.
    await quit;
    await until(() => !running(pid));
    await until(() => connected.server.live() === 0);
  });

  it("a PTY's scope ends in the epoch-guarded hangup: a reaped pid is never signalled", async () => {
    const kills: Array<string | undefined> = [];
    let alive = true;
    const fake: SpawnPty = () => ({
      pid: 4250,
      onExit: () => ({ dispose: () => undefined }),
      onData: () => ({ dispose: () => undefined }),
      kill: (signal?: string) => kills.push(signal),
      write: () => undefined,
      resize: () => undefined,
    }) as unknown as ReturnType<SpawnPty>;
    const epochs = Layer.succeed(PidEpochs, {
      capture: async (pid) => ({ pid, startKey: "spawned" }),
      isCurrent: async () => alive,
    });
    const scope = Effect.runSync(Scope.make());
    const deps = Layer.mergeAll(
      Layer.succeed(PtySpawner, fake),
      epochs,
      Layer.succeed(CoreLink, {
        parentAsCore: undefined,
        listenParent: () => () => undefined,
      }),
    );
    const context = Effect.runSync(Layer.buildWithScope(Layer.provideMerge(TerminalServer.layer, deps), scope));
    const server = Context.get(context, TerminalServer);
    const { port1, port2 } = new MessageChannel();
    opened.push(port1, port2);
    server.attach(linkOf(port2), 1);
    const core = coreOf(port1);
    await Effect.runPromise(core.calls.TerminalSpawn({ id: 1, command: "/bin/true", args: [], cols: 80, rows: 24 }));

    // Live at close: the hangup lands.
    await Effect.runPromise(Scope.close(scope, Exit.void));
    expect(kills).toEqual(["SIGHUP"]);

    // A stale epoch would drop it: the pid answers for no child of this process.
    kills.length = 0;
    alive = false;
    const second = Effect.runSync(Scope.make());
    const deps2 = Layer.mergeAll(
      Layer.succeed(PtySpawner, fake),
      epochs,
      Layer.succeed(CoreLink, { parentAsCore: undefined, listenParent: () => () => undefined }),
    );
    const context2 = Effect.runSync(Layer.buildWithScope(Layer.provideMerge(TerminalServer.layer, deps2), second));
    const server2 = Context.get(context2, TerminalServer);
    const { port1: p1, port2: p2 } = new MessageChannel();
    opened.push(p1, p2);
    server2.attach(linkOf(p2), 1);
    const core2 = coreOf(p1);
    await Effect.runPromise(core2.calls.TerminalSpawn({ id: 1, command: "/bin/true", args: [], cols: 80, rows: 24 }));
    await Effect.runPromise(Scope.close(second, Exit.void));
    expect(kills).toEqual([]);
  });

  it("a fresh terminal process adopts nothing and spawns what the next core asks", async () => {
    // The old process is gone: a new server knows nothing of its PTYs.
    const connected = boot();
    const first = coreAt(connected, 1);
    const [none] = await Effect.runPromise(first.client.adopt());
    expect(none).toBeUndefined();
    const cat = first.client.spawn({ command: "/bin/cat", args: [], cols: 80, rows: 24, env });
    expect(await cat.pid).toBeGreaterThan(0);
    let echoed = "";
    cat.onData((data) => {
      echoed += data;
    });
    cat.write("fresh process\r");
    await until(() => echoed.includes("fresh process"));
    cat.kill("SIGKILL");
    await until(() => connected.server.live() === 0);
  });
});
