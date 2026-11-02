import type { IPty } from "node-pty";
import type { CoreMessage, CorePort } from "../core-process/port";
import { readSingleProcessEpochSnapshotAsync, type ChildProcessEpoch } from "../junto/process-epoch";
import {
  TERMINAL_ADOPT,
  TERMINAL_FENCE,
  TERMINAL_HISTORY_CHARS,
  TERMINAL_SPAWN,
  TerminalInbound,
  TerminalOutbound,
  type TerminalData,
  type TerminalError,
  type TerminalExitEvent,
  type TerminalAck,
  type TerminalAdopted,
  type TerminalExitAck,
  type TerminalKill,
  TERMINAL_UNACKED_HIGH,
  TERMINAL_UNACKED_LOW,
  type TerminalResize,
  type TerminalSpawnInput,
  type TerminalWrite,
  TerminalSurface,
  type SurfaceIn,
  type SurfaceOut,
  type TerminalGate,
  type TerminalHold,
  type TerminalSurfaceClose,
  type TerminalSurfaceOpen,
  type SurfaceLease,
} from "./protocol";

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
  exit?: { readonly code: number | undefined; readonly signal: number | undefined };
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * `port` is the first core's, or undefined to wait for `attach`. A core's port
 * can go and another come: every PTY, its surfaces, gates and holds stay as
 * they are, and the new core takes them back with `pty.adopt`.
 */
export const serveTerminals = (
  port: CorePort | undefined,
  spawnPty: SpawnPty,
  epochs: PtyEpochs = systemEpochs,
): {
  readonly close: () => void;
  readonly live: () => number;
  /** A surface port arrived with its `pty.surface` message. */
  readonly openSurface: (open: TerminalSurfaceOpen, surface: SurfacePort) => void;
  /** A core's port arrived; any core before it is gone. */
  readonly attach: (core: CorePort) => void;
  /** This core's port closed. No effect on a core already replaced. */
  readonly detach: (core: CorePort) => void;
  /** Orderly quit: every PTY gets its hangup, and the promise settles after. */
  readonly hangupAll: () => Promise<void>;
} => {
  const ptys = new Map<number, IPty>();
  // Taken at spawn; a PTY whose epoch could not be read is never signalled.
  const epochOf = new Map<number, Promise<ChildProcessEpoch | undefined>>();
  const surfacesOf = new Map<number, Surfaces>();
  const links = new Map<number, CoreLink>();
  let core: CorePort | undefined;
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

  const adopt = (): readonly TerminalAdopted[] =>
    [...links].map(([id, link]) => ({
      id, pid: link.pid, cols: link.cols, rows: link.rows, meta: link.meta,
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
    if (ptys.has(input.id)) throw new Error(`terminal ${input.id} already exists`);
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

  const inbound = (channel: string, payload: unknown): void => {
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

  const received = (from: CorePort) => (message: CoreMessage): void => {
    if (message.kind === "push") return inbound(message.channel, message.payload);
    if (message.kind !== "call") return;
    if (message.name === TERMINAL_FENCE) {
      from.post({ kind: "answer", id: message.id, ok: true, value: {} });
      return;
    }
    if (message.name === TERMINAL_ADOPT) {
      from.post({ kind: "answer", id: message.id, ok: true, value: adopt() });
      redeliver();
      return;
    }
    if (message.name !== TERMINAL_SPAWN) {
      from.post({ kind: "answer", id: message.id, ok: false, failure: { tag: "UnknownTerminalOp", message: `no terminal operation named ${message.name}` } });
      return;
    }
    try {
      const pid = spawn(message.input as TerminalSpawnInput);
      from.post({ kind: "answer", id: message.id, ok: true, value: { pid } });
    } catch (error) {
      from.post({ kind: "answer", id: message.id, ok: false, failure: { tag: "TerminalBackendUnavailable", message: errorMessage(error) } });
    }
  };

  const detach = (gone: CorePort): void => {
    if (core !== gone) return;
    stopListening?.();
    stopListening = undefined;
    core = undefined;
    for (const link of links.values()) link.delivering = false;
  };

  const attach = (next: CorePort): void => {
    if (core !== undefined) detach(core);
    core = next;
    stopListening = next.listen(received(next));
  };

  if (port !== undefined) attach(port);

  return { close: () => { if (core !== undefined) detach(core); }, live: () => ptys.size, openSurface, attach, detach, hangupAll };
};
