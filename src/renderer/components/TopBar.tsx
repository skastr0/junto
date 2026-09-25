import { use$, useObservable } from "@legendapp/state/react";
import { useEffect, useRef, useState } from "react";
import { CircleHelp, Pause, Play, Plus, Radar, ScrollText, Search, Settings2, Trash2 } from "lucide-react";
import type { CanvasSummary } from "@shared/ipc";
import {
  cancelFactoryFirstPlay,
  confirmFactoryFirstPlay,
  factoryPause$,
  refreshFactoryPause,
  toggleFactoryPause,
} from "../lib/factory-pause";
import {
  DEV_TOOLS_ENABLED,
  FLEET_UI_ENABLED,
  HELP_MAP_ENABLED,
  USAGE_ENABLED,
} from "@shared/features";
import { isCommandCenterAuthoring } from "../lib/canvas-boot";
import { state$ } from "../lib/state";
import { openCommandBar } from "../lib/command-bar";
import { retrySave } from "../lib/mutations";
import { openSettings } from "../lib/settings-state";
import { openFleet, prefetchFleetChunk } from "../lib/fleet-state";
import { GREEN, HUE, INK, withAlpha } from "../lib/theme";
import { Dropdown } from "./ui";
import { CanvasInteractionMap } from "./help/CanvasInteractionMap";
import { FirstPlayConfirm } from "./FirstPlayConfirm";
import { UpdateChip } from "./UpdateChip";
import { UsageHud } from "./UsageHud";
import { claimFocusOnMount } from "../lib/focus-ownership";

function CanvasPicker({
  canvases,
  canvasName,
  busy,
  authoring,
  onOpen,
  onCreate,
  onDelete,
}: {
  readonly canvases: ReadonlyArray<CanvasSummary>;
  readonly canvasName: string;
  readonly busy: boolean;
  readonly authoring: boolean;
  readonly onOpen: (name: string) => void;
  readonly onCreate: (name: string) => void;
  readonly onDelete: (name: string) => void;
}) {
  const createName$ = useObservable("");
  const createOpen$ = useObservable(false);
  const deleteOpen$ = useObservable(false);
  const deleteTarget$ = useObservable("");
  const createName = use$(createName$);
  const createOpen = use$(createOpen$);
  const deleteOpen = use$(deleteOpen$);
  const deleteTarget = use$(deleteTarget$);

  const closeCreate = () => {
    createOpen$.set(false);
    createName$.set("");
  };
  const closeDelete = () => {
    deleteOpen$.set(false);
    deleteTarget$.set("");
  };
  const openDelete = () => {
    if (!canvasName) return;
    deleteTarget$.set(canvasName);
    deleteOpen$.set(true);
  };
  const submitCreate = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = createName.trim();
    if (!name) return;
    onCreate(name);
    closeCreate();
  };
  const submitDelete = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!deleteTarget) return;
    onDelete(deleteTarget);
    closeDelete();
  };

  return (
    <>
      <div className="station-canvas" role="group" aria-label="Canvas switcher">
        <Dropdown
          className="station-select-wrap"
          triggerClassName="station-select"
          disabled={busy}
          aria-busy={busy}
          aria-label="Active canvas"
          title={busy ? "Opening canvas…" : "Switch canvas"}
          value={canvasName}
          uppercase
          emptyLabel={authoring ? "no canvases" : "no projected canvases"}
          placeholder="select canvas"
          options={canvases.map((canvas) => ({ value: canvas.name, label: canvas.name }))}
          onChange={onOpen}
        />
        {busy ? <span className="station-context__loading" role="status" aria-live="polite">opening</span> : null}
        {authoring ? (
          <>
        <button type="button" className="station-canvas__action" disabled={busy} title="New canvas" aria-label="New canvas" onClick={() => createOpen$.set(true)}>
          <Plus size={14} />
        </button>
        <button type="button" className="station-canvas__action station-canvas__action--danger" disabled={busy || !canvasName} title="Delete canvas" aria-label="Delete canvas" onClick={openDelete}>
          <Trash2 size={14} />
        </button>
          </>
        ) : null}
      </div>
      {createOpen ? (
        <div className="canvas-dialog-backdrop" role="presentation" onMouseDown={closeCreate}>
          <form className="canvas-dialog" role="dialog" aria-modal="true" aria-labelledby="canvas-dialog-title" onSubmit={submitCreate} onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Escape") closeCreate(); }}>
            <h2 id="canvas-dialog-title">New canvas</h2>
            <p>Choose a short name for this canvas.</p>
            <label className="canvas-dialog__field">
              <span>name</span>
              <input ref={claimFocusOnMount} aria-label="Canvas name" value={createName} onChange={(event) => createName$.set(event.target.value)} placeholder="research" />
            </label>
            <div className="canvas-dialog__actions">
              <button type="button" className="canvas-dialog__cancel" onClick={closeCreate}>cancel</button>
              <button type="submit" className="canvas-dialog__submit" disabled={!createName.trim()}>create</button>
            </div>
          </form>
        </div>
      ) : null}
      {deleteOpen && deleteTarget ? (
        <div className="canvas-dialog-backdrop" role="presentation" onMouseDown={closeDelete}>
          <form className="canvas-dialog" role="dialog" aria-modal="true" aria-labelledby="canvas-delete-title" onSubmit={submitDelete} onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Escape") closeDelete(); }}>
            <h2 id="canvas-delete-title">Delete canvas</h2>
            <p>Permanently delete <strong style={{ color: INK }}>{deleteTarget}</strong>? This cannot be undone.</p>
            <div className="canvas-dialog__actions">
              <button type="button" className="canvas-dialog__cancel" ref={claimFocusOnMount} onClick={closeDelete}>cancel</button>
              <button type="submit" className="canvas-dialog__danger">delete</button>
            </div>
          </form>
        </div>
      ) : null}
    </>
  );
}

function CommandBarTrigger({ canvasName }: { readonly canvasName: string }) {
  const label = `Search ${canvasName || "canvas"}`;
  return (
    <button
      type="button"
      className="station-command-trigger"
      title="Open command bar (⌘K)"
      aria-label={label}
      onClick={() => openCommandBar()}
    >
      <Search size={14} />
      <span className="station-command-trigger__label">search nodes</span>
      <kbd className="station-command-trigger__kbd">⌘K</kbd>
    </button>
  );
}

// Factory pause switch (app-state, main-owned). The canvas is born paused;
// PAUSED is the prominent state, playing stays quiet. First play routes
// through FirstPlayConfirm (everPlayed latch); pausing is always instant.
// The state machine lives in lib/factory-pause.ts and is shared with the
// command bar "Play/Pause crew" action — this control is a thin face.
function FactoryPauseControl({ canvasName }: { readonly canvasName: string }) {
  const pauseState = use$(factoryPause$.state);
  const confirmOpen = use$(factoryPause$.confirmOpen);
  const error = use$(factoryPause$.error);
  const busy = use$(factoryPause$.busy);

  useEffect(() => {
    void refreshFactoryPause(canvasName);
  }, [canvasName]);

  if (!canvasName || !pauseState) return null;

  const onClick = () => toggleFactoryPause(canvasName);

  const playing = pauseState.playing;
  const pauseLabel = playing ? "playing" : "paused";
  return (
    <>
      <button
        type="button"
        data-testid="factory-pause"
        data-pause-state={pauseLabel}
        aria-label={playing ? "Pause canvas" : "Play canvas"}
        title={
          error
            ? `pause switch: ${error}`
            : playing
              ? "Pause canvas"
              : "Play canvas"
        }
        disabled={busy}
        onClick={onClick}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          height: 26,
          padding: "0 10px",
          borderRadius: 7,
          fontFamily: "inherit",
          fontSize: 9,
          letterSpacing: ".14em",
          textTransform: "uppercase",
          cursor: busy ? "not-allowed" : "pointer",
          border: "1px solid",
          ...(playing
            ? {
                color: GREEN,
                borderColor: withAlpha(GREEN, 0.28),
                background: "var(--color-overlay-1)",
              }
            : {
                color: HUE.amber,
                borderColor: withAlpha(HUE.amber, 0.55),
                background: withAlpha(HUE.amber, 0.12),
                boxShadow: `0 0 0 3px ${withAlpha(HUE.amber, 0.08)}`,
              }),
        }}
      >
        {playing ? (
          <Play size={11} fill="currentColor" />
        ) : (
          <Pause size={11} fill="currentColor" />
        )}
        <span>{pauseLabel}</span>
      </button>
      {error ? (
        <span
          role="alert"
          style={{
            color: HUE.crimson,
            fontSize: 8,
            letterSpacing: ".12em",
            textTransform: "uppercase",
            maxWidth: 180,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {error}
        </span>
      ) : null}
      {confirmOpen ? (
        <FirstPlayConfirm
          canvasName={canvasName}
          onConfirm={() => confirmFactoryFirstPlay(canvasName)}
          onCancel={cancelFactoryFirstPlay}
        />
      ) : null}
    </>
  );
}

function SaveStatus() {
  const saveState = use$(state$.saveState);
  const label = saveState === "saving" ? "saving" : saveState === "error" ? "save error" : "saved";
  if (saveState === "error") return <button className="station-save station-save--error" title="Retry writing the latest canvas change" aria-label="Retry save" onClick={retrySave}><span className="station-save__dot" /><span>retry save</span></button>;
  return <div role="status" aria-live="polite" className={`station-save station-save--${saveState}`} title={`Canvas ${label}`}><span className="station-save__dot" /><span>{label}</span></div>;
}

export function TopBar({
  onOpen,
  onCreate,
  onDelete,
}: {
  readonly onOpen: (name: string) => void;
  readonly onCreate: (name: string) => void;
  readonly onDelete: (name: string) => void;
}) {
  const canvases = use$(state$.canvases);
  const canvasName = use$(state$.canvasName);
  const canvasLoading = use$(state$.canvasLoading);
  const authoring = isCommandCenterAuthoring(use$(state$.settings.station.role));
  const logsExplorer = use$(state$.settings.advanced.logsExplorer);
  const observabilityOpen = use$(state$.observabilityOpen);
  const [helpOpen, setHelpOpen] = useState(false);
  useEffect(() => {
    if (!helpOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setHelpOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && !target.closest(".station-actions")) setHelpOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [helpOpen]);
  return (
    <header className="station-bar">
      {USAGE_ENABLED ? <UsageHud /> : null}
      <CanvasPicker canvases={canvases} canvasName={canvasName} busy={canvasLoading} authoring={authoring} onOpen={onOpen} onCreate={onCreate} onDelete={onDelete} />
      <CommandBarTrigger canvasName={canvasName} />
      <SaveStatus />
      <div className="station-actions relative ml-auto flex items-center gap-3">
        <UpdateChip />
        <FactoryPauseControl canvasName={canvasName} />
        {DEV_TOOLS_ENABLED && logsExplorer ? (
          <button
            type="button"
            className="station-icon-button"
            data-testid="observability-logs"
            aria-label={observabilityOpen ? "Close logs explorer" : "Open logs explorer"}
            aria-pressed={observabilityOpen}
            title="Logs explorer"
            style={{
              borderColor: observabilityOpen
                ? withAlpha(HUE.cyan, 0.45)
                : "var(--color-stroke)",
              color: observabilityOpen ? HUE.cyan : HUE.steel,
            }}
            onClick={() => {
              setHelpOpen(false);
              state$.observabilityOpen.set(!state$.observabilityOpen.peek());
            }}
          >
            <ScrollText size={15} />
          </button>
        ) : null}
        {FLEET_UI_ENABLED && authoring ? (
          <button type="button" className="station-icon-button" aria-label="Open fleet manager" title="Fleet"
            style={{ borderColor: "var(--color-stroke)", color: HUE.steel }}
            onPointerEnter={prefetchFleetChunk}
            onFocus={prefetchFleetChunk}
            onClick={() => { setHelpOpen(false); openFleet(); }}>
            <Radar size={15} />
          </button>
        ) : null}
        {HELP_MAP_ENABLED ? (
          <>
            <button type="button" className="station-help-trigger" aria-label="Open interaction help" aria-expanded={helpOpen} aria-haspopup="dialog" onClick={() => setHelpOpen((open) => !open)}>
              <CircleHelp size={15} />
            </button>
            {helpOpen ? <CanvasInteractionMap onClose={() => setHelpOpen(false)} /> : null}
          </>
        ) : null}
        <button className="station-icon-button" aria-label="Open settings" style={{ borderColor: "var(--color-stroke)", color: HUE.steel }} title="Settings" onClick={() => { setHelpOpen(false); openSettings(); }}>
          <Settings2 size={15} />
        </button>
      </div>
    </header>
  );
}
