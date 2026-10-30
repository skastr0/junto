import type { IPty } from "node-pty";
import type { CoreMessage, CorePort } from "../core-process/port";
import { readSingleProcessEpochSnapshotAsync, type ChildProcessEpoch } from "../junto/process-epoch";
import {
  TERMINAL_SPAWN,
  TerminalInbound,
  TerminalOutbound,
  type TerminalData,
  type TerminalError,
  type TerminalExitEvent,
  type TerminalAck,
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

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const serveTerminals = (
  port: CorePort,
  spawnPty: SpawnPty,
  epochs: PtyEpochs = systemEpochs,
): {
  readonly close: () => void;
  readonly live: () => number;
  /** A surface port arrived with its `pty.surface` message. */
  readonly openSurface: (open: TerminalSurfaceOpen, surface: SurfacePort) => void;
} => {
  const ptys = new Map<number, IPty>();
  // Taken at spawn; a PTY whose epoch could not be read is never signalled.
  const epochOf = new Map<number, Promise<ChildProcessEpoch | undefined>>();
  const surfacesOf = new Map<number, Surfaces>();
  // Output sent to the core and not yet handled there, and whether the PTY is paused for it.
  const unacked = new Map<number, { chars: number; paused: boolean }>();
  const push = (channel: string, payload: TerminalData | TerminalExitEvent | TerminalError): void =>
    port.post({ kind: "push", channel, payload });

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
    port.post({ kind: "push", channel: TerminalSurface.input, payload: { id, leaseId: from.leaseId, data } });
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
    push(TerminalOutbound.data, { id, data, seq });
    const owed = unacked.get(id);
    if (owed === undefined) return;
    owed.chars += data.length;
    if (!owed.paused && owed.chars > TERMINAL_UNACKED_HIGH) {
      owed.paused = true;
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
    if (open.fromSeq < oldest && open.fromSeq <= surfaces.seq) surface.post({ t: "gap" });
    else for (const chunk of surfaces.ring) if (chunk.seq >= open.fromSeq) surface.post({ t: "out", ...chunk });
    const stop = surface.listen((message) => {
      if (message.t !== "in") return;
      // Operator presence is the signal, not delivery: the core hears every
      // key as it arrives, a refused or held one included, before any gate.
      port.post({ kind: "push", channel: TerminalSurface.typing, payload: { id: open.id, leaseId: open.leaseId, data: message.data } });
      keyed(open.id, open, message.data);
    });
    surfaces.open.set(open.leaseId, { port: surface, stop });
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
    unacked.set(input.id, { chars: 0, paused: false });
    surfacesOf.set(input.id, { seq: 0, ring: [], ringBytes: 0, controller: null, held: false, heldKeys: [], open: new Map() });
    // The exit witness first, then the stream, as the plane installs them.
    pty.onExit(({ exitCode, signal }) => {
      ptys.delete(input.id);
      epochOf.delete(input.id);
      unacked.delete(input.id);
      const surfaces = surfacesOf.get(input.id);
      surfacesOf.delete(input.id);
      if (surfaces !== undefined) for (const leaseId of [...surfaces.open.keys()]) endSurface(surfaces, leaseId);
      push(TerminalOutbound.exit, { id: input.id, code: exitCode ?? undefined, signal: signal ?? undefined });
    });
    pty.onData((data) => output(input.id, data));
    return pty.pid;
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
      } catch (error) {
        push(TerminalOutbound.error, { id, message: errorMessage(error) });
      }
      return;
    }
    if (channel === TerminalInbound.ack) {
      const { id, chars } = payload as TerminalAck;
      const owed = unacked.get(id);
      if (owed === undefined) return;
      owed.chars = Math.max(0, owed.chars - chars);
      if (owed.paused && owed.chars < TERMINAL_UNACKED_LOW) {
        owed.paused = false;
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
    if (channel === TerminalInbound.kill) {
      const { id, signal } = payload as TerminalKill;
      const pty = ptys.get(id);
      const captured = epochOf.get(id);
      if (pty === undefined || captured === undefined) return;
      void (async () => {
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
      })();
    }
  };

  const close = port.listen((message: CoreMessage) => {
    if (message.kind === "push") return inbound(message.channel, message.payload);
    if (message.kind !== "call") return;
    if (message.name !== TERMINAL_SPAWN) {
      port.post({ kind: "answer", id: message.id, ok: false, failure: { tag: "UnknownTerminalOp", message: `no terminal operation named ${message.name}` } });
      return;
    }
    try {
      const pid = spawn(message.input as TerminalSpawnInput);
      port.post({ kind: "answer", id: message.id, ok: true, value: { pid } });
    } catch (error) {
      port.post({ kind: "answer", id: message.id, ok: false, failure: { tag: "TerminalBackendUnavailable", message: errorMessage(error) } });
    }
  });

  return { close, live: () => ptys.size, openSurface };
};
