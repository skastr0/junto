/**
 * The core's terminal client applies what the terminal process sends by its
 * numbers, never by arrival: output by `seq`, held past a gap and dropped on
 * a repeat; an exit only once output through its `afterSeq` is applied; key
 * events by `k`. A control event that does not decode is refused at the edge.
 * A fence waits on its own terminal's key events through the `k` the terminal
 * process names for it, and an adopted terminal continues `n` and `k` from
 * where the adoption says they stand.
 */
import { Effect, Exit, Layer, Scope } from "effect";
import { RpcServer } from "effect/rpc";
import { afterEach, describe, expect, it, vi } from "vitest";
import { terminalClient, type RemoteTerminalExit } from "../src/node/terminals/client";
import type { Command, Event, EventFrame } from "../src/contract/terminal/messages";
import type { TerminalLinkMessage, TerminalLinkPort } from "../src/contract/terminal/protocol";
import { TERMINAL_LINK_VERSION, TerminalRpcs, type TerminalAdoption, type TerminalFenced } from "../src/contract/terminal/rpcs";
import { serverProtocol, type PortMessage, type RpcPort } from "../src/shared/rpc-port";

const scopes: Scope.Closeable[] = [];

/** What the stub terminal process answers: a spawn's pid, the adoption, and each fence. */
type Answers = { adoption?: TerminalAdoption; fenced?: TerminalFenced };

const link = (answers: Answers = {}) => {
  const handlers = new Set<(message: TerminalLinkMessage) => void>();
  const posted: TerminalLinkMessage[] = [];
  // The stub terminal process: its RPC server hears the client's calls and answers on the same link.
  const serverHandlers = new Set<(message: PortMessage) => void>();
  const server: RpcPort = {
    post: (message) => { for (const handler of handlers) handler(message as TerminalLinkMessage); },
    listen: (handler) => {
      serverHandlers.add(handler);
      return () => serverHandlers.delete(handler);
    },
  };
  const scope = Effect.runSync(Scope.make());
  scopes.push(scope);
  Effect.runFork(Layer.buildWithScope(
    RpcServer.layer(TerminalRpcs).pipe(
      Layer.provide(TerminalRpcs.toLayer({
        TerminalSpawn: () => Effect.succeed({ pid: 1 }),
        TerminalAdopt: () => Effect.succeed(answers.adoption ?? { version: TERMINAL_LINK_VERSION, terminals: [], nextId: 1 }),
        TerminalFence: () => Effect.succeed(answers.fenced ?? new Map()),
      })),
      Layer.provide(Layer.effect(RpcServer.Protocol, serverProtocol(server))),
    ),
    scope,
  ));
  const port: TerminalLinkPort = {
    post: (message) => {
      posted.push(message);
      if (message.kind === "rpc") for (const handler of serverHandlers) handler(message);
    },
    listen: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
  const send = (message: Event): void => {
    const frame: EventFrame = { kind: "event", message };
    for (const handler of handlers) handler(frame as unknown as TerminalLinkMessage);
  };
  /** The commands posted with this tag, in order. */
  const commands = (tag: Command["_tag"]) =>
    posted.flatMap((message) => (message.kind === "command" && message.message._tag === tag ? [message.message] : []));
  return { port, send, commands, deliver: (message: unknown) => { for (const handler of handlers) handler(message as TerminalLinkMessage); } };
};

const spawned = (port: TerminalLinkPort) => {
  const terminal = terminalClient(port).spawn({ command: "/bin/cat", args: [], cols: 80, rows: 24 });
  const output: string[] = [];
  const exits: RemoteTerminalExit[] = [];
  const keys: string[] = [];
  terminal.onData((data) => void output.push(data));
  terminal.onExit((exit) => void exits.push(exit));
  terminal.onTyping(({ data }) => void keys.push(`typing ${data}`));
  terminal.onInput(({ data }) => void keys.push(`input ${data}`));
  return { terminal, output, exits, keys };
};

afterEach(async () => {
  vi.restoreAllMocks();
  for (const scope of scopes.splice(0)) await Effect.runPromise(Scope.close(scope, Exit.void));
});

/** Settles once `promise` has, or reports it still waiting after a few turns. */
const settled = async (promise: Promise<unknown>): Promise<boolean> => {
  let done = false;
  void promise.then(() => { done = true; });
  for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  return done;
};

describe("the terminal client applies events by number", () => {
  it("holds a chunk past a gap and drops a repeat", () => {
    const { port, send } = link();
    const { terminal, output } = spawned(port);
    send({ _tag: "data", id: terminal.id, seq: 2, data: "b" });
    expect(output).toEqual([]);
    send({ _tag: "data", id: terminal.id, seq: 1, data: "a" });
    send({ _tag: "data", id: terminal.id, seq: 1, data: "a" });
    send({ _tag: "data", id: terminal.id, seq: 3, data: "c" });
    expect(output).toEqual(["a", "b", "c"]);
    expect(terminal.lastSeq()).toBe(3);
  });

  it("applies an exit only once output through its afterSeq is applied", () => {
    const { port, send, commands } = link();
    const { terminal, output, exits } = spawned(port);
    send({ _tag: "data", id: terminal.id, seq: 1, data: "a" });
    send({ _tag: "exit", id: terminal.id, afterSeq: 2, code: 0, signal: undefined });
    expect(exits).toEqual([]);
    expect(commands("exitAck")).toEqual([]);
    send({ _tag: "data", id: terminal.id, seq: 2, data: "b" });
    expect(output).toEqual(["a", "b"]);
    expect(exits).toEqual([{ code: 0, signal: undefined }]);
    expect(commands("exitAck")).toEqual([{ _tag: "exitAck", id: terminal.id, n: 2 }]);
  });

  it("applies typing and input in k order, once each", () => {
    const { port, send } = link();
    const { terminal, keys } = spawned(port);
    send({ _tag: "input", id: terminal.id, k: 2, leaseId: "lease", data: "x" });
    expect(keys).toEqual([]);
    send({ _tag: "typing", id: terminal.id, k: 1, leaseId: "lease", data: "x" });
    send({ _tag: "typing", id: terminal.id, k: 1, leaseId: "lease", data: "x" });
    expect(keys).toEqual(["typing x", "input x"]);
  });

  it("acknowledges each turn's handled output once per terminal, through the last chunk applied", async () => {
    const { port, send, commands } = link();
    const { terminal } = spawned(port);
    send({ _tag: "data", id: terminal.id, seq: 1, data: "ab" });
    send({ _tag: "data", id: terminal.id, seq: 2, data: "cde" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(commands("ack")).toEqual([{ _tag: "ack", id: terminal.id, n: 2, throughSeq: 2 }]);
  });

  it("numbers each terminal's commands from 2, behind its spawn", () => {
    const { port, commands } = link();
    const { terminal } = spawned(port);
    terminal.resize(100, 30);
    terminal.write("x");
    terminal.gate(null);
    expect([...commands("resize"), ...commands("write"), ...commands("gate")].map((command) => "n" in command ? command.n : 0)).toEqual([2, 3, 4]);
  });

  it("refuses a control event that does not decode, and applies nothing of it", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { port, deliver } = link();
    const { terminal, exits } = spawned(port);
    deliver({ kind: "event", message: { _tag: "exit", id: terminal.id, afterSeq: 0, code: "zero", signal: undefined } });
    deliver({ kind: "event", message: { _tag: "exit", id: terminal.id, afterSeq: 0, code: 0, signal: undefined, extra: true } });
    expect(exits).toEqual([]);
    expect(error).toHaveBeenCalledTimes(2);
  });

  it("still reads the old pushes, in the order they came", () => {
    const { port, deliver } = link();
    const { terminal, output, exits } = spawned(port);
    deliver({ kind: "push", channel: "pty.data", payload: { id: terminal.id, data: "a", seq: 1 } });
    deliver({ kind: "push", channel: "pty.exit", payload: { id: terminal.id, code: 1, signal: undefined } });
    expect(output).toEqual(["a"]);
    expect(exits).toEqual([{ code: 1, signal: undefined }]);
  });

  it("a fence waits for its own terminal's key events through the k the terminal process names", async () => {
    const { port, send } = link({ fenced: new Map([[1, 2], [2, 5]]) });
    const client = terminalClient(port);
    const a = client.spawn({ command: "/bin/cat", args: [], cols: 80, rows: 24 });
    const b = client.spawn({ command: "/bin/cat", args: [], cols: 80, rows: 24 });
    const fenced = a.fence();
    send({ _tag: "typing", id: a.id, k: 1, leaseId: "lease", data: "x" });
    // Another terminal's keys, however many, do not release this fence.
    for (let k = 1; k <= 5; k += 1) send({ _tag: "typing", id: b.id, k, leaseId: "lease", data: "y" });
    expect(await settled(fenced)).toBe(false);
    send({ _tag: "input", id: a.id, k: 2, leaseId: "lease", data: "x" });
    expect(await settled(fenced)).toBe(true);
  });

  it("a fence whose keys were applied before its answer resolves at once", async () => {
    const { port, send } = link({ fenced: new Map([[1, 1]]) });
    const terminal = terminalClient(port).spawn({ command: "/bin/cat", args: [], cols: 80, rows: 24 });
    send({ _tag: "typing", id: terminal.id, k: 1, leaseId: "lease", data: "x" });
    expect(await settled(terminal.fence())).toBe(true);
  });

  it("a fence on a terminal that ends resolves: nothing is left to type", async () => {
    const { port, send } = link({ fenced: new Map([[1, 3]]) });
    const { terminal } = spawned(port);
    const fenced = terminal.fence();
    expect(await settled(fenced)).toBe(false);
    send({ _tag: "exit", id: terminal.id, afterSeq: 0, code: 0, signal: undefined });
    expect(await settled(fenced)).toBe(true);
  });

  it("an adopted terminal continues n from lastN and k from lastK", async () => {
    const { port, send, commands } = link({
      adoption: {
        version: TERMINAL_LINK_VERSION,
        terminals: [{ id: 7, pid: 70, cols: 80, rows: 24, history: "", seq: 3, lastN: 9, lastK: 4 }],
        nextId: 8,
      },
    });
    const client = terminalClient(port);
    const [adopted] = await Effect.runPromise(client.adopt());
    const terminal = adopted!.terminal;
    const keys: string[] = [];
    terminal.onTyping(({ data }) => void keys.push(data));
    terminal.write("x");
    expect(commands("write")).toEqual([{ _tag: "write", id: 7, n: 10, data: "x" }]);
    send({ _tag: "typing", id: 7, k: 4, leaseId: "lease", data: "went to the last core" });
    send({ _tag: "typing", id: 7, k: 5, leaseId: "lease", data: "new" });
    expect(keys).toEqual(["new"]);
    // The next spawn is named past every id the terminal process knows.
    expect(client.spawn({ command: "/bin/cat", args: [], cols: 80, rows: 24 }).id).toBe(8);
  });
});
