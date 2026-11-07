import type { IPty } from "node-pty";
import { Effect, Exit, Layer, Scope } from "effect";
import { RpcServer } from "effect/rpc";
import { heldForServer, serverProtocol, type RpcPort } from "../shared/rpc-port";
import { readSingleProcessEpochSnapshotAsync, type ChildProcessEpoch } from "../node/process-epoch";
import {
  TERMINAL_LINK_VERSION,
  TerminalLinkVersionMismatch,
  TerminalRpcs,
  TerminalSpawnRefused,
  type TerminalAdopted,
  type TerminalExitStatus,
  type TerminalSpawnInput,
} from "../contract/terminal/rpcs";
import {
  TERMINAL_HISTORY_CHARS,
  TerminalInbound,
  TerminalOutbound,
  type TerminalData,
  type TerminalError,
  type TerminalExitEvent,
  type TerminalAck,
  type TerminalExitAck,
  type TerminalKill,
  TERMINAL_UNACKED_HIGH,
  TERMINAL_UNACKED_LOW,
  type TerminalResize,
  type TerminalWrite,
  TerminalSurface,
  type SurfaceIn,
  type SurfaceOut,
  type TerminalGate,
  type TerminalHold,
  type TerminalSurfaceClose,
  type TerminalSurfaceOpen,
  type SurfaceLease,
  type TerminalLinkMessage,
  type TerminalLinkPort,
  type TerminalPush,
} from "../contract/terminal/protocol";

/**
 * The terminal process's side (phase 1): it holds every PTY, runs what the
 * core asks of them, and pushes their output and exit back on the same port.
 * It decides nothing about seats; the core keeps every gate.
 *
 * A signal reaches a PTY only while its pid still names the process this
 * side spawned: the start epoch is taken at spawn and read again before each
 * kill, as the plane does for a local PTY (process-signal.ts). node-pty can
 * report an exit after the child was reaped, so the exit alone does not
 * close that window. A PTY that has exited takes no more input.
 *
 * Both reads are the asynchronous one-pid `ps`, never the synchronous one:
 * this process carries every PTY's bytes, and a blocking fork would stall
 * them all at each spawn and each signal.
 */
export type SpawnPty = (command: string, args: readonly string[], options: {
  readonly name: string;
  readonly cols: number;
  readonly rows: number;
  readonly cwd?: string;
  readonly env?: Record<string, string>;
}) => IPty;

/** The pid identity reads behind a signal; the process table by default. */
export type PtyEpochs = {
  readonly capture: (pid: number) => Promise<ChildProcessEpoch | undefined>;
  readonly isCurrent: (pid: number, epoch: ChildProcessEpoch) => Promise<boolean>;
};

const rowOf = async (pid: number): Promise<ChildProcessEpoch | undefined> => {
  const row = (await readSingleProcessEpochSnapshotAsync(pid))?.find((candidate) => candidate.pid === pid);
  return row === undefined ? undefined : { pid: row.pid, startKey: row.startKey };
};

const systemEpochs: PtyEpochs = {
  capture: rowOf,
  isCurrent: async (pid, epoch) => epoch.pid === pid && (await rowOf(pid))?.startKey === epoch.startKey,
};

/** One renderer's end of a surface port, as this process holds it. */
export type SurfacePort = {
  readonly post: (message: SurfaceOut) => void;
  readonly listen: (handler: (message: SurfaceIn) => void) => () => void;
  readonly close: () => void;
};

/** The output a surface opened late can still be given, per PTY. */
export const SURFACE_RING_BYTES = 256 * 1024;

type Chunk = { readonly seq: number; readonly data: string };

/**
 * A PTY's surfaces. A key reaches the PTY only from the lease the core's gate
 * names, checked key by key; a managed submission span holds keys, and each
 * is checked again at release, in order. Gates start closed: no key is
 * written before the core has named a lease.
 */
type Surfaces = {
  seq: number;
  ring: Chunk[];
  ringBytes: number;
  controller: SurfaceLease | null;
  held: boolean;
  readonly heldKeys: Array<SurfaceLease & { readonly data: string }>;
  readonly open: Map<string, { readonly port: SurfacePort; readonly stop: () => void }>;
};

/** What the core has of one PTY's output: what it handled, what it has not, and its exit once there is one. */
type CoreLink = {
  readonly pid: number;
  readonly meta: unknown;
  cols: number;
  rows: number;
  lastSeq: number;
  readonly history: Chunk[];
  historyChars: number;
  /** Posted to the core and not acknowledged, or waiting for one to adopt it, in seq order. */
  readonly unacked: Chunk[];
  chars: number;
  paused: boolean;
  /** False from the moment a core is lost until the next one adopts this PTY. */
  delivering: boolean;
  exit?: TerminalExitStatus;
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * `port` is the first core's, or undefined to wait for `attach`. A core's port
 * can go and another come: every PTY, its surfaces, gates and holds stay as
 * they are, and the new core takes them back with `TerminalAdopt`.
 *
 * The calls are answered by one RPC server per core port, started when the
 * port is attached and stopped when it goes: a reply never reaches a core
 * that did not ask, and a new core's clients share no id with the last's.
 */
export const serveTerminals = (
  port: TerminalLinkPort | undefined,
  spawnPty: SpawnPty,
  epochs: PtyEpochs = systemEpochs,
): {
  /** The current core is gone; every PTY stays, for the next one to adopt. */
  readonly close: () => void;
  readonly live: () => number;
  /** A surface port arrived with its `pty.surface` message. */
  readonly openSurface: (open: TerminalSurfaceOpen, surface: SurfacePort) => void;
  /** A core's port arrived; any core before it is gone. */
  readonly attach: (core: TerminalLinkPort) => void;
  /** This core's port closed. No effect on a core already replaced. */
  readonly detach: (core: TerminalLinkPort) => void;
  /** Orderly quit: every PTY gets its hangup, and the promise settles after. */
  readonly hangupAll: () => Promise<void>;
} => {
  const ptys = new Map<number, IPty>();
  // Taken at spawn; a PTY whose epoch could not be read is never signalled.
  const epochOf = new Map<number, Promise<ChildProcessEpoch | undefined>>();
  const surfacesOf = new Map<number, Surfaces>();
  const links = new Map<number, CoreLink>();
  /** Every id a spawn has named here, started or refused; the next core names its spawns past them. */
  const named = new Set<number>();
  let nextId = 1;
  /**
   * Messages for a terminal whose spawn has not reached this process: the
   * core posts them behind its spawn, but the spawn is a call and they are
   * not, so either may come first. A spawn that starts replays them in order;
   * a refused one drops them, and its refusal is the core's answer.
   */
  const early = new Map<number, Array<{ readonly run: () => void; readonly drop: () => void }>>();
  const wait = (id: number, run: () => void, drop: () => void = () => undefined): void => {
    const waiting = early.get(id);
    if (waiting === undefined) early.set(id, [{ run, drop }]);
    else waiting.push({ run, drop });
  };
  const dropEarly = (id: number): void => {
    const waiting = early.get(id);
    early.delete(id);
    for (const { drop } of waiting ?? []) drop();
  };
  let core: TerminalLinkPort | undefined;
  let stopListening: (() => void) | undefined;
  const push = (channel: string, payload: TerminalData | TerminalExitEvent | TerminalError): void =>
    core?.post({ kind: "push", channel, payload });

  const keyed = (id: number, from: SurfaceLease, data: string): void => {
    const pty = ptys.get(id);
    const surfaces = surfacesOf.get(id);
    if (pty === undefined || surfaces === undefined) return;
    const controller = surfaces.controller;
    if (controller === null || controller.leaseId !== from.leaseId || controller.epoch !== from.epoch) return;
    if (surfaces.held) {
      surfaces.heldKeys.push({ ...from, data });
      return;
    }
    try {
      pty.write(data);
    } catch (error) {
      return push(TerminalOutbound.error, { id, message: errorMessage(error) });
    }
    // The core keeps the input clock; the key itself never waited for it.
    core?.post({ kind: "push", channel: TerminalSurface.input, payload: { id, leaseId: from.leaseId, data } });
  };

  const endSurface = (surfaces: Surfaces, leaseId: string): void => {
    const open = surfaces.open.get(leaseId);
    if (open === undefined) return;
    surfaces.open.delete(leaseId);
    open.stop();
    open.port.post({ t: "end" });
    open.port.close();
  };

  const output = (id: number, data: string): void => {
    const surfaces = surfacesOf.get(id);
    if (surfaces === undefined) return;
    const seq = ++surfaces.seq;
    surfaces.ring.push({ seq, data });
    surfaces.ringBytes += data.length;
    while (surfaces.ringBytes > SURFACE_RING_BYTES && surfaces.ring.length > 1) {
      surfaces.ringBytes -= surfaces.ring.shift()!.data.length;
    }
    for (const { port: surface } of surfaces.open.values()) surface.post({ t: "out", seq, data });
    const link = links.get(id);
    if (link === undefined) return;
    link.lastSeq = seq;
    link.unacked.push({ seq, data });
    link.chars += data.length;
    if (link.delivering) push(TerminalOutbound.data, { id, data, seq });
    if (!link.paused && link.chars > TERMINAL_UNACKED_HIGH) {
      link.paused = true;
      try {
        ptys.get(id)?.pause();
      } catch {
        // An exiting PTY has nothing left to pause.
      }
    }
  };

  const openSurface = (open: TerminalSurfaceOpen, surface: SurfacePort): void => {
    if (!named.has(open.id)) {
      return wait(open.id, () => openSurface(open, surface), () => {
        surface.post({ t: "end" });
        surface.close();
      });
    }
    const surfaces = surfacesOf.get(open.id);
    if (surfaces === undefined) {
      surface.post({ t: "end" });
      return surface.close();
    }
    endSurface(surfaces, open.leaseId);
    const oldest = surfaces.ring[0]?.seq ?? surfaces.seq + 1;
    if (open.fromSeq < oldest && open.fromSeq <= surfaces.seq) {
      // A gap ends the port: the view reattaches, and a key it posted here
      // takes no "took", so it goes again to the new lease, once.
      surface.post({ t: "gap" });
      return surface.close();
    }
    for (const chunk of surfaces.ring) if (chunk.seq >= open.fromSeq) surface.post({ t: "out", ...chunk });
    const stop = surface.listen((message) => {
      if (message.t !== "in") return;
      // Operator presence is the signal, not delivery: the core hears every
      // key as it arrives, a refused or held one included, before any gate.
      core?.post({ kind: "push", channel: TerminalSurface.typing, payload: { id: open.id, leaseId: open.leaseId, data: message.data } });
      surface.post({ t: "took" });
      keyed(open.id, open, message.data);
    });
    surfaces.open.set(open.leaseId, { port: surface, stop });
  };

  /**
   * Told to the core. The record stays until the core acknowledges the exit:
   * a port can die after this post and before its close is seen, and the
   * next core's adopt must still name the PTY.
   */
  const deliverExit = (id: number, link: CoreLink): void => {
    push(TerminalOutbound.exit, { id, ...link.exit! });
  };

  const adopted = (): readonly TerminalAdopted[] =>
    [...links].map(([id, link]) => ({
      id, pid: link.pid, cols: link.cols, rows: link.rows,
      ...(link.meta === undefined ? {} : { meta: link.meta }),
      history: link.history.map((chunk) => chunk.data).join(""),
      seq: link.history.at(-1)?.seq ?? (link.unacked[0] === undefined ? link.lastSeq : link.unacked[0].seq - 1),
      ...(link.exit === undefined ? {} : { exit: link.exit }),
    }));

  /** After the adopt answer, on the same ordered port: what the last core never handled, then held exits. */
  const redeliver = (): void => {
    for (const [id, link] of links) {
      link.delivering = true;
      for (const chunk of link.unacked) push(TerminalOutbound.data, { id, ...chunk });
      if (link.exit !== undefined) deliverExit(id, link);
    }
  };

  const spawn = (input: TerminalSpawnInput): number | undefined => {
    if (named.has(input.id)) throw new Error(`terminal ${input.id} already exists`);
    const pty = spawnPty(input.command, input.args, {
      name: "xterm-256color",
      cols: input.cols,
      rows: input.rows,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.env === undefined
        ? {}
        : { env: Object.fromEntries(Object.entries(input.env).filter((entry): entry is [string, string] => entry[1] !== undefined)) }),
      // Never node-pty `handleFlowControl`: it swallows a lone Ctrl+S and
      // pauses the read with no resume (app-process-plane.ts spawnTerminal).
    });
    ptys.set(input.id, pty);
    epochOf.set(input.id, epochs.capture(pty.pid).catch(() => undefined));
    links.set(input.id, {
      pid: pty.pid, meta: input.meta, cols: input.cols, rows: input.rows, lastSeq: 0,
      history: [], historyChars: 0, unacked: [], chars: 0, paused: false, delivering: true,
    });
    surfacesOf.set(input.id, { seq: 0, ring: [], ringBytes: 0, controller: null, held: false, heldKeys: [], open: new Map() });
    // The exit witness first, then the stream, as the plane installs them.
    pty.onExit(({ exitCode, signal }) => {
      ptys.delete(input.id);
      epochOf.delete(input.id);
      const surfaces = surfacesOf.get(input.id);
      surfacesOf.delete(input.id);
      if (surfaces !== undefined) for (const leaseId of [...surfaces.open.keys()]) endSurface(surfaces, leaseId);
      const link = links.get(input.id);
      if (link === undefined) return;
      // Held for the next core while there is none.
      link.exit = { code: exitCode ?? undefined, signal: signal ?? undefined };
      if (link.delivering) deliverExit(input.id, link);
    });
    pty.onData((data) => output(input.id, data));
    return pty.pid;
  };

  /**
   * One PTY gets one signal, and the promise settles once it was decided: the
   * epoch is read first, so a pid that was reaped or reused is never signalled.
   */
  const signalPty = async (id: number, signal: NodeJS.Signals | undefined): Promise<void> => {
    const pty = ptys.get(id);
    const captured = epochOf.get(id);
    if (pty === undefined || captured === undefined) return;
    const epoch = await captured;
    // Gone, reaped or reused: the signal is dropped, never sent to a pid.
    if (epoch === undefined || !(await epochs.isCurrent(pty.pid, epoch).catch(() => false))) return;
    // The exit may have been reported while the table was read.
    if (ptys.get(id) !== pty) return;
    try {
      pty.kill(signal);
    } catch {
      // The child is already gone; its exit witness reports it.
    }
  };

  /**
   * Orderly quit: every PTY gets its hangup, and the promise settles when each
   * one has been decided, so the process can leave knowing the signals landed.
   */
  const hangupAll = async (): Promise<void> => {
    await Promise.all([...ptys.keys()].map((id) => signalPty(id, "SIGHUP")));
  };

  /** The spawn of `id` was decided: what waited for it runs, or goes with a refusal. */
  const decided = (id: number, started: boolean): void => {
    named.add(id);
    nextId = Math.max(nextId, id + 1);
    if (!started) return dropEarly(id);
    const waiting = early.get(id);
    early.delete(id);
    for (const { run } of waiting ?? []) run();
  };

  const inbound = (message: TerminalPush): void => {
    const { channel, payload } = message;
    const id = (payload as { readonly id?: unknown } | undefined)?.id;
    if (typeof id === "number" && !named.has(id)) return wait(id, () => inbound(message));
    if (channel === TerminalInbound.write) {
      const { id, data } = payload as TerminalWrite;
      const pty = ptys.get(id);
      if (pty === undefined) return push(TerminalOutbound.error, { id, message: "terminal process already exited" });
      try {
        pty.write(data);
      } catch (error) {
        push(TerminalOutbound.error, { id, message: errorMessage(error) });
      }
      return;
    }
    if (channel === TerminalInbound.resize) {
      const { id, cols, rows } = payload as TerminalResize;
      try {
        ptys.get(id)?.resize(cols, rows);
        const link = links.get(id);
        if (link !== undefined) {
          link.cols = cols;
          link.rows = rows;
        }
      } catch (error) {
        push(TerminalOutbound.error, { id, message: errorMessage(error) });
      }
      return;
    }
    if (channel === TerminalInbound.ack) {
      const { id, chars } = payload as TerminalAck;
      const link = links.get(id);
      if (link === undefined) return;
      link.chars = Math.max(0, link.chars - chars);
      // Acknowledgements come whole chunks at a time, in order.
      for (let left = chars; left > 0 && link.unacked[0] !== undefined && link.unacked[0].data.length <= left;) {
        const chunk = link.unacked.shift()!;
        left -= chunk.data.length;
        link.history.push(chunk);
        link.historyChars += chunk.data.length;
      }
      while (link.historyChars > TERMINAL_HISTORY_CHARS) link.historyChars -= link.history.shift()!.data.length;
      if (link.paused && link.chars < TERMINAL_UNACKED_LOW) {
        link.paused = false;
        try {
          ptys.get(id)?.resume();
        } catch {
          // An exiting PTY has nothing left to resume.
        }
      }
      return;
    }
    if (channel === TerminalSurface.gate) {
      const { id, lease } = payload as TerminalGate;
      const surfaces = surfacesOf.get(id);
      if (surfaces === undefined) return;
      surfaces.controller = lease;
      // A closed gate drops what a span was holding; nothing may reach the PTY.
      if (lease === null) surfaces.heldKeys.length = 0;
      return;
    }
    if (channel === TerminalSurface.hold) {
      const { id, held } = payload as TerminalHold;
      const surfaces = surfacesOf.get(id);
      if (surfaces === undefined) return;
      surfaces.held = held;
      // Each held key is checked again: its lease may have lost control.
      if (!held) for (const { data, ...from } of surfaces.heldKeys.splice(0)) keyed(id, from, data);
      return;
    }
    if (channel === TerminalSurface.close) {
      const { id, leaseId } = payload as TerminalSurfaceClose;
      const surfaces = surfacesOf.get(id);
      if (surfaces !== undefined) endSurface(surfaces, leaseId);
      return;
    }
    if (channel === TerminalInbound.exitAck) {
      // Everything before the exit reached that core on the same ordered port.
      const { id } = payload as TerminalExitAck;
      if (links.get(id)?.exit !== undefined) links.delete(id);
      return;
    }
    if (channel === TerminalInbound.hangupAll) {
      void hangupAll();
      return;
    }
    if (channel === TerminalInbound.kill) {
      const { id, signal } = payload as TerminalKill;
      void signalPty(id, signal);
    }
  };

  const handlers = TerminalRpcs.toLayer({
    TerminalSpawn: (input) =>
      Effect.try({
        try: () => spawn(input),
        catch: (error) => new TerminalSpawnRefused({ message: errorMessage(error) }),
      }).pipe(
        Effect.tap(() => Effect.sync(() => decided(input.id, true))),
        Effect.tapError(() => Effect.sync(() => decided(input.id, false))),
        Effect.map((pid) => ({ pid })),
      ),
    TerminalAdopt: ({ version }) =>
      version === TERMINAL_LINK_VERSION
        ? Effect.sync(() => {
            const answer = { version: TERMINAL_LINK_VERSION, terminals: adopted(), nextId };
            // Posted before the answer: the core holds output for an id it
            // does not know yet until the answer names it.
            redeliver();
            return answer;
          })
        : Effect.fail(new TerminalLinkVersionMismatch({ expected: TERMINAL_LINK_VERSION, actual: version })),
    TerminalFence: () => Effect.void,
  });

  /** The calls on one core's port, served until the scope closes. */
  const serve = (calls: RpcPort): Scope.Closeable => {
    const scope = Effect.runSync(Scope.make());
    Effect.runFork(
      Layer.buildWithScope(
        RpcServer.layer(TerminalRpcs).pipe(
          Layer.provide(handlers),
          // Opened at once, so a call that comes before the server listens waits for it.
          Layer.provide(Layer.succeed(RpcServer.Protocol, Effect.runSync(Effect.provideService(serverProtocol(heldForServer(calls)), Scope.Scope, scope)))),
        ),
        scope,
      ),
    );
    return scope;
  };
  let serving: Scope.Closeable | undefined;

  const detach = (gone: TerminalLinkPort): void => {
    if (core !== gone) return;
    stopListening?.();
    stopListening = undefined;
    if (serving !== undefined) Effect.runFork(Scope.close(serving, Exit.void));
    serving = undefined;
    core = undefined;
    // What waited on a spawn from that core waits on nothing now.
    for (const id of [...early.keys()]) dropEarly(id);
    for (const link of links.values()) link.delivering = false;
  };

  const attach = (next: TerminalLinkPort): void => {
    if (core !== undefined) detach(core);
    core = next;
    // RPC hears every message on the port but the pushes, which are this side's own.
    const calls = new Set<(message: TerminalLinkMessage) => void>();
    stopListening = next.listen((message) => {
      if (message.kind === "push") return inbound(message);
      for (const handler of [...calls]) handler(message);
    });
    serving = serve({
      post: (message) => next.post(message),
      listen: (handler) => {
        calls.add(handler);
        return () => calls.delete(handler);
      },
    });
  };

  if (port !== undefined) attach(port);

  return {
    close: () => {
      if (core !== undefined) detach(core);
    },
    live: () => ptys.size,
    openSurface,
    attach,
    detach,
    hangupAll,
  };
};
