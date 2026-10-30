import { MessageChannelMain, type IpcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import type {
  JuntoApi,
  MachineInventoryResult,
  NativeSettingsReadResult,
  NativeSettingWriteResult,
} from "@shared/ipc";
import {
  IPC_CHANNELS,
  type TerminalAttachInput,
  type TerminalFinishNodeDeleteOutcome,
  type TerminalNodeDeleteResource,
  type TerminalParkResult,
} from "@shared/ipc";
import { isHarnessId } from "@shared/managed-terminal-templates";
import type { ControlLease, LocalHostEvent } from "./local-host";
import { TerminalStreamCoalescer, terminalBindingKey } from "./stream-coalescer";
import { core } from "../../core-process/main-client";
import { subscribe as subscribeCore } from "../../core-process/push";
import { TERM_EVENT, TERM_LEASE_ENDED, TERM_SEAT_STATE } from "../../core-process/channels";
import { coreSurfacePlaneInUse } from "../../core-process/main-side/term-surface";

type LeaseOwner = {
  readonly lease: ControlLease;
  readonly sender: WebContents;
  readonly hostId: string;
  readonly release: () => void;
  /** The view is hidden: it is sent no output until it unparks. */
  parked: boolean;
  /** Output was held back while parked, so the unpark carries a catch-up. */
  missed: boolean;
  /**
   * The view takes a surface port: how to make one. While it holds one
   * (`surfaced`), its output goes over the port, never IPC; a hidden view
   * gives its port up and gets a new one when shown.
   */
  readonly surfacePorts?: typeof MessageChannelMain;
  surfaced: boolean;
  /** It gave its port up when it was hidden, and gets a new one when shown. */
  resurface?: boolean;
  /**
   * Output that flowed while an unpark read the screen for a new port. Given
   * up once the port opens (it starts after that screen); sent over IPC if
   * it does not, so the view misses none of it.
   */
  reading?: LocalHostEvent[];
  stopSurface?: () => void;
};

export type TerminalIpcGate = {
  readonly isTrustedSender: (sender: WebContents) => boolean;
  /** Renderer fan-out for what arrives on the cores' seat-state channel. */
  readonly broadcast: (channel: string, payload: unknown) => void;
};

const deny = (message: string): never => {
  throw new Error(message);
};

type AttachInput = TerminalAttachInput & { readonly hostId?: string };

/**
 * The window's terminal IPC. Every plane and router call asks the core by
 * name (`term.*`, ops/term-ipc.ts), so it runs where the plane is: the core
 * process, whose PTYs run in the terminal process over a port. The plane's
 * events come back on the push bus; main keeps the leases' windows, which are
 * Electron's, and hands each view its surface port.
 */
export const registerTerminalIpc = (
  ipcMain: IpcMain,
  gate: TerminalIpcGate,
): void => {
  const owners = new Map<string, LeaseOwner>();
  const controlByBinding = new Map<string, string>();

  const assertTrusted = (event: IpcMainInvokeEvent): WebContents => {
    const sender = event.sender;
    if (!sender || sender.isDestroyed()) deny("terminal ipc: sender gone");
    if (gate && !gate.isTrustedSender(sender)) deny("terminal ipc: untrusted sender");
    return sender;
  };

  /**
   * Give the owner's view a surface port, reading from the chunk after the
   * screen it painted (`read`, or the attach that minted its lease). False
   * when its PTY is not in the terminal process or the lease lost control;
   * the view then reads and types over IPC.
   */
  const openSurface = async (owner: LeaseOwner, read?: bigint): Promise<boolean> => {
    owner.stopSurface?.();
    owner.stopSurface = undefined;
    owner.surfaced = false;
    const corePlane = coreSurfacePlaneInUse();
    if (owner.surfacePorts === undefined || corePlane === undefined || owner.sender.isDestroyed()) return false;
    const { port1, port2 } = new owner.surfacePorts();
    const stopped = await corePlane.open(owner.lease, port1, read);
    if (stopped === undefined || owners.get(owner.lease.leaseId) !== owner || owner.sender.isDestroyed()) {
      stopped?.();
      port2.close();
      return false;
    }
    owner.stopSurface = stopped;
    owner.surfaced = true;
    owner.sender.postMessage(IPC_CHANNELS.terminalSurface, { leaseId: owner.lease.leaseId }, [port2]);
    return true;
  };

  const release = (leaseId: string): void => {
    const owner = owners.get(leaseId);
    if (!owner) return;
    owner.stopSurface?.();
    // Deliver any pending coalesced output to the releasing owner before the
    // lease tears down, then drop the buffer once no owner shares the binding.
    coalescer.flush(terminalBindingKey(owner.lease.bindingId, owner.lease.epoch));
    owners.delete(leaseId);
    let sharedBinding = false;
    for (const other of owners.values()) {
      if (
        other.lease.bindingId === owner.lease.bindingId &&
        other.lease.epoch === owner.lease.epoch
      ) {
        sharedBinding = true;
        break;
      }
    }
    if (!sharedBinding) {
      coalescer.drop(owner.lease.bindingId, owner.lease.epoch);
    }
    if (
      owner.lease.mode === "control" &&
      controlByBinding.get(owner.lease.bindingId) === leaseId
    ) {
      controlByBinding.delete(owner.lease.bindingId);
    }
    void core.call("term.release", { lease: owner.lease, hostId: owner.hostId }).catch(() => undefined);
    try {
      if (!owner.sender.isDestroyed()) {
        owner.sender.removeListener("destroyed", owner.release);
        owner.sender.removeListener("render-process-gone", owner.release);
        owner.sender.removeListener("did-start-loading", owner.release);
      }
    } catch {
      /* gone */
    }
  };

  /** Tell the window holding a lease that it ended without its release, so it stops typing into nothing. */
  const leaseEnded = (leaseId: string, reason: string): void => {
    const owner = owners.get(leaseId);
    if (owner === undefined || owner.sender.isDestroyed()) return;
    try {
      owner.sender.send(IPC_CHANNELS.terminalLeaseEnded, { leaseId, reason });
    } catch {
      /* gone */
    }
  };

  const owned = (sender: WebContents, leaseId: string): LeaseOwner | undefined => {
    const owner = owners.get(leaseId);
    return owner?.sender === sender && !sender.isDestroyed() ? owner : undefined;
  };

  // PTY output reaches renderers coalesced per binding+epoch: one event per
  // flush window instead of one per OS chunk. Observation (journal, seat
  // state) is untouched; this bounds redraw + compositor damage per open
  // surface, which is what lets stream presentation scale to many agents.
  const coalescer = new TerminalStreamCoalescer((payload: LocalHostEvent) => {
    for (const [leaseId, owner] of owners) {
      if (owner.lease.bindingId !== payload.bindingId || owner.lease.epoch !== payload.epoch) {
        continue;
      }
      if (owner.sender.isDestroyed()) {
        release(leaseId);
        continue;
      }
      // A hidden view parses nothing: its bytes stay in the main grid, which
      // its unpark reads back. Every other event still reaches it.
      if (owner.parked && payload.type === "output") {
        owner.missed = true;
        continue;
      }
      // While it holds a surface port the port carries the output, straight
      // from the terminal process; a view without one reads over IPC.
      if (owner.surfaced && payload.type === "output") continue;
      if (owner.reading !== undefined && payload.type === "output") {
        owner.reading.push(payload);
        continue;
      }
      try {
        owner.sender.send(IPC_CHANNELS.terminalEvent, payload);
      } catch {
        release(leaseId);
      }
    }
  },
  undefined,
  undefined,
  // A binding under a control lease is the surface the operator is driving:
  // typing into it, scrolling it, watching it. Its output is coalesced per
  // event loop turn instead of per window, so a batch never waits on a clock;
  // every other stream keeps the long window. `controlByBinding` is already
  // the authority for who holds control, so this reads the existing fact
  // rather than inventing a second notion of "visible". A parked control view
  // is hidden, so its binding keeps the long window.
  (bindingId: string) => {
    const leaseId = controlByBinding.get(bindingId);
    return leaseId !== undefined && owners.get(leaseId)?.parked !== true;
  });
  // A linked seat's view the seat's machine ended: tell its window, then forget the lease.
  subscribeCore(TERM_LEASE_ENDED, (payload) => {
    const end = payload as { readonly leaseId: string; readonly reason: string };
    if (!owners.has(end.leaseId)) return;
    leaseEnded(end.leaseId, end.reason);
    release(end.leaseId);
  });
  // A seat on another machine reports its state over the seats channel.
  subscribeCore(TERM_SEAT_STATE, (event) => gate?.broadcast(IPC_CHANNELS.agentSeatStateChanged, event));
  subscribeCore(TERM_EVENT, (raw) => {
    const payload = raw as LocalHostEvent;
    if (payload.type === "seat-state") {
      gate?.broadcast(IPC_CHANNELS.agentSeatStateChanged, payload.event);
      return;
    }
    coalescer.push(payload);
  });

  ipcMain.handle(IPC_CHANNELS.terminalList, async (event, hostId?: string) => {
    assertTrusted(event);
    return core.call("term.list", { ...(hostId === undefined ? {} : { hostId }) });
  });

  ipcMain.handle(
    IPC_CHANNELS.hostDirectoryRead,
    async (event, hostId: string, path?: string) => {
      assertTrusted(event);
      return core.call("term.readDirectory", { hostId, ...(path === undefined ? {} : { path }) });
    },
  );

  const readSeat = async (canvas: string, id: string) => {
    if (typeof canvas !== "string" || !canvas.trim() || typeof id !== "string" || !id.trim())
      return deny("terminal ipc: canvas and node id required");
    const node = await core.call("term.seatNode", { canvas, id });
    if (node?.kind !== "agent" && node?.kind !== "terminal")
      return deny("terminal ipc: this node is not a seat or terminal");
    return node;
  };

  ipcMain.handle(IPC_CHANNELS.modelSeatLaunchState, async (event, input: Parameters<JuntoApi["modelSeatLaunchState"]>[0]) => {
    assertTrusted(event);
    const node = await readSeat(input?.canvas, input?.id);
    if (node.kind !== "agent") return { settingsFixed: false };
    if (await core.call("term.isLocalHost", { hostId: node.host })) return core.call("term.seatLaunchState", { canvas: input.canvas, node });
    // A seat on another machine: what that machine last said (seats-launch.ts).
    const launch = await core.call("term.remoteSeatLaunch", { node });
    return launch === undefined ? deny("This seat runs on another machine.") : launch;
  });

  ipcMain.handle(IPC_CHANNELS.modelStart, async (event, input: Parameters<JuntoApi["modelStart"]>[0]) => {
    assertTrusted(event);
    const node = await readSeat(input?.canvas, input?.id);
    if (node.kind === "agent") {
      return core.call("term.startSeat", { canvas: input.canvas, seatId: node.id });
    }
    // The core takes the delete admission and reaches another machine before it starts.
    return core.call("term.startTerminal", { canvas: input.canvas, node });
  });

  ipcMain.handle(IPC_CHANNELS.modelStop, async (event, input: Parameters<JuntoApi["modelStop"]>[0]) => {
    assertTrusted(event);
    const node = await readSeat(input?.canvas, input?.id);
    if (node.kind !== "agent") return void await stopBinding(node.bindingId, node.host);
    await core.call("term.stopSeat", { canvas: input.canvas, seatId: node.id });
  });

  ipcMain.handle(
    IPC_CHANNELS.managedTerminalModels,
    async (event, harness: string) => {
      assertTrusted(event);
      return core.call("term.harnessModels", { harness });
    },
  );

  ipcMain.handle(IPC_CHANNELS.managedTerminalProfiles, async (event) => {
    assertTrusted(event);
    return core.call("term.managedProfiles", {});
  });

  ipcMain.handle(IPC_CHANNELS.machineInventory, async (event, machine: unknown): Promise<MachineInventoryResult> => {
    assertTrusted(event);
    if (typeof machine !== "string" || !machine.trim()) return deny("machine inventory: a machine name is required");
    return core.call("term.machineInventory", { machine });
  });

  // Every machine's harness config, this one included, goes through the same
  // client: this machine answers itself, a linked one over the link.
  ipcMain.handle(IPC_CHANNELS.nativeSettingsRead, async (event, input: unknown): Promise<NativeSettingsReadResult> => {
    assertTrusted(event);
    const request = input as { machine?: unknown; harness?: unknown; keys?: unknown } | undefined;
    if (typeof request?.machine !== "string" || typeof request.harness !== "string"
      || !Array.isArray(request.keys) || !request.keys.every((key) => typeof key === "string"))
      return deny("native settings: machine, harness and keys are required");
    const { machine, harness, keys } = { machine: request.machine, harness: request.harness, keys: request.keys as string[] };
    return core.call("term.nativeSettingsRead", { machine, harness, keys });
  });

  ipcMain.handle(IPC_CHANNELS.nativeSettingWrite, async (event, input: unknown): Promise<NativeSettingWriteResult> => {
    assertTrusted(event);
    const request = input as { machine?: unknown; harness?: unknown; key?: unknown; value?: unknown } | undefined;
    if (typeof request?.machine !== "string" || typeof request.harness !== "string" || typeof request.key !== "string")
      return deny("native settings: machine, harness, key and value are required");
    const { machine, harness, key, value } = { machine: request.machine, harness: request.harness, key: request.key, value: request.value };
    return core.call("term.nativeSettingWrite", { machine, harness, key, value });
  });

  ipcMain.handle(IPC_CHANNELS.managedTerminalHarnesses, async (event) => {
    assertTrusted(event);
    return core.call("term.harnessInstalls", {});
  });

  ipcMain.handle(
    IPC_CHANNELS.managedTerminalFlags,
    async (event, harness: string, cwd?: string) => {
      assertTrusted(event);
      if (typeof harness !== "string" || !isHarnessId(harness)) {
        return { installed: false, flags: [] };
      }
      return core.call("term.harnessFlags", { harness, ...(typeof cwd === "string" ? { cwd } : {}) });
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.terminalGet,
    async (event, bindingId: string, hostId?: string) => {
      assertTrusted(event);
      return core.call("term.get", { bindingId, ...(hostId === undefined ? {} : { hostId }) });
    },
  );

  // Both trusted IPC stop commands use the same owned-session router capability;
  // a seat on another machine is stopped over the seats channel, typed.
  const stopBinding = (bindingId: string, hostId?: string) =>
    core.call("term.stopBinding", { bindingId, ...(hostId === undefined ? {} : { hostId }) });

  ipcMain.handle(
    IPC_CHANNELS.terminalKill,
    async (event, bindingId: string, hostId?: string) => {
      assertTrusted(event);
      return stopBinding(bindingId, hostId);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.terminalBeginNodeDelete,
    (
      event,
      resources: ReadonlyArray<TerminalNodeDeleteResource>,
    ) => {
      assertTrusted(event);
      return core.call("term.beginNodeDelete", { resources });
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.terminalFinishNodeDelete,
    (
      event,
      leaseId: string,
      outcome: TerminalFinishNodeDeleteOutcome,
    ) => {
      assertTrusted(event);
      return core.call("term.finishNodeDelete", { leaseId, outcome });
    },
  );

  ipcMain.handle(IPC_CHANNELS.terminalAttach, async (event, input: AttachInput) => {
    const sender = assertTrusted(event);
    const hostId = input.hostId?.trim() || (await core.call("term.thisMachine", {}));
    const local = await core.call("term.isLocalHost", { hostId });
    // Every local lease gets a port, an observe lease's included.
    const surfacePorts = input.surface === true && (input.mode === "control" || coreSurfacePlaneInUse() !== undefined) && local
      ? MessageChannelMain
      : undefined;
    if (input.mode === "control" && input.takeover) {
      const priorLeaseId = controlByBinding.get(input.bindingId);
      if (priorLeaseId) {
        leaseEnded(priorLeaseId, "replaced");
        release(priorLeaseId);
      }
    }
    const { result } = await core.call("term.attach", { input: { ...input, hostId } });
    if (!result.ok) return result;
    if (sender.isDestroyed()) {
      void core.call("term.release", { lease: result.lease, hostId }).catch(() => undefined);
      return { ok: false as const, message: "renderer gone" };
    }
    const leaseId = result.lease.leaseId;
    const releaseOwner = () => release(leaseId);
    sender.once("destroyed", releaseOwner);
    sender.once("render-process-gone", releaseOwner);
    sender.once("did-start-loading", releaseOwner);
    owners.set(leaseId, {
      lease: result.lease,
      sender,
      hostId,
      release: releaseOwner,
      parked: false,
      missed: false,
      ...(surfacePorts === undefined ? {} : { surfacePorts }),
      surfaced: false,
    });
    if (result.lease.mode === "control") {
      controlByBinding.set(result.lease.bindingId, leaseId);
    }
    if (surfacePorts !== undefined) void openSurface(owners.get(leaseId)!);
    return result;
  });

  ipcMain.handle(IPC_CHANNELS.terminalRelease, async (event, leaseId: string) => {
    assertTrusted(event);
    if (!owned(event.sender, leaseId)) return false;
    release(leaseId);
    return true;
  });

  // A hidden view parks its stream and keeps its lease, so the main grid keeps
  // the watched scrollback for it. Shown again, a view that missed output
  // repaints from that grid's full snapshot, read through a short observe
  // lease so local, linked and viewed seats answer the same way. Output that
  // flows after the unpark carries later sequence numbers than the snapshot,
  // the same contract a first attach keeps.
  ipcMain.handle(
    IPC_CHANNELS.terminalPark,
    async (event, leaseId: string, parked: boolean): Promise<TerminalParkResult> => {
      assertTrusted(event);
      const owner = owned(event.sender, leaseId);
      if (!owner) return { ok: false };
      if (parked) {
        if (!owner.parked) {
          coalescer.flush(terminalBindingKey(owner.lease.bindingId, owner.lease.epoch));
          owner.parked = true;
          owner.missed = false;
          if (owner.surfaced) {
            // A hidden view parses nothing: its port goes, and showing it
            // again repaints from the grid and opens a new one.
            owner.stopSurface?.();
            owner.stopSurface = undefined;
            owner.surfaced = false;
            owner.missed = true;
            owner.resurface = true;
          }
        }
        return { ok: true, missed: false };
      }
      if (!owner.parked) return { ok: true, missed: false };
      owner.parked = false;
      // Output that flows while the screen is read waits to see whether the
      // new port opens: it starts after that screen, so then none of this is
      // needed; if it does not, this goes over IPC, after the screen.
      const resurface = owner.resurface === true;
      owner.resurface = false;
      if (resurface) owner.reading = [];
      const endRead = (opened: boolean): void => {
        const held = owner.reading ?? [];
        owner.reading = undefined;
        if (opened || owner.sender.isDestroyed()) return;
        for (const payload of held) {
          try {
            owner.sender.send(IPC_CHANNELS.terminalEvent, payload);
          } catch {
            return;
          }
        }
      };
      const missed = owner.missed;
      owner.missed = false;
      if (!missed) return { ok: true, missed: false };
      const { result: view } = await core.call("term.attach", { input: {
        bindingId: owner.lease.bindingId,
        mode: "observe",
        hostId: owner.hostId,
      } });
      if (!view.ok) {
        endRead(false);
        return { ok: true, missed: true };
      }
      void core.call("term.release", { lease: view.lease, hostId: owner.hostId }).catch(() => undefined);
      if (view.lease.epoch !== owner.lease.epoch) {
        endRead(false);
        return { ok: true, missed: true };
      }
      const screen = view.screen?.epoch === owner.lease.epoch ? view.screen : undefined;
      // No new port (the lease lost control during the read, the generation
      // left no grid, or the chunk memory let go of the screen's seq): the
      // view paints what there is and reads over IPC from here, beginning
      // with what flowed during the read.
      if (resurface && owner.parked) {
        // Hidden again while the screen was read: no port for a hidden view.
        // It missed this output, and its next unpark reads a new screen and
        // opens the port then.
        owner.reading = undefined;
        owner.missed = true;
        owner.resurface = true;
      } else if (resurface) endRead(screen !== undefined && await openSurface(owner, screen.seq));
      return {
        ok: true,
        missed: true,
        ...(screen
          ? { screen: { epoch: screen.epoch, cols: screen.cols, rows: screen.rows, seq: screen.seq, serialized: screen.serialized } }
          : {}),
        journal: view.journal,
      };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.terminalWrite,
    async (event, leaseId: string, data: string, encoding = "utf8") => {
      assertTrusted(event);
      const owner = owned(event.sender, leaseId);
      if (!owner) return false;
      const decoded =
        encoding === "base64" ? Buffer.from(data, "base64").toString("utf8") : data;
      // The core tags the input's origin where the keys land (term.write).
      return core.call("term.write", { lease: owner.lease, data: decoded, hostId: owner.hostId });
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.terminalResize,
    async (event, leaseId: string, cols: number, rows: number) => {
      assertTrusted(event);
      const owner = owned(event.sender, leaseId);
      if (!owner) return false;
      return core.call("term.resize", { lease: owner.lease, cols, rows, hostId: owner.hostId });
    },
  );
};
