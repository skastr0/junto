import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import { actorDeliverySurfaceOf } from "@shared/actor-surface";
import { resolveTerminalBinding } from "@shared/terminal";
import type { TerminalCreateInput } from "@shared/ipc";
import { ModelService } from "../model/service";
import type { JuntoApi } from "@shared/ipc";
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
import { managedHarnessEnabled } from "@shared/features";
import type { ControlLease, LocalHostEvent } from "./local-host";
import { TerminalStreamCoalescer, terminalBindingKey } from "./stream-coalescer";
import type { TermPlane } from "./plane";
import { injectionSupervisor } from "./injection-supervisor";
import { rememberRemoteSeatState } from "./remote-seat-state";
import {
  ActorSeatOccupy,
  ActorSeatProjectionPending,
} from "./actor-seat-occupy";
import { AppRuntime } from "../../runtime";
import { liveSeatEnvironment } from "../region-env/live";
import { Effect } from "effect";

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
      target === "local" ||
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

  ipcMain.handle(
    IPC_CHANNELS.terminalCreate,
    async (event, input: TerminalCreateInput) => {
      assertTrusted(event);
      const node = input?.node;
      if (!node || typeof node !== "object") {
        return deny("terminal ipc: canvas node required");
      }

      const entityKind = node.ether?.entity?.kind;
      const canvasName =
        typeof input.canvasName === "string" ? input.canvasName.trim() : "";

      if (entityKind === "agent") {
        const surface = actorDeliverySurfaceOf(node);
        if (!surface) {
          return deny(
            "terminal ipc: agent seat requires an agent name, terminal binding, and harness",
          );
        }
        if (!canvasName || !node.id.trim()) {
          return deny(
            "terminal ipc: agent seat requires a canvas name and node id",
          );
        }
        if (!isHarnessId(surface.harness)) {
          return deny(`terminal ipc: unknown harness template ${surface.harness}`);
        }
        if (!managedHarnessEnabled(surface.harness)) {
          return deny(
            `terminal ipc: harness ${surface.harness} is disabled in this build`,
          );
        }
        if (
          !templateFor(surface.harness).capabilityBadges.remote &&
          !router.isLocalHostId(surface.hostId)
        ) {
          return deny(
            `terminal ipc: harness ${surface.harness} is local-only and cannot use a Remote host`,
          );
        }
        // Capture before the first await. Node deletion increments this exact
        // host/binding revision synchronously and the final assertion prevents
        // an older create from materializing after teardown.
        const createAdmission = nodeDelete.admitCreate(
          surface.bindingId,
          surface.hostId,
        );
        await ensureHostAvailable(surface.hostId);

        // A provisioned-session harness (Amp) has its thread minted by its own
        // CLI and stored on the node before any PTY opens. Idempotent: a node
        // that already carries a thread never mints a second one.
        const { ensureProvisionedSessionId } = await import("./amp-seat-thread");
        const provisioned = await ensureProvisionedSessionId({
          canvasName,
          nodeId: node.id,
          harness: surface.harness,
          documentLaunch: surface.launch,
          ...(node.ether?.terminal?.sessionId
            ? { storedSessionId: node.ether.terminal.sessionId }
            : {}),
          ...(surface.launch?.cwd ? { cwd: surface.launch.cwd } : {}),
        });
        if (!provisioned.ok) {
          // Auth, network, and unreadable-receipt failures all land here. The
          // seat never opens on a thread it does not own, and never silently
          // falls back to Amp's own thread picker.
          return deny(`terminal ipc: ${surface.harness} session unavailable — ${provisioned.reason}`);
        }
        const sessionIdForSpawn =
          provisioned.sessionId || node.ether?.terminal?.sessionId;
        // A thread minted for this spawn is empty: the seat is fresh, however
        // the launch argv is shaped.
        const resumeRequested =
          provisioned.ok && provisioned.minted ? false : input.resume === true;
        const { makeManagedSpawnIntent } = await import("./managed-spawn-plan");
        // Pure compilation only. Session proof, isolation, and final argv
        // belong to the selected process host.
        const spawnIntent = makeManagedSpawnIntent({
          nodeId: node.id,
          harness: surface.harness,
          documentLaunch: surface.launch,
          agentKey: surface.agentKey,
          cwd: surface.launch?.cwd,
          sessionId: sessionIdForSpawn,
          resume: resumeRequested,
        });

        nodeDelete.assertCreate(createAdmission);
        return AppRuntime.runPromise(
          Effect.gen(function* () {
            const seats = yield* ActorSeatOccupy;
            return yield* seats.occupy({
              bindingId: surface.bindingId,
              harness: surface.harness,
              agentKey: surface.agentKey,
              hostId: surface.hostId,
              spawnIntent,
              ...(typeof input.cols === "number" ? { cols: input.cols } : {}),
              ...(typeof input.rows === "number" ? { rows: input.rows } : {}),
              canvasName,
              nodeId: node.id,
              // The node in hand is newer than the saved canvas: read the
              // seat's regions from where it sits now.
              seatRect: {
                x: node.x,
                y: node.y,
                width: node.width,
                height: node.height,
              },
              ...(node.ether?.terminal?.label
                ? { label: node.ether.terminal.label }
                : {}),
            }).pipe(
              // A pending projection acknowledgement is a truthful non-start,
              // not a crash. Hand the renderer the product message alone.
              Effect.catchIf(
                (error): error is ActorSeatProjectionPending =>
                  error instanceof ActorSeatProjectionPending,
                (pending) => Effect.fail(new Error(pending.message)),
              ),
            );
          }),
        );
      }

      if (entityKind === "terminal") {
        const binding = resolveTerminalBinding(node);
        if (binding?.kind !== "native") {
          return deny("terminal ipc: raw terminal requires a terminal binding");
        }
        const createAdmission = nodeDelete.admitCreate(
          binding.bindingId,
          binding.hostId,
        );
        await ensureHostAvailable(binding.hostId);
        nodeDelete.assertCreate(createAdmission);
        return router.create({
          bindingId: binding.bindingId,
          hostId: binding.hostId,
          ...(binding.launch ? { launch: binding.launch } : {}),
          ...(typeof input.cols === "number" ? { cols: input.cols } : {}),
          ...(typeof input.rows === "number" ? { rows: input.rows } : {}),
          ...(canvasName ? { canvasName } : {}),
          nodeId: node.id,
          // The node in hand is newer than the saved canvas: read the
          // terminal's regions from where it sits now.
          seatRect: {
            x: node.x,
            y: node.y,
            width: node.width,
            height: node.height,
          },
          ...(binding.label ? { label: binding.label } : {}),
        });
      }

      return deny(
        `terminal ipc: unsupported canvas node kind ${entityKind ?? "missing"}`,
      );
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

  ipcMain.handle(IPC_CHANNELS.modelStart, async (event, input: Parameters<JuntoApi["modelStart"]>[0]) => {
    assertTrusted(event);
    const node = await readSeat(input?.canvas, input?.id);
    const createAdmission = nodeDelete.admitCreate(node.bindingId, node.host);
    if (node.kind === "agent") {
      if (!managedHarnessEnabled(node.harness)) return deny(`terminal ipc: harness ${node.harness} is disabled in this build`);
      if (!templateFor(node.harness).capabilityBadges.remote && !router.isLocalHostId(node.host))
        return deny(`terminal ipc: harness ${node.harness} is local-only and cannot use a Remote host`);
    }
    await ensureHostAvailable(node.host);
    const assertCurrent = async () => {
      nodeDelete.assertCreate(createAdmission);
      const current = await readSeat(input.canvas, input.id);
      nodeDelete.assertCreate(createAdmission);
      if (current.kind !== node.kind || current.bindingId !== node.bindingId || current.host !== node.host ||
        (current.kind === "agent" && node.kind === "agent" && (current.harness !== node.harness || current.agentKey !== node.agentKey)))
        return deny("terminal ipc: seat changed while starting");
    };
    if (node.kind === "terminal") {
      await assertCurrent();
      return router.create({ bindingId: node.bindingId, hostId: node.host,
        ...(node.launch ? { launch: node.launch } : {}), canvasName: input.canvas, nodeId: node.id,
        seatRect: { x: node.x, y: node.y, width: node.width, height: node.height },
        ...(node.label ? { label: node.label } : {}),
      });
    }
    const { ensureProvisionedSessionId } = await import("./amp-seat-thread");
    const provisioned = await ensureProvisionedSessionId({ canvasName: input.canvas, nodeId: node.id,
      harness: node.harness, documentLaunch: node.launch,
      ...(node.sessionId ? { storedSessionId: node.sessionId } : {}),
      ...(node.launch?.cwd ? { cwd: node.launch.cwd } : {}),
    });
    if (!provisioned.ok) return deny(`terminal ipc: ${node.harness} session unavailable — ${provisioned.reason}`);
    const { makeManagedSpawnIntent } = await import("./managed-spawn-plan");
    const spawnIntent = makeManagedSpawnIntent({ nodeId: node.id, harness: node.harness,
      documentLaunch: node.launch, agentKey: node.agentKey, cwd: node.launch?.cwd,
      sessionId: provisioned.sessionId || node.sessionId,
      resume: provisioned.minted ? false : input.resume !== false,
    });
    await assertCurrent();
    return AppRuntime.runPromise(Effect.gen(function* () {
      const seats = yield* ActorSeatOccupy;
      return yield* seats.occupy({ bindingId: node.bindingId, harness: node.harness,
        agentKey: node.agentKey, hostId: node.host, spawnIntent, canvasName: input.canvas, nodeId: node.id,
        seatRect: { x: node.x, y: node.y, width: node.width, height: node.height }, label: node.label,
      }).pipe(Effect.catchIf(
        (error): error is ActorSeatProjectionPending => error instanceof ActorSeatProjectionPending,
        (pending) => Effect.fail(new Error(pending.message)),
      ));
    }));
  });

  ipcMain.handle(IPC_CHANNELS.modelStop, async (event, input: Parameters<JuntoApi["modelStop"]>[0]) => {
    assertTrusted(event);
    const node = await readSeat(input?.canvas, input?.id);
    await router.kill(node.bindingId, node.host);
  });

  ipcMain.handle(
    IPC_CHANNELS.managedTerminalModels,
    async (event, harness: string) => {
      assertTrusted(event);
      const { enumerateManagedModels } = await import("./templates/enumerate-dispatch");
      return enumerateManagedModels(harness);
    },
  );

  ipcMain.handle(IPC_CHANNELS.managedTerminalProfiles, async (event) => {
    assertTrusted(event);
    const { enumerateManagedProfiles } = await import("./templates/enumerate-dispatch");
    return enumerateManagedProfiles();
  });

  ipcMain.handle(IPC_CHANNELS.managedTerminalHarnesses, async (event) => {
    assertTrusted(event);
    const { probeManagedHarnessInstalls } = await import("./templates/harness-install");
    return { harnesses: probeManagedHarnessInstalls() };
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
      return router.get(bindingId, hostId);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.terminalKill,
    async (event, bindingId: string, hostId?: string) => {
      assertTrusted(event);
      return router.kill(bindingId, hostId);
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

  ipcMain.handle(
    IPC_CHANNELS.terminalBindCanvas,
    async (event, bindingId: string, ref, hostId?: string) => {
      assertTrusted(event);
      await router.bindCanvas(bindingId, ref, hostId);
    },
  );

  ipcMain.handle(IPC_CHANNELS.terminalAttach, async (event, input: AttachInput) => {
    const sender = assertTrusted(event);
    const hostId = input.hostId?.trim() || "local";
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
