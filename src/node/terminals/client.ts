import { Context, Duration, Effect, Layer, ManagedRuntime, Result, Schema } from "effect";
import { RpcClient, type RpcClientError } from "effect/rpc";
import { clientProtocol, type PortMessage, type RpcPort } from "../../shared/rpc-port";
import {
  TERMINAL_LINK_VERSION,
  TerminalRpcs,
  type TerminalAdopted,
  type TerminalExitStatus,
  type TerminalSpawnInput,
} from "../../contract/terminal/rpcs";
import {
  TerminalInbound,
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
import type { EventFrame, EventHandlers, TerminalInput, TerminalTyping } from "../../contract/terminal/messages";
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

/** The calls on one link, as the client its runtime built. */
class TerminalCalls extends Context.Service<TerminalCalls, RpcClient.FromGroup<typeof TerminalRpcs, RpcClientError.RpcClientError>>()(
  "@junto/node/TerminalCalls",
) {}

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
   * Resolves once everything posted before it is in force in the terminal
   * process and every surface key that arrived there first has been heard
   * here. A lost terminal process resolves it too: nothing is left to type.
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
  /** The last key event applied; undefined until the first one names where the count stands. */
  k: number | undefined;
  readonly pendingKeys: Map<number, TerminalTyping | TerminalInput>;
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
 */
export const terminalClient = (
  port: TerminalLinkPort,
  transfer?: (message: TerminalLinkMessage, surface: unknown) => void,
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
  // One runtime per link: it holds the RPC client and its scope, and every
  // call on this link runs on it.
  const runtime = ManagedRuntime.make(
    Layer.effect(TerminalCalls, RpcClient.make(TerminalRpcs)).pipe(
      Layer.provide(Layer.effect(RpcClient.Protocol, clientProtocol(rpcPort))),
    ),
  );
  const calls = runtime.runSync(Effect.service(TerminalCalls));

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

  const post = (channel: string, payload: unknown): void => port.post({ kind: "push", channel, payload });

  // Handled output is acknowledged once per turn, every terminal at once, so
  // a PTY is read only as fast as this side keeps up (backpressure).
  const handled = new Map<number, number>();
  let ackScheduled = false;
  const acknowledge = (): void => {
    ackScheduled = false;
    for (const [id, chars] of handled) post(TerminalInbound.ack, { id, chars });
    handled.clear();
  };

  /** Applies what is next in order: chunks through the first gap, then a held exit once its chunks are in. */
  const advance = (id: number, terminal: Live): void => {
    // Keys apply as soon as they are in order: a listener added later hears only later keys.
    for (let key = terminal.pendingKeys.get((terminal.k ?? 0) + 1); key !== undefined; key = terminal.pendingKeys.get(key.k + 1)) {
      terminal.pendingKeys.delete(key.k);
      terminal.k = key.k;
      each(key._tag === "typing" ? terminal.typing : terminal.input, { leaseId: key.leaseId, data: key.data });
    }
    if (!terminal.ready) return;
    for (let next = terminal.pending.get(terminal.seq + 1); next !== undefined; next = terminal.pending.get(terminal.seq + 1)) {
      terminal.pending.delete(terminal.seq + 1);
      terminal.seq += 1;
      each(terminal.data, next);
      handled.set(id, (handled.get(id) ?? 0) + next.length);
      if (!ackScheduled) {
        ackScheduled = true;
        setImmediate(acknowledge);
      }
    }
    const exit = terminal.heldExit;
    if (exit === undefined || terminal.seq < exit.afterSeq) return;
    delete terminal.heldExit;
    post(TerminalInbound.exitAck, { id });
    exited(id, exit.status);
  };

  const key = (event: TerminalTyping | TerminalInput): void => {
    const terminal = live.get(event.id);
    if (terminal === undefined) return;
    // The first key event names where an adopted terminal's count stands.
    terminal.k ??= event.k - 1;
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

  const fresh = (seq: number, ready: boolean): Live => ({
    data: new Set(), exit: new Set(), error: new Set(), typing: new Set(), input: new Set(),
    seq, pending: new Map(), received: seq, k: ready ? 0 : undefined, pendingKeys: new Map(), ready,
  });

  const handleOf = (id: number, pid: Promise<number | undefined>): RemoteTerminal => ({
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
    fence: () => runtime.runPromise(calls.TerminalFence().pipe(Effect.ignore)),
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
        live.set(adopted.id, fresh(adopted.seq, false));
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
    hangupAll: () => post(TerminalInbound.hangupAll, {}),
    spawn: (input) => {
      const id = nextId++;
      live.set(id, fresh(0, true));
      const pid = runtime.runPromise(
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
