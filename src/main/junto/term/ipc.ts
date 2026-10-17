import { randomUUID } from "node:crypto";
import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import { ModelService } from "../model/service";
import { SeatSessionRepository } from "../seat-sessions/repository";
import { shouldResumeHarnessSession } from "./session-existence";
import { seatNextLaunch } from "@shared/seat-next-launch";
import type {
  JuntoApi,
  MachineInventoryResult,
  NativeSettingFailure,
  NativeSettingsReadResult,
  NativeSettingWriteResult,
} from "@shared/ipc";
import {
  IPC_CHANNELS,
  type TerminalAttachInput,
  type TerminalFinishNodeDeleteOutcome,
  type TerminalNodeDeleteResource,
} from "@shared/ipc";
import {
  isHarnessId,
  templateFor,
} from "@shared/managed-terminal-templates";
import { asCanvasName } from "@shared/model";
import type { ControlLease, LocalHostEvent } from "./local-host";
import { TerminalStreamCoalescer, terminalBindingKey } from "./stream-coalescer";
import type { TermPlane } from "./plane";
import { injectionSupervisor } from "./injection-supervisor";
import { onRemoteSeatState, rememberRemoteSeatState } from "./remote-seat-state";
import { AppRuntime } from "../../runtime";
import { liveSeatEnvironment } from "../region-env/live";
import { Effect, Result, Schema } from "effect";
import { MachineRepository } from "../machines/repository";
import type { InventoryUnavailableError } from "@shared/harness-domain/inventory";
import type { NativeSettingRefusedError } from "@shared/harness-domain/native-config";
import type { NativeConfigWriteError } from "@shared/harness-domain/native-config-write";

type LeaseOwner = {
  readonly lease: ControlLease;
  readonly sender: WebContents;
  readonly hostId: string;
  readonly release: () => void;
};

export type TerminalIpcGate = {
  readonly isTrustedSender: (sender: WebContents) => boolean;
  /**
   * Integration hook invoked before a named host is resolved. Core terminal
   * routing remains provider-neutral; an optional provider may restore it.
   */
  readonly ensureHostAvailable?: (hostId: string) => Promise<void>;
  /**
   * Renderer fan-out. Remote seat-state arrives on the term-control hop
   * (Mini observer → this router) and never through the local runtime.
   */
  readonly broadcast: (channel: string, payload: unknown) => void;
};

const deny = (message: string): never => {
  throw new Error(message);
};

type AttachInput = TerminalAttachInput & { readonly hostId?: string };

export const registerTerminalIpc = (
  ipcMain: IpcMain,
  plane: TermPlane,
  gate?: TerminalIpcGate,
): void => {
  const owners = new Map<string, LeaseOwner>();
  const controlByBinding = new Map<string, string>();
  const router = plane.router;
  const nodeDelete = plane.nodeDelete;
  // A plain terminal opened inside a region starts with that region's
  // environment, read by the same service that serves agent seats.
  router.setTerminalEnvironment(liveSeatEnvironment);

  const assertTrusted = (event: IpcMainInvokeEvent): WebContents => {
    const sender = event.sender;
    if (!sender || sender.isDestroyed()) deny("terminal ipc: sender gone");
    if (gate && !gate.isTrustedSender(sender)) deny("terminal ipc: untrusted sender");
    return sender;
  };
  const ensureHostAvailable = async (
    hostId: string | undefined,
  ): Promise<void> => {
    const target = hostId?.trim();
    if (
      target === undefined ||
      target.length === 0 ||
      router.isLocalHostId(target) ||
      target === "*" ||
      target === "all"
    ) {
      return;
    }
    await gate?.ensureHostAvailable?.(target);
  };

  const release = (leaseId: string): void => {
    const owner = owners.get(leaseId);
    if (!owner) return;
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
    void router.release(owner.lease, owner.hostId);
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
  // rather than inventing a second notion of "visible".
  (bindingId: string) => controlByBinding.has(bindingId));
  // A seat on another machine reports its state over the seats channel.
  onRemoteSeatState((event) => gate?.broadcast(IPC_CHANNELS.agentSeatStateChanged, event));
  router.on("event", (payload: LocalHostEvent) => {
    if (payload.type === "seat-state") {
      rememberRemoteSeatState(payload.event);
      gate?.broadcast(IPC_CHANNELS.agentSeatStateChanged, payload.event);
      return;
    }
    coalescer.push(payload);
  });

  ipcMain.handle(IPC_CHANNELS.terminalList, async (event, hostId?: string) => {
    assertTrusted(event);
    if (hostId === "*" || hostId === "all") return router.listAll();
    await ensureHostAvailable(hostId);
    return router.list(hostId);
  });

  ipcMain.handle(
    IPC_CHANNELS.hostDirectoryRead,
    async (event, hostId: string, path?: string) => {
      assertTrusted(event);
      await ensureHostAvailable(hostId);
      return router.readDirectory(hostId, path);
    },
  );

  const readSeat = async (canvas: string, id: string) => {
    if (typeof canvas !== "string" || !canvas.trim() || typeof id !== "string" || !id.trim())
      return deny("terminal ipc: canvas and node id required");
    const node = await AppRuntime.runPromise(Effect.gen(function* () {
      const model = yield* ModelService;
      const current = yield* model.canvas(canvas);
      return current.nodes.get(id as never);
    }));
    if (node?.kind !== "agent" && node?.kind !== "terminal")
      return deny("terminal ipc: this node is not a seat or terminal");
    return node;
  };

  ipcMain.handle(IPC_CHANNELS.modelSeatLaunchState, async (event, input: Parameters<JuntoApi["modelSeatLaunchState"]>[0]) => {
    assertTrusted(event);
    const node = await readSeat(input?.canvas, input?.id);
    if (node.kind !== "agent") return { hasSession: false, next: "fresh" };
    if (!router.isLocalHostId(node.host)) return deny("This seat runs on another machine.");
    const { session, history } = await AppRuntime.runPromise(Effect.flatMap(SeatSessionRepository,
      (sessions) => Effect.all({
        session: sessions.current(node.id, node.bindingId),
        history: sessions.list(node.id).pipe(Effect.orElseSucceed(() => [])),
      })));
    const lastEnded = history.find((row) => row.endedAt !== undefined)?.endReason;
    // The same proof a start asks for (managed-spawn-plan.ts): the harness's own store holds the id.
    const cwd = node.launch?.cwd?.trim();
    const next = seatNextLaunch({
      harness: node.harness,
      ...(session ? { open: { harness: session.harness, sessionId: session.sessionId } } : {}),
      provisioned: isHarnessId(node.harness) && templateFor(node.harness).capabilityBadges.sessionId === "provision",
      provenOnDisk: session !== undefined && session.harness === node.harness &&
        shouldResumeHarnessSession(true, { harness: node.harness, sessionId: session.sessionId, ...(cwd ? { cwd } : {}) }),
      ...(lastEnded ? { lastEnded } : {}),
    });
    return { hasSession: session?.harness === node.harness, next };
  });

  ipcMain.handle(IPC_CHANNELS.modelStart, async (event, input: Parameters<JuntoApi["modelStart"]>[0]) => {
    assertTrusted(event);
    const node = await readSeat(input?.canvas, input?.id);
    if (node.kind === "agent") {
      const { startSeat } = await import("./seat-control");
      return AppRuntime.runPromise(startSeat({ canvas: asCanvasName(input.canvas), seatId: node.id,
        ...(input.resume === undefined ? {} : { resume: input.resume }) },
      { plane, ensureHostAvailable }));
    }
    const createAdmission = nodeDelete.admitCreate(node.bindingId, node.host);
    await ensureHostAvailable(node.host);
    const assertCurrent = async () => {
      nodeDelete.assertCreate(createAdmission);
      const current = await readSeat(input.canvas, input.id);
      nodeDelete.assertCreate(createAdmission);
      if (current.kind !== node.kind || current.bindingId !== node.bindingId || current.host !== node.host)
        return deny("terminal ipc: seat changed while starting");
    };
    await assertCurrent();
    return router.create({ bindingId: node.bindingId, hostId: node.host,
      ...(node.launch ? { launch: node.launch } : {}), canvasName: input.canvas, nodeId: node.id,
      seatRect: { x: node.x, y: node.y, width: node.width, height: node.height },
      ...(node.label ? { label: node.label } : {}),
    });
  });

  ipcMain.handle(IPC_CHANNELS.modelStop, async (event, input: Parameters<JuntoApi["modelStop"]>[0]) => {
    assertTrusted(event);
    const node = await readSeat(input?.canvas, input?.id);
    if (node.kind !== "agent") return void await stopBinding(node.bindingId, node.host);
    const { stopSeat } = await import("./seat-control");
    await AppRuntime.runPromise(stopSeat({ canvas: asCanvasName(input.canvas), seatId: node.id }, { plane }));
  });

  ipcMain.handle(
    IPC_CHANNELS.managedTerminalModels,
    async (event, harness: string) => {
      assertTrusted(event);
      const { HarnessInventory } = await import("./templates/harness-inventory");
      return AppRuntime.runPromise(Effect.flatMap(HarnessInventory, (inventory) => inventory.models(harness)));
    },
  );

  ipcMain.handle(IPC_CHANNELS.managedTerminalProfiles, async (event) => {
    assertTrusted(event);
    const { enumerateManagedProfiles } = await import("./templates/enumerate-dispatch");
    return enumerateManagedProfiles();
  });

  ipcMain.handle(IPC_CHANNELS.machineInventory, async (event, machine: unknown): Promise<MachineInventoryResult> => {
    assertTrusted(event);
    if (typeof machine !== "string" || !machine.trim()) return deny("machine inventory: a machine name is required");
    const { HarnessInventory } = await import("./templates/harness-inventory");
    const { peerInventory } = await import("../inventory/client");
    return AppRuntime.runPromise(Effect.gen(function* () {
      const inventory = yield* HarnessInventory;
      const own = yield* (yield* MachineRepository).machineName.pipe(Effect.orElseSucceed(() => undefined));
      if (own === undefined || own === machine) return { ok: true, inventory: yield* inventory.machine } satisfies MachineInventoryResult;
      // A linked machine answers over the link's inventory channel.
      return yield* peerInventory().inventoryOf(machine);
    }).pipe(
      Effect.catchTag("InventoryUnavailableError", (error) => Effect.succeed<MachineInventoryResult>({
        ok: false,
        error: { _tag: error._tag, machine: error.machine || machine, reason: error.reason, message: error.message },
      })),
    ));
  });

  // Another machine's config is read and written by that machine over the
  // link's inventory channel, which lands after the link rewrite.
  const notThisMachine = (machine: string): NativeSettingFailure => ({
    _tag: "InventoryUnavailableError",
    machine,
    reason: "unreachable",
    message: "Another machine's harness config comes over the link's inventory channel, which is not built yet",
  });
  const asFailure = (
    error: InventoryUnavailableError | NativeSettingRefusedError | NativeConfigWriteError,
  ): NativeSettingFailure => {
    switch (error._tag) {
      case "InventoryUnavailableError":
        return { _tag: error._tag, machine: error.machine, reason: error.reason, message: error.message };
      case "NativeSettingRefusedError":
        return { _tag: error._tag, harness: error.harness, key: error.key, reason: error.reason, message: error.message };
      case "NativeConfigWriteError":
        return {
          _tag: error._tag, machine: error.machine, harness: error.harness, key: error.key,
          reason: error.reason, message: error.message,
        };
    }
  };

  ipcMain.handle(IPC_CHANNELS.nativeSettingsRead, async (event, input: unknown): Promise<NativeSettingsReadResult> => {
    assertTrusted(event);
    const request = input as { machine?: unknown; harness?: unknown; keys?: unknown } | undefined;
    if (typeof request?.machine !== "string" || typeof request.harness !== "string" || !isHarnessId(request.harness)
      || !Array.isArray(request.keys) || !request.keys.every((key) => typeof key === "string"))
      return deny("native settings: machine, harness and keys are required");
    const { machine, harness, keys } = { machine: request.machine, harness: request.harness, keys: request.keys as string[] };
    const [{ HarnessInventory }, { NativeConfig }] = await Promise.all([
      import("./templates/harness-inventory"),
      import("../native-config/service"),
    ]);
    return AppRuntime.runPromise(Effect.gen(function* () {
      const own = (yield* (yield* HarnessInventory).machine).machine;
      if (own !== machine) return { ok: false, error: notThisMachine(machine) } satisfies NativeSettingsReadResult;
      const values = yield* (yield* NativeConfig).read(harness, keys);
      return { ok: true, values } satisfies NativeSettingsReadResult;
    }).pipe(Effect.catch((error) => Effect.succeed<NativeSettingsReadResult>({ ok: false, error: asFailure(error) }))));
  });

  ipcMain.handle(IPC_CHANNELS.nativeSettingWrite, async (event, input: unknown): Promise<NativeSettingWriteResult> => {
    assertTrusted(event);
    const { NativeSettingWrite } = await import("@shared/harness-domain/native-config");
    const decoded = Schema.decodeUnknownResult(NativeSettingWrite)(input);
    if (Result.isFailure(decoded)) return deny("native settings: the write does not match its schema");
    const write = decoded.success;
    const [{ HarnessInventory }, { NativeConfig }] = await Promise.all([
      import("./templates/harness-inventory"),
      import("../native-config/service"),
    ]);
    return AppRuntime.runPromise(Effect.gen(function* () {
      const own = (yield* (yield* HarnessInventory).machine).machine;
      if (own !== write.machine) return { ok: false, error: notThisMachine(write.machine) } satisfies NativeSettingWriteResult;
      const value = yield* (yield* NativeConfig).write(write);
      return { ok: true, value } satisfies NativeSettingWriteResult;
    }).pipe(Effect.catch((error) => Effect.succeed<NativeSettingWriteResult>({ ok: false, error: asFailure(error) }))));
  });

  ipcMain.handle(IPC_CHANNELS.managedTerminalHarnesses, async (event) => {
    assertTrusted(event);
    const { probeManagedHarnessInstalls } = await import("./templates/harness-install");
    return { harnesses: await probeManagedHarnessInstalls() };
  });

  ipcMain.handle(
    IPC_CHANNELS.managedTerminalFlags,
    async (event, harness: string, cwd?: string) => {
      assertTrusted(event);
      if (typeof harness !== "string" || !isHarnessId(harness)) {
        return { installed: false, flags: [] };
      }
      const { harnessLaunchFlags } = await import("./templates/harness-install");
      return harnessLaunchFlags(harness, typeof cwd === "string" ? cwd : undefined);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.terminalGet,
    async (event, bindingId: string, hostId?: string) => {
      assertTrusted(event);
      await ensureHostAvailable(hostId);
      if (hostId !== undefined && !router.isLocalHostId(hostId)) return (await remoteSeats(hostId)).get(bindingId);
      return router.get(bindingId, hostId);
    },
  );

  // A seat on another machine is reached only over the seats channel: its
  // machine answers, and a failure there arrives typed instead of as false.
  const remoteSeats = async (hostId: string) =>
    (await import("./seats-client")).makeSeatsProcessClient(hostId);
  // Both trusted IPC stop commands use the same owned-session router capability.
  const stopBinding = async (bindingId: string, hostId?: string) =>
    hostId !== undefined && !router.isLocalHostId(hostId)
      ? (await remoteSeats(hostId)).stop(bindingId, randomUUID())
      : router.kill(bindingId, hostId);

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
      return nodeDelete.beginNodeDelete(resources);
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
      return nodeDelete.finishNodeDelete(leaseId, outcome);
    },
  );

  ipcMain.handle(IPC_CHANNELS.terminalAttach, async (event, input: AttachInput) => {
    const sender = assertTrusted(event);
    const hostId = input.hostId?.trim() || router.thisMachineName();
    await ensureHostAvailable(hostId);
    if (input.mode === "control" && input.takeover) {
      const priorLeaseId = controlByBinding.get(input.bindingId);
      if (priorLeaseId) release(priorLeaseId);
    }
    const result = await router.attach({ ...input, hostId });
    if (!result.ok) return result;
    if (sender.isDestroyed()) {
      void router.release(result.lease, hostId);
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
    });
    if (result.lease.mode === "control") {
      controlByBinding.set(result.lease.bindingId, leaseId);
    }
    return result;
  });

  ipcMain.handle(IPC_CHANNELS.terminalRelease, async (event, leaseId: string) => {
    assertTrusted(event);
    if (!owned(event.sender, leaseId)) return false;
    release(leaseId);
    return true;
  });

  ipcMain.handle(
    IPC_CHANNELS.terminalWrite,
    async (event, leaseId: string, data: string, encoding = "utf8") => {
      assertTrusted(event);
      const owner = owned(event.sender, leaseId);
      if (!owner) return false;
      const decoded =
        encoding === "base64" ? Buffer.from(data, "base64").toString("utf8") : data;
      const written = router.write(owner.lease, decoded, owner.hostId);
      // Input-origin tagging: user keystrokes must suppress injection.
      void written.then((ok) => {
        if (!ok) return;
        injectionSupervisor.noteUserInput(owner.lease.bindingId, undefined, decoded);
      });
      return written;
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.terminalResize,
    async (event, leaseId: string, cols: number, rows: number) => {
      assertTrusted(event);
      const owner = owned(event.sender, leaseId);
      if (!owner) return false;
      return router.resize(owner.lease, cols, rows, owner.hostId);
    },
  );
};
