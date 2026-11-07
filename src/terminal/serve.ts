import type { IPty } from "node-pty";
import { Context, Deferred, Effect, Exit, Layer, Result, Scope } from "effect";
import { RpcServer } from "effect/rpc";
import { heldForServer, peersLink, serverProtocol, type LinkedPeer } from "../shared/rpc-port";
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
import { commandEdge } from "../contract/terminal/edge";
import type {
  Command,
  CommandHandlers,
  Event,
  ParentCommand,
} from "../contract/terminal/messages";
import {
  TERMINAL_HISTORY_CHARS,
  TerminalInbound,
  TerminalSurface,
  TERMINAL_UNACKED_HIGH,
  TERMINAL_UNACKED_LOW,
  type TerminalAck as LegacyAck,
  type TerminalExitAck as LegacyExitAck,
  type TerminalGate as LegacyGate,
  type TerminalHold as LegacyHold,
  type TerminalKill as LegacyKill,
  type TerminalLink,
  type TerminalLinkPort,
  type TerminalResize as LegacyResize,
  type TerminalSurfaceClose as LegacySurfaceClose,
  type TerminalSurfaceOpen as LegacySurfaceOpen,
  type TerminalWrite as LegacyWrite,
  type TerminalPush,
} from "../contract/terminal/protocol";
import type { SurfaceIn, SurfaceOut } from "../contract/terminal/surface";

/**
 * The terminal process's side: it holds every PTY, runs what the core asks of
 * them, and pushes their output and exit back on the same port. It decides
 * nothing about seats; the core keeps every gate.
 *
 * The core's one-way commands are the `Command` union, decoded closed at this
 * edge for the control tags and passed typed for the hot ones (`write`,
 * `ack`). Every command for a terminal carries `n`, its control number — a
 * spawn counts as 1 — and commands apply in `n` order per terminal: a gap is
 * held, a repeat dropped. While the old push channels are still posted by a
 * core that has not moved, they arrive without `n` and apply as they come.
 *
 * Its events are the `Event` union: output carries `seq`, an exit `afterSeq`,
 * a key `k`, each placed by number on the far side.
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

/** What the terminal process asks to start a PTY. */
export class PtySpawner extends Context.Service<PtySpawner, SpawnPty>()("@junto/terminal/PtySpawner") {}

/** What the terminal process asks to guard a signal with a pid's epoch. */
export class PidEpochs extends Context.Service<PidEpochs, PtyEpochs>()("@junto/terminal/PidEpochs") {
  /** The process table's own epochs. */
  static readonly live: Layer.Layer<PidEpochs> = Layer.succeed(PidEpochs, systemEpochs);
}

/** One renderer's end of a surface port, as this process holds it. */
export type SurfacePort = {
  readonly post: (message: SurfaceOut) => void;
  readonly listen: (handler: (message: SurfaceIn) => void) => () => void;
  readonly close: () => void;
};

/**
 * The parent as the terminal process sees it: its port may stand in as the
 * first core, and it hands each later core over with `connect` until it says
 * `shutdown`.
 */
export type CoreLinkShape = {
  /** The parent's port acting as a core link, when the core runs in main. Attached first, generation 0. */
  readonly parentAsCore: TerminalLink<SurfacePort> | undefined;
  /**
   * The parent's commands. A `connect` arrives with its core's port already
   * wrapped; `shutdown` carries nothing. Each generation is main's count of
   * the cores it started; only a higher one attaches.
   */
  readonly listenParent: (handler: (command: ParentCommand, port: TerminalLink<SurfacePort> | undefined) => void) => () => void;
};

export class CoreLink extends Context.Service<CoreLink, CoreLinkShape>()("@junto/terminal/CoreLink") {}

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
  controller: { readonly leaseId: string; readonly epoch: string } | null;
  held: boolean;
  readonly heldKeys: Array<{ readonly leaseId: string; readonly epoch: string; readonly data: string }>;
  readonly open: Map<string, { readonly port: SurfacePort; readonly stop: () => void }>;
};

/** What the core has of one PTY's output: what it handled, what it has not, and its exit once there is one. */
type Link = {
  readonly pid: number;
  readonly meta: unknown;
  cols: number;
  rows: number;
  lastSeq: number;
  /** The last `throughSeq` the core acknowledged; an equal or older one is a repeat. */
  acked: number;
  /** The last key event posted to a core (`typing` or `input`), the fence's answer. */
  lastK: number;
  readonly history: Chunk[];
  historyChars: number;
  /** Posted to the core and not acknowledged, or waiting for one to adopt it, in seq order. */
  readonly unacked: Chunk[];
  chars: number;
  paused: boolean;
  /** False from the moment a core is lost until the next one adopts this PTY. */
  delivering: boolean;
  exit?: TerminalExitStatus;
  /** The last chunk `seq` before the PTY ended, the exit's `afterSeq`. */
  exitSeq: number;
  /** The last command `n` applied; a command numbering it or less is a repeat. */
  appliedN: number;
  /**
   * True for a terminal the current core did not spawn and cannot name the
   * count of (until the adopt answer carries `lastN`): the first command the
   * core posts for it is applied and starts the count from there.
   */
  awaitingBase: boolean;
  /** Commands past the next `n`, applied in order once their predecessors land. */
  readonly held: Map<number, () => void>;
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The whole server: every PTY, the cores that attach, the gates and holds.
 * Built on one scope whose close is the process's orderly quit: each PTY's
 * own child scope ends with its epoch-guarded hangup.
 */
const openServer = (spawnPty: SpawnPty, epochs: PtyEpochs): {
  readonly live: () => number;
  /** A core's port at its generation; refused when it is not higher than the attached one's. */
  readonly attach: (port: TerminalLink<SurfacePort>, generation: number) => boolean;
  readonly detach: (port: TerminalLink<SurfacePort>) => void;
  /** Every live PTY gets its epoch-guarded SIGHUP; settles when each was decided. */
  readonly hangupAll: () => Promise<void>;
  /** Orderly quit: the server scope closes, every child scope runs its hangup. */
  readonly shutdown: () => Promise<void>;
  /** A surface port arrived the old way, beside a `pty.surface` push. */
  readonly openSurface: (open: LegacySurfaceOpen, surface: SurfacePort) => void;
} => {
  /** The scope every PTY's child scope and the RPC server hang off of. */
  const serverScope = Effect.runSync(Scope.make());

  /** One live PTY: its handle, its spawn epoch, and the child scope that owns it. */
  const ptys = new Map<number, { readonly pty: IPty; readonly epoch: Promise<ChildProcessEpoch | undefined> }>();
  const surfacesOf = new Map<number, Surfaces>();
  const links = new Map<number, Link>();
  /** Every id a spawn has named here, started or refused; the next core names its spawns past them. */
  const named = new Set<number>();
  let nextId = 1;
  /**
   * `nextId` as the last adoption answered it. A core names every spawn from
   * there on, so an id below it that no spawn named never will be: a message
   * for it is not held, and goes as one for a gone terminal does.
   */
  let adoptedFrom = 1;
  /**
   * Messages for a terminal whose spawn has not reached this process: the
   * core posts them behind its spawn, but the spawn is a call and they are
   * not, so either may come first. A spawn that starts replays them in order;
   * a refused one drops them, and its refusal is the core's answer. Only ids
   * a core may still spawn wait (`awaited`), and nothing outlives the core
   * that sent it.
   */
  const early = new Map<number, Array<{ readonly run: () => void; readonly drop: () => void }>>();
  const wait = (id: number, run: () => void, drop: () => void = () => undefined): void => {
    const waiting = early.get(id);
    if (waiting === undefined) early.set(id, [{ run, drop }]);
    else waiting.push({ run, drop });
  };
  const awaited = (id: number): boolean => !named.has(id) && id >= adoptedFrom;
  const dropEarly = (id: number): void => {
    const waiting = early.get(id);
    early.delete(id);
    for (const { drop } of waiting ?? []) drop();
  };

  let core: TerminalLink<SurfacePort> | undefined;
  let peer: LinkedPeer | undefined;
  let stopListening: (() => void) | undefined;
  /** The attached core's generation; a connect attaches only above it. */
  let attachedGeneration = -1;

  const emit = (event: Event): void => {
    core?.post({ kind: "event", message: event });
  };

  const keyed = (id: number, from: { readonly leaseId: string; readonly epoch: string }, data: string): void => {
    const pty = ptys.get(id);
    const surfaces = surfacesOf.get(id);
    if (pty === undefined || surfaces === undefined) return;
    const controller = surfaces.controller;
    if (controller === null || controller.leaseId !== from.leaseId || controller.epoch !== from.epoch) return;
    if (surfaces.held) {
      surfaces.heldKeys.push({ leaseId: from.leaseId, epoch: from.epoch, data });
      return;
    }
    try {
      pty.pty.write(data);
    } catch (error) {
      emit({ _tag: "error", id, message: errorMessage(error) });
      return;
    }
    const link = links.get(id);
    // The core keeps the input clock; the key itself never waited for it.
    if (link !== undefined) emit({ _tag: "input", id, k: ++link.lastK, leaseId: from.leaseId, data });
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
    if (link.delivering) emit({ _tag: "data", id, seq, data });
    if (!link.paused && link.chars > TERMINAL_UNACKED_HIGH) {
      link.paused = true;
      try {
        ptys.get(id)?.pty.pause();
      } catch {
        // An exiting PTY has nothing left to pause.
      }
    }
  };

  const openSurface = (open: { readonly id: number; readonly leaseId: string; readonly epoch: string; readonly fromSeq: number }, surface: SurfacePort): void => {
    if (awaited(open.id)) {
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
      const link = links.get(open.id);
      // Operator presence is the signal, not delivery: the core hears every
      // key as it arrives, a refused or held one included, before any gate.
      if (link !== undefined) emit({ _tag: "typing", id: open.id, k: ++link.lastK, leaseId: open.leaseId, data: message.data });
      surface.post({ t: "took", key: message.key });
      keyed(open.id, open, message.data);
    });
    surfaces.open.set(open.leaseId, { port: surface, stop });
  };

  /** A `surfaceOpen` (or its lease end) that will never be served: the port still hears of it. */
  const endPortFor = (surface: SurfacePort | undefined): void => {
    if (surface === undefined) return;
    surface.post({ t: "end" });
    surface.close();
  };

  /** Told to the core. The record stays until the core acknowledges the exit. */
  const deliverExit = (id: number, link: Link): void => {
    emit({ _tag: "exit", id, afterSeq: link.exitSeq, code: link.exit!.code, signal: link.exit!.signal });
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
      for (const chunk of link.unacked) emit({ _tag: "data", id, seq: chunk.seq, data: chunk.data });
      if (link.exit !== undefined) deliverExit(id, link);
    }
  };

  /**
   * One PTY gets one signal, and the promise settles once it was decided: the
   * epoch is read first, so a pid that was reaped or reused is never signalled.
   */
  const signalPty = async (id: number, signal: NodeJS.Signals | undefined): Promise<void> => {
    const held = ptys.get(id);
    if (held === undefined) return;
    const epoch = await held.epoch;
    // Gone, reaped or reused: the signal is dropped, never sent to a pid.
    if (epoch === undefined || !(await epochs.isCurrent(held.pty.pid, epoch).catch(() => false))) return;
    // The exit may have been reported while the table was read.
    if (ptys.get(id) !== held) return;
    try {
      held.pty.kill(signal);
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

  const write = (id: number, data: string): void => {
    const held = ptys.get(id);
    if (held === undefined) return emit({ _tag: "error", id, message: "terminal process already exited" });
    try {
      held.pty.write(data);
    } catch (error) {
      emit({ _tag: "error", id, message: errorMessage(error) });
    }
  };

  const resize = (id: number, cols: number, rows: number): void => {
    try {
      ptys.get(id)?.pty.resize(cols, rows);
      const link = links.get(id);
      if (link !== undefined) {
        link.cols = cols;
        link.rows = rows;
      }
    } catch (error) {
      emit({ _tag: "error", id, message: errorMessage(error) });
    }
  };

  /** Cumulative acknowledgement: the core handled output through chunk `throughSeq`. Max wins; a repeat changes nothing. */
  const acknowledge = (id: number, throughSeq: number): void => {
    const link = links.get(id);
    if (link === undefined || throughSeq <= link.acked) return;
    link.acked = throughSeq;
    while (link.unacked[0] !== undefined && link.unacked[0].seq <= link.acked) {
      const chunk = link.unacked.shift()!;
      link.chars -= chunk.data.length;
      link.history.push(chunk);
      link.historyChars += chunk.data.length;
    }
    while (link.historyChars > TERMINAL_HISTORY_CHARS) link.historyChars -= link.history.shift()!.data.length;
    if (link.paused && link.chars < TERMINAL_UNACKED_LOW) {
      link.paused = false;
      try {
        ptys.get(id)?.pty.resume();
      } catch {
        // An exiting PTY has nothing left to resume.
      }
    }
  };

  /** The old acknowledgement, a count of handled characters, while a core still posts it. */
  const ackChars = (id: number, chars: number): void => {
    const link = links.get(id);
    if (link === undefined) return;
    link.chars = Math.max(0, link.chars - chars);
    // Acknowledgements come whole chunks at a time, in order.
    for (let left = chars; left > 0 && link.unacked[0] !== undefined && link.unacked[0].data.length <= left;) {
      const chunk = link.unacked.shift()!;
      left -= chunk.data.length;
      link.acked = Math.max(link.acked, chunk.seq);
      link.history.push(chunk);
      link.historyChars += chunk.data.length;
    }
    while (link.historyChars > TERMINAL_HISTORY_CHARS) link.historyChars -= link.history.shift()!.data.length;
    if (link.paused && link.chars < TERMINAL_UNACKED_LOW) {
      link.paused = false;
      try {
        ptys.get(id)?.pty.resume();
      } catch {
        // An exiting PTY has nothing left to resume.
      }
    }
  };

  const gate = (id: number, lease: { readonly leaseId: string; readonly epoch: string } | null): void => {
    const surfaces = surfacesOf.get(id);
    if (surfaces === undefined) return;
    surfaces.controller = lease;
    // A closed gate drops what a span was holding; nothing may reach the PTY.
    if (lease === null) surfaces.heldKeys.length = 0;
  };

  const hold = (id: number, held: boolean): void => {
    const surfaces = surfacesOf.get(id);
    if (surfaces === undefined) return;
    surfaces.held = held;
    // Each held key is checked again: its lease may have lost control.
    if (!held) for (const { data, ...from } of surfaces.heldKeys.splice(0)) keyed(id, from, data);
  };

  const surfaceEnd = (id: number, leaseId: string): void => {
    const surfaces = surfacesOf.get(id);
    if (surfaces !== undefined) endSurface(surfaces, leaseId);
  };

  const exitAck = (id: number): void => {
    // Everything before the exit reached that core on the same ordered port.
    if (links.get(id)?.exit !== undefined) links.delete(id);
  };

  /** The command record as the contract requires it: every tag, applied once its `n` is reached. */
  const apply: CommandHandlers<SurfacePort> = {
    write: (command) => write(command.id, command.data),
    resize: (command) => resize(command.id, command.cols, command.rows),
    kill: (command) => void signalPty(command.id, command.signal),
    ack: (command) => acknowledge(command.id, command.throughSeq),
    gate: (command) => gate(command.id, command.lease),
    hold: (command) => hold(command.id, command.held),
    surfaceOpen: (command, port) => openSurface(command, port),
    surfaceEnd: (command) => surfaceEnd(command.id, command.leaseId),
    exitAck: (command) => exitAck(command.id),
    hangupAll: () => void hangupAll(),
  };

  /** The commands that landed: what was held past the gap now applies in order. */
  const drainHeld = (link: Link): void => {
    for (let next = link.appliedN + 1; link.held.has(next); next = link.appliedN + 1) {
      const run = link.held.get(next)!;
      link.held.delete(next);
      link.appliedN = next;
      run();
    }
  };

  /**
   * One command at its terminal's place in `n`. A repeat is dropped, a gap
   * waits, and a terminal the core adopted takes its first `n` here as the
   * count it continues from.
   */
  const order = (link: Link, command: Command & { readonly id: number; readonly n: number }, port: SurfacePort | undefined): void => {
    const run = (): void => {
      (apply[command._tag] as (command: Command, port: SurfacePort) => void)(command, port!);
    };
    if (link.awaitingBase) {
      link.awaitingBase = false;
      link.appliedN = command.n;
      run();
      drainHeld(link);
      return;
    }
    if (command.n <= link.appliedN) return;
    if (command.n === link.appliedN + 1) {
      link.appliedN = command.n;
      run();
      drainHeld(link);
      return;
    }
    link.held.set(command.n, run);
  };

  const onCommand = (command: Command, port?: SurfacePort): void => {
    if (command._tag === "hangupAll") {
      void hangupAll();
      return;
    }
    const link = links.get(command.id);
    if (link === undefined) {
      if (awaited(command.id)) return wait(command.id, () => onCommand(command, port), () => endPortFor(port));
      return endPortFor(port);
    }
    order(link, command, port);
  };

  /** What the edge serves: every command tag, each routed through its terminal's `n`. */
  const commands: CommandHandlers<SurfacePort> = {
    write: (command) => onCommand(command),
    resize: (command) => onCommand(command),
    kill: (command) => onCommand(command),
    ack: (command) => onCommand(command),
    gate: (command) => onCommand(command),
    hold: (command) => onCommand(command),
    surfaceOpen: (command, port) => onCommand(command, port),
    surfaceEnd: (command) => onCommand(command),
    exitAck: (command) => onCommand(command),
    hangupAll: (command) => onCommand(command),
  };

  const onCommandFrame = commandEdge<SurfacePort>(commands);

  /** The old push channels, while a core still posts them: the same commands, without `n`, applied as they come. */
  const onLegacy = (message: TerminalPush, surface: SurfacePort | undefined): void => {
    const { channel, payload } = message;
    const id = (payload as { readonly id?: unknown } | undefined)?.id;
    if (typeof id === "number" && awaited(id)) return wait(id, () => onLegacy(message, surface), () => endPortFor(surface));
    if (channel === TerminalSurface.open) {
      if (surface !== undefined) openSurface(payload as LegacySurfaceOpen, surface);
      return;
    }
    if (channel === TerminalInbound.write) {
      const { id, data } = payload as LegacyWrite;
      return write(id, data);
    }
    if (channel === TerminalInbound.resize) {
      const { id, cols, rows } = payload as LegacyResize;
      return resize(id, cols, rows);
    }
    if (channel === TerminalInbound.ack) {
      const { id, chars } = payload as LegacyAck;
      return ackChars(id, chars);
    }
    if (channel === TerminalSurface.gate) {
      const { id, lease } = payload as LegacyGate;
      return gate(id, lease);
    }
    if (channel === TerminalSurface.hold) {
      const { id, held } = payload as LegacyHold;
      return hold(id, held);
    }
    if (channel === TerminalSurface.close) {
      const { id, leaseId } = payload as LegacySurfaceClose;
      return surfaceEnd(id, leaseId);
    }
    if (channel === TerminalInbound.exitAck) {
      const { id } = payload as LegacyExitAck;
      return exitAck(id);
    }
    if (channel === TerminalInbound.hangupAll) {
      void hangupAll();
      return;
    }
    if (channel === TerminalInbound.kill) {
      const { id, signal } = payload as LegacyKill;
      void signalPty(id, signal);
    }
  };

  /**
   * The spawn of `id` was decided: what waited for it runs, or goes with a
   * refusal. Spawn is control number 1, so its terminal starts applying at 2.
   */
  const decided = (id: number, started: boolean): void => {
    named.add(id);
    nextId = Math.max(nextId, id + 1);
    if (!started) return dropEarly(id);
    const waiting = early.get(id);
    early.delete(id);
    for (const { run } of waiting ?? []) run();
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
    // The PTY's own scope: it ends when the PTY exits, or when the server's
    // does, and its finalizer is the epoch-guarded hangup — a no-op for a
    // PTY that already exited. The link record outlives it on purpose.
    const scope = Effect.runSync(Scope.make());
    Effect.runSync(Scope.addFinalizer(scope, Effect.promise(() => signalPty(input.id, "SIGHUP"))));
    Effect.runSync(Scope.addFinalizer(serverScope, Scope.close(scope, Exit.void)));
    ptys.set(input.id, { pty, epoch: epochs.capture(pty.pid).catch(() => undefined) });
    links.set(input.id, {
      pid: pty.pid, meta: input.meta, cols: input.cols, rows: input.rows, lastSeq: 0, acked: 0, lastK: 0,
      history: [], historyChars: 0, unacked: [], chars: 0, paused: false, delivering: true,
      exitSeq: 0, appliedN: 1, awaitingBase: false, held: new Map(),
    });
    surfacesOf.set(input.id, { seq: 0, ring: [], ringBytes: 0, controller: null, held: false, heldKeys: [], open: new Map() });
    // The exit witness first, then the stream, as the plane installs them.
    pty.onExit(({ exitCode, signal }) => {
      ptys.delete(input.id);
      const surfaces = surfacesOf.get(input.id);
      surfacesOf.delete(input.id);
      if (surfaces !== undefined) for (const leaseId of [...surfaces.open.keys()]) endSurface(surfaces, leaseId);
      const link = links.get(input.id);
      if (link !== undefined) {
        // Held for the next core while there is none.
        link.exit = { code: exitCode ?? undefined, signal: signal ?? undefined };
        link.exitSeq = link.lastSeq;
        if (link.delivering) deliverExit(input.id, link);
      }
      // Its scope ends here: the hangup finalizer finds nothing to signal.
      Effect.runFork(Scope.close(scope, Exit.void));
    });
    pty.onData((data) => output(input.id, data));
    return pty.pid;
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
            adoptedFrom = nextId;
            // What waited on an id this core can no longer spawn waits on nothing.
            for (const id of [...early.keys()]) if (id < adoptedFrom) dropEarly(id);
            // Posted before the answer: the core holds output for an id it
            // does not know yet until the answer names it.
            redeliver();
            return answer;
          })
        : Effect.fail(new TerminalLinkVersionMismatch({ expected: TERMINAL_LINK_VERSION, actual: version })),
    TerminalFence: () => Effect.void,
  });

  /** One RPC server on the link for every core generation; a joined peer per attach. */
  const peers = peersLink();
  Effect.runFork(
    Layer.buildWithScope(
      RpcServer.layer(TerminalRpcs).pipe(
        Layer.provide(handlers),
        // Opened at once, so a call that comes before the server listens waits for it.
        Layer.provide(Layer.succeed(RpcServer.Protocol, Effect.runSync(Effect.provideService(serverProtocol(heldForServer(peers.link)), Scope.Scope, serverScope)))),
      ),
      serverScope,
    ),
  );

  /** This core is gone: its calls die with it, its terminals wait for the next. */
  const detachCore = (): void => {
    if (core === undefined) return;
    stopListening?.();
    stopListening = undefined;
    peer?.leave();
    peer = undefined;
    core = undefined;
    // What waited on a spawn from that core waits on nothing now.
    for (const id of [...early.keys()]) dropEarly(id);
    for (const link of links.values()) link.delivering = false;
  };

  // The attached core's listener and peer end with the server, as the PTYs do.
  Effect.runSync(Scope.addFinalizer(serverScope, Effect.sync(detachCore)));

  const attach = (next: TerminalLink<SurfacePort>, generation: number): boolean => {
    if (generation <= attachedGeneration) return false;
    attachedGeneration = generation;
    detachCore();
    core = next;
    // A core that did not spawn a terminal cannot name its count: the first
    // command it posts for one becomes the base `n` runs from.
    for (const link of links.values()) link.awaitingBase = true;
    const joined = peers.join((message) => next.post(message));
    stopListening = next.listen((message, surface) => {
      if (message.kind === "down") {
        if (core === next) detachCore();
        return;
      }
      if (message.kind === "command") {
        const refused = onCommandFrame(message.message, surface);
        if (Result.isFailure(refused)) console.error(`[terminal] a command the link refuses reached it: ${refused.failure.tag} ${refused.failure.message}`);
        return;
      }
      if (message.kind === "push") return onLegacy(message, surface);
      joined.deliver(message);
    });
    peer = joined;
    return true;
  };

  const detach = (gone: TerminalLink<SurfacePort>): void => {
    if (core === gone) detachCore();
  };

  return {
    live: () => ptys.size,
    attach,
    detach,
    hangupAll,
    shutdown: () => Effect.runPromiseWith(Context.empty())(Scope.close(serverScope, Exit.void)),
    openSurface,
  };
};

/** The terminal process's program: the server and its orderly end. */
export class TerminalServer extends Context.Service<TerminalServer, {
  readonly live: () => number;
  readonly attach: (port: TerminalLink<SurfacePort>, generation: number) => boolean;
  readonly detach: (port: TerminalLink<SurfacePort>) => void;
  readonly hangupAll: () => Promise<void>;
  /** Resolves after the parent said `shutdown` and every PTY's hangup was decided. */
  readonly quit: Effect.Effect<void>;
}>()("@junto/terminal/TerminalServer") {
  /**
   * The whole terminal program as one layer: the server over its `PtySpawner`
   * and `PidEpochs`, wired to the `CoreLink`'s parent for each core it hands
   * over and for the orderly quit.
   */
  static readonly layer: Layer.Layer<TerminalServer, never, PtySpawner | PidEpochs | CoreLink> = Layer.effect(
    TerminalServer,
    Effect.gen(function* () {
      const spawnPty = yield* PtySpawner;
      const epochs = yield* PidEpochs;
      const link = yield* CoreLink;
      const server = yield* Effect.sync(() => openServer(spawnPty, epochs));
      const quitting = yield* Deferred.make<void>();
      // The parent's orderly quit: every PTY's hangup, then the program may leave.
      const shutdown = (): void => {
        void server.shutdown().then(() => {
          Effect.runFork(Deferred.succeed(quitting, undefined));
        });
      };
      yield* Effect.addFinalizer(() => Effect.promise(() => server.shutdown()));
      // The parent is the first core when the core runs in main, generation 0;
      // a connect replaces it only above the generation attached.
      if (link.parentAsCore !== undefined) server.attach(link.parentAsCore, 0);
      const stopParent = link.listenParent((command, port) => {
        if (command._tag === "connect") {
          if (port !== undefined) server.attach(port, command.generation);
          return;
        }
        shutdown();
      });
      yield* Effect.addFinalizer(() => Effect.sync(stopParent));
      return {
        live: server.live,
        attach: server.attach,
        detach: server.detach,
        hangupAll: server.hangupAll,
        quit: Deferred.await(quitting),
      };
    }),
  );
}

/**
 * The old entry shape, kept while the rest of the tree moves to the server:
 * `attach` takes any generation (each call replaces, as it always did), the
 * old port type needs no transferred-surface argument, and `close` is the
 * detach it always was.
 */
export const serveTerminals = (
  port: TerminalLinkPort | undefined,
  spawnPty: SpawnPty,
  epochs: PtyEpochs = systemEpochs,
): {
  readonly close: () => void;
  readonly live: () => number;
  readonly openSurface: (open: LegacySurfaceOpen, surface: SurfacePort) => void;
  readonly attach: (core: TerminalLinkPort) => void;
  readonly detach: (core: TerminalLinkPort) => void;
  readonly hangupAll: () => Promise<void>;
} => {
  const server = openServer(spawnPty, epochs);
  const wrapped = new Map<TerminalLinkPort, TerminalLink<SurfacePort>>();
  let generation = 0;
  const asServed = (link: TerminalLinkPort): TerminalLink<SurfacePort> => {
    const known = wrapped.get(link);
    if (known !== undefined) return known;
    const served: TerminalLink<SurfacePort> = {
      post: (message) => link.post(message),
      // The old port type moves no port: a `surfaceOpen` frame posted through
      // it arrives without the port it carries and the edge refuses it. The
      // shim's callers open surfaces through `openSurface`, as they did.
      transfer: (frame) => link.post(frame),
      listen: (handler) => link.listen((message) => handler(message, undefined)),
    };
    wrapped.set(link, served);
    return served;
  };
  const attach = (link: TerminalLinkPort): void => {
    server.attach(asServed(link), ++generation);
  };
  if (port !== undefined) attach(port);
  return {
    close: () => {
      for (const link of wrapped.keys()) server.detach(asServed(link));
    },
    live: server.live,
    openSurface: server.openSurface,
    attach,
    detach: (link) => server.detach(asServed(link)),
    hangupAll: server.hangupAll,
  };
};
