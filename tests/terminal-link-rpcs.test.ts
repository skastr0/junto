/**
 * The terminal link's calls (src/contract/terminal/rpcs.ts) over a real
 * MessageChannel: the terminal process decodes what the core asks, closed,
 * so a payload of the wrong shape is refused at its edge and never reaches a
 * spawn; the core decodes the answer; a core of another link version adopts
 * nothing and leaves the PTYs running; a command frame posted before its
 * spawn reaches the terminal process waits for it, and one for a refused
 * spawn goes with the refusal. The server is the real one, through its layer.
 */
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { Context, Effect, Exit, Layer, Result, Schema, Scope } from "effect";
import { RpcClient, type RpcClientError, type RpcGroup } from "effect/rpc";
import { afterEach, describe, expect, it } from "vitest";
import { clientProtocol, type RpcPort } from "../src/shared/rpc-port";
import type { TerminalLink, TerminalLinkMessage } from "../src/contract/terminal/protocol";
import { TERMINAL_LINK_VERSION, TerminalAdopted, TerminalFenced, TerminalRpcs } from "../src/contract/terminal/rpcs";
import { TerminalAck, TerminalConnect, TerminalData, TerminalExit, TerminalInput, TerminalResize, TerminalSurfaceOpen, TerminalTyping } from "../src/contract/terminal/messages";
import { CoreLink, PidEpochs, PtySpawner, TerminalServer, type SpawnPty, type SurfacePort } from "../src/terminal/serve";
import { commandEdge, eventEdge, parentEdge } from "../src/contract/terminal/edge";
import type { Command, CommandHandlers, Event, EventHandlers, ParentCommandHandlers, PortlessCommandFrame } from "../src/contract/terminal/messages";

const opened: MessagePort[] = [];
const scopes: Scope.Closeable[] = [];
afterEach(async () => {
  for (const port of opened.splice(0)) port.close();
  for (const scope of scopes.splice(0)) await Effect.runPromise(Scope.close(scope, Exit.void));
});

/** The terminal process's end of a core link. No test here opens a surface, so no port rides in. */
const servedLinkOf = (port: MessagePort): TerminalLink<SurfacePort> => ({
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

/** The core's end, raw: its RPC through the port, its commands posted as frames, and the events it hears. */
type CoreEnd = RpcPort & {
  readonly command: (message: PortlessCommandFrame["message"]) => void;
  readonly onEvent: (handler: (event: Event) => void) => () => void;
};

const coreEndOf = (port: MessagePort): CoreEnd => ({
  post: (message) => port.postMessage(message),
  listen: (handler) => {
    port.on("message", handler);
    port.start();
    return () => port.off("message", handler);
  },
  command: (message) => port.postMessage({ kind: "command", message } satisfies PortlessCommandFrame),
  onEvent: (handler) => {
    const on = (message: TerminalLinkMessage) => {
      if (message.kind === "event") handler(message.message);
    };
    port.on("message", on);
    return () => port.off("message", on);
  },
});

/** A PTY that records what reached it and never runs anything. */
const recordingPty = () => {
  const spawned: string[] = [];
  const written: string[] = [];
  const spawnPty: SpawnPty = (command) => {
    if (command === "/refused") throw new Error("posix_spawnp failed");
    spawned.push(command);
    return {
      pid: 4242,
      onExit: () => ({ dispose: () => undefined }),
      onData: () => ({ dispose: () => undefined }),
      write: (data: string) => written.push(data),
      resize: () => undefined,
      kill: () => undefined,
      pause: () => undefined,
      resume: () => undefined,
    } as unknown as ReturnType<SpawnPty>;
  };
  return { spawned, written, spawnPty };
};

/** The real server through its layer, with no parent and no process table, attached to one core. */
const link = (spawnPty: SpawnPty): CoreEnd => {
  const { port1, port2 } = new MessageChannel();
  opened.push(port1, port2);
  const scope = Effect.runSync(Scope.make());
  scopes.push(scope);
  const deps = Layer.mergeAll(
    Layer.succeed(PtySpawner, spawnPty),
    Layer.succeed(PidEpochs, { capture: async () => undefined, isCurrent: async () => false }),
    Layer.succeed(CoreLink, { parentAsCore: undefined, listenParent: () => () => undefined }),
  );
  const context = Effect.runSync(Layer.buildWithScope(Layer.provideMerge(TerminalServer.layer, deps), scope));
  Context.get(context, TerminalServer).attach(servedLinkOf(port2), 1);
  return coreEndOf(port1);
};

type Calls = RpcClient.RpcClient<RpcGroup.Rpcs<typeof TerminalRpcs>, RpcClientError.RpcClientError>;

/** One call on a fresh client of the group, in its own scope. */
const ask = <A, E>(core: RpcPort, call: (calls: Calls) => Effect.Effect<A, E>) =>
  Effect.runPromiseExit(Effect.scoped(
    RpcClient.make(TerminalRpcs).pipe(
      Effect.provideServiceEffect(RpcClient.Protocol, clientProtocol(core)),
      Effect.flatMap(call),
    ),
  ));

const until = async (check: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe("the terminal link's calls", () => {
  it("answers a spawn with its pid, decoded on the core's side", async () => {
    const pty = recordingPty();
    const exit = await ask(link(pty.spawnPty), (calls) => calls.TerminalSpawn({ id: 1, command: "/bin/cat", args: [], cols: 80, rows: 24 }));
    expect(exit).toEqual(Exit.succeed({ pid: 4242 }));
    expect(pty.spawned).toEqual(["/bin/cat"]);
  });

  it("refuses a spawn of the wrong shape at the terminal process's edge, and spawns nothing", async () => {
    const pty = recordingPty();
    const core = link(pty.spawnPty);
    // What a core from a drifted build would post: cols as text, and a field the contract does not name.
    const malformed = { id: 1, command: "/bin/cat", args: [], cols: "80", rows: 24, shell: true } as never;
    const exit = await ask(core, (calls) => calls.TerminalSpawn(malformed));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(pty.spawned).toEqual([]);
  });

  it("answers a refused spawn with the tagged refusal", async () => {
    const exit = await ask(link(recordingPty().spawnPty), (calls) => calls.TerminalSpawn({ id: 1, command: "/refused", args: [], cols: 80, rows: 24 }));
    expect(exit).toMatchObject({ _tag: "Failure" });
    expect(JSON.stringify(exit)).toContain("TerminalSpawnRefused");
    expect(JSON.stringify(exit)).toContain("posix_spawnp failed");
  });

  it("refuses an adoption from another link version, and keeps the PTY", async () => {
    const pty = recordingPty();
    const core = link(pty.spawnPty);
    await ask(core, (calls) => calls.TerminalSpawn({ id: 7, command: "/bin/cat", args: [], cols: 80, rows: 24 }));
    const refused = await ask(core, (calls) => calls.TerminalAdopt({ version: TERMINAL_LINK_VERSION + 1 }));
    expect(JSON.stringify(refused)).toContain("TerminalLinkVersionMismatch");
    const adopted = await ask(core, (calls) => calls.TerminalAdopt({ version: TERMINAL_LINK_VERSION }));
    expect(adopted).toMatchObject({ _tag: "Success", value: { version: TERMINAL_LINK_VERSION, nextId: 8, terminals: [{ id: 7, pid: 4242 }] } });
  });

  it("holds a write posted before its spawn, and drops one whose spawn was refused", async () => {
    const pty = recordingPty();
    const core = link(pty.spawnPty);
    // Spawn is each terminal's command 1, so its first command after it is 2.
    core.command({ _tag: "write", id: 1, n: 2, data: "before the spawn" });
    core.command({ _tag: "write", id: 2, n: 2, data: "for a refused spawn" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pty.written).toEqual([]);
    await ask(core, (calls) => calls.TerminalSpawn({ id: 2, command: "/refused", args: [], cols: 80, rows: 24 }));
    await ask(core, (calls) => calls.TerminalSpawn({ id: 1, command: "/bin/cat", args: [], cols: 80, rows: 24 }));
    await until(() => pty.written.length > 0);
    expect(pty.written).toEqual(["before the spawn"]);
  });

  it("after an adoption, holds nothing for an id below the next one it named, since no core spawns it again", async () => {
    const pty = recordingPty();
    const core = link(pty.spawnPty);
    await ask(core, (calls) => calls.TerminalSpawn({ id: 5, command: "/bin/cat", args: [], cols: 80, rows: 24 }));
    const adopted = await ask(core, (calls) => calls.TerminalAdopt({ version: TERMINAL_LINK_VERSION }));
    expect(adopted).toMatchObject({ _tag: "Success", value: { nextId: 6 } });
    // Id 3 was never spawned here and is below 6: it is not held.
    const errors: unknown[] = [];
    core.onEvent((event) => {
      if (event._tag === "error") errors.push({ id: event.id, message: event.message });
    });
    core.command({ _tag: "write", id: 3, n: 2, data: "for an id no core spawns" });
    await until(() => errors.length > 0);
    expect(errors).toEqual([{ id: 3, message: "terminal process already exited" }]);
    // Id 6 may still be spawned: its write waits for it.
    core.command({ _tag: "write", id: 6, n: 2, data: "for the next spawn" });
    await ask(core, (calls) => calls.TerminalSpawn({ id: 6, command: "/bin/cat", args: [], cols: 80, rows: 24 }));
    await until(() => pty.written.length > 0);
    expect(pty.written).toEqual(["for the next spawn"]);
  });
});

/** A command record that keeps every message it is handed, with the port beside it when one came. */
const recordingCommands = () => {
  const heard: Array<{ readonly message: Command; readonly port?: string }> = [];
  const keep = (message: Command) => heard.push({ message });
  const handlers: CommandHandlers<string> = {
    write: keep, resize: keep, kill: keep, ack: keep, gate: keep, hold: keep,
    surfaceOpen: (message, port) => heard.push({ message, port }),
    surfaceEnd: keep, exitAck: keep, hangupAll: keep,
  };
  return { heard, handlers };
};

describe("the terminal link's one-way edges", () => {
  it("passes a hot message by its tag, the same object, with no decode", () => {
    const { heard, handlers } = recordingCommands();
    const enter = commandEdge(handlers);
    // An extra field on a hot tag is not looked at: the hot path never decodes.
    const write = { _tag: "write", id: 1, n: 2, data: "ls\r", extra: true };
    const ack = { _tag: "ack", id: 1, n: 3, throughSeq: 9 };
    expect(Result.isSuccess(enter(write))).toBe(true);
    expect(Result.isSuccess(enter(ack))).toBe(true);
    expect(heard[0]!.message).toBe(write);
    expect(heard[1]!.message).toBe(ack);
  });

  it("decodes a control message closed, and refuses a drifted or extra field before any handler", () => {
    const { heard, handlers } = recordingCommands();
    const enter = commandEdge(handlers);
    expect(Result.isSuccess(enter({ _tag: "resize", id: 1, n: 2, cols: 120, rows: 40 }))).toBe(true);
    expect(heard.map(({ message }) => message)).toEqual([{ _tag: "resize", id: 1, n: 2, cols: 120, rows: 40 }]);
    const drifted = enter({ _tag: "resize", id: 1, n: 3, cols: "120", rows: 40 });
    const extra = enter({ _tag: "gate", id: 1, n: 4, lease: null, force: true });
    const badSignal = enter({ _tag: "kill", id: 1, n: 5, signal: "SIGNOPE" });
    for (const refused of [drifted, extra, badSignal]) {
      expect(Result.isFailure(refused)).toBe(true);
      expect(Result.isFailure(refused) && refused.failure._tag).toBe("LinkFrameRefused");
    }
    expect(heard).toHaveLength(1);
  });

  it("refuses an untagged message, an unknown tag, a tag of the other direction, and a prototype key", () => {
    const { heard, handlers } = recordingCommands();
    const enter = commandEdge(handlers);
    for (const message of [null, "write", { id: 1 }, { _tag: "paste", id: 1, n: 2 }, { _tag: "data", id: 1, seq: 1, data: "x" }, { _tag: "constructor" }]) {
      const refused = enter(message);
      expect(Result.isFailure(refused)).toBe(true);
    }
    expect(heard).toEqual([]);
  });

  it("hands a port-carrying message its port, and refuses one that came without it", () => {
    const { heard, handlers } = recordingCommands();
    const enter = commandEdge(handlers);
    const open = { _tag: "surfaceOpen", id: 1, n: 4, leaseId: "lease", epoch: "e1", fromSeq: 1 };
    expect(Result.isFailure(enter(open))).toBe(true);
    expect(Result.isSuccess(enter(open, "the surface port"))).toBe(true);
    expect(heard).toEqual([{ message: open, port: "the surface port" }]);
  });

  it("decodes every parent command, and attaches a core only with its port", () => {
    const heard: unknown[] = [];
    const handlers: ParentCommandHandlers<string> = {
      connect: (message, port) => heard.push([message.generation, port]),
      shutdown: (message) => heard.push(message._tag),
    };
    const enter = parentEdge(handlers);
    expect(Result.isFailure(enter({ _tag: "connect", generation: 2 }))).toBe(true);
    expect(Result.isFailure(enter({ _tag: "connect", generation: "2" }, "core port"))).toBe(true);
    expect(Result.isSuccess(enter({ _tag: "connect", generation: 2 }, "core port"))).toBe(true);
    expect(Result.isSuccess(enter({ _tag: "shutdown" }))).toBe(true);
    expect(heard).toEqual([[2, "core port"], "shutdown"]);
  });

  it("on the core's side, passes output and keys raw and decodes an exit and an error closed", () => {
    const heard: Event[] = [];
    const keep = (message: Event) => heard.push(message);
    const handlers: EventHandlers = { data: keep, exit: keep, error: keep, typing: keep, input: keep };
    const enter = eventEdge(handlers);
    const data = { _tag: "data", id: 1, seq: 7, data: "out" };
    expect(Result.isSuccess(enter(data))).toBe(true);
    expect(heard[0]).toBe(data);
    expect(Result.isSuccess(enter({ _tag: "exit", id: 1, afterSeq: 7, code: 0, signal: undefined }))).toBe(true);
    expect(Result.isFailure(enter({ _tag: "exit", id: 1, code: 0, signal: undefined }))).toBe(true);
    expect(Result.isFailure(enter({ _tag: "error", id: 1, message: "EIO", stack: "" }))).toBe(true);
    expect(heard).toHaveLength(2);
  });

  it("fails the compile of a record that lacks a handler or names a tag the link does not have", () => {
    const keep = () => undefined;
    // @ts-expect-error: no handler for input.
    const missing: EventHandlers = { data: keep, exit: keep, error: keep, typing: keep };
    // @ts-expect-error: paste is no event of this link.
    const extra: EventHandlers = { data: keep, exit: keep, error: keep, typing: keep, input: keep, paste: keep };
    const drifted: ParentCommandHandlers<string> = {
      // @ts-expect-error: a handler written for a connect whose generation is text no longer handles the contract's.
      connect: (_message: { readonly _tag: "connect"; readonly generation: string }) => undefined,
      shutdown: keep,
    };
    const end = { post: () => undefined, transfer: () => undefined, listen: () => () => undefined } satisfies TerminalLink<string>;
    const open = { _tag: "surfaceOpen", id: 1, n: 2, leaseId: "lease", epoch: "e1", fromSeq: 1 } as const;
    const typed: TerminalLink<string> = end;
    // @ts-expect-error: a surfaceOpen frame goes only through transfer, with its port.
    typed.post({ kind: "command", message: open });
    typed.transfer({ kind: "command", message: open }, "the surface port");
    // @ts-expect-error: transfer takes no frame that carries no port.
    typed.transfer({ kind: "command", message: { _tag: "write", id: 1, n: 3, data: "x" } }, "the surface port");
    expect([missing, extra, drifted]).toHaveLength(3);
  });
});

describe("the terminal link's answers, as the RPC codec carries them", () => {
  const json = <S extends Schema.Top>(schema: S) => Schema.toCodecJson(schema);

  it("carries the fence answer, terminal id to last key event, as JSON-safe pairs and back to a map", () => {
    const fenced: TerminalFenced = new Map([[1, 4], [7, 0]]);
    const encoded = Schema.encodeSync(json(TerminalFenced))(fenced);
    expect(JSON.parse(JSON.stringify(encoded))).toEqual([[1, 4], [7, 0]]);
    expect(Schema.decodeUnknownSync(json(TerminalFenced))(encoded)).toEqual(fenced);
  });

  it("decodes an adopted terminal only with its last control and key numbers, and its held exit only with afterSeq", () => {
    const decode = Schema.decodeUnknownResult(TerminalAdopted, { onExcessProperty: "error" });
    const adopted = { id: 3, pid: 4242, cols: 80, rows: 24, history: "", seq: 9, lastN: 12, lastK: 5 };
    expect(Result.isSuccess(decode(adopted))).toBe(true);
    expect(Result.isSuccess(decode({ ...adopted, exit: { code: 0, signal: undefined, afterSeq: 9 } }))).toBe(true);
    expect(Result.isFailure(decode({ ...adopted, exit: { code: 0, signal: undefined } }))).toBe(true);
    const { lastN: _lastN, ...withoutN } = adopted;
    const { lastK: _lastK, ...withoutK } = adopted;
    expect(Result.isFailure(decode(withoutN))).toBe(true);
    expect(Result.isFailure(decode(withoutK))).toBe(true);
  });

  it("refuses a counter that is negative, fractional or NaN, in an adopted terminal, its held exit and the fence answer", () => {
    const adopted = Schema.decodeUnknownResult(TerminalAdopted, { onExcessProperty: "error" });
    const fenced = Schema.decodeUnknownResult(json(TerminalFenced));
    const base = { id: 3, pid: 4242, cols: 80, rows: 24, history: "", seq: 9, lastN: 12, lastK: 5 };
    expect(Result.isSuccess(adopted({ ...base, lastN: 0, lastK: 0, exit: { code: 0, signal: undefined, afterSeq: 0 } }))).toBe(true);
    expect(Result.isSuccess(fenced([[0, 0], [7, 3]]))).toBe(true);
    for (const drifted of [-1, 1.5, Number.NaN]) {
      expect(Result.isFailure(adopted({ ...base, lastN: drifted }))).toBe(true);
      expect(Result.isFailure(adopted({ ...base, lastK: drifted }))).toBe(true);
      expect(Result.isFailure(adopted({ ...base, exit: { code: 0, signal: undefined, afterSeq: drifted } }))).toBe(true);
      expect(Result.isFailure(fenced([[drifted, 1]]))).toBe(true);
      expect(Result.isFailure(fenced([[1, drifted]]))).toBe(true);
      expect(Result.isFailure(adopted({ ...base, seq: drifted }))).toBe(true);
    }
  });

  it("refuses a drifted count in every message that carries one, and the edge refuses it on a control tag", () => {
    const cases: ReadonlyArray<readonly [Schema.Top, Record<string, unknown>, ReadonlyArray<string>]> = [
      [TerminalResize, { _tag: "resize", id: 1, n: 2, cols: 80, rows: 24 }, ["n"]],
      [TerminalAck, { _tag: "ack", id: 1, n: 2, throughSeq: 4 }, ["n", "throughSeq"]],
      [TerminalSurfaceOpen, { _tag: "surfaceOpen", id: 1, n: 2, leaseId: "lease", epoch: "e1", fromSeq: 0 }, ["n", "fromSeq"]],
      [TerminalConnect, { _tag: "connect", generation: 0 }, ["generation"]],
      [TerminalData, { _tag: "data", id: 1, seq: 0, data: "x" }, ["seq"]],
      [TerminalExit, { _tag: "exit", id: 1, afterSeq: 0, code: 0, signal: undefined }, ["afterSeq"]],
      [TerminalTyping, { _tag: "typing", id: 1, k: 0, leaseId: "lease", data: "x" }, ["k"]],
      [TerminalInput, { _tag: "input", id: 1, k: 0, leaseId: "lease", data: "x" }, ["k"]],
    ];
    for (const [schema, valid, counts] of cases) {
      const decode = Schema.decodeUnknownResult(schema as Schema.Codec<unknown, unknown>, { onExcessProperty: "error" });
      expect(Result.isSuccess(decode(valid))).toBe(true);
      for (const field of counts) {
        for (const drifted of [-1, 1.5, Number.NaN]) expect(Result.isFailure(decode({ ...valid, [field]: drifted }))).toBe(true);
      }
    }
    const { heard, handlers } = recordingCommands();
    const enter = commandEdge(handlers);
    for (const drifted of [-1, 1.5, Number.NaN]) expect(Result.isFailure(enter({ _tag: "resize", id: 1, n: drifted, cols: 80, rows: 24 }))).toBe(true);
    expect(heard).toEqual([]);
  });
});
