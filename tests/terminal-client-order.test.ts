/**
 * The core's terminal client applies what the terminal process sends by its
 * numbers, never by arrival: output by `seq`, held past a gap and dropped on
 * a repeat; an exit only once output through its `afterSeq` is applied; key
 * events by `k`. A control event that does not decode is refused at the edge.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { terminalClient, type RemoteTerminalExit } from "../src/node/terminals/client";
import type { Command, Event, EventFrame } from "../src/contract/terminal/messages";
import type { TerminalLinkMessage, TerminalLinkPort } from "../src/contract/terminal/protocol";

const link = () => {
  const handlers = new Set<(message: TerminalLinkMessage) => void>();
  const posted: TerminalLinkMessage[] = [];
  const port: TerminalLinkPort = {
    post: (message) => void posted.push(message),
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

afterEach(() => {
  vi.restoreAllMocks();
});

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
});
