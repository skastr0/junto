/**
 * Surface ports in the terminal process: a `surfaceOpen` command frame with
 * its port moved beside it joins a renderer lease to one PTY. A numbered key
 * from it reaches the PTY and its echo comes back on the same port, with
 * nothing on the core's side in between; each key is answered `took` by its
 * number. The core hears every key as it arrives, `k`-numbered `typing`
 * events, refused ones included, and again once it landed as `input`. Only
 * the lease the core's gate names writes, key by key: closed until named, a
 * second or stale lease dropped. A held span queues keys and writes them in
 * order at release, each checked again; a closed gate drops what was held.
 * A surface opened late is given the output it missed from the ring, or told
 * there is a gap; an exit or a lease end closes it. Real PTYs.
 */
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { RpcClient } from "effect/rpc";
import { clientProtocol, type RpcPort } from "../src/shared/rpc-port";
import { TerminalRpcs } from "../src/contract/terminal/rpcs";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import type { TerminalLink, TerminalLinkMessage } from "../src/contract/terminal/protocol";
import type { Command, Event, ParentCommand } from "../src/contract/terminal/messages";
import type { SurfaceIn, SurfaceOut } from "../src/contract/terminal/surface";
import {
  CoreLink,
  PidEpochs,
  PtySpawner,
  SURFACE_RING_BYTES,
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

const until = async (check: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

/** The real server through its layer, with the parent stubbed. */
const boot = (spawnPty: SpawnPty) => {
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
  return Context.get(context, TerminalServer);
};

/** A raw core end: every event collected, commands and their ports posted, the RPC group answered. */
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
  const ns = new Map<number, number>();
  return {
    events,
    calls,
    /** The commands a test posts for a terminal count from 2: its spawn was 1. */
    n: (id: number): number => {
      const next = (ns.get(id) ?? 1) + 1;
      ns.set(id, next);
      return next;
    },
    command: (message: Command) => port.postMessage({ kind: "command", message }),
    /** A `surfaceOpen` with its port moved beside it, as the link carries one. */
    surfaceOpen: (message: Extract<Command, { readonly _tag: "surfaceOpen" }>, surface: MessagePort) =>
      port.postMessage({ kind: "command", message, port: surface }, [surface]),
    typing: (id: number) => events.flatMap((event) => (event._tag === "typing" && event.id === id ? [event.data] : [])),
    input: (id: number) => events.flatMap((event) => (event._tag === "input" && event.id === id ? [event.data] : [])),
    keyEvents: (id: number) => events.flatMap((event) => (event._tag === "typing" || event._tag === "input") && event.id === id ? [event] : []),
  };
};

const setup = (spawnPty: SpawnPty = realPty) => {
  const { port1, port2 } = new MessageChannel();
  opened.push(port1, port2);
  const server = boot(spawnPty);
  server.attach(linkOf(port2), 1);
  return { server, core: coreOf(port1), client: terminalClient(clientLinkOf(port1)) };
};

const spawn = (core: ReturnType<typeof coreOf>, id: number, command: string, args: readonly string[] = []) =>
  Effect.runPromise(core.calls.TerminalSpawn({ id, command, args, cols: 80, rows: 24, env }));

/** The renderer's end: everything the surface was sent, and a way to type a numbered key. */
const surface = (core: ReturnType<typeof coreOf>, id: number, leaseId: string, fromSeq = 1, epoch = "1") => {
  const { port1, port2 } = new MessageChannel();
  opened.push(port1, port2);
  const seen: SurfaceOut[] = [];
  port1.on("message", (message: SurfaceOut) => seen.push(message));
  port1.start();
  let key = 0;
  core.surfaceOpen({ _tag: "surfaceOpen", id, n: core.n(id), leaseId, epoch, fromSeq }, port2);
  return {
    seen,
    text: () => seen.flatMap((message) => (message.t === "out" ? [message.data] : [])).join(""),
    type: (data: string) => port1.postMessage({ t: "in", key: ++key, data } satisfies SurfaceIn),
  };
};

const lease1 = { leaseId: "lease-1", epoch: "1" };

const env = { PATH: process.env.PATH, TERM: "xterm-256color" };

describe("surface ports in the terminal process", () => {
  it("a key from a surface echoes on it, and the core hears the key", async () => {
    const { server, core } = setup();
    await spawn(core, 1, "/bin/cat");
    core.command({ _tag: "gate", id: 1, n: core.n(1), lease: lease1 });
    await settle();
    const lead = surface(core, 1, "lease-1");
    lead.type("hello\r");
    await until(() => lead.text().includes("hello"));
    expect(core.input(1)).toEqual(["hello\r"]);
    const seqs = lead.seen.flatMap((message) => (message.t === "out" ? [message.seq] : []));
    expect(seqs).toEqual(seqs.map((_, index) => index + 1));
    core.command({ _tag: "kill", id: 1, n: core.n(1), signal: "SIGKILL" });
    await until(() => server.live() === 0);
  });

  it("numbers the key events it posts, in arrival order", async () => {
    const { server, core } = setup();
    await spawn(core, 1, "/bin/cat");
    core.command({ _tag: "gate", id: 1, n: core.n(1), lease: lease1 });
    await settle();
    const lead = surface(core, 1, "lease-1");
    lead.type("a");
    lead.type("b");
    await until(() => core.keyEvents(1).length === 4);
    // Each key arrives as typing, then lands as input: 1, 2, 3, 4.
    expect(core.keyEvents(1).map((event) => event.k)).toEqual([1, 2, 3, 4]);
    expect(core.keyEvents(1).map((event) => event._tag)).toEqual(["typing", "input", "typing", "input"]);
    core.command({ _tag: "kill", id: 1, n: core.n(1), signal: "SIGKILL" });
    await until(() => server.live() === 0);
  });

  it("drops keys until the core opens the gate", async () => {
    const { server, core } = setup();
    await spawn(core, 1, "/bin/cat");
    const lead = surface(core, 1, "lease-1");
    lead.type("before\r");
    await settle();
    expect(lead.text()).toBe("");
    expect(core.input(1)).toEqual([]);
    core.command({ _tag: "gate", id: 1, n: core.n(1), lease: lease1 });
    // The gate and the key cross different ports; a key wins no race to it.
    await settle();
    lead.type("after\r");
    await until(() => lead.text().includes("after"));
    expect(lead.text()).not.toContain("before");
    core.command({ _tag: "kill", id: 1, n: core.n(1), signal: "SIGKILL" });
    await until(() => server.live() === 0);
  });

  it("a held span queues keys and writes them in order at release", async () => {
    const { server, core } = setup();
    await spawn(core, 1, "/bin/cat");
    core.command({ _tag: "gate", id: 1, n: core.n(1), lease: lease1 });
    core.command({ _tag: "hold", id: 1, n: core.n(1), held: true });
    await settle();
    const lead = surface(core, 1, "lease-1");
    lead.type("one ");
    lead.type("two\r");
    await settle();
    expect(lead.text()).toBe("");
    core.command({ _tag: "hold", id: 1, n: core.n(1), held: false });
    await until(() => lead.text().includes("one two"));
    expect(core.input(1)).toEqual(["one ", "two\r"]);
    core.command({ _tag: "kill", id: 1, n: core.n(1), signal: "SIGKILL" });
    await until(() => server.live() === 0);
  });

  it("closing the gate drops what a span held", async () => {
    const { server, core } = setup();
    await spawn(core, 1, "/bin/cat");
    core.command({ _tag: "gate", id: 1, n: core.n(1), lease: lease1 });
    core.command({ _tag: "hold", id: 1, n: core.n(1), held: true });
    await settle();
    const lead = surface(core, 1, "lease-1");
    lead.type("held\r");
    await settle();
    core.command({ _tag: "gate", id: 1, n: core.n(1), lease: null });
    core.command({ _tag: "hold", id: 1, n: core.n(1), held: false });
    await settle();
    expect(lead.text()).toBe("");
    expect(core.input(1)).toEqual([]);
    core.command({ _tag: "kill", id: 1, n: core.n(1), signal: "SIGKILL" });
    await until(() => server.live() === 0);
  });

  it("a second lease on an open gate writes nothing, and the core still hears it type", async () => {
    const { server, core } = setup();
    await spawn(core, 1, "/bin/cat");
    core.command({ _tag: "gate", id: 1, n: core.n(1), lease: lease1 });
    await settle();
    const lead = surface(core, 1, "lease-1");
    const other = surface(core, 1, "lease-2");
    other.type("intruder\r");
    lead.type("owner\r");
    await until(() => lead.text().includes("owner"));
    await settle();
    expect(lead.text()).not.toContain("intruder");
    expect(core.input(1)).toEqual(["owner\r"]);
    expect(core.typing(1)).toEqual(expect.arrayContaining(["intruder\r", "owner\r"]));
    core.command({ _tag: "kill", id: 1, n: core.n(1), signal: "SIGKILL" });
    await until(() => server.live() === 0);
  });

  it("a lease of another generation writes nothing", async () => {
    const { server, core } = setup();
    await spawn(core, 1, "/bin/cat");
    core.command({ _tag: "gate", id: 1, n: core.n(1), lease: lease1 });
    await settle();
    const stale = surface(core, 1, "lease-1", 1, "0");
    stale.type("stale\r");
    await settle();
    expect(core.input(1)).toEqual([]);
    core.command({ _tag: "kill", id: 1, n: core.n(1), signal: "SIGKILL" });
    await until(() => server.live() === 0);
  });

  it("a held key from a lease that lost control is dropped at release", async () => {
    const { server, core } = setup();
    await spawn(core, 1, "/bin/cat");
    core.command({ _tag: "gate", id: 1, n: core.n(1), lease: lease1 });
    core.command({ _tag: "hold", id: 1, n: core.n(1), held: true });
    await settle();
    const lead = surface(core, 1, "lease-1");
    const next = surface(core, 1, "lease-2");
    lead.type("from the old lease\r");
    await until(() => core.typing(1).length === 1);
    // Taken over while the span held the key.
    core.command({ _tag: "gate", id: 1, n: core.n(1), lease: { leaseId: "lease-2", epoch: "1" } });
    core.command({ _tag: "hold", id: 1, n: core.n(1), held: false });
    await settle();
    next.type("from the new lease\r");
    await until(() => next.text().includes("from the new lease"));
    expect(next.text()).not.toContain("old lease");
    expect(core.input(1)).toEqual(["from the new lease\r"]);
    core.command({ _tag: "kill", id: 1, n: core.n(1), signal: "SIGKILL" });
    await until(() => server.live() === 0);
  });

  it("a refused key still reaches the core as typing", async () => {
    const { server, core } = setup();
    await spawn(core, 1, "/bin/cat");
    const lead = surface(core, 1, "lease-1");
    lead.type("x");
    await until(() => core.typing(1).length === 1);
    expect(core.typing(1)).toEqual(["x"]);
    expect(core.input(1)).toEqual([]);
    core.command({ _tag: "kill", id: 1, n: core.n(1), signal: "SIGKILL" });
    await until(() => server.live() === 0);
  });

  it("a late surface is given what it missed from the ring, or told of a gap", async () => {
    const { server, core } = setup();
    await spawn(core, 1, "/bin/sh", ["-c", "printf early; read go; printf late"]);
    core.command({ _tag: "gate", id: 1, n: core.n(1), lease: lease1 });
    const first = surface(core, 1, "lease-1");
    await until(() => first.text().includes("early"));
    const late = surface(core, 1, "lease-2", 1);
    await until(() => late.text().includes("early"));
    first.type("\r");
    await until(() => late.text().includes("late"));
    core.command({ _tag: "kill", id: 1, n: core.n(1), signal: "SIGKILL" });
    await until(() => server.live() === 0);

    const big = setup();
    await spawn(big.core, 1, "/bin/sh", ["-c", `head -c ${SURFACE_RING_BYTES * 2} /dev/zero | tr '\\0' x; read go`]);
    await until(() => big.core.events.flatMap((event) => (event._tag === "data" ? [event.data.length] : [])).reduce((a, b) => a + b, 0) >= SURFACE_RING_BYTES * 2);
    const behind = surface(big.core, 1, "lease-3", 1);
    await until(() => behind.seen.length > 0);
    expect(behind.seen[0]).toEqual({ t: "gap" });
    // The gap ends the port: a key typed after it is not taken, so the view sends it again elsewhere.
    big.core.command({ _tag: "gate", id: 1, n: big.core.n(1), lease: { leaseId: "lease-3", epoch: "1" } });
    behind.type("go\r");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(behind.seen).toEqual([{ t: "gap" }]);
    big.core.command({ _tag: "kill", id: 1, n: big.core.n(1), signal: "SIGKILL" });
  });

  it("says it took each key, by its own number, gated or not", async () => {
    const { server, core } = setup();
    await spawn(core, 1, "/bin/cat");
    const view = surface(core, 1, "lease-1");
    view.type("a");
    view.type("b");
    await until(() => view.seen.filter((message) => message.t === "took").length === 2);
    expect(view.seen.filter((message) => message.t === "took")).toEqual([{ t: "took", key: 1 }, { t: "took", key: 2 }]);
    core.command({ _tag: "kill", id: 1, n: core.n(1), signal: "SIGKILL" });
    await until(() => server.live() === 0);
  });

  it("an exit or a lease end closes the surface", async () => {
    const { server, core } = setup();
    await spawn(core, 1, "/bin/cat");
    const one = surface(core, 1, "lease-1");
    const two = surface(core, 1, "lease-2");
    core.command({ _tag: "surfaceEnd", id: 1, n: core.n(1), leaseId: "lease-1" });
    await until(() => one.seen.some((message) => message.t === "end"));
    expect(two.seen.some((message) => message.t === "end")).toBe(false);
    core.command({ _tag: "kill", id: 1, n: core.n(1), signal: "SIGKILL" });
    await until(() => two.seen.some((message) => message.t === "end"));
    const gone = surface(core, 1, "lease-3");
    await until(() => gone.seen.some((message) => message.t === "end"));
    await until(() => server.live() === 0);
  });

  it("a surface opened through the client reaches the PTY, whichever protocol the client posts", async () => {
    const { server, client, core } = setup();
    const pty = client.spawn({ command: "/bin/cat", args: [], cols: 80, rows: 24, env });
    await pty.pid;
    pty.gate(lease1);
    const { port1: s1, port2: s2 } = new MessageChannel();
    opened.push(s1, s2);
    const seen: SurfaceOut[] = [];
    s1.on("message", (message: SurfaceOut) => seen.push(message));
    s1.start();
    pty.openSurface(lease1, 1, s2);
    s1.postMessage({ t: "in", key: 1, data: "through the client\r" } satisfies SurfaceIn);
    await until(() => seen.some((message) => message.t === "out" && message.data.includes("through the client")));
    expect(core.input(pty.id)).toContain("through the client\r");
    pty.kill("SIGKILL");
    await until(() => server.live() === 0);
  });
});
