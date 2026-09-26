import { lazy, Suspense, useEffect } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { identityHints } from "../shared/connections";
import type { CanvasDoc } from "@shared/canvas";
import { batch } from "@legendapp/state";
import { use$ } from "@legendapp/state/react";
import { impactModeActive$ } from "./lib/impact-mode";
import { clearSelection, selectNode, state$ } from "./lib/state";
import { canvasCommandGroups } from "./lib/command-groups";
import {
  acceptCanvasRevision,
  canvasMutationsQuiesced,
  clearAbandonedCanvas,
  getCanvasRevision,
  hasPendingCanvasChanges,
  loadDoc,
  prepareCanvasRemoval,
  replaceActiveActorRefs,
  redo,
  retrySave,
  undo,
} from "./lib/mutations";
import {
  flushCanvasEdits,
  quiesceAndFlushCanvasEdits,
  runCanvasAuthoringOperation,
} from "./lib/canvas-editor-flush";
import { makeCanvasExternalReloadCoordinator } from "./lib/canvas-external-reload";
import { startKernelBridge } from "./lib/kernel-view";
import { startSettingsBridge, closeSettings } from "./lib/settings-state";
import { startThemeMode } from "./lib/theme-mode";
import { startUpdateBridge } from "./lib/update-state";
import { subscribeAgentSeatState } from "./lib/agent-seat-state";
import { subscribeSeatAwareness } from "./lib/seat-awareness";
import { installCompletedNotifyTestHook } from "./lib/completed-task-notify";
import { installActorMirrorHotkeys } from "./lib/actor-mirrors";
import { installFocusSwitcherHotkeys } from "./lib/focus-switcher";
import { reconcileDockFromLiveSessions } from "./lib/dock-state";
import { startSurfaceMotionGate } from "./lib/surface-motion";
import { clearPreambles, showPreamble } from "./lib/preamble-state";
import { startPreambleSources } from "./lib/preamble-sources";
import { startAgentSignalSync } from "./lib/agent-signals-state";
import { Canvas } from "./components/Canvas";
import { TopBar } from "./components/TopBar";
import { CanvasChrome } from "./components/CanvasChrome";
import { CommandBarHost } from "./components/command-bar/CommandBar";
import { FocusSwitcherHud } from "./components/FocusSwitcherHud";
import { LiveConversationHost } from "./components/live/LiveConversation";
import { RemoteStationFace } from "./components/remote/RemoteStationFace";
import { RendererErrorBoundary } from "./components/RendererErrorBoundary";

import { SettingsPanel } from "./components/SettingsPanel";
import { FirstRunIntro } from "./components/onboarding/FirstRunIntro";
import { DigestPanel } from "./components/DigestPanel";
import { OperatorFeedHost } from "./components/feed/OperatorFeed";
import { DesktopNotificationsHost } from "./lib/desktop-notify";
import { StoreHost } from "./overlay/surfaces";
import { ObservabilityPanel } from "./components/ObservabilityPanel";
import {
  FLEET_UI_ENABLED,
  HERMES_INTEGRATION_ENABLED,
  LIVE_OVERSEER_ENABLED,
  USAGE_ENABLED,
} from "@shared/features";
// Fleet is experimental. The define identifier must wrap import() in
// this module so ship builds can drop the chunk; imported FLEET_UI_ENABLED
// is not visible to Rollup DCE.
const FleetOverlay = __JUNTO_FLEET_UI_ENABLED__
  ? lazy(async () => {
      const mod = await import("./components/fleet/FleetOverlay");
      return { default: mod.FleetOverlay };
    })
  : () => null;
import { WorkSurfaceDock } from "./components/WorkSurfaceDock";
import { WorkFocusShell } from "./components/workbench";
import { PersistentTerminalHost } from "./components/terminal/PersistentTerminalHost";
import { TerminalGridFocus } from "./components/terminal/TerminalGridFocus";
import { closeAllWorkbenchSurfaces, closeFocusModalSurface, dock$ } from "./lib/dock-state";
import { closeAllTerminalSurfaces } from "./lib/terminal-state";
import { TooltipLayer } from "./components/TooltipLayer";
import { DemoCameraBridge } from "./demo/camera-bridge";
import { DemoLayer } from "./demo/demo-layer";
import { SEED_CANVAS_NAME } from "@shared/seed";
import { isCommandCenterFleetUi, nextCanvasBootAction } from "./lib/canvas-boot";
import {
  makeNavigationClock,
  makeNodeRefNavigationCoordinator,
} from "./lib/node-ref-navigation";
import { isOperatorTyping } from "./lib/focus-ownership";

const setError = (error: unknown) =>
  state$.error.set(error instanceof Error ? error.message : String(error));

const refreshList = async () => {
  if (!window.junto) return;
  state$.canvases.set(await window.junto.listCanvases());
};

const refreshSnapshotsSoft = async (doc: CanvasDoc) => {
  if (!HERMES_INTEGRATION_ENABLED || !window.junto?.refreshSnapshots) return;
  try {
    const snapshots = await Promise.race([
      window.junto.refreshSnapshots(identityHints([doc], state$.snapshots.peek())),
      new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 1500)),
    ]);
    if (snapshots) state$.snapshots.set(snapshots);
  } catch (error) {
    setError(error);
  }
};

const resetCanvasView = (): void => {
  batch(() => {
    state$.commandBarOpen.set(false);
    state$.digestOpen.set(false);
    state$.digest.set(null);
    state$.nodePaletteOpen.set(false);
    state$.edgeFilter.set("");
    state$.flagFilter.set("");
    clearSelection();
    state$.connectionFocusNodeId.set("");
    state$.focusNodeId.set("");
    // Operator slots (fixed nodes, command groups) come back for the canvas
    // being opened; leases recompute from activity once its doc loads.
    state$.hotbarSlots.set(canvasCommandGroups.recall(state$.canvasName.peek()));
    state$.hotbarActiveMru.set([]);
    state$.regionSlotOrder.set([]);
    state$.regionSeverityByNodeId.set({});
    impactModeActive$.set(false);
  });
  clearPreambles();
};

const canvasNavigationClock = makeNavigationClock();

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
      const result = await window.junto.readCanvas(name);
      if (canvasMutationsQuiesced() || !canvasNavigationClock.isCurrent(request)) return;
      clearAbandonedCanvas(result.name);
      state$.canvasName.set(result.name);
      resetCanvasView();
      batch(() => {
        loadDoc(result.doc, result.revision, result.name);
        replaceActiveActorRefs(result.actorRefs);
      });
      externalCanvasReload.accept(result);
      state$.error.set("");
      await refreshSnapshotsSoft(result.doc);
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
  readCanvas: async (name) => {
    const junto = window.junto;
    if (!junto) throw new Error("Electron preload bridge is not available.");
    return junto.readCanvas(name);
  },
  assertCanApply: assertCanvasNavigationAdmitted,
  apply: (event, result) => {
    clearAbandonedCanvas(result.name);
    state$.canvasName.set(result.name);
    resetCanvasView();
    batch(() => {
      loadDoc(result.doc, result.revision, result.name);
      replaceActiveActorRefs(result.actorRefs);
    });
    externalCanvasReload.accept(result);
    selectNode(event.nodeId);
    state$.focusNodeId.set(event.nodeId);
    state$.canvasLoading.set(false);
    state$.error.set("");
    void refreshSnapshotsSoft(result.doc);
  },
  onFailure: (error) => {
    state$.canvasLoading.set(false);
    state$.error.set(`node reference / ${error.message}`);
  },
});

const externalCanvasReload = makeCanvasExternalReloadCoordinator({
  flushLocalEdits: () => flushCanvasEdits("background"),
  readCanvas: async (name) => {
    const junto = window.junto;
    if (!junto) throw new Error("Electron preload bridge is not available.");
    return junto.readCanvas(name);
  },
  currentCanvasName: () => state$.canvasName.peek(),
  currentDoc: () => state$.doc.peek(),
  currentDocEpoch: () => state$.docEpoch.peek(),
  currentRevision: getCanvasRevision,
  hasPendingChanges: hasPendingCanvasChanges,
  acceptRevision: acceptCanvasRevision,
  apply: (result) =>
    batch(() => {
      loadDoc(result.doc, result.revision, result.name, {
        preserveValidInteraction: true,
      });
      replaceActiveActorRefs(result.actorRefs);
    }),
  onFailure: setError,
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
      const result = await window.junto.createCanvas(name);
      if (canvasMutationsQuiesced()) return;
      clearAbandonedCanvas(result.name);
      await refreshList();
      if (canvasMutationsQuiesced() || !canvasNavigationClock.isCurrent(request)) return;
      state$.canvasName.set(result.name);
      resetCanvasView();
      batch(() => {
        loadDoc(result.doc, result.revision, result.name);
        replaceActiveActorRefs(result.actorRefs);
      });
      externalCanvasReload.accept(result);
      state$.error.set("");
      await refreshSnapshotsSoft(result.doc);
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
      await window.junto.deleteCanvas(name);
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
  const fleetOpen = use$(state$.fleetOpen);
  const stationRole = use$(state$.settings.station.role);
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
        const list = await junto.listCanvases();
        state$.canvases.set(list);
        if (!nodeRefNavigation.hasReceived()) {
          const action = nextCanvasBootAction(
            state$.settings.station.role.peek(),
            list.map((row) => row.name),
          );
          if (action.kind === "open") {
            await openCanvas(action.name);
          } else if (action.kind === "seed") {
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
    installCompletedNotifyTestHook();
    // Freeze continuous CSS when the page is hidden / reduced-motion so the
    // GPU helper can drop off the fan curve (fleet closed is not enough).
    const stopSurfaceMotion = startSurfaceMotionGate();

    const offSnapshots = junto.onSnapshotsChanged((state) => state$.snapshots.set(state));
    const offCanvas = junto.onCanvasChanged((name) => {
      const current = state$.canvasName.peek();
      if (name !== "" && name === current) {
        void externalCanvasReload.changed(name);
        return;
      }
      if (current !== "") return;
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

  // Cmd+] / Cmd+[ swap the front terminal between connected actors. Capture
  // phase (installed here, checked there) so the chord never reaches xterm.
  useEffect(() => installActorMirrorHotkeys(), []);
  // Control+Tab cycles focus models without closing the modal.
  useEffect(() => installFocusSwitcherHotkeys(), []);

  // Command bar "Open canvas" action — one-shot request consumed here so the
  // readCanvas + loadDoc flow keeps its single owner in App.
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
     * browser page frontmost means Escape dismisses the surface (warm-detach)
     * and Cmd+Z never edits the doc behind the modal; a PTY keeps Escape
     * page-owned (xterm consumes it, so this handler rarely fires) and the
     * canvas keys stay gated by Canvas's focus-surface delete-key rules.
     */
    const frontBrowserSurface = (): { readonly id: string } | undefined => {
      const registry = dock$.registry.peek();
      const frontId = registry.focusMru[0];
      const front = registry.surfaces.find((s) => s.id === frontId);
      return front?.kind === "browser" && front.zone === "focus" ? { id: front.id } : undefined;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (isOperatorTyping(event.target)) return;
        if (state$.settingsOpen.peek()) {
          event.preventDefault();
          closeSettings();
          return;
        }
        if (state$.digestOpen.peek()) {
          event.preventDefault();
          state$.digestOpen.set(false);
          return;
        }
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
          return;
        }
        return;
      }
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return;
      if (isOperatorTyping(event.target)) return;
      if (frontBrowserSurface()) return;
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (stationRole === "remote") {
    return <RemoteStationFace />;
  }

  return (
    <div className="junto-app flex h-screen w-screen flex-col overflow-hidden" style={{ background: "var(--color-ground)" }}>
      <TopBar
        onOpen={(name) => void openCanvas(name)}
        onCreate={(name) => void createCanvas(name)}
        onDelete={(name) => void deleteCanvas(name)}
      />

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
        <CanvasChrome />
        <CommandBarHost />
        <FocusSwitcherHud />
        {LIVE_OVERSEER_ENABLED && <LiveConversationHost />}
        {/* Selection fields live on the RTS kind surface (FocusSurface forms). */}

        <RendererErrorBoundary
          title="This work surface hit a render error"
          onReset={() => {
            closeAllWorkbenchSurfaces();
            closeAllTerminalSurfaces();
          }}
        >
          <WorkFocusShell />
          <PersistentTerminalHost />
          <TerminalGridFocus />
        </RendererErrorBoundary>
        <SettingsPanel />
        <DigestPanel />
        <OperatorFeedHost />
        <DesktopNotificationsHost />
        <StoreHost />
        <ObservabilityPanel />
        {/* Mount fleet only while open — unmount destroys every WebGL machine. */}
        {FLEET_UI_ENABLED && isCommandCenterFleetUi(stationRole) && fleetOpen ? (
          <Suspense
            fallback={
              <div className="fleet-chunk-fallback" role="status" aria-live="polite">
                Opening Command Fleet…
              </div>
            }
          >
            <FleetOverlay />
          </Suspense>
        ) : null}
        <DemoLayer />
        <FirstRunIntro />
        </div>
        <WorkSurfaceDock />
      </div>
      <TooltipLayer />
    </div>
  );
}
