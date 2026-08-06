import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import { IPC_CHANNELS, type TerminalAttachInput } from "@shared/ipc";
import { isHarnessId } from "@shared/managed-terminal-templates";
import { managedHarnessEnabled } from "@shared/features";
import type { TerminalLaunch } from "@shared/terminal";
import { messageDelivery } from "../work/message-delivery";
import type { ControlLease, LocalHostEvent } from "./local-host";
import type { TermPlane } from "./plane";
import { injectionSupervisor } from "./injection-supervisor";

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
    owners.delete(leaseId);
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

  router.on("event", (payload: LocalHostEvent) => {
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

  ipcMain.handle(IPC_CHANNELS.terminalCreate, async (event, input) => {
    assertTrusted(event);
    await ensureHostAvailable(input?.hostId);
    const harness =
      typeof input?.harness === "string" ? input.harness.trim() : "";
    // No harness on the wire ⇒ the node is geography; it opens a shell.
    if (!harness) return router.create(input);

    // Everything below is the actor seat. Its harness and key are required here
    // rather than reconstructed at spawn, so an unnamed template errors on the
    // node instead of quietly becoming a terminal.
    if (!isHarnessId(harness)) {
      return deny(`terminal ipc: unknown harness template ${harness}`);
    }
    if (!managedHarnessEnabled(harness)) {
      return deny(`terminal ipc: harness ${harness} is disabled in this build`);
    }
    const agentKey =
      typeof input?.agentKey === "string" ? input.agentKey.trim() : "";
    if (!agentKey) return deny("terminal ipc: agent seat requires an agent key");

    // Edge-aware injection replan at spawn (document may be unconnected silence).
    const canvasName =
      typeof input?.canvasName === "string" ? input.canvasName.trim() : "";
    const nodeId = typeof input?.nodeId === "string" ? input.nodeId.trim() : "";
    let launch: TerminalLaunch | undefined = input?.launch;
    let firstTypedMessage: string | undefined;
    if (canvasName && nodeId) {
      try {
        const { CanvasesService } = await import("../canvases");
        const { AppRuntime } = await import("../../runtime");
        const { Effect } = await import("effect");
        const { launchForManagedSpawn } = await import("./managed-spawn-plan");
        const read = await AppRuntime.runPromise(
          Effect.gen(function* () {
            const canvases = yield* CanvasesService;
            return yield* canvases.read(canvasName).pipe(Effect.result);
          }),
        );
        if (read._tag === "Success") {
          const planned = launchForManagedSpawn({
            doc: read.success.doc,
            nodeId,
            harness,
            documentLaunch: input.launch,
            agentKey,
            cwd: input.launch?.cwd,
            resume: input.resume === true,
          });
          if (planned.launch) launch = planned.launch;
          firstTypedMessage = planned.plan?.firstTypedMessage;
        }
      } catch (err) {
        console.error("[term] managed spawn replan failed; using document launch:", err);
      }
    }
    // Named field by field so the seat is built from the wire, never spread
    // from it — an untyped echo is how a loose harness field got its authority.
    return router.createAgentSeat({
      harness,
      agentKey,
      bindingId: typeof input?.bindingId === "string" ? input.bindingId : "",
      ...(typeof input?.hostId === "string" ? { hostId: input.hostId } : {}),
      ...(typeof input?.cols === "number" ? { cols: input.cols } : {}),
      ...(typeof input?.rows === "number" ? { rows: input.rows } : {}),
      ...(canvasName ? { canvasName } : {}),
      ...(nodeId ? { nodeId } : {}),
      ...(typeof input?.label === "string" ? { label: input.label } : {}),
      ...(typeof input?.title === "string" ? { title: input.title } : {}),
      ...(launch ? { launch } : {}),
      ...(firstTypedMessage ? { firstTypedMessage } : {}),
    });
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
        if (ok) injectionSupervisor.noteUserInput(owner.lease.bindingId);
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
