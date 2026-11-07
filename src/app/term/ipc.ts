import { MessageChannelMain, type IpcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import { Context, Effect, Predicate, Result, Schema } from "effect";
import type { MachineInventoryResult, NativeSettingsReadResult, NativeSettingWriteResult } from "@shared/ipc";
import { IPC_CHANNELS, type TerminalParkResult } from "@shared/ipc";
import type { TerminalSessionSummary } from "@shared/terminal";
import type { LocalHostEvent } from "../../core/term/local-host";
import { TerminalStreamCoalescer, terminalBindingKey } from "./stream-coalescer";
import { CorePushesMain } from "../core-process/main-side/core-pushes";
import { TERM_EVENT, TERM_LEASE_ENDED, TERM_SEAT_STATE } from "../../contract/core/channels";
import { CoreLink, coreClient } from "../../contract/core/link";
import {
  TermAttachInput,
  TermBindingAsk,
  TermCore,
  TermDirectoryAsk,
  TermHarnessAsk,
  TermListAsk,
  TermMachineAsk,
  TermNativeSettingsAsk,
  TermNativeSettingWriteAsk,
  TermNodeDeleteBegin,
  TermNodeDeleteFinish,
  TermRpcs,
  TermSeatWhere,
  type ControlLease,
} from "../../contract/core/term-ipc";
import { TermTemplatesCore, TermTemplatesFlagsAsk } from "../../contract/core/term-templates";
import type { RpcPort } from "../../shared/rpc-port";
import type { SurfacePlane } from "../core-process/main-side/term-surface";
import { AppRuntime } from "../runtime";

type LeaseOwner = {
  readonly lease: typeof ControlLease.Type;
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
  /** The core's surface plane while a core is up, or none: main's boot owns the answer. */
  readonly surfacePlane: () => SurfacePlane | undefined;
};

const deny = (message: string): never => {
  throw new Error(message);
};

/** A closed decoder of what the window sends: the value, or undefined when it is not that shape exactly. */
const strict = <S extends Schema.ConstraintDecoder<unknown>>(schema: S): ((raw: unknown) => S["Type"] | undefined) => {
  const decode = Schema.decodeUnknownResult(schema);
  return (raw) => Result.getOrUndefined(decode(raw, { onExcessProperty: "error" }));
};

/** The window's arguments as one payload: one it left out, or sent as undefined, is absent. */
const present = (raw: unknown): unknown =>
  Predicate.isObject(raw)
    ? Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== undefined))
    : raw;

const decodeList = strict(TermListAsk);
const decodeDirectory = strict(TermDirectoryAsk);
const decodeSeat = strict(TermSeatWhere);
const decodeHarness = strict(TermHarnessAsk);
const decodeMachine = strict(TermMachineAsk);
const decodeNativeRead = strict(TermNativeSettingsAsk);
const decodeNativeWrite = strict(TermNativeSettingWriteAsk);
const decodeFlags = strict(TermTemplatesFlagsAsk);
const decodeBinding = strict(TermBindingAsk);
const decodeDeleteBegin = strict(TermNodeDeleteBegin);
const decodeDeleteFinish = strict(TermNodeDeleteFinish);
const decodeAttach = strict(TermAttachInput);
const decodeText = strict(Schema.String);
const decodeCount = strict(Schema.Number);

/**
 * What is running, as the core's terminal plane lists it, for the quit
 * prompt: a client of the terminal group on the core's link, for this one
 * read. No core, or a core that does not answer, rejects; the quit counts
 * that as unknown (quit-live-work.ts).
 */
export const coreTerminalSessions =
  (link: () => RpcPort | undefined) => (): Promise<ReadonlyArray<TerminalSessionSummary>> => {
    const port = link();
    if (port === undefined) return Promise.reject(new Error("no core is running to say what is running"));
    return AppRuntime.runPromise(
      Effect.scoped(Effect.flatMap(coreClient(TermRpcs), (term) => term.TermList({}))).pipe(
        Effect.provideService(CoreLink, port),
      ),
    );
  };

/**
 * The window's terminal IPC. Every plane and router call asks the core's
 * terminal group (src/contract/core/term-ipc.ts), so it runs where the plane
 * is: the core process, whose PTYs run in the terminal process over a port.
 * The window's input is decoded closed here first. The plane's events come
 * back on the push bus; main keeps the leases' windows, which are Electron's,
 * and hands each view its surface port.
 */
export const registerTerminalIpc = (
  ipcMain: IpcMain,
  gate: TerminalIpcGate,
  core: Context.Context<TermCore | TermTemplatesCore | CorePushesMain>,
): void => {
  const term = Context.get(core, TermCore);
  const templates = Context.get(core, TermTemplatesCore);
  const pushes = Context.get(core, CorePushesMain);
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
    const corePlane = gate.surfacePlane();
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
    void AppRuntime.runPromise(term.TermRelease({ lease: owner.lease, hostId: owner.hostId })).catch(() => undefined);
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

  const owned = (sender: WebContents, leaseId: unknown): LeaseOwner | undefined => {
    const owner = typeof leaseId === "string" ? owners.get(leaseId) : undefined;
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
  pushes.subscribe(TERM_LEASE_ENDED, (payload) => {
    const end = payload as { readonly leaseId: string; readonly reason: string };
    if (!owners.has(end.leaseId)) return;
    leaseEnded(end.leaseId, end.reason);
    release(end.leaseId);
  });
  // A seat on another machine reports its state over the seats channel.
  pushes.subscribe(TERM_SEAT_STATE, (event) => gate?.broadcast(IPC_CHANNELS.agentSeatStateChanged, event));
  pushes.subscribe(TERM_EVENT, (raw) => {
    const payload = raw as LocalHostEvent;
    if (payload.type === "seat-state") {
      gate?.broadcast(IPC_CHANNELS.agentSeatStateChanged, payload.event);
      return;
    }
    coalescer.push(payload);
  });

  ipcMain.handle(IPC_CHANNELS.terminalList, async (event, hostId: unknown) => {
    assertTrusted(event);
    const ask = decodeList(present({ hostId })) ?? deny("terminal ipc: a host is named by text");
    return AppRuntime.runPromise(term.TermList(ask));
  });

  ipcMain.handle(
    IPC_CHANNELS.hostDirectoryRead,
    async (event, hostId: unknown, path: unknown) => {
      assertTrusted(event);
      const ask = decodeDirectory(present({ hostId, path })) ?? deny("terminal ipc: a host and a folder are named by text");
      return AppRuntime.runPromise(term.TermReadDirectory(ask));
    },
  );

  const readSeat = async (input: unknown) => {
    const where = decodeSeat(input) ?? deny("terminal ipc: canvas and node id required");
    const node = await AppRuntime.runPromise(term.TermSeatNode(where));
    return node === undefined ? deny("terminal ipc: this node is not a seat or terminal") : { canvas: where.canvas, node };
  };

  ipcMain.handle(IPC_CHANNELS.modelSeatLaunchState, async (event, input: unknown) => {
    assertTrusted(event);
    const { canvas, node } = await readSeat(input);
    if (node.kind !== "agent") return { settingsFixed: false };
    if (await AppRuntime.runPromise(term.TermIsLocalHost({ hostId: node.host })))
      return AppRuntime.runPromise(term.TermSeatLaunchState({ canvas, node }));
    // A seat on another machine: what that machine last said (seats-launch.ts).
    const launch = await AppRuntime.runPromise(term.TermRemoteSeatLaunch({ node }));
    return launch === undefined ? deny("This seat runs on another machine.") : launch;
  });

  ipcMain.handle(IPC_CHANNELS.modelStart, async (event, input: unknown) => {
    assertTrusted(event);
    const { canvas, node } = await readSeat(input);
    if (node.kind === "agent") {
      return AppRuntime.runPromise(term.TermStartSeat({ canvas, seatId: node.id }));
    }
    // The core takes the delete admission and reaches another machine before it starts.
    return AppRuntime.runPromise(term.TermStartTerminal({ canvas, node }));
  });

  ipcMain.handle(IPC_CHANNELS.modelStop, async (event, input: unknown) => {
    assertTrusted(event);
    const { canvas, node } = await readSeat(input);
    if (node.kind !== "agent") return void await stopBinding({ bindingId: node.bindingId, hostId: node.host });
    await AppRuntime.runPromise(term.TermStopSeat({ canvas, seatId: node.id }));
  });

  ipcMain.handle(
    IPC_CHANNELS.managedTerminalModels,
    async (event, harness: unknown) => {
      assertTrusted(event);
      const ask = decodeHarness({ harness }) ?? deny("terminal ipc: a harness is named by text");
      return AppRuntime.runPromise(term.TermHarnessModels(ask));
    },
  );

  ipcMain.handle(IPC_CHANNELS.managedTerminalProfiles, async (event) => {
    assertTrusted(event);
    return AppRuntime.runPromise(templates.TermTemplatesManagedProfiles());
  });

  ipcMain.handle(IPC_CHANNELS.machineInventory, async (event, machine: unknown): Promise<MachineInventoryResult> => {
    assertTrusted(event);
    const ask = decodeMachine({ machine }) ?? deny("machine inventory: a machine name is required");
    return AppRuntime.runPromise(term.TermMachineInventory(ask));
  });

  // Every machine's harness config, this one included, goes through the same
  // client: this machine answers itself, a linked one over the link.
  ipcMain.handle(IPC_CHANNELS.nativeSettingsRead, async (event, input: unknown): Promise<NativeSettingsReadResult> => {
    assertTrusted(event);
    const ask = decodeNativeRead(input) ?? deny("native settings: machine, harness and keys are required");
    return AppRuntime.runPromise(term.TermNativeSettingsRead(ask));
  });

  ipcMain.handle(IPC_CHANNELS.nativeSettingWrite, async (event, input: unknown): Promise<NativeSettingWriteResult> => {
    assertTrusted(event);
    const write = decodeNativeWrite(input) ?? deny("native settings: machine, harness, key and value are required");
    return AppRuntime.runPromise(term.TermNativeSettingWrite(write));
  });

  ipcMain.handle(IPC_CHANNELS.managedTerminalHarnesses, async (event) => {
    assertTrusted(event);
    return AppRuntime.runPromise(templates.TermTemplatesHarnessInstalls());
  });

  ipcMain.handle(
    IPC_CHANNELS.managedTerminalFlags,
    async (event, harness: unknown, cwd: unknown) => {
      assertTrusted(event);
      // A folder that is not text is not asked in; the harness still answers.
      const ask = decodeFlags(present({ harness, cwd: typeof cwd === "string" ? cwd : undefined }));
      if (ask === undefined) return { installed: false, flags: [] };
      return AppRuntime.runPromise(templates.TermTemplatesHarnessFlags(ask));
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.terminalGet,
    async (event, bindingId: unknown, hostId: unknown) => {
      assertTrusted(event);
      const ask = decodeBinding(present({ bindingId, hostId })) ?? deny("terminal ipc: a binding is named by text");
      return AppRuntime.runPromise(term.TermGet(ask));
    },
  );

  // Both trusted IPC stop commands use the same owned-session router capability;
  // a seat on another machine is stopped over the seats channel, typed.
  const stopBinding = (ask: typeof TermBindingAsk.Type) => AppRuntime.runPromise(term.TermStopBinding(ask));

  ipcMain.handle(
    IPC_CHANNELS.terminalKill,
    async (event, bindingId: unknown, hostId: unknown) => {
      assertTrusted(event);
      return stopBinding(decodeBinding(present({ bindingId, hostId })) ?? deny("terminal ipc: a binding is named by text"));
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.terminalBeginNodeDelete,
    (event, resources: unknown) => {
      assertTrusted(event);
      const ask = decodeDeleteBegin({ resources }) ?? deny("terminal ipc: the bindings to delete are each a binding and a host");
      return AppRuntime.runPromise(term.TermBeginNodeDelete(ask));
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.terminalFinishNodeDelete,
    (event, leaseId: unknown, outcome: unknown) => {
      assertTrusted(event);
      const ask = decodeDeleteFinish({ leaseId, outcome }) ?? deny("terminal ipc: a delete ends committed or aborted");
      return AppRuntime.runPromise(term.TermFinishNodeDelete(ask));
    },
  );

  ipcMain.handle(IPC_CHANNELS.terminalAttach, async (event, raw: unknown) => {
    const sender = assertTrusted(event);
    const input = decodeAttach(present(raw)) ?? deny("terminal ipc: this build does not read that attach");
    const hostId = input.hostId?.trim() || (await AppRuntime.runPromise(term.TermThisMachine()));
    const local = await AppRuntime.runPromise(term.TermIsLocalHost({ hostId }));
    // Every local lease gets a port, an observe lease's included.
    const surfacePorts = input.surface === true && (input.mode === "control" || gate.surfacePlane() !== undefined) && local
      ? MessageChannelMain
      : undefined;
    if (input.mode === "control" && input.takeover) {
      const priorLeaseId = controlByBinding.get(input.bindingId);
      if (priorLeaseId) {
        leaseEnded(priorLeaseId, "replaced");
        release(priorLeaseId);
      }
    }
    const { result } = await AppRuntime.runPromise(term.TermAttach({ input: { ...input, hostId } }));
    if (!result.ok) return result;
    if (sender.isDestroyed()) {
      void AppRuntime.runPromise(term.TermRelease({ lease: result.lease, hostId })).catch(() => undefined);
      return { ok: false as const, message: "renderer gone" };
    }
    const leaseId = result.lease.leaseId;
    const releaseOwner = () => release(leaseId);
    sender.once("destroyed", releaseOwner);
    sender.once("render-process-gone", releaseOwner);
    sender.once("did-start-loading", releaseOwner);
    const owner: LeaseOwner = {
      lease: result.lease,
      sender,
      hostId,
      release: releaseOwner,
      parked: false,
      missed: false,
      ...(surfacePorts === undefined ? {} : { surfacePorts }),
      surfaced: false,
    };
    owners.set(leaseId, owner);
    if (result.lease.mode === "control") {
      controlByBinding.set(result.lease.bindingId, leaseId);
    }
    if (surfacePorts !== undefined) void openSurface(owner);
    return result;
  });

  ipcMain.handle(IPC_CHANNELS.terminalRelease, async (event, leaseId: unknown) => {
    assertTrusted(event);
    if (typeof leaseId !== "string" || !owned(event.sender, leaseId)) return false;
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
    async (event, leaseId: unknown, parked: unknown): Promise<TerminalParkResult> => {
      assertTrusted(event);
      const owner = owned(event.sender, leaseId);
      if (!owner || typeof parked !== "boolean") return { ok: false };
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
      const { result: view } = await AppRuntime.runPromise(term.TermAttach({ input: {
        bindingId: owner.lease.bindingId,
        mode: "observe",
        hostId: owner.hostId,
      } }));
      if (!view.ok) {
        endRead(false);
        return { ok: true, missed: true };
      }
      void AppRuntime.runPromise(term.TermRelease({ lease: view.lease, hostId: owner.hostId })).catch(() => undefined);
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
    async (event, leaseId: unknown, data: unknown, encoding: unknown = "utf8") => {
      assertTrusted(event);
      const owner = owned(event.sender, leaseId);
      const text = decodeText(data);
      if (!owner || text === undefined) return false;
      const decoded = encoding === "base64" ? Buffer.from(text, "base64").toString("utf8") : text;
      // The core tags the input's origin where the keys land (TermWrite).
      return AppRuntime.runPromise(term.TermWrite({ lease: owner.lease, data: decoded, hostId: owner.hostId }));
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.terminalResize,
    async (event, leaseId: unknown, cols: unknown, rows: unknown) => {
      assertTrusted(event);
      const owner = owned(event.sender, leaseId);
      const width = decodeCount(cols);
      const height = decodeCount(rows);
      if (!owner || width === undefined || height === undefined) return false;
      return AppRuntime.runPromise(term.TermResize({ lease: owner.lease, cols: width, rows: height, hostId: owner.hostId }));
    },
  );
};
