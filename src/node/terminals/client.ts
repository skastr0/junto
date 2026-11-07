import { Context, Duration, Effect, Result, Schema, Scope } from "effect";
import { RpcClient } from "effect/rpc";
import { clientProtocol, type PortMessage, type RpcPort } from "../../shared/rpc-port";
import {
  TERMINAL_LINK_VERSION,
  TerminalRpcs,
  type TerminalAdopted,
  type TerminalExitStatus,
  type TerminalSpawnInput,
} from "../../contract/terminal/rpcs";
import {
  TerminalOutbound,
  TerminalSurface,
  type TerminalData as LegacyData,
  type TerminalError,
  type TerminalExitEvent,
  type SurfaceLease,
  type TerminalInput as LegacyInput,
  type TerminalLinkMessage,
  type TerminalLinkPort,
  type TerminalPush,
} from "../../contract/terminal/protocol";
import type { Command, EventFrame, EventHandlers, TerminalInput, TerminalTyping } from "../../contract/terminal/messages";
import { eventEdge } from "../../contract/terminal/edge";

/**
 * The core's side of the terminal process (phase 1). A spawn answers at once
 * with a handle, as the in-process PTY does: its writes and resizes are posted
 * behind the spawn, and the terminal process holds them until the spawn is
 * there, so nothing waits for the pid. The pid arrives a turn later, and a
 * spawn the child refuses arrives as an error and then an exit.
 *
 * The calls are the `TerminalRpcs` group, decoded at both ends; a call the
 * terminal process does not serve fails the compile, not a runtime answer.
 */
export type RemoteTerminalExit = TerminalExitStatus;

/** How long a new core waits on `TerminalAdopt` before it adopts nothing and says so. */
const ADOPT_DEADLINE = Duration.seconds(10);

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
  /**
   * Resolves once every surface key the terminal process had pushed for this
   * terminal when it answered has been applied here, by its `k`, whatever
   * order the answer and the keys arrive in. Waits on this terminal only. A
   * lost terminal process, or a terminal that ended, resolves it too:
   * nothing is left to type.
   */
  readonly fence: () => Promise<void>;
};

export type RemoteTerminalSpawn = Omit<TerminalSpawnInput, "id">;

/** A PTY a new core took back from the terminal process, with what it was spawned with. */
export type AdoptedTerminal = { readonly terminal: RemoteTerminal; readonly meta: unknown; readonly adopted: TerminalAdopted };

/** The terminal process did not answer `pty.adopt`: it is gone, or refused the call. */
export class TerminalAdoptFailed extends Schema.TaggedError<TerminalAdoptFailed>()("TerminalAdoptFailed", {
  message: Schema.String,
}) {}

export type TerminalClient = {
  readonly spawn: (input: RemoteTerminalSpawn) => RemoteTerminal;
  /**
   * A new core's first ask on its port: a handle for every PTY the terminal
   * process kept. Each handle holds its output and exit until it has both a
   * data and an exit listener; then they arrive as they would from a spawn.
   */
  readonly adopt: () => Effect.Effect<ReadonlyArray<AdoptedTerminal>, TerminalAdoptFailed>;
  /** Orderly quit: hang up every PTY. */
  readonly hangupAll: () => void;
  /** The terminal process is gone: every live terminal reports an exit. */
  readonly fail: (reason: string) => void;
};

/** The commands that name one terminal and go with no port. */
type PortlessCommand = Exclude<Command, { readonly _tag: "surfaceOpen" | "hangupAll" }>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type KeyListener = (input: { readonly leaseId: string; readonly data: string }) => void;

/**
 * One terminal as this side applies it. Output is applied strictly by `seq`:
 * a chunk past a gap waits in `pending` for the chunks before it, and a chunk
 * already applied is dropped. An exit waits until output through its
 * `afterSeq` is applied. Key events are applied by `k` the same way.
 */
type Live = {
  readonly data: Set<(data: string) => void>;
  readonly exit: Set<(event: RemoteTerminalExit) => void>;
  readonly error: Set<(error: Error) => void>;
  readonly typing: Set<KeyListener>;
  readonly input: Set<KeyListener>;
  /** The last chunk applied. */
  seq: number;
  readonly pending: Map<number, string>;
  /** The highest chunk received, applied or waiting. */
  received: number;
  heldExit?: { readonly afterSeq: number; readonly status: RemoteTerminalExit };
  /** The last key event applied: 0 for a spawn, the adoption's `lastK` for an adopted terminal. */
  k: number;
  readonly pendingKeys: Map<number, TerminalTyping | TerminalInput>;
  /** Fences waiting for this terminal's key events through their `k`. */
  readonly fences: Array<{ readonly k: number; readonly done: () => void }>;
  /** False for an adopted terminal until it has a data and an exit listener: nothing is applied before. */
  ready: boolean;
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

const textOf = (value: unknown): string | undefined =>
  typeof value === "object" && value !== null && "message" in value && typeof value.message === "string" ? value.message : undefined;

/** The sentence a failed call carries; an `RpcClientError` says it on its reason. */
const messageOf = (error: unknown): string =>
  textOf(typeof error === "object" && error !== null && "reason" in error ? error.reason : undefined) ?? textOf(error) ?? String(error);

/**
 * `transfer` posts one message with a port moved alongside it, which the
 * link port cannot: Electron's `UtilityProcess.postMessage(message, [port])`.
 * Without it no surface can be opened.
 *
 * `context` is the program's own, and every call on the link runs on it:
 * `Terminals` hands the client the core's. A test that builds a client
 * alone runs its calls on an empty one.
 */
export const terminalClient = (
  port: TerminalLinkPort,
  transfer?: (message: TerminalLinkMessage, surface: unknown) => void,
  context: Context.Context<never> = Context.empty(),
): TerminalClient => {
  const live = new Map<number, Live>();
  let nextId = 1;

  // RPC hears every message but the pushes, and a local `down` when the
  // terminal process is gone, which fails every call still waiting.
  const rpcListeners = new Set<(message: PortMessage) => void>();
  const rpcPort: RpcPort = {
    post: (message) => port.post(message),
    listen: (handler) => {
      rpcListeners.add(handler);
      return () => rpcListeners.delete(handler);
    },
  };
  // Every call on this link runs on the program's context it was given.
  const run = Effect.runPromiseWith(context);
  const runSync = Effect.runSyncWith(context);
  const scope = runSync(Scope.make());
  const calls = runSync(
    RpcClient.make(TerminalRpcs).pipe(
      Effect.provideServiceEffect(RpcClient.Protocol, clientProtocol(rpcPort)),
      Effect.provideService(Scope.Scope, scope),
    ),
  );

  const exited = (id: number, event: RemoteTerminalExit): void => {
    const terminal = live.get(id);
    if (terminal === undefined) return;
    live.delete(id);
    // A terminal that ended has nothing left to type: its fences resolve.
    for (const fence of terminal.fences.splice(0)) fence.done();
    each(terminal.exit, event);
  };
  const failed = (id: number, message: string): void => {
    const terminal = live.get(id);
    if (terminal !== undefined) each(terminal.error, new Error(message));
  };

  /**
   * Each terminal's last command number. The spawn is 1, so its first command
   * is 2; the terminal process applies a terminal's commands in this order,
   * whatever order they arrive in. Kept past the exit: a command posted to a
   * terminal that ended still counts on.
   */
  const numbered = new Map<number, number>();
  const nextN = (id: number): number => {
    const n = (numbered.get(id) ?? 1) + 1;
    numbered.set(id, n);
    return n;
  };
  const command = (message: DistributiveOmit<PortlessCommand, "n">): void =>
    port.post({ kind: "command", message: { ...message, n: nextN(message.id) } as PortlessCommand });

  // Handled output is acknowledged once per turn, every terminal at once, so
  // a PTY is read only as fast as this side keeps up (backpressure). The ack
  // names the last chunk applied, so a late or repeated one changes nothing.
  const handled = new Map<number, number>();
  let ackScheduled = false;
  const acknowledge = (): void => {
    ackScheduled = false;
    for (const [id, throughSeq] of handled) command({ _tag: "ack", id, throughSeq });
    handled.clear();
  };

  /** Resolves the fences this terminal's applied key events have reached. */
  const release = (terminal: Live): void => {
    for (let i = terminal.fences.length - 1; i >= 0; i -= 1) {
      const fence = terminal.fences[i]!;
      if (terminal.k < fence.k) continue;
      terminal.fences.splice(i, 1);
      fence.done();
    }
  };

  /** Applies what is next in order: chunks through the first gap, then a held exit once its chunks are in. */
  const advance = (id: number, terminal: Live): void => {
    // Keys apply as soon as they are in order: a listener added later hears only later keys.
    for (let key = terminal.pendingKeys.get(terminal.k + 1); key !== undefined; key = terminal.pendingKeys.get(key.k + 1)) {
      terminal.pendingKeys.delete(key.k);
      terminal.k = key.k;
      each(key._tag === "typing" ? terminal.typing : terminal.input, { leaseId: key.leaseId, data: key.data });
    }
    release(terminal);
    if (!terminal.ready) return;
    for (let next = terminal.pending.get(terminal.seq + 1); next !== undefined; next = terminal.pending.get(terminal.seq + 1)) {
      terminal.pending.delete(terminal.seq + 1);
      terminal.seq += 1;
      each(terminal.data, next);
      handled.set(id, terminal.seq);
      if (!ackScheduled) {
        ackScheduled = true;
        setImmediate(acknowledge);
      }
    }
    const exit = terminal.heldExit;
    if (exit === undefined || terminal.seq < exit.afterSeq) return;
    delete terminal.heldExit;
    command({ _tag: "exitAck", id });
    exited(id, exit.status);
  };

  const key = (event: TerminalTyping | TerminalInput): void => {
    const terminal = live.get(event.id);
    if (terminal === undefined) return;
    if (event.k <= terminal.k) return;
    terminal.pendingKeys.set(event.k, event);
    advance(event.id, terminal);
  };

  // Set while an adopt is out: what follows its answer may reach this side
  // first, for ids it does not name yet. Replayed in order behind the answer.
  let adopting: Array<() => void> | undefined;
  const known = (id: number, replay: () => void): Live | undefined => {
    const terminal = live.get(id);
    if (terminal === undefined) adopting?.push(replay);
    return terminal;
  };

  const events: EventHandlers = {
    data: (event) => {
      const terminal = known(event.id, () => events.data(event));
      if (terminal === undefined || event.seq <= terminal.seq || terminal.pending.has(event.seq)) return;
      terminal.pending.set(event.seq, event.data);
      terminal.received = Math.max(terminal.received, event.seq);
      advance(event.id, terminal);
    },
    exit: (event) => {
      const terminal = known(event.id, () => events.exit(event));
      if (terminal === undefined || terminal.heldExit !== undefined) return;
      terminal.heldExit = { afterSeq: event.afterSeq, status: { code: event.code, signal: event.signal } };
      advance(event.id, terminal);
    },
    error: (event) => failed(event.id, event.message),
    typing: (event) => {
      if (known(event.id, () => events.typing(event)) !== undefined) key(event);
    },
    input: (event) => {
      if (known(event.id, () => events.input(event)) !== undefined) key(event);
    },
  };
  const eventOf = eventEdge(events);

  /**
   * The old one-way channels, until the terminal process posts event frames
   * only. They arrive in the order they were posted: an exit follows every
   * chunk received, and a key event applies as it comes.
   */
  const legacy = (message: TerminalPush): void => {
    if (message.channel === TerminalOutbound.data) {
      const { id, data, seq } = message.payload as LegacyData;
      return events.data({ _tag: "data", id, seq, data });
    }
    if (message.channel === TerminalOutbound.exit) {
      const { id, code, signal } = message.payload as TerminalExitEvent;
      const terminal = known(id, () => legacy(message));
      if (terminal !== undefined) events.exit({ _tag: "exit", id, afterSeq: terminal.received, code, signal });
      return;
    }
    if (message.channel === TerminalOutbound.error) {
      const { id, message: text } = message.payload as TerminalError;
      return events.error({ _tag: "error", id, message: text });
    }
    if (message.channel === TerminalSurface.typing || message.channel === TerminalSurface.input) {
      const input = message.payload as LegacyInput;
      const terminal = known(input.id, () => legacy(message));
      if (terminal !== undefined) each(message.channel === TerminalSurface.typing ? terminal.typing : terminal.input, input);
    }
  };

  port.listen((message) => {
    const frame = message as TerminalLinkMessage | EventFrame;
    if (frame.kind === "push") return legacy(frame);
    if (frame.kind === "event") {
      const refused = eventOf(frame.message);
      if (Result.isFailure(refused)) console.error(`[term] the terminal process sent an event this core refuses: ${refused.failure.tag} ${refused.failure.message}`);
      return;
    }
    for (const listener of [...rpcListeners]) listener(frame);
  });

  const subscribe = <A>(id: number, pick: (terminal: Live) => Set<(value: A) => void>) => (listener: (value: A) => void) => {
    const terminal = live.get(id);
    if (terminal === undefined) return () => undefined;
    pick(terminal).add(listener);
    if (!terminal.ready && terminal.data.size > 0 && terminal.exit.size > 0) {
      terminal.ready = true;
      advance(id, terminal);
    }
    return () => pick(terminal).delete(listener);
  };

  const fresh = (seq: number, k: number, ready: boolean): Live => ({
    data: new Set(), exit: new Set(), error: new Set(), typing: new Set(), input: new Set(),
    seq, pending: new Map(), received: seq, k, pendingKeys: new Map(), fences: [], ready,
  });

  /**
   * One fence for this terminal: the terminal process names the last key
   * event it pushed for each terminal, and this one resolves once that event
   * is applied here, wherever the answer lands among the events. A lost link
   * or a refused call resolves it too: nothing is left to type.
   */
  const fence = (id: number): Promise<void> =>
    run(calls.TerminalFence().pipe(Effect.option)).then((answer) => new Promise<void>((done) => {
      const terminal = live.get(id);
      const k = answer._tag === "Some" ? answer.value.get(id) : undefined;
      if (terminal === undefined || k === undefined || terminal.k >= k) return done();
      terminal.fences.push({ k, done });
    }));

  const handleOf = (id: number, pid: Promise<number | undefined>): RemoteTerminal => ({
    id,
    pid,
    write: (data) => command({ _tag: "write", id, data }),
    resize: (cols, rows) => command({ _tag: "resize", id, cols, rows }),
    kill: (signal) => command({ _tag: "kill", id, ...(signal === undefined ? {} : { signal }) }),
    onData: subscribe(id, (terminal) => terminal.data),
    onExit: subscribe(id, (terminal) => terminal.exit),
    onError: subscribe(id, (terminal) => terminal.error),
    gate: (lease) => command({ _tag: "gate", id, lease }),
    hold: (held) => command({ _tag: "hold", id, held }),
    endSurface: (leaseId) => command({ _tag: "surfaceEnd", id, leaseId }),
    openSurface: (lease, fromSeq, surface) => {
      if (transfer === undefined) throw new Error("this terminal process cannot take a surface port");
      transfer({ kind: "command", message: { _tag: "surfaceOpen", id, n: nextN(id), leaseId: lease.leaseId, epoch: lease.epoch, fromSeq } }, surface);
    },
    lastSeq: () => live.get(id)?.seq ?? 0,
    onTyping: subscribe(id, (terminal) => terminal.typing),
    onInput: subscribe(id, (terminal) => terminal.input),
    fence: () => fence(id),
  });

  const adopt = (): Effect.Effect<ReadonlyArray<AdoptedTerminal>, TerminalAdoptFailed> => Effect.suspend(() => {
    const arrived: Array<() => void> = [];
    adopting = arrived;
    return calls.TerminalAdopt({ version: TERMINAL_LINK_VERSION }).pipe(
      // A terminal process that never answers (one from a build that speaks
      // no RPC) is refused like one that is gone: its PTYs keep running.
      Effect.timeoutOrElse({
        duration: ADOPT_DEADLINE,
        orElse: () => Effect.fail(new TerminalAdoptFailed({ message: "the Junto terminal process did not answer its adoption" })),
      }),
      Effect.mapError((cause) => (cause instanceof TerminalAdoptFailed ? cause : new TerminalAdoptFailed({ message: messageOf(cause) }))),
      Effect.map((answer) => answer.terminals.map((adopted) => {
        nextId = Math.max(nextId, answer.nextId, adopted.id + 1);
        live.set(adopted.id, fresh(adopted.seq, adopted.lastK, false));
        // The terminal process applied commands through lastN: this core continues from the next.
        numbered.set(adopted.id, adopted.lastN);
        return { terminal: handleOf(adopted.id, Promise.resolve(adopted.pid)), meta: adopted.meta, adopted };
      })),
      // What arrived behind the answer goes to the handles it names, in order.
      Effect.tap(() => Effect.sync(() => {
        adopting = undefined;
        for (const replay of arrived) replay();
      })),
      Effect.ensuring(Effect.sync(() => {
        if (adopting === arrived) adopting = undefined;
      })),
    );
  });


  return {
    adopt,
    hangupAll: () => port.post({ kind: "command", message: { _tag: "hangupAll" } }),
    spawn: (input) => {
      const id = nextId++;
      live.set(id, fresh(0, 0, true));
      const pid = run(
        calls.TerminalSpawn({ ...input, id }).pipe(Effect.mapError((error) => new Error(messageOf(error)))),
      ).then((answer) => answer.pid, (error: unknown) => {
        failed(id, messageOf(error));
        exited(id, { code: undefined, signal: undefined });
        throw error;
      });
      // A refused spawn is reported on the terminal; the pid's own rejection is for a waiter.
      pid.catch(() => undefined);
      return handleOf(id, pid);
    },
    fail: (reason) => {
      for (const listener of [...rpcListeners]) listener({ kind: "down", reason });
      for (const id of [...live.keys()]) {
        failed(id, reason);
        exited(id, { code: undefined, signal: undefined });
      }
    },
  };
};
