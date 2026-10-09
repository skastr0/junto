import { lazy, Suspense, useEffect } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { seatIdentityHints } from "../shared/connections";
import { batch } from "@legendapp/state";
import { use$ } from "@legendapp/state/react";
import { modelStore } from "./lib/use-model";
import { impactModeActive$ } from "./lib/impact-mode";
import { clearSelection, selectNode, state$ } from "./lib/state";
import { asCanvasName } from "@shared/model";
import { CountedSurface } from "./lib/performance/surface-commits";
import type { ActorRef } from "@shared/work-protocol";
import { canvasCommandGroups } from "./lib/command-groups";
import {
  canvasMutationsQuiesced,
  clearAbandonedCanvas,
  followStore,
  prepareCanvasRemoval,
  showOpenedCanvas,
  replaceActiveActorRefs,
  retrySave,
} from "./lib/mutations";
import {
  flushCanvasEdits,
  quiesceAndFlushCanvasEdits,
  runCanvasAuthoringOperation,
} from "./lib/canvas-editor-flush";
import { startKernelBridge } from "./lib/kernel-view";
import { startSettingsBridge } from "./lib/settings-state";
import { startThemeMode } from "./lib/theme-mode";
import { startUpdateBridge } from "./lib/update-state";
import { subscribeAgentSeatState } from "./lib/agent-seat-state";
import { subscribeSeatAwareness } from "./lib/seat-awareness";
import { KEY_ACTIONS } from "./lib/key-actions";
import { installKeyDispatcher } from "./lib/key-dispatcher";
import { installRemovedNodeViews } from "./lib/removed-node-views";
import { reconcileDockFromLiveSessions } from "./lib/dock-state";
import { startSurfaceMotionGate } from "./lib/surface-motion";
import { clearPreambles, showPreamble } from "./lib/preamble-state";
import { startPreambleSources } from "./lib/preamble-sources";
import { startAgentSignalSync } from "./lib/agent-signals-state";
import { Canvas } from "./components/Canvas";
import { TopBar } from "./components/TopBar";
import { CanvasChrome } from "./components/CanvasChrome";
import { ConfirmHost } from "./components/ConfirmHost";
import { OperatorModalHost } from "./components/operator-modal/OperatorModalHost";
import { closeOperatorModal } from "./lib/operator-modal";
import { FocusSwitcherHud } from "./components/FocusSwitcherHud";
import { LiveConversationHost } from "./components/live/LiveConversation";
import { RendererErrorBoundary } from "./components/RendererErrorBoundary";

import { SettingsPanel } from "./components/SettingsPanel";
import { FirstRunIntro } from "./components/onboarding/FirstRunIntro";
import { DigestPanel } from "./components/DigestPanel";
import { DesktopNotificationsHost } from "./lib/desktop-notify";
import { StoreHost } from "./overlay/surfaces";
import { AgentEditorHost } from "./components/agent-editor/AgentEditor";
import { ObservabilityPanel } from "./components/ObservabilityPanel";
import {
  FLEET_UI_ENABLED,
  HERMES_INTEGRATION_ENABLED,
  LIVE_OVERSEER_ENABLED,
  USAGE_ENABLED,
} from "@shared/features";
// The Machines window is behind a flag. The define identifier must wrap
// import() in this module so ship builds can drop the chunk; imported
// FLEET_UI_ENABLED is not visible to Rollup DCE.
const MachinesWindow = __JUNTO_FLEET_UI_ENABLED__
  ? lazy(async () => {
      const mod = await import("./components/machines/MachinesWindow");
      return { default: mod.MachinesWindow };
    })
  : () => null;
// Pinning is off in every profile. Like the Machines window above, the define identifier
// wraps import() here so the dock and its styles are left out of the build.
const WorkSurfaceDock = __JUNTO_PINNING_ENABLED__
  ? lazy(async () => {
      const mod = await import("./components/WorkSurfaceDock");
      return { default: mod.WorkSurfaceDock };
    })
  : null;
import { WorkFocusShell } from "./components/workbench";
import { PersistentTerminalHost } from "./components/terminal/PersistentTerminalHost";
import { TerminalGridFocus } from "./components/terminal/TerminalGridFocus";
import { closeAllWorkbenchSurfaces, closeFocusModalSurface, dock$ } from "./lib/dock-state";
import { TooltipLayer } from "./components/TooltipLayer";
import { DemoCameraBridge } from "./demo/camera-bridge";
import { DemoLayer } from "./demo/demo-layer";
import { SEED_CANVAS_NAME } from "@shared/seed";
import { nextCanvasBootAction } from "./lib/canvas-boot";
import {
  makeNavigationClock,
  makeNodeRefNavigationCoordinator,
} from "./lib/node-ref-navigation";
import { isOperatorTyping } from "./lib/focus-ownership";

const setError = (error: unknown) =>
  state$.error.set(error instanceof Error ? error.message : String(error));

const refreshList = async () => {
  if (!window.junto) return;
  state$.canvases.set(await window.junto.modelCanvases());
};

/** Ask for fresh snapshots of the agents the open canvas seats. */
const refreshSnapshotsSoft = async () => {
  if (!HERMES_INTEGRATION_ENABLED || !window.junto?.refreshSnapshots) return;
  try {
    const snapshots = await Promise.race([
      window.junto.refreshSnapshots(seatIdentityHints([modelStore.canvasOf(state$.canvasName.peek())])),
      new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 1500)),
    ]);
    if (snapshots) state$.snapshots.set(snapshots);
  } catch (error) {
    setError(error);
  }
};

const resetCanvasView = (): void => {
  batch(() => {
    closeOperatorModal();
    state$.digestOpen.set(false);
    state$.digest.set(null);
    state$.nodePaletteOpen.set(false);
    state$.edgeFilter.set("");
    clearSelection();
    state$.connectionFocusNodeId.set("");
    state$.focusNodeId.set("");
    // Operator slots (fixed nodes, command groups) come back for the canvas
    // being opened; leases recompute from activity once its doc loads.
    state$.hotbarSlots.set(canvasCommandGroups.recall(state$.canvasName.peek()));
    state$.hotbarActiveMru.set([]);
    state$.regionSlotOrder.set([]);
    state$.regionSeverityByNodeId.set({});
    state$.regionCountsByNodeId.set({});
    impactModeActive$.set(false);
  });
  clearPreambles();
};

const canvasNavigationClock = makeNavigationClock();

// The node store holds the canvas on screen. A canvas is read into the store
// before the window shows it, so its cards and its document arrive together
// and the first fit of the camera is not left to run over the operator's
// first move. The canvas shown before is let go only once the next is shown.
let shownCanvas: { readonly name: string; readonly release: () => void } | undefined;

/** Read a canvas into the store and keep it there. Returns the way to let it go. */
const holdCanvas = async (name: string): Promise<() => void> => {
  const release = modelStore.open(name);
  await modelStore.ready(name);
  return release;
};

/** A canvas read into the store, with the actor references main compiled for it. */
type HeldCanvas = { readonly release: () => void; readonly actorRefs: ReadonlyArray<ActorRef> };

/**
 * Read a canvas from main: its nodes and wires into the store, and its actor
 * references. Nothing reads a document; the window works its own out from the
 * store for the readers that still take one.
 */
const readHeld = async (name: string): Promise<HeldCanvas> => {
  const junto = window.junto;
  if (!junto) throw new Error("Electron preload bridge is not available.");
  const release = await holdCanvas(name);
  try {
    if (modelStore.canvas$(name).status.peek() === "error") {
      throw new Error(modelStore.canvas$(name).error.peek() || `canvas "${name}" could not be read`);
    }
    return { release, actorRefs: await junto.modelActorRefs({ canvas: name }) };
  } catch (error) {
    release();
    throw error;
  }
};

/** Put a canvas that was read on screen: its document, its actor references, a clean view. */
const showHeld = (name: string, held: HeldCanvas): void => {
  showHeldCanvas(name, held.release);
  state$.canvasName.set(name);
  resetCanvasView();
  batch(() => {
    showOpenedCanvas(name);
    replaceActiveActorRefs(held.actorRefs);
  });
};

/** Canvases read for a jump to a node, held until the jump is applied. */
const heldForNavigation = new Map<string, HeldCanvas>();

/** The canvas held by `release` is the one on screen now. */
const showHeldCanvas = (name: string, release: () => void): void => {
  const before = shownCanvas;
  shownCanvas = { name, release };
  before?.release();
};

// Read a canvas, load it as the source of truth, and prime the adapter plane
// with just this document's bindings.
const openCanvas = async (name: string) => {
  await runCanvasAuthoringOperation(async () => {
    if (!window.junto) return;
    let request: number | undefined;
    state$.canvasLoading.set(true);
    try {
      await flushCanvasEdits("navigation");
      if (canvasMutationsQuiesced()) return;
      request = canvasNavigationClock.begin();
      const held = await readHeld(name);
      if (canvasMutationsQuiesced() || !canvasNavigationClock.isCurrent(request)) {
        held.release();
        return;
      }
      clearAbandonedCanvas(name);
      showHeld(name, held);
      state$.error.set("");
      await refreshSnapshotsSoft();
    } catch (error) {
      if (request === undefined || canvasNavigationClock.isCurrent(request)) setError(error);
    } finally {
      if (request === undefined || canvasNavigationClock.isCurrent(request)) {
        state$.canvasLoading.set(false);
      }
    }
  });
};

const assertCanvasNavigationAdmitted = (): void => {
  if (canvasMutationsQuiesced()) {
    throw new Error("Canvas navigation is unavailable while Junto is quitting.");
  }
};

const nodeRefNavigation = makeNodeRefNavigationCoordinator({
  clock: canvasNavigationClock,
  openModelCanvas: async (name) => {
    // Held until `apply` shows it. A read that is never applied is let go by
    // the next read of the same canvas.
    heldForNavigation.get(name)?.release();
    heldForNavigation.delete(name);
    const held = await readHeld(name);
    heldForNavigation.set(name, held);
    return { name, nodeIds: [...modelStore.canvasOf(name).nodes.keys()], actorRefs: held.actorRefs };
  },
  assertCanApply: assertCanvasNavigationAdmitted,
  apply: (event, result) => {
    clearAbandonedCanvas(result.name);
    showHeld(
      result.name,
      heldForNavigation.get(result.name) ?? { release: modelStore.open(result.name), actorRefs: result.actorRefs },
    );
    heldForNavigation.delete(result.name);
    selectNode(event.nodeId);
    state$.focusNodeId.set(event.nodeId);
    state$.canvasLoading.set(false);
    state$.error.set("");
    void refreshSnapshotsSoft();
  },
  onFailure: (error) => {
    state$.canvasLoading.set(false);
    state$.error.set(`node reference / ${error.message}`);
  },
});

const createCanvas = async (name: string) => {
  await runCanvasAuthoringOperation(async () => {
    if (!window.junto) return;
    let request: number | undefined;
    state$.canvasLoading.set(true);
    try {
      await flushCanvasEdits("navigation");
      if (canvasMutationsQuiesced()) return;
      request = canvasNavigationClock.begin();
      // A new canvas is a command; it is then read like any other.
      await window.junto.modelCommand({ _tag: "CreateCanvas", canvas: asCanvasName(name) });
      const result = { name };
      if (canvasMutationsQuiesced()) return;
      clearAbandonedCanvas(result.name);
      await refreshList();
      if (canvasMutationsQuiesced() || !canvasNavigationClock.isCurrent(request)) return;
      const held = await readHeld(result.name);
      if (canvasMutationsQuiesced() || !canvasNavigationClock.isCurrent(request)) {
        held.release();
        return;
      }
      showHeld(result.name, held);
      state$.error.set("");
      await refreshSnapshotsSoft();
    } catch (error) {
      if (request === undefined || canvasNavigationClock.isCurrent(request)) setError(error);
    } finally {
      if (request === undefined || canvasNavigationClock.isCurrent(request)) {
        state$.canvasLoading.set(false);
      }
    }
  });
};

const deleteCanvas = async (name: string) => {
  await runCanvasAuthoringOperation(async () => {
    if (!window.junto || !name) return;
    state$.canvasLoading.set(true);
    try {
      const wasOpen = state$.canvasName.peek() === name;
      await flushCanvasEdits("navigation");
      if (canvasMutationsQuiesced()) return;
      // Mark the name abandoned after its last pending edit is durable so the
      // delete wins over any already-returning watcher echo.
      await prepareCanvasRemoval(name);
      if (canvasMutationsQuiesced()) return;
      await window.junto.modelCommand({ _tag: "RemoveCanvas", canvas: asCanvasName(name) });
      if (canvasMutationsQuiesced()) return;
      await refreshList();
      if (canvasMutationsQuiesced()) return;
      const remaining = state$.canvases.peek();
      state$.error.set("");
      if (!wasOpen) return;
      if (remaining.length === 0) {
        await createCanvas(SEED_CANVAS_NAME);
        return;
      }
      await openCanvas(remaining[0]!.name);
    } catch (error) {
      setError(error);
    } finally {
      state$.canvasLoading.set(false);
    }
  });
};

const retryActionForError = (message: string): { readonly label: string; readonly run: () => Promise<void> } | undefined => {
  if (message.includes("write-canvas") || message.includes("cannot write")) return { label: "retry save", run: async () => retrySave() };
  return undefined;
};

// One-shot across the app lifetime, so StrictMode's mount/remount and any
// re-mount never re-run the boot sequence. Subscriptions, by contrast, are set
// up and torn down per effect run so they always stay balanced.
let didBoot = false;

export function App() {
  const error = use$(state$.error);
  const booting = use$(state$.booting);
  const canvasName = use$(state$.canvasName);
  const machinesOpen = use$(state$.machinesOpen);
  const errorAction = retryActionForError(error);

  useEffect(() => {
    if (!window.junto) {
      state$.error.set("Electron preload bridge is not available.");
      state$.booting.set(false);
      return;
    }
    const junto = window.junto;
    // Subscribe before boot touches a default canvas. Preload can deliver a
    // buffered cold-start locator synchronously from this call; returning the
    // navigation promise delays its durable relay ACK until focus is applied.
    const offNodeRef = junto.onNodeRefOpened(async (event) => {
      assertCanvasNavigationAdmitted();
      state$.canvasLoading.set(true);
      await runCanvasAuthoringOperation(async () => {
        try {
          await flushCanvasEdits("navigation");
          assertCanvasNavigationAdmitted();
          await nodeRefNavigation.navigate(event);
        } catch (error) {
          state$.canvasLoading.set(false);
          throw error;
        }
      });
    });

    // Usage: subscribe first so no push is lost. getUsage is instant (main
    // already holds last-good cache + kicks primary poll on start). Do NOT
    // await refreshUsage here — that was waiting 30–60s on slow provider
    // fetches and made the HUD feel deferred. Main `usage.start()` polls
    // immediately.
    const offUsage =
      USAGE_ENABLED && junto.onUsageChanged
        ? junto.onUsageChanged((state) => state$.usage.set(state))
        : () => undefined;
    if (USAGE_ENABLED && junto.getUsage) {
      void junto
        .getUsage()
        .then((usage) => state$.usage.set(usage))
        .catch(() => {
          // Fail open: keep empty until a push lands.
        });
    }

    const boot = async () => {
      try {
        const settingsResult = await junto.settingsGet?.();
        if (settingsResult?.ok && settingsResult.settings) {
          state$.settings.set(settingsResult.settings);
        }
        state$.snapshots.set(await junto.getSnapshots());
        const list = await junto.modelCanvases();
        state$.canvases.set(list);
        if (!nodeRefNavigation.hasReceived()) {
          const action = nextCanvasBootAction(list.map((row) => row.name));
          if (action.kind === "open") {
            await openCanvas(action.name);
          } else {
            await createCanvas(SEED_CANVAS_NAME);
          }
        }
      } catch (error) {
        setError(error);
      } finally {
        state$.booting.set(false);
      }
    };
    if (!didBoot) {
      didBoot = true;
      void boot().catch(setError);
    }

    // A renderer-only reload (dev hot reload, crash-recovery reload) leaves
    // any already-attached WebContentsView orphaned unless the dock is
    // rebuilt from the main process's live session list on mount.
    void reconcileDockFromLiveSessions();

    const stopKernel = startKernelBridge();
    startThemeMode();
    const stopSettings = startSettingsBridge();
    const stopUpdate = startUpdateBridge();
    // Managed-agent seat state (attention/working) — subscribe early so canvas
    // node chrome paints before any TerminalCard mounts.
    const stopAgentSeat = subscribeAgentSeatState();
    // Advisory seat awareness — same early subscription so a card that mounts
    // later already holds the latest judgment for its binding.
    const stopSeatAwareness = subscribeSeatAwareness();
    // Freeze continuous CSS when the page is hidden / reduced-motion so the
    // GPU helper can drop off the fan curve (fleet closed is not enough).
    const stopSurfaceMotion = startSurfaceMotionGate();

    const offSnapshots = junto.onSnapshotsChanged((state) => state$.snapshots.set(state));
    // The open canvas follows the node store; nothing reads it again here. A
    // window showing no canvas opens the first one that comes to exist.
    const offCanvas = junto.onModelCanvasesChanged(() => {
      if (state$.canvasName.peek() !== "") return;
      void (async () => {
        await refreshList();
        const list = state$.canvases.peek();
        if (state$.canvasName.peek() !== "") return;
        const first = list[0]?.name;
        if (first) await openCanvas(first);
      })();
    });
    const offPreamble = junto.onPreamble?.((event) => {
      if (event.canvasName !== state$.canvasName.peek()) return;
      showPreamble(event);
    });
    const offAgentSignals = startAgentSignalSync(junto);
    const offPreambleSources = startPreambleSources(junto);

    const offCanvasFlush = junto.onCanvasFlushRequested(async () => {
      await flushCanvasEdits("navigation");
    });
    const offCanvasQuiesceAndFlush = junto.onCanvasQuiesceAndFlushRequested(async (acknowledgeQuiesced) => {
      try {
        const flush = quiesceAndFlushCanvasEdits();
        // quiesceAndFlushCanvasEdits closes admission synchronously before its
        // first await. Publish that boundary separately from final durability
        // so main can classify timeout/crash recovery without guessing.
        if (canvasMutationsQuiesced()) acknowledgeQuiesced();
        await flush;
        return { ok: true, quiesced: true };
      } catch {
        return { ok: false, quiesced: canvasMutationsQuiesced() };
      }
    });

    return () => {
      offNodeRef();
      offSnapshots();
      offUsage();
      offCanvas();
      offPreamble?.();
      offAgentSignals();
      offPreambleSources();
      offCanvasFlush();
      offCanvasQuiesceAndFlush();
      stopKernel();
      stopSettings?.();
      stopUpdate?.();
      stopAgentSeat?.();
      stopSeatAwareness?.();
      stopSurfaceMotion();
    };
  }, []);

  // Every app shortcut: one listener, resolved against the key table.
  useEffect(() => installKeyDispatcher(KEY_ACTIONS), []);

  // A view never outlives its node, however the node left the canvas.
  useEffect(() => installRemovedNodeViews(), []);

  // What is selected follows the node store; the actor references follow
  // what main announces.
  useEffect(() => followStore(), []);
  useEffect(
    () =>
      window.junto?.onModelActorRefsChanged((event) => {
        if (event.canvas === state$.canvasName.peek()) replaceActiveActorRefs(event.refs);
      }),
    [],
  );

  // Command bar "Open canvas" action — one-shot request consumed here so
  // opening a canvas keeps its single owner in App.
  useEffect(() => {
    return state$.canvasOpenRequest.onChange(() => {
      const name = state$.canvasOpenRequest.peek();
      if (!name) return;
      state$.canvasOpenRequest.set("");
      void openCanvas(name);
    });
  }, []);

  useEffect(() => {
    /**
     * The front focus surface owns the keyboard before the canvas does. A
     * browser page frontmost means Escape dismisses the surface (warm-detach);
     * a PTY keeps Escape page-owned (xterm consumes it, so this handler
     * rarely fires) and the canvas keys stay gated by Canvas's focus-surface
     * delete-key rules. Undo and redo are in the key table.
     */
    const frontBrowserSurface = (): { readonly id: string } | undefined => {
      const registry = dock$.registry.peek();
      const frontId = registry.focusMru[0];
      const front = registry.surfaces.find((s) => s.id === frontId);
      return front?.kind === "browser" && front.zone === "focus" ? { id: front.id } : undefined;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isOperatorTyping(event.target)) return;
      const front = frontBrowserSurface();
      if (front) {
        // Dismiss the page surface, keep the canvas selection intact — the
        // operator was leaving the page, not deselecting their node.
        event.preventDefault();
        closeFocusModalSurface(front.id);
        return;
      }
      if (state$.selectedNodeId.peek() || state$.selectedEdgeId.peek() || state$.selectedNodeIds.peek().length > 0) {
        event.preventDefault();
        clearSelection();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="junto-app flex h-screen w-screen flex-col overflow-hidden" style={{ background: "var(--color-ground)" }}>
      <CountedSurface id="top-bar">
        <TopBar
          onOpen={(name) => void openCanvas(name)}
          onCreate={(name) => void createCanvas(name)}
          onDelete={(name) => void deleteCanvas(name)}
        />
      </CountedSurface>

      <div className="junto-stage flex min-h-0 flex-1">
        {/* Canvas column shrinks when the dock opens; overlays anchor to it. */}
        <div className="junto-stage-main relative min-w-0 flex-1">
        {error ? (
          <div
            role="alert"
            className="error-banner absolute left-1/2 top-3 z-50 -translate-x-1/2 rounded-md border px-3 py-1.5 text-[11px]"
            style={{ borderColor: "color-mix(in oklab, var(--color-accent) 40%, transparent)", background: "color-mix(in oklab, var(--color-accent) 12%, transparent)", color: "var(--color-ink)" }}
          >
            <button type="button" className="error-banner__close" aria-label="Dismiss warning" onClick={() => state$.error.set("")}>×</button>
            <span className="error-banner__label">renderer / data warning</span>
            <span className="error-banner__message">{error}</span>
            {errorAction ? <button type="button" className="error-banner__retry" onClick={() => void errorAction.run()}>{errorAction.label}</button> : null}
          </div>
        ) : null}

        {booting && !canvasName ? (
          <div className="boot-indicator absolute left-1/2 top-5 z-40 -translate-x-1/2">
            <span className="boot-indicator__dot" />
            opening station
          </div>
        ) : null}

        <ReactFlowProvider>
          <Canvas />
          <DemoCameraBridge />
        </ReactFlowProvider>
        <CountedSurface id="canvas-chrome">
          <CanvasChrome />
        </CountedSurface>
        <CountedSurface id="focus-switcher">
          <FocusSwitcherHud />
        </CountedSurface>
        {LIVE_OVERSEER_ENABLED && <LiveConversationHost />}
        {/* Selection fields live on the RTS kind surface (FocusSurface forms). */}

        <RendererErrorBoundary
          title="This work surface hit a render error"
          onReset={() => {
            closeAllWorkbenchSurfaces();
          }}
        >
          <CountedSurface id="work-focus">
            <WorkFocusShell />
          </CountedSurface>
          <CountedSurface id="terminal-host">
            <PersistentTerminalHost />
          </CountedSurface>
          <CountedSurface id="terminal-grid">
            <TerminalGridFocus />
          </CountedSurface>
        </RendererErrorBoundary>
        <SettingsPanel />
        <DigestPanel />
        <CountedSurface id="notifications">
          <DesktopNotificationsHost />
        </CountedSurface>
        <StoreHost />
        <AgentEditorHost />
        <ObservabilityPanel />
        {/* Mounted only while open, so none of it loads at startup. */}
        {FLEET_UI_ENABLED && machinesOpen ? (
          <Suspense
            fallback={
              <div className="machines-opening" role="status" aria-live="polite">
                Opening machines…
              </div>
            }
          >
            <MachinesWindow />
          </Suspense>
        ) : null}
        <DemoLayer />
        <FirstRunIntro />
        </div>
        {WorkSurfaceDock ? (
          <Suspense fallback={null}>
            <CountedSurface id="work-dock">
              <WorkSurfaceDock />
            </CountedSurface>
          </Suspense>
        ) : null}
      </div>
      <ConfirmHost />
      <OperatorModalHost />
      <TooltipLayer />
    </div>
  );
}
