import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import { actorDeliverySurfaceOf } from "@shared/actor-surface";
import type { CanvasDoc } from "@shared/canvas";
import {
  IPC_CHANNELS,
  type TerminalAttachInput,
  type TerminalCreateInput,
  type TerminalFinishNodeDeleteOutcome,
  type TerminalNodeDeleteResource,
} from "@shared/ipc";
import {
  isHarnessId,
  templateFor,
} from "@shared/managed-terminal-templates";
import { managedHarnessEnabled } from "@shared/features";
import { resolveTerminalBinding } from "@shared/terminal";
import { messageDelivery } from "../work/message-delivery";
import type { ControlLease, LocalHostEvent } from "./local-host";
import { TerminalStreamCoalescer, terminalBindingKey } from "./stream-coalescer";
import type { TermPlane } from "./plane";
import { composerDraft } from "./composer-draft";
import { injectionSupervisor } from "./injection-supervisor";
import { TerminalNodeDeleteService } from "./node-delete";
import { rememberRemoteSeatState } from "./remote-seat-state";
import {
  ActorSeatOccupy,
  ActorSeatProjectionPending,
} from "./actor-seat-occupy";
import { AppRuntime } from "../../runtime";
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
  const nodeDelete = new TerminalNodeDeleteService(router);

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

        // The supplied node is immediate authorial intent. Canvas persistence
        // is debounced, so this read can enrich launch injection with live
        // edges but is never a prerequisite for occupying a LOCAL actor seat.
        // Remote placement is different: the renderer flushes its debounced
        // save before invoking, and ActorSeatOccupy holds the seat behind the
        // destination's projection acknowledgement of that committed state.
        let docForPlan: CanvasDoc | undefined;
        if (canvasName) {
          try {
            const { CanvasesService } = await import("../canvases");
            const read = await AppRuntime.runPromise(
              Effect.gen(function* () {
                const canvases = yield* CanvasesService;
                return yield* canvases.read(canvasName, "term.seatPlan").pipe(Effect.result);
              }),
            );
            if (read._tag === "Success") {
              const persisted = read.success.doc;
              const found = persisted.nodes.some((candidate) => candidate.id === node.id);
              docForPlan = {
                ...persisted,
                nodes: found
                  ? persisted.nodes.map((candidate) =>
                      candidate.id === node.id ? node : candidate,
                    )
                  : [...persisted.nodes, node],
              };
            }
          } catch (err) {
            console.error(
              "[term] managed spawn context enrichment failed; using immediate node:",
              err,
            );
          }
        }
        // A provisioned-session harness (Amp) has its thread minted by its own
        // CLI and stored on the node before any PTY opens. Idempotent: a node
        // that already carries a thread never mints a second one.
        const { ensureProvisionedSessionId } = await import("./amp-seat-thread");
        const provisioned = await ensureProvisionedSessionId({
          canvasName,
          nodeId: node.id,
          harness: surface.harness,
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
        const { makeManagedSpawnIntent } = await import("./managed-spawn-plan");
        // Pure compilation only. Session proof, isolation, final argv, and
        // first-typed disposition belong to the selected process host.
        const spawnIntent = makeManagedSpawnIntent({
          ...(docForPlan ? { doc: docForPlan } : {}),
          nodeId: node.id,
          harness: surface.harness,
          documentLaunch: surface.launch,
          agentKey: surface.agentKey,
          cwd: surface.launch?.cwd,
          sessionId: sessionIdForSpawn,
          resume: input.resume === true,
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
          ...(binding.label ? { label: binding.label } : {}),
        });
      }

      return deny(
        `terminal ipc: unsupported canvas node kind ${entityKind ?? "missing"}`,
      );
    },
  );

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
    messageDelivery.onTerminalAttached(result.lease.bindingId);
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
        injectionSupervisor.noteUserInput(owner.lease.bindingId);
        // Draft ledger: no factory write may land on a half-typed prompt.
        composerDraft.note(owner.lease.bindingId, decoded);
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
