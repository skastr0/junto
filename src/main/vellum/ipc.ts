import { BrowserWindow, ipcMain } from "electron";
import { Effect } from "effect";
import {
  IPC_CHANNELS,
  type BindingHint,
  type FactoryPauseSetResult,
  type WorkOpResult,
} from "@shared/ipc";
import type { CanvasDoc } from "@shared/canvas";
import { seatPaused, type PauseScope } from "@shared/pause";
import { digestCanvas } from "@shared/digest";
import { buildGlyphView } from "@shared/glyph-view";
import { mergePortfolioInto } from "@shared/portfolio";
import { AppRuntime } from "../runtime";
import { registerBrowserIpc } from "./browser/ipc";
import type { BrowserSessionService } from "./browser/sessions";
import { CanvasesService } from "./canvases";

import { registerChatIpc } from "./chat/ipc";
import { ChatServiceContext } from "./chat/service";
import { HermesPlane } from "./hermes/plane";
import { registerHerdrIpc } from "./herdr/ipc";
import type { PulseRegionOptions } from "./kernel/service";
import { KernelService } from "./kernel/service";
import { RegionRollupService } from "./region-rollup";
import { registerHostsIpc } from "./hosts/ipc";
import { PausePlane } from "./pause-plane";
import { registerSettingsIpc } from "./settings/ipc";
import { SettingsService } from "./settings/service";
import { SnapshotsService } from "./snapshots";
import { UsageService } from "./usage/usage-service";
import { WorkService } from "./work/service";
import { messageDelivery } from "./work/message-delivery";
import { stampMessageDelivered } from "@shared/message-delivery";
import { kernelRecordFromSnapshot } from "@shared/station-status";
import { HerdrPlane } from "./herdr/plane";
import { registerTerminalIpc } from "./term/ipc";
import { GROK_MIN_POST_SPAWN_MS, ManagedTerminalDrive } from "./term/drive";
import { assertMacClipboardSafeForPaste } from "./term/drive/clipboard-safe";
import { isManagedTerminalReady } from "./term/drive/readiness";
import { seatStateRuntime } from "./term/agent-state";
import {
  peekFirstTypedMessage,
  takeFirstTypedMessage,
} from "./term/first-typed";
import { setManagedPulseDeliver } from "./term/managed-pulse-bridge";
import { terminalObserverPlane } from "./term/observer";
import { termPlane } from "./term/plane";
import type { ControlLease } from "./term/local-host";
import { isTrustedMainWebContents, trustedRendererIpc } from "./trusted-main-webcontents";
import type { WorkMetadata, Artifact, Message, TaskState } from "@shared/canvas";
import {
  MainAuthoringRefused,
  MainAuthoringTransitionError,
  mainAuthoringGate,
  type MainAuthoringFinalOperation,
  type MainAuthoringLabel,
} from "./main-authoring-gate";
import { StationStatusService } from "./station-status-store";
import { StationFleetPropagation } from "./station/fleet-propagation";

const broadcast = (channel: string, payload: unknown) => {
  for (const window of BrowserWindow.getAllWindows()) {
    // Guard: close/reopen races can leave a BrowserWindow whose webContents
    // is already destroyed (Object has been destroyed in main).
    if (
      window.isDestroyed() ||
      window.webContents.isDestroyed() ||
      !isTrustedMainWebContents(window.webContents)
    ) continue;
    window.webContents.send(channel, payload);
  }
};

const runMainAuthoring = <A>(
  label: MainAuthoringLabel,
  operation: () => Promise<A>,
): Promise<A> => mainAuthoringGate.run(label, operation);

interface RendererFinalWriteMetadata {
  readonly requestId: string;
  readonly operation: MainAuthoringFinalOperation;
}

const decodeRendererFinalWriteMetadata = (
  value: unknown,
): RendererFinalWriteMetadata | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  if (Object.keys(value).join(",") !== "__vellumFinalWrite") return undefined;
  if (!("__vellumFinalWrite" in value)) return undefined;
  const metadata = value.__vellumFinalWrite;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    return undefined;
  }
  if (Object.keys(metadata).sort().join(",") !== "operation,requestId") return undefined;
  if (!("requestId" in metadata) || typeof metadata.requestId !== "string") return undefined;
  if (!("operation" in metadata)) return undefined;
  if (metadata.operation !== "canvas.write" && metadata.operation !== "canvas.create") {
    return undefined;
  }
  return {
    requestId: metadata.requestId,
    operation: metadata.operation,
  };
};

const runRendererCanvasAuthoring = <A>(
  label: Extract<MainAuthoringLabel, "ipc.canvas.write" | "ipc.canvas.create">,
  senderId: number,
  rawMetadata: unknown,
  operation: MainAuthoringFinalOperation,
  task: () => Promise<A>,
): Promise<A> => {
  // Metadata is absent on every ordinary renderer call. Once admission has
  // closed, those calls must continue through run() so they are refused.
  if (rawMetadata === undefined) return runMainAuthoring(label, task);

  const metadata = decodeRendererFinalWriteMetadata(rawMetadata);
  if (metadata === undefined) {
    return Promise.reject(
      new MainAuthoringTransitionError(
        "invalid_final_permit",
        "renderer final-write metadata must be an exact preload-issued envelope",
      ),
    );
  }
  if (metadata.operation !== operation) {
    return Promise.reject(
      new MainAuthoringTransitionError(
        "unsupported_final_operation",
        `renderer final-write metadata for ${metadata.operation} cannot authorize ${operation}`,
      ),
    );
  }
  return mainAuthoringGate.runFinalWrite(
    { senderId, requestId: metadata.requestId },
    operation,
    label,
    task,
  );
};

const runRendererWorkAuthoring = <A>(
  label: MainAuthoringLabel,
  operation: () => Promise<WorkOpResult<A>>,
): Promise<WorkOpResult<A>> =>
  runMainAuthoring(label, operation).catch((error: unknown) => {
    if (error instanceof MainAuthoringRefused) {
      return {
        ok: false as const,
        code: "invalid" as const,
        message: error.message,
      };
    }
    return Promise.reject(error);
  });

/**
 * Doctrine: only Command Center authors the canvas. Remote and seal-stripped
 * (role unset) must fail closed — never mint authorial power by defaulting to CC.
 */
const denyUnlessCommandCenterAuthorial = Effect.gen(function* () {
  const settings = yield* SettingsService;
  const current = yield* settings.get;
  if (current.station.role !== "command-center") {
    return yield* Effect.fail(
      new Error(
        current.station.role === "remote"
          ? "Remote station cannot mutate authorial canvases. Author on the Command Center."
          : "Station role is unset or untrusted; authorial canvas mutation is refused until topology is sealed as Command Center.",
      ),
    );
  }
});

export const registerVellumIpc = (): void => {
  const privilegedIpc = trustedRendererIpc(ipcMain);
  registerHerdrIpc(privilegedIpc, () =>
    BrowserWindow.getAllWindows()
      .map((window) => window.webContents)
      .filter(isTrustedMainWebContents),
  );
  registerTerminalIpc(privilegedIpc, termPlane);
  registerSettingsIpc(privilegedIpc, broadcast);
  registerHostsIpc(privilegedIpc);
  privilegedIpc.handle(IPC_CHANNELS.listCanvases, () =>
    AppRuntime.runPromise(Effect.flatMap(CanvasesService, (canvases) => canvases.list)),
  );

  privilegedIpc.handle(IPC_CHANNELS.readCanvas, (_event, name: string) =>
    AppRuntime.runPromise(Effect.flatMap(CanvasesService, (canvases) => canvases.read(name))),
  );

  privilegedIpc.handle(IPC_CHANNELS.writeCanvas, (
    event,
    name: string,
    doc: CanvasDoc,
    expectedRevision?: string,
    finalWriteMetadata?: unknown,
  ) =>
    runRendererCanvasAuthoring(
      "ipc.canvas.write",
      event.sender.id,
      finalWriteMetadata,
      "canvas.write",
      () => AppRuntime.runPromise(
        Effect.gen(function* () {
          yield* denyUnlessCommandCenterAuthorial;
          const canvases = yield* CanvasesService;
          return yield* canvases.write(name, doc, expectedRevision);
        }),
      ),
    ),
  );

  privilegedIpc.handle(IPC_CHANNELS.createCanvas, (event, name: string, finalWriteMetadata?: unknown) =>
    runRendererCanvasAuthoring(
      "ipc.canvas.create",
      event.sender.id,
      finalWriteMetadata,
      "canvas.create",
      () => AppRuntime.runPromise(
        Effect.gen(function* () {
          yield* denyUnlessCommandCenterAuthorial;
          const canvases = yield* CanvasesService;
          return yield* canvases.create(name);
        }),
      ),
    ),
  );

  privilegedIpc.handle(IPC_CHANNELS.deleteCanvas, (_event, name: string) =>
    runMainAuthoring(
      "ipc.canvas.delete",
      () => AppRuntime.runPromise(
        Effect.gen(function* () {
          yield* denyUnlessCommandCenterAuthorial;
          const canvases = yield* CanvasesService;
          return yield* canvases.remove(name);
        }),
      ),
    ),
  );

  privilegedIpc.handle(IPC_CHANNELS.exportDigest, (_event, name: string) =>
    AppRuntime.runPromise(
      Effect.gen(function* () {
        const canvases = yield* CanvasesService;
        const snapshots = yield* SnapshotsService;
        const result = yield* canvases.read(name);
        const state = yield* snapshots.current;
        // Private glyph browse excised — empty view keeps criteria non-generating.
        const glyphs = buildGlyphView(result.doc, new Map());
        const digest = digestCanvas(name, result.doc, state, glyphs);
        const path = yield* canvases.writeSidecar(name, "digest.txt", digest);
        return { digest, path };
      }),
    ),
  );

  privilegedIpc.handle(
    IPC_CHANNELS.generatePortfolio,
    (_event, name: string, options?: { all?: boolean }) =>
      runMainAuthoring(
        "ipc.canvas.portfolio",
        () => AppRuntime.runPromise(
          Effect.gen(function* () {
            const canvases = yield* CanvasesService;
            const snapshots = yield* SnapshotsService;
            // Fresh full-corpus pull (no hints = base project lists from each source).
            const state = yield* snapshots.refresh([]);
            // mergePortfolioInto is idempotent. Run it through the retrying
            // document mutation boundary so a direct-file edit during refresh
            // is merged into, never overwritten by a stale pre-refresh read.
            yield* canvases.mutate(name, (doc) =>
              mergePortfolioInto(doc, state, { all: options?.all ?? false }),
            );
            return yield* canvases.read(name);
          }),
        ),
      ),
  );

  privilegedIpc.handle(IPC_CHANNELS.getSnapshots, () =>
    AppRuntime.runPromise(Effect.flatMap(SnapshotsService, (snapshots) => snapshots.current)),
  );

  privilegedIpc.handle(
    IPC_CHANNELS.refreshSnapshots,
    (_event, hints?: ReadonlyArray<BindingHint>) =>
      AppRuntime.runPromise(
        Effect.flatMap(SnapshotsService, (snapshots) => snapshots.refresh(hints)),
      ),
  );

  privilegedIpc.handle(IPC_CHANNELS.getUsage, () =>
    AppRuntime.runPromise(Effect.flatMap(UsageService, (usage) => usage.current)),
  );

  privilegedIpc.handle(IPC_CHANNELS.refreshUsage, () =>
    AppRuntime.runPromise(Effect.flatMap(UsageService, (usage) => usage.refresh())),
  );


  privilegedIpc.handle(IPC_CHANNELS.agentIdentity, (_event, key: string) =>
    AppRuntime.runPromise(HermesPlane).then((plane) => plane.fetchAgentIdentity(key)),
  );

  privilegedIpc.handle(IPC_CHANNELS.agentAvatar, (_event, key: string) =>
    AppRuntime.runPromise(HermesPlane).then((plane) => plane.fetchAgentAvatar(key)),
  );

  privilegedIpc.handle(IPC_CHANNELS.agentMessage, (_event, key: string, text: string) =>
    AppRuntime.runPromise(HermesPlane).then((plane) => plane.fetchAgentMessage(key, text)),
  );

  // The attached-chat plane (hermes ACP sessions per agent node). Shares its
  // ChatService instance with KernelService below — a pulse-driven turn and
  // a human reuse the same live ACP session per agent.
  void registerChatIpc(
    privilegedIpc,
    () => BrowserWindow.getAllWindows()
      .map((window) => window.webContents)
      .filter(isTrustedMainWebContents),
    AppRuntime.runPromise(ChatServiceContext),
  );

  // The kernel plane: watcher/timer evaluation over every hydrated canvas,
  // running continuously in main regardless of window state.
  privilegedIpc.handle(IPC_CHANNELS.getKernelState, () =>
    AppRuntime.runPromise(Effect.map(KernelService, (kernel) => kernel.getSnapshot())),
  );

  // Factory pause plane — canvas-level switch. start is idempotent hydration,
  // so an early renderer read/write never races boot into the born-paused
  // default composing a store write from an unhydrated map.
  privilegedIpc.handle(IPC_CHANNELS.factoryPauseState, (_event, canvas: string) =>
    AppRuntime.runPromise(
      Effect.gen(function* () {
        const pause = yield* PausePlane;
        yield* pause.start;
        return pause.stateFor(canvas);
      }),
    ),
  );

  privilegedIpc.handle(
    IPC_CHANNELS.factoryPauseSet,
    (
      _event,
      canvas: string,
      scope: PauseScope,
      paused: boolean,
    ): Promise<FactoryPauseSetResult> =>
      AppRuntime.runPromise(
        Effect.gen(function* () {
          const pause = yield* PausePlane;
          yield* pause.start;
          const written = yield* Effect.either(pause.setScopePaused(canvas, scope, paused));
          if (written._tag === "Left") {
            return { ok: false as const, error: written.left.message };
          }
          return { ok: true as const, state: pause.stateFor(canvas) };
        }),
      ),
  );

  privilegedIpc.handle(IPC_CHANNELS.armRegion, (_event, canvasName: string, regionId: string, armed: boolean) =>
    AppRuntime.runPromise(Effect.flatMap(KernelService, (kernel) => kernel.armRegion(canvasName, regionId, armed))),
  );

  privilegedIpc.handle(
    IPC_CHANNELS.pulseRegion,
    (_event, canvasName: string, regionId: string, opts?: PulseRegionOptions) =>
      AppRuntime.runPromise(Effect.flatMap(KernelService, (kernel) => kernel.pulseRegion(canvasName, regionId, opts))),
  );

  // Region rollups for the bottom bar: derived per call from the current
  // document + snapshots + the chat plane's session/permission state.
  privilegedIpc.handle(IPC_CHANNELS.regionRollups, (_event, name: string) =>
    AppRuntime.runPromise(Effect.flatMap(RegionRollupService, (service) => service.rollups(name))),
  );

  // work plane — seven ops, all serialized through CanvasesService write.
  // Remote stations get a typed WorkOpResult (never a rejected IPC promise).
  const denyRemoteWork = Effect.gen(function* () {
    const settings = yield* SettingsService;
    const current = yield* settings.get;
    if (current.station.role === "remote") {
      return {
        ok: false as const,
        code: "invalid" as const,
        message:
          "Remote station cannot mutate authorial canvases. Author on the Command Center.",
      };
    }
    return null;
  });

  privilegedIpc.handle(
    IPC_CHANNELS.workTaskCreate,
    (_event, canvas: string, nodeId: string, brief: string, metadata?: WorkMetadata, reason?: string) =>
      runRendererWorkAuthoring(
        "ipc.work.task-create",
        () => AppRuntime.runPromise(
          Effect.gen(function* () {
            const denied = yield* denyRemoteWork;
            if (denied) return denied;
            const work = yield* WorkService;
            return yield* work.workTaskCreate(canvas, nodeId, brief, metadata, reason);
          }),
        ),
      ),
  );
  privilegedIpc.handle(
    IPC_CHANNELS.workTaskDescribe,
    (_event, canvas: string, nodeId: string, taskId: string, brief: string) =>
      runRendererWorkAuthoring(
        "ipc.work.task-describe",
        () => AppRuntime.runPromise(
          Effect.gen(function* () {
            const denied = yield* denyRemoteWork;
            if (denied) return denied;
            const work = yield* WorkService;
            return yield* work.workTaskDescribe(canvas, nodeId, taskId, brief);
          }),
        ),
      ),
  );
  privilegedIpc.handle(
    IPC_CHANNELS.workTaskTransition,
    (
      _event,
      canvas: string,
      nodeId: string,
      taskId: string,
      state: TaskState,
      note?: string,
    ) =>
      runRendererWorkAuthoring(
        "ipc.work.task-transition",
        () => AppRuntime.runPromise(
          Effect.gen(function* () {
            const denied = yield* denyRemoteWork;
            if (denied) return denied;
            const work = yield* WorkService;
            return yield* work.workTaskTransition(canvas, nodeId, taskId, state, note);
          }),
        ),
      ),
  );
  privilegedIpc.handle(
    IPC_CHANNELS.workTaskClaim,
    (_event, canvas: string, nodeId: string, taskId: string, actor: string) =>
      runRendererWorkAuthoring(
        "ipc.work.task-claim",
        () => AppRuntime.runPromise(
          Effect.gen(function* () {
            const denied = yield* denyRemoteWork;
            if (denied) return denied;
            const work = yield* WorkService;
            return yield* work.workTaskClaim(canvas, nodeId, taskId, actor);
          }),
        ),
      ),
  );
  privilegedIpc.handle(
    IPC_CHANNELS.workMessageAppend,
    (_event, canvas: string, nodeId: string, taskId: string | null, message: Message) =>
      runRendererWorkAuthoring(
        "ipc.work.message-append",
        () => AppRuntime.runPromise(
          Effect.gen(function* () {
            const denied = yield* denyRemoteWork;
            if (denied) return denied;
            const work = yield* WorkService;
            return yield* work.workMessageAppend(canvas, nodeId, taskId, message);
          }),
        ),
      ),
  );
  privilegedIpc.handle(
    IPC_CHANNELS.workRequestCreate,
    (_event, canvas: string, nodeId: string, brief: string, metadata?: WorkMetadata, raisedBy?: string, reason?: string) =>
      runRendererWorkAuthoring(
        "ipc.work.request-create",
        () => AppRuntime.runPromise(
          Effect.gen(function* () {
            const denied = yield* denyRemoteWork;
            if (denied) return denied;
            const work = yield* WorkService;
            return yield* work.workRequestCreate(canvas, nodeId, brief, metadata, raisedBy, reason);
          }),
        ),
      ),
  );
  privilegedIpc.handle(
    IPC_CHANNELS.workRequestResolve,
    (
      _event,
      canvas: string,
      nodeId: string,
      taskId: string,
      responseText: string,
      disposition: "completed" | "rejected",
    ) =>
      runRendererWorkAuthoring(
        "ipc.work.request-resolve",
        () => AppRuntime.runPromise(
          Effect.gen(function* () {
            const denied = yield* denyRemoteWork;
            if (denied) return denied;
            const work = yield* WorkService;
            return yield* work.workRequestResolve(
              canvas,
              nodeId,
              taskId,
              responseText,
              disposition,
            );
          }),
        ),
      ),
  );
  privilegedIpc.handle(
    IPC_CHANNELS.workArtifactPublish,
    (_event, canvas: string, nodeId: string, artifact: Artifact) =>
      runRendererWorkAuthoring(
        "ipc.work.artifact-publish",
        () => AppRuntime.runPromise(
          Effect.gen(function* () {
            const denied = yield* denyRemoteWork;
            if (denied) return denied;
            const work = yield* WorkService;
            return yield* work.workArtifactPublish(canvas, nodeId, artifact);
          }),
        ),
      ),
  );

  // Wire pushes and background loops once at startup.
  void AppRuntime.runPromise(
    Effect.gen(function* () {
      const canvases = yield* CanvasesService;
      const snapshots = yield* SnapshotsService;
      const usage = yield* UsageService;
      const kernel = yield* KernelService;
      const herdr = yield* HerdrPlane;
      const pause = yield* PausePlane;
      const settingsForSeed = yield* SettingsService;
      const fleetPropagation = yield* StationFleetPropagation;
      const stationStatus = yield* StationStatusService;
      const stationForSeed = yield* settingsForSeed.get;
      // Fresh Command Center (or unset) may seed. Remote never authors a seed.
      if (stationForSeed.station.role !== "remote") {
        yield* Effect.tryPromise({
          try: () =>
            runMainAuthoring("startup.canvas.ensure-seed", () =>
              Effect.runPromise(canvases.ensureSeed),
            ),
          catch: () => undefined,
        }).pipe(Effect.catchAll(() => Effect.void));
      }
      canvases.subscribeChanges((name) => broadcast(IPC_CHANNELS.canvasChanged, name));
      canvases.subscribeChanges(() => {
        Effect.runFork(fleetPropagation.request());
      });
      snapshots.subscribe((state) => broadcast(IPC_CHANNELS.snapshotsChanged, state));
      usage.subscribe((state) => broadcast(IPC_CHANNELS.usageChanged, state));
      // Kernel flag mutate also notifies via subscribeCanvasMutated so an open
      // renderer's doc stays coherent with a kernel write (app-owned path).
      kernel.subscribeCanvasMutated((name) => broadcast(IPC_CHANNELS.canvasChanged, name));
      kernel.subscribe((snapshot) => {
        broadcast(IPC_CHANNELS.kernelChanged, snapshot);
        // Fleet Doctor reads this bounded heartbeat over SSH. Never persist
        // canvas names, node ids, agent identities, instructions, or tokens.
        Effect.runFork(
          stationStatus
            .recordKernel(kernelRecordFromSnapshot(snapshot))
            .pipe(Effect.ignore),
        );
      });

      // Managed-terminal drive: process-local control leases for factory typing.
      // Takeover is intentional — the factory owns control; UI attaches as observe.
      const driveLeases = new Map<string, ControlLease>();
      const ensureDriveLease = (bindingId: string): ControlLease | undefined => {
        const existing = driveLeases.get(bindingId);
        if (existing) {
          // Epoch/session may have rotated — host.write rejects stale leases.
          return existing;
        }
        const attached = termPlane.host.attach({
          bindingId,
          mode: "control",
          takeover: true,
        });
        if (!attached.ok) return undefined;
        driveLeases.set(bindingId, attached.lease);
        return attached.lease;
      };
      // Observer → seat state machine → idle gate for drive typing.
      // Fail closed: unknown/unbound seats are not idle (never type into dialogs).
      seatStateRuntime.start();
      const managedDrive = new ManagedTerminalDrive({
        write: (bindingId, data) => {
          let lease = ensureDriveLease(bindingId);
          if (!lease) return false;
          let ok = termPlane.host.write(lease, data);
          if (!ok) {
            // Lease may be stale after kill/recreate — re-attach once.
            driveLeases.delete(bindingId);
            lease = ensureDriveLease(bindingId);
            if (!lease) return false;
            ok = termPlane.host.write(lease, data);
          }
          return ok;
        },
        isSeatIdle: (bindingId) => seatStateRuntime.isSeatIdle(bindingId),
        // Grok (and all seats): never paste when macOS clipboard holds an image.
        assertClipboardSafe: assertMacClipboardSafeForPaste,
        onAttention: (bindingId, reason) => {
          broadcast(IPC_CHANNELS.agentSeatStateChanged, {
            bindingId,
            state: "attention",
            reason,
            at: Date.now(),
          });
        },
      });
      const driveReady = (bindingId: string): boolean => {
        const slot = seatStateRuntime.machine.getSlot(bindingId);
        return isManagedTerminalReady({
          harness: slot?.harness,
          seatState: seatStateRuntime.getState(bindingId),
          snapshot: terminalObserverPlane.snapshot(bindingId),
        });
      };
      const writeManagedPrompt = (bindingId: string, text: string) =>
        managedDrive.writePrompt(bindingId, text, {
          ready: driveReady(bindingId),
        });
      // Grok ≥1.5s post-spawn before first paste (verified trap).
      termPlane.host.on("event", (payload: {
        type?: string;
        bindingId?: string;
        status?: string;
      }) => {
        if (payload.type !== "session" || payload.status !== "running") return;
        const bindingId = payload.bindingId;
        if (!bindingId) return;
        const harness = seatStateRuntime.machine.getSlot(bindingId)?.harness;
        if (harness === "grok") {
          managedDrive.markSpawned(bindingId, GROK_MIN_POST_SPAWN_MS);
        }
      });
      seatStateRuntime.subscribe((event) => {
        broadcast(IPC_CHANNELS.agentSeatStateChanged, event);
        if (event.state === "idle") {
          // Tier B doctrine: first typed message once seat is ready+idle.
          // Peek first — only consume after a successful write so not-ready
          // / queue-timeout can retry on the next idle event.
          const first = peekFirstTypedMessage(event.bindingId);
          if (first && driveReady(event.bindingId)) {
            void writeManagedPrompt(event.bindingId, first).then((ok) => {
              if (ok) takeFirstTypedMessage(event.bindingId);
            });
          }
          managedDrive.onSeatIdle(event.bindingId);
          messageDelivery.onManagedTerminalIdle(event.bindingId);
        }
        if (event.state === "working") {
          managedDrive.onTurnStart(event.bindingId);
        }
      });
      // Kernel pulses for managed seats (not ACP).
      setManagedPulseDeliver((bindingId, text) => writeManagedPrompt(bindingId, text));

      // Message nudge channel: ether.messages -> live managed terminal seats.
      // Retry only on session-live / seat-idle (no polling store).
      messageDelivery.configure({
        transport: {
          // Kind-discriminated surfaces only — no ACP transport fields.
          // Raw geography shells: no auto-submit.
          sendTerminalPaste: (_bindingId, _text, _messageId) => false,
          // managedAgent + rawTerminal → paste+CR via idle-gated drive.
          sendManagedTerminalPrompt: (bindingId, text) =>
            writeManagedPrompt(bindingId, text),
        },
        store: {
          listCanvasNames: () =>
            AppRuntime.runPromise(
              canvases.list.pipe(Effect.map((entries) => entries.map((e) => e.name))),
            ),
          readDoc: (name) =>
            AppRuntime.runPromise(
              canvases.read(name).pipe(
                Effect.map((r) => r.doc),
                Effect.catchAll(() => Effect.succeed(undefined as CanvasDoc | undefined)),
              ),
            ),
          stampDelivered: (canvas, nodeId, messageId, deliveredAt) =>
            runMainAuthoring("delivery.message-stamp", async () => {
              for (let attempt = 0; attempt < 8; attempt += 1) {
                const read = await AppRuntime.runPromise(
                  canvases.read(canvas).pipe(Effect.either),
                );
                if (read._tag === "Left") return false;
                const next = stampMessageDelivered(read.right.doc, nodeId, messageId, deliveredAt);
                if (!next) return false; // already stamped or missing
                const written = await AppRuntime.runPromise(
                  canvases.write(canvas, next, read.right.revision).pipe(Effect.either),
                );
                if (written._tag === "Right") return true;
                const msg =
                  written.left instanceof Error ? written.left.message : String(written.left);
                if (!msg.includes("revision conflict; reload before saving")) {
                  return false;
                }
              }
              return false;
            }),
        },
        // Pause law (@shared/pause): canvas paused OR node paused OR any
        // containing region paused keeps the message pending, never sent.
        seatPaused: (canvas, doc, nodeId) =>
          seatPaused(pause.stateFor(canvas), doc, nodeId),
      });
      // A canvas flipping to playing (or a node/region unpausing inside a
      // playing canvas) re-drives every message held pending while paused.
      pause.subscribe((canvas) => {
        if (pause.stateFor(canvas).playing) messageDelivery.onResumed();
      });

      canvases.start();
      snapshots.start();
      // First usage fetch is fire-and-forget off the boot critical path;
      // codexbar can take ~15-20s so it never blocks window open.
      usage.start();
      kernel.start();

      if (stationForSeed.station.role === "command-center") {
        yield* fleetPropagation.start();
      }
      settingsForSeed.subscribe((settings) => {
        if (settings.station.role === "command-center") {
          Effect.runFork(fleetPropagation.start());
        }
      });
    }),
  );
};

/** Browser-only IPC is installed after cold profile recovery succeeds. */
export const registerVellumBrowserIpc = (sessions: BrowserSessionService): void => {
  registerBrowserIpc(
    trustedRendererIpc(ipcMain),
    sessions,
    () => BrowserWindow.getAllWindows()
      .map((window) => window.webContents)
      .filter(isTrustedMainWebContents),
  );
};
