import { portCore } from "../core-process/port";
import type { CoreMessage, CorePort } from "../core-process/port";
import {
  TERMINAL_SPAWN,
  TerminalInbound,
  TerminalOutbound,
  TerminalSurface,
  type TerminalData,
  type TerminalError,
  type TerminalExitEvent,
  type TerminalSpawnInput,
  type TerminalSpawnOutput,
  type SurfaceLease,
  type TerminalInput,
} from "./protocol";

/**
 * The core's side of the terminal process (phase 1). A spawn answers at once
 * with a handle, as the in-process PTY does: its writes and resizes are posted
 * behind the spawn on the same ordered port, so nothing waits for the pid.
 * The pid arrives a turn later, and a spawn the child refuses arrives as an
 * error and then an exit.
 */
export type RemoteTerminalExit = { readonly code: number | undefined; readonly signal: number | undefined };

export type RemoteTerminal = {
  /** The name surface messages carry for this terminal (phase 3). */
  readonly id: number;
  /** Resolves once the terminal process has spawned it; rejects when it could not. */
  readonly pid: Promise<number | undefined>;
  readonly write: (data: string) => void;
  readonly resize: (cols: number, rows: number) => void;
  readonly kill: (signal?: NodeJS.Signals) => void;
  readonly onData: (listener: (data: string) => void) => () => void;
  readonly onExit: (listener: (event: RemoteTerminalExit) => void) => () => void;
  readonly onError: (listener: (error: Error) => void) => () => void;
  /** Phase 3: the one lease whose surface keys may reach the PTY, or none. Closed until said. */
  readonly gate: (lease: SurfaceLease | null) => void;
  /** Phase 3: a managed span holds surface keys; release writes them in order. */
  readonly hold: (held: boolean) => void;
  /** Phase 3: a lease ended; its surface port closes. */
  readonly endSurface: (leaseId: string) => void;
  /** Phase 3: hand a renderer's port to the terminal process, for this lease, from `fromSeq`. */
  readonly openSurface: (lease: SurfaceLease, fromSeq: number, surface: unknown) => void;
  /** The seq of the last output chunk this side has been given; a surface opened now starts after it. */
  readonly lastSeq: () => number;
  /** Phase 3: a key arrived from a surface, before any gate (operator presence). */
  readonly onTyping: (listener: (input: { readonly leaseId: string; readonly data: string }) => void) => () => void;
  /** Phase 3: a key from a surface reached the PTY. */
  readonly onInput: (listener: (input: { readonly leaseId: string; readonly data: string }) => void) => () => void;
};

export type RemoteTerminalSpawn = Omit<TerminalSpawnInput, "id">;

export type TerminalClient = {
  readonly spawn: (input: RemoteTerminalSpawn) => RemoteTerminal;
  /** The terminal process is gone: every live terminal reports an exit. */
  readonly fail: (reason: string) => void;
};

type Live = {
  readonly data: Set<(data: string) => void>;
  readonly exit: Set<(event: RemoteTerminalExit) => void>;
  readonly error: Set<(error: Error) => void>;
  readonly typing: Set<(input: TerminalInput) => void>;
  readonly input: Set<(input: TerminalInput) => void>;
  seq: number;
};

const each = <A>(listeners: ReadonlySet<(value: A) => void>, value: A): void => {
  for (const listener of [...listeners]) {
    try {
      listener(value);
    } catch {
      // A listener never stops the others.
    }
  }
};

/**
 * `transfer` posts one message with a port moved alongside it, which the
 * core port cannot: Electron's `UtilityProcess.postMessage(message, [port])`.
 * Without it no surface can be opened.
 */
export const terminalClient = (
  port: CorePort,
  transfer?: (message: CoreMessage, surface: unknown) => void,
): TerminalClient => {
  const calls = portCore(port);
  const live = new Map<number, Live>();
  let nextId = 1;

  const exited = (id: number, event: RemoteTerminalExit): void => {
    const terminal = live.get(id);
    if (terminal === undefined) return;
    live.delete(id);
    each(terminal.exit, event);
  };
  const failed = (id: number, message: string): void => {
    const terminal = live.get(id);
    if (terminal !== undefined) each(terminal.error, new Error(message));
  };

  port.listen((message: CoreMessage) => {
    if (message.kind !== "push") return;
    if (message.channel === TerminalOutbound.data) {
      const { id, data, seq } = message.payload as TerminalData;
      const terminal = live.get(id);
      if (terminal === undefined) return;
      terminal.seq = seq;
      each(terminal.data, data);
      return;
    }
    if (message.channel === TerminalSurface.typing || message.channel === TerminalSurface.input) {
      const input = message.payload as TerminalInput;
      const terminal = live.get(input.id);
      if (terminal !== undefined) each(message.channel === TerminalSurface.typing ? terminal.typing : terminal.input, input);
      return;
    }
    if (message.channel === TerminalOutbound.exit) {
      const { id, code, signal } = message.payload as TerminalExitEvent;
      return exited(id, { code, signal });
    }
    if (message.channel === TerminalOutbound.error) {
      const { id, message: text } = message.payload as TerminalError;
      failed(id, text);
    }
  });

  const subscribe = <A>(id: number, pick: (terminal: Live) => Set<(value: A) => void>) => (listener: (value: A) => void) => {
    const terminal = live.get(id);
    if (terminal === undefined) return () => undefined;
    pick(terminal).add(listener);
    return () => pick(terminal).delete(listener);
  };

  const post = (channel: string, payload: unknown): void => port.post({ kind: "push", channel, payload });

  return {
    spawn: (input) => {
      const id = nextId++;
      live.set(id, { data: new Set(), exit: new Set(), error: new Set(), typing: new Set(), input: new Set(), seq: 0 });
      const pid = (calls.call as (name: string, input: unknown) => Promise<TerminalSpawnOutput>)(TERMINAL_SPAWN, { ...input, id })
        .then((answer) => answer.pid, (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          failed(id, message);
          exited(id, { code: undefined, signal: undefined });
          throw error;
        });
      // A refused spawn is reported on the terminal; the pid's own rejection is for a waiter.
      pid.catch(() => undefined);
      return {
        id,
        pid,
        write: (data) => post(TerminalInbound.write, { id, data }),
        resize: (cols, rows) => post(TerminalInbound.resize, { id, cols, rows }),
        kill: (signal) => post(TerminalInbound.kill, { id, ...(signal === undefined ? {} : { signal }) }),
        onData: subscribe(id, (terminal) => terminal.data),
        onExit: subscribe(id, (terminal) => terminal.exit),
        onError: subscribe(id, (terminal) => terminal.error),
        gate: (lease) => post(TerminalSurface.gate, { id, lease }),
        hold: (held) => post(TerminalSurface.hold, { id, held }),
        endSurface: (leaseId) => post(TerminalSurface.close, { id, leaseId }),
        openSurface: (lease, fromSeq, surface) => {
          if (transfer === undefined) throw new Error("this terminal process cannot take a surface port");
          transfer({ kind: "push", channel: TerminalSurface.open, payload: { id, ...lease, fromSeq } }, surface);
        },
        lastSeq: () => live.get(id)?.seq ?? 0,
        onTyping: subscribe(id, (terminal) => terminal.typing),
        onInput: subscribe(id, (terminal) => terminal.input),
      };
    },
    fail: (reason) => {
      calls.fail(reason);
      for (const id of [...live.keys()]) {
        failed(id, reason);
        exited(id, { code: undefined, signal: undefined });
      }
    },
  };
};
