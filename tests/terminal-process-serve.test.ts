/**
 * The terminal process over a real port with real PTYs: a spawn answers at
 * once and its input follows it in order, output and the exit come back as
 * numbered event frames, a size change reaches the child, a signal stops it,
 * and an exited terminal takes no more input or signal. A spawn the child
 * refuses arrives as an error and then an exit.
 *
 * A terminal's commands apply in their `n` order — a gap is held, a repeat
 * dropped — and an adopted terminal takes its first command's `n` as the
 * base it continues from; the events out are `EventFrame`s.
 */
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { RpcClient } from "effect/rpc";
import { clientProtocol, type RpcPort } from "../src/shared/rpc-port";
import { TerminalRpcs } from "../src/contract/terminal/rpcs";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import type {
  TerminalLink,
  TerminalLinkMessage,
} from "../src/contract/terminal/protocol";
import type { Command, Event, ParentCommand } from "../src/contract/terminal/messages";
import type { SurfaceOut } from "../src/contract/terminal/surface";
import {
  CoreLink,
  PidEpochs,
  PtySpawner,
  TerminalServer,
  type SpawnPty,
  type SurfacePort,
} from "../src/terminal/serve";
import { terminalClient, type RemoteTerminal, type RemoteTerminalExit } from "../src/node/terminals/client";

const nodePty = createRequire(import.meta.url)("node-pty") as typeof import("node-pty");
const realPty: SpawnPty = (command, args, options) => nodePty.spawn(command, [...args], options);

const opened: MessagePort[] = [];
const scopes: Scope.Closeable[] = [];
afterEach(async () => {
  for (const port of opened.splice(0)) port.close();
  for (const scope of scopes.splice(0)) await Effect.runPromise(Scope.close(scope, Exit.void));
});

/** One renderer's end of a surface port, as the tests hold it. */
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

/** A link end as the client holds it: a node port moves a surface port inside the posted value. */
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

/**
 * A raw core end, for the tests that drive the frames themselves: every
 * event frame collected, commands posted with or without the port they
 * carry, the RPC group answered through the same port.
 */
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
  // Spawn is command 1; the commands a test posts for a terminal count from 2.
  // A floor keeps an id the client numbered itself out of the client's range.
  const ns = new Map<number, number>();
  const n = (id: number, base = 1): number => {
    const next = Math.max(ns.get(id) ?? base, base) + 1;
    ns.set(id, next);
    return next;
  };
  return {
    events,
    calls,
    n,
    command: (message: Command) => port.postMessage({ kind: "command", message }),
    surfaceOpen: (message: Extract<Command, { readonly _tag: "surfaceOpen" }>, surface: MessagePort) =>
      port.postMessage({ kind: "command", message, port: surface }, [surface]),
  };
};

/**
 * The real server through its layer, with the parent stubbed: `connect` and
 * `shutdown` reach it as the parent's commands would. The scope's close runs
 * the server's orderly quit — every PTY's hangup.
 */
const boot = (spawnPty: SpawnPty, epochs: Layer.Layer<PidEpochs> = PidEpochs.live) => {
  const scope = Effect.runSync(Scope.make());
  scopes.push(scope);
  const listeners = new Set<(command: ParentCommand, port: TerminalLink<SurfacePort> | undefined) => void>();
  const deps = Layer.mergeAll(
    Layer.succeed(PtySpawner, spawnPty),
    epochs,
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
    /** A `connect` from main: the port is already the link it serves, as CoreLink's handler gets it. */
    connect: (link: TerminalLink<SurfacePort>, generation: number) =>
      listeners.forEach((listener) => listener({ _tag: "connect", generation }, link)),
    shutdown: () => listeners.forEach((listener) => listener({ _tag: "shutdown" }, undefined)),
  };
};

const pair = (spawnPty: SpawnPty = realPty) => {
  const { port1, port2 } = new MessageChannel();
  opened.push(port1, port2);
  const { server } = boot(spawnPty);
  server.attach(linkOf(port2), 1);
  return { server, client: terminalClient(clientLinkOf(port1)), core: coreOf(port1) };
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

const settleTurn = () => new Promise((resolve) => setTimeout(resolve, 30));

const spawn = (core: ReturnType<typeof coreOf>, id: number, input: { readonly command: string; readonly args?: readonly string[] } = { command: "/bin/cat" }) =>
  Effect.runPromise(core.calls.TerminalSpawn({ id, command: input.command, args: input.args ?? [], cols: 80, rows: 24, env }));

describe("the terminal process", () => {
  it("echoes input written before the pid is known, and reports the exit", async () => {
    const { client, served } = (() => {
      const { client, server } = pair();
      return { client, served: server };
    })();
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
    const { client, core } = pair();
    const echo = client.spawn({ command: "/bin/echo", args: ["done"], cols: 80, rows: 24, env });
    const seen = record(echo);
    expect((await seen.exit).code).toBe(0);
    const after = { errors: [] as string[] };
    // Listeners on an exited terminal are never called; the push names it.
    echo.onError((error) => after.errors.push(error.message));
    echo.write("too late");
    echo.kill("SIGKILL");
    // A command frame for the exited id is named the same way on the wire:
    // past the client's own n's, on a link the exitAck already removed.
    core.command({ _tag: "write", id: echo.id, n: core.n(echo.id, 40), data: "too late too" });
    await until(() => core.events.some((event) => event._tag === "error" && event.id === echo.id));
    expect(core.events.find((event) => event._tag === "error" && event.id === echo.id)).toMatchObject({
      message: "terminal process already exited",
    });
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
    const { server } = boot(reaped, Layer.succeed(PidEpochs, {
      capture: async (pid) => ({ pid, startKey: "spawned" }),
      isCurrent: async () => alive,
    }));
    server.attach(linkOf(port2), 1);
    const client = terminalClient(clientLinkOf(port1));
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
    const { server } = boot(fake, Layer.succeed(PidEpochs, {
      capture: async (pid) => ({ pid, startKey: "spawned" }),
      isCurrent: () => new Promise<boolean>((resolve) => {
        answer = resolve;
      }),
    }));
    server.attach(linkOf(port2), 1);
    const client = terminalClient(clientLinkOf(port1));
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

  it("stops reading a PTY the core has fallen a megabyte behind on, and reads it again once the core catches up", async () => {
    let emit: ((data: string) => void) | undefined;
    const calls: string[] = [];
    const fake: SpawnPty = () => ({
      pid: 4244,
      onExit: () => ({ dispose: () => undefined }),
      onData: (listener: (data: string) => void) => {
        emit = listener;
        return { dispose: () => undefined };
      },
      pause: () => calls.push("pause"),
      resume: () => calls.push("resume"),
      kill: () => undefined,
      write: () => undefined,
      resize: () => undefined,
    }) as unknown as ReturnType<SpawnPty>;
    const { port1, port2 } = new MessageChannel();
    opened.push(port1, port2);
    const { server } = boot(fake, Layer.succeed(PidEpochs, { capture: async () => undefined, isCurrent: async () => false }));
    server.attach(linkOf(port2), 1);
    const core = coreOf(port1);
    // A core that does not keep up: it answers the spawn and acknowledges nothing.
    void Effect.runPromise(core.calls.TerminalSpawn({ id: 1, command: "/bin/true", args: [], cols: 80, rows: 24 }));
    await until(() => emit !== undefined);
    const chunk = "x".repeat(64 * 1024);
    for (let i = 0; i < 16; i++) emit!(chunk);
    expect(calls).toEqual([]);
    emit!(chunk);
    expect(calls).toEqual(["pause"]);
    emit!(chunk);
    expect(calls).toEqual(["pause"]);
    // Cumulative `throughSeq`: 18 chunks out, so 13 leaves five (320 KiB) held —
    // still over the 256 KiB low mark.
    core.command({ _tag: "ack", id: 1, n: core.n(1), throughSeq: 13 });
    await settleTurn();
    expect(calls).toEqual(["pause"]);
    // Through 15 leaves three (192 KiB): under the mark, so the PTY is read again.
    core.command({ _tag: "ack", id: 1, n: core.n(1), throughSeq: 15 });
    await until(() => calls.length === 2);
    expect(calls).toEqual(["pause", "resume"]);
  });

  it("a core that keeps up acknowledges what it handled, so a fast stream is never paused", async () => {
    const calls: string[] = [];
    const spawnPty: SpawnPty = (command, args, options) => {
      const pty = realPty(command, args, options);
      const { pause, resume } = pty;
      pty.pause = () => {
        calls.push("pause");
        pause.call(pty);
      };
      pty.resume = () => {
        calls.push("resume");
        resume.call(pty);
      };
      return pty;
    };
    const { client } = pair(spawnPty);
    const flood = client.spawn({ command: "/bin/sh", args: ["-c", "head -c 4000000 /dev/zero | tr '\\0' x"], cols: 80, rows: 24, env });
    const seen = record(flood);
    expect((await seen.exit).code).toBe(0);
    expect(seen.output().replace(/[^x]/g, "").length).toBe(4_000_000);
    expect(calls.filter((call) => call === "pause").length).toBe(calls.filter((call) => call === "resume").length);
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

  /** A new core's port on the same terminal process, connected the parent's way. */
  const nextCore = (connected: ReturnType<typeof boot>, generation: number) => {
    const { port1, port2 } = new MessageChannel();
    opened.push(port1, port2);
    connected.connect(linkOf(port2), generation);
    return { client: terminalClient(clientLinkOf(port1)), core: coreOf(port1) };
  };

  const running = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it("a core that is gone leaves its PTY running; the next core adopts it with its screen, and loses no output", async () => {
    const { port1, port2 } = new MessageChannel();
    opened.push(port1, port2);
    const connected = boot(realPty);
    connected.connect(linkOf(port2), 1);
    const client = terminalClient(clientLinkOf(port1));
    const meta = { bindingId: "seat-a" };
    const shell = client.spawn({ command: "/bin/sh", args: ["-c", "printf before; sleep 0.3; printf during; exec cat"], cols: 80, rows: 24, env, meta });
    const seen = record(shell);
    const pid = (await shell.pid)!;
    await until(() => seen.output().includes("before"));
    await settleTurn();
    port2.close();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(running(pid)).toBe(true);
    expect(connected.server.live()).toBe(1);

    const next = nextCore(connected, 2);
    const [taken] = await Effect.runPromise(next.client.adopt());
    expect(taken!.meta).toEqual(meta);
    expect(taken!.adopted).toMatchObject({ pid, cols: 80, rows: 24, meta, seq: 1, history: "before" });
    expect(taken!.adopted.exit).toBeUndefined();
    const after = record(taken!.terminal);
    await until(() => after.output().includes("during"));
    taken!.terminal.write("typed after\r");
    await until(() => after.output().includes("typed after"));
    expect(after.output().match(/during/g)).toHaveLength(1);
    expect(after.output()).not.toContain("before");
    // A spawn on the new core does not take the adopted id.
    const other = next.client.spawn({ command: "/bin/echo", args: ["other"], cols: 80, rows: 24, env });
    expect(other.id).toBeGreaterThan(taken!.terminal.id);
    taken!.terminal.kill("SIGKILL");
    expect((await after.exit).signal).toBe(9);
  });

  it("an exit while no core is there is held, after its output, for the next one", async () => {
    const { port1, port2 } = new MessageChannel();
    opened.push(port1, port2);
    const connected = boot(realPty);
    connected.connect(linkOf(port2), 1);
    const client = terminalClient(clientLinkOf(port1));
    const shell = client.spawn({ command: "/bin/sh", args: ["-c", "sleep 0.2; printf bye; exit 3"], cols: 80, rows: 24, env });
    const pid = (await shell.pid)!;
    port2.close();
    await until(() => connected.server.live() === 0);
    const next = nextCore(connected, 2);
    const [taken] = await Effect.runPromise(next.client.adopt());
    expect(taken!.adopted).toMatchObject({ pid, exit: { code: 3 } });
    const after = record(taken!.terminal);
    expect((await after.exit).code).toBe(3);
    expect(after.output()).toContain("bye");
    await settleTurn();
    expect(await Effect.runPromise(nextCore(connected, 3).client.adopt())).toEqual([]);
  });

  it("an exit posted to a core that died before its port closed is still named by the next adopt", async () => {
    const { port1, port2 } = new MessageChannel();
    opened.push(port1, port2);
    let dead = false;
    const linked = linkOf(port2);
    const dying: TerminalLink<SurfacePort> = {
      post: (message) => {
        if (!dead) linked.post(message);
      },
      transfer: linked.transfer,
      listen: linked.listen,
    };
    const connected = boot(realPty);
    connected.connect(dying, 1);
    const client = terminalClient(clientLinkOf(port1));
    const shell = client.spawn({ command: "/bin/sh", args: ["-c", "sleep 0.2; exit 4"], cols: 80, rows: 24, env });
    const pid = (await shell.pid)!;
    // The core is gone, but its port has not closed: the exit is posted into nothing.
    dead = true;
    await until(() => connected.server.live() === 0);
    await settleTurn();
    connected.server.detach(dying);
    const next = nextCore(connected, 2);
    const [taken] = await Effect.runPromise(next.client.adopt());
    expect(taken!.adopted).toMatchObject({ pid, exit: { code: 4 } });
    expect((await record(taken!.terminal).exit).code).toBe(4);
    await settleTurn();
    expect(await Effect.runPromise(nextCore(connected, 3).client.adopt())).toEqual([]);
  });

  it("history keeps the newest handled output under its bound, cut on a chunk boundary", async () => {
    let emit: ((data: string) => void) | undefined;
    const fake: SpawnPty = () => ({
      pid: 4246,
      onExit: () => ({ dispose: () => undefined }),
      onData: (listener: (data: string) => void) => {
        emit = listener;
        return { dispose: () => undefined };
      },
      pause: () => undefined,
      resume: () => undefined,
      kill: () => undefined,
      write: () => undefined,
      resize: () => undefined,
    }) as unknown as ReturnType<SpawnPty>;
    const { port1, port2 } = new MessageChannel();
    opened.push(port1, port2);
    const connected = boot(fake, Layer.succeed(PidEpochs, { capture: async () => undefined, isCurrent: async () => false }));
    connected.connect(linkOf(port2), 1);
    const client = terminalClient(clientLinkOf(port1));
    const terminal = client.spawn({ command: "/bin/true", args: [], cols: 80, rows: 24 });
    const seen = record(terminal);
    await terminal.pid;
    // 650 KiB handled against a 512 KiB bound: the first chunk goes, and so
    // must the whole second, since keeping part of it would cut mid-chunk.
    const chunks = ["a".repeat(100 * 1024), "b".repeat(450 * 1024), "c".repeat(100 * 1024)];
    for (const chunk of chunks) emit!(chunk);
    await until(() => seen.output().length === 650 * 1024);
    await settleTurn();
    port2.close();
    const [taken] = await Effect.runPromise(nextCore(connected, 2).client.adopt());
    expect(taken!.adopted.seq).toBe(3);
    expect(taken!.adopted.history).toBe(chunks[2]);
  });

  it("with no core a PTY reads to the high mark and stops, and every chunk reaches the next core", async () => {
    let emit: ((data: string) => void) | undefined;
    const calls: string[] = [];
    const fake: SpawnPty = () => ({
      pid: 4245,
      onExit: () => ({ dispose: () => undefined }),
      onData: (listener: (data: string) => void) => {
        emit = listener;
        return { dispose: () => undefined };
      },
      pause: () => calls.push("pause"),
      resume: () => calls.push("resume"),
      kill: () => undefined,
      write: () => undefined,
      resize: () => undefined,
    }) as unknown as ReturnType<SpawnPty>;
    const { port1, port2 } = new MessageChannel();
    opened.push(port1, port2);
    const connected = boot(fake, Layer.succeed(PidEpochs, { capture: async () => undefined, isCurrent: async () => false }));
    connected.connect(linkOf(port2), 1);
    await terminalClient(clientLinkOf(port1)).spawn({ command: "/bin/true", args: [], cols: 80, rows: 24 }).pid;
    port2.close();
    const chunk = "x".repeat(64 * 1024);
    for (let i = 0; i < 17; i++) emit!(chunk);
    expect(calls).toEqual(["pause"]);
    const next = nextCore(connected, 2);
    const [taken] = await Effect.runPromise(next.client.adopt());
    const after = record(taken!.terminal);
    await until(() => after.output().length === 17 * chunk.length);
    await until(() => calls.length === 2);
    expect(calls).toEqual(["pause", "resume"]);
  });

  it("an adopt the terminal process never answers fails tagged when it is lost", async () => {
    const { port1, port2 } = new MessageChannel();
    opened.push(port1, port2);
    const orphan = terminalClient(clientLinkOf(port1));
    const asked = Effect.runPromise(orphan.adopt());
    orphan.fail("the terminal process exited");
    await expect(asked).rejects.toMatchObject({ _tag: "TerminalAdoptFailed", message: "the terminal process exited" });
  });

  it("an orderly quit hangs up every PTY", async () => {
    const { client, server } = pair();
    const cat = client.spawn({ command: "/bin/cat", args: [], cols: 80, rows: 24, env });
    const seen = record(cat);
    await cat.pid;
    client.hangupAll();
    expect((await seen.exit).signal).toBe(1);
    expect(server.live()).toBe(0);
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

  it("a terminal's commands apply in `n` order: a gap is held, a repeat dropped", async () => {
    const { server, core } = (() => {
      const { port1, port2 } = new MessageChannel();
      opened.push(port1, port2);
      const { server } = boot(realPty);
      server.attach(linkOf(port2), 1);
      return { server, core: coreOf(port1) };
    })();
    await spawn(core, 1);
    // Posted 4, 3, 2: the PTY sees them 2, 3, 4. `cat` on a tty answers each
    // line twice — its echo and its output — so order is read by where each
    // marker first lands.
    core.command({ _tag: "write", id: 1, n: 4, data: "four\r" });
    core.command({ _tag: "write", id: 1, n: 3, data: "three\r" });
    core.command({ _tag: "write", id: 1, n: 2, data: "two\r" });
    await until(() => {
      const echoed = core.events.flatMap((event) => (event._tag === "data" ? [event.data] : [])).join("");
      return echoed.includes("four");
    });
    const echoed = core.events.flatMap((event) => (event._tag === "data" ? [event.data] : [])).join("");
    expect(echoed.indexOf("two")).toBeLessThan(echoed.indexOf("three"));
    expect(echoed.indexOf("three")).toBeLessThan(echoed.indexOf("four"));
    // A repeat of 2 applies nowhere.
    core.command({ _tag: "write", id: 1, n: 2, data: "again\r" });
    await settleTurn();
    expect(core.events.flatMap((event) => (event._tag === "data" ? [event.data] : [])).join("")).not.toContain("again");
    core.command({ _tag: "kill", id: 1, n: 5, signal: "SIGKILL" });
    await until(() => server.live() === 0);
  });

  it("a first command for an adopted terminal takes its `n` as the base", async () => {
    const { port1, port2 } = new MessageChannel();
    opened.push(port1, port2);
    const connected = boot(realPty);
    connected.connect(linkOf(port2), 1);
    const core = coreOf(port1);
    await spawn(core, 1);
    port2.close();
    await settleTurn();
    const next = nextCore(connected, 2);
    await Effect.runPromise(next.client.adopt());
    // The new core cannot name the count: the first `n` it sends is the base.
    next.core.command({ _tag: "write", id: 1, n: 42, data: "from the new base\r" });
    await until(() => next.core.events.flatMap((event) => (event._tag === "data" ? [event.data] : [])).join("").includes("from the new base"));
    // Under the base is a repeat; past it, order holds.
    next.core.command({ _tag: "write", id: 1, n: 41, data: "too old\r" });
    next.core.command({ _tag: "write", id: 1, n: 44, data: "four\r" });
    next.core.command({ _tag: "write", id: 1, n: 43, data: "three\r" });
    await until(() => next.core.events.flatMap((event) => (event._tag === "data" ? [event.data] : [])).join("").includes("four"));
    const echoed = next.core.events.flatMap((event) => (event._tag === "data" ? [event.data] : [])).join("");
    expect(echoed).not.toContain("too old");
    expect(echoed.indexOf("three")).toBeLessThan(echoed.indexOf("four"));
    next.core.command({ _tag: "kill", id: 1, n: 45, signal: "SIGKILL" });
  });

  it("a command for an unspawned id waits for its spawn, and a refused spawn drops it", async () => {
    const { port1, port2 } = new MessageChannel();
    opened.push(port1, port2);
    const { server } = boot(realPty);
    server.attach(linkOf(port2), 1);
    const core = coreOf(port1);
    // Written before its spawn is a call, so the write lands first.
    core.command({ _tag: "write", id: 9, n: 2, data: "held for the spawn\r" });
    await spawn(core, 9);
    await until(() => core.events.flatMap((event) => (event._tag === "data" ? [event.data] : [])).join("").includes("held for the spawn"));
    core.command({ _tag: "kill", id: 9, n: 3, signal: "SIGKILL" });
    await until(() => server.live() === 0);
  });

  it("a refused spawn drops the commands held for it", async () => {
    const refusing: SpawnPty = () => {
      throw new Error("posix_spawnp failed");
    };
    const { port1, port2 } = new MessageChannel();
    opened.push(port1, port2);
    const { server } = boot(refusing);
    server.attach(linkOf(port2), 1);
    const core = coreOf(port1);
    core.command({ _tag: "write", id: 9, n: 2, data: "never written\r" });
    await expect(Effect.runPromise(core.calls.TerminalSpawn({ id: 9, command: "/no/such", args: [], cols: 80, rows: 24 }))).rejects.toMatchObject({
      _tag: "TerminalSpawnRefused",
    });
    await settleTurn();
    // Nothing of it is served, and nothing errors it either: the refusal was the answer.
    expect(core.events.filter((event) => event.id === 9)).toEqual([]);
    expect(server.live()).toBe(0);
  });

  it("a command for an id below the adopted `nextId` is not held", async () => {
    const { port1, port2 } = new MessageChannel();
    opened.push(port1, port2);
    const connected = boot(realPty);
    connected.connect(linkOf(port2), 1);
    const core = coreOf(port1);
    await spawn(core, 1);
    port2.close();
    const next = nextCore(connected, 2);
    await Effect.runPromise(next.client.adopt());
    // Id 5 was never spawned and is below nextId: dropped, not held.
    next.core.command({ _tag: "write", id: 5, n: 2, data: "to nobody\r" });
    await settleTurn();
    expect(next.core.events.filter((event) => event.id === 5)).toEqual([]);
    next.core.command({ _tag: "kill", id: 1, n: 2, signal: "SIGKILL" });
  });

  it("`hangupAll` applies at once, outside every terminal's `n`", async () => {
    const { port1, port2 } = new MessageChannel();
    opened.push(port1, port2);
    const { server } = boot(realPty);
    server.attach(linkOf(port2), 1);
    const core = coreOf(port1);
    await spawn(core, 1);
    // A held command behind a gap does not hold the hangup.
    core.command({ _tag: "write", id: 1, n: 5, data: "still held\r" });
    core.command({ _tag: "hangupAll" });
    await until(() => core.events.some((event) => event._tag === "exit" && event.id === 1));
    expect(core.events.find((event) => event._tag === "exit" && event.id === 1)).toMatchObject({ signal: 1 });
    await until(() => server.live() === 0);
  });

  it("a fence is answered once every command posted before it is applied", async () => {
    const { port1, port2 } = new MessageChannel();
    opened.push(port1, port2);
    const { server } = boot(realPty);
    server.attach(linkOf(port2), 1);
    const core = coreOf(port1);
    await spawn(core, 1);
    // The hold must be in force before the fence's answer comes back.
    core.command({ _tag: "hold", id: 1, n: 2, held: true });
    const fenced = Effect.runPromise(core.calls.TerminalFence());
    // A gate for the surface's lease, then a surface, then a key, all posted
    // after the fence call: they arrive behind its answer only on this port,
    // but the hold was already applied when it resolved. Its answer names the
    // last key event each live terminal pushed — none yet, so last k is 0.
    expect(await fenced).toEqual(new Map([[1, 0]]));
    core.command({ _tag: "gate", id: 1, n: 3, lease: { leaseId: "lease-1", epoch: "1" } });
    const { port1: s1, port2: s2 } = new MessageChannel();
    opened.push(s1, s2);
    const seen: SurfaceOut[] = [];
    s1.on("message", (message: SurfaceOut) => seen.push(message));
    s1.start();
    core.surfaceOpen({ _tag: "surfaceOpen", id: 1, n: 4, leaseId: "lease-1", epoch: "1", fromSeq: 1 }, s2);
    s1.postMessage({ t: "in", key: 1, data: "held by the fence's hold\r" });
    // The key is heard (typing) and taken (took), but the hold keeps it off the PTY.
    await until(() => seen.some((message) => message.t === "took") && core.events.some((event) => event._tag === "typing" && event.id === 1));
    await settleTurn();
    expect(core.events.flatMap((event) => (event._tag === "data" ? [event.data] : [])).join("")).not.toContain("held by the fence");
    core.command({ _tag: "hold", id: 1, n: 5, held: false });
    await until(() => core.events.flatMap((event) => (event._tag === "data" ? [event.data] : [])).join("").includes("held by the fence"));
    core.command({ _tag: "kill", id: 1, n: 6, signal: "SIGKILL" });
    await until(() => server.live() === 0);
  });

  it("a connect whose generation is not higher is refused", async () => {
    const { port1, port2 } = new MessageChannel();
    opened.push(port1, port2);
    const { server } = boot(realPty);
    expect(server.attach(linkOf(port2), 2)).toBe(true);
    const core = coreOf(port1);
    await spawn(core, 1);
    const { port1: a1, port2: a2 } = new MessageChannel();
    opened.push(a1, a2);
    expect(server.attach(linkOf(a2), 2)).toBe(false);
    expect(server.attach(linkOf(a2), 1)).toBe(false);
    // The refused port's commands reach nothing; the attached core still serves.
    a1.postMessage({ kind: "command", message: { _tag: "write", id: 1, n: 2, data: "refused\r" } });
    core.command({ _tag: "write", id: 1, n: 2, data: "still served\r" });
    await until(() => core.events.flatMap((event) => (event._tag === "data" ? [event.data] : [])).join("").includes("still served"));
    expect(core.events.flatMap((event) => (event._tag === "data" ? [event.data] : [])).join("")).not.toContain("refused");
    core.command({ _tag: "kill", id: 1, n: 3, signal: "SIGKILL" });
    await until(() => server.live() === 0);
  });
});
