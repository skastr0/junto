import { use$, useObservable } from "@legendapp/state/react";
import { useEffect, useId, useState } from "react";
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
import { openOperatorModal } from "../lib/operator-modal";
import { retrySave } from "../lib/mutations";
import { openSettings } from "../lib/settings-state";
import { openFleet, prefetchFleetChunk } from "../lib/fleet-state";
import { HUE, withAlpha } from "../lib/theme";
import { Button, ConfirmDialog, Dialog, Dropdown, FieldLabel, Input, Popover } from "./ui";
import { CanvasInteractionMap } from "./help/CanvasInteractionMap";
import { FirstPlayConfirm } from "./FirstPlayConfirm";
import { UpdateChip } from "./UpdateChip";
import { NeedsYouButton } from "./feed/NeedsYouButton";
import { UsageHud } from "./UsageHud";
import { CommandGroupBar } from "./command-groups/CommandGroupBar";
import { claimFocusOnMount } from "../lib/focus-ownership";

// Module-level so the popover's placement effect sees one stable array.
const HELP_SIDES = ["below"] as const;

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
  const createFormId = useId();
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
  const confirmDelete = () => {
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
        <Dialog
          title="New canvas"
          onClose={closeCreate}
          actions={
            <>
              <Button size="md" variant="chrome" onClick={closeCreate}>Cancel</Button>
              <Button size="md" variant="primary" type="submit" form={createFormId} disabled={!createName.trim()}>Create</Button>
            </>
          }
        >
          <form id={createFormId} className="grid gap-3" onSubmit={submitCreate}>
            <span>Choose a short name for this canvas.</span>
            <FieldLabel>
              name
              <Input ref={claimFocusOnMount} aria-label="Canvas name" value={createName} onChange={(event) => createName$.set(event.target.value)} placeholder="research" />
            </FieldLabel>
          </form>
        </Dialog>
      ) : null}
      {deleteOpen && deleteTarget ? (
        <ConfirmDialog
          title="Delete canvas"
          confirmLabel="Delete canvas"
          onConfirm={confirmDelete}
          onCancel={closeDelete}
        >
          <span>Permanently delete <strong className="text-ink">{deleteTarget}</strong>? This cannot be undone.</span>
        </ConfirmDialog>
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
      onClick={() => openOperatorModal("search")}
    >
      <Search size={14} />
      <span className="station-command-trigger__label">search nodes</span>
      <kbd className="station-command-trigger__kbd">⌘K</kbd>
    </button>
  );
}

/**
 * The pause switch as drawn: an icon button like its neighbours. The glyph is
 * the action (pause while playing, play while paused); paused is the loud
 * state, in amber, and playing stays quiet. Pure, so the tour can show the
 * real control in either state.
 */
export function PauseSwitchFace({
  playing,
  busy = false,
  error,
  onClick,
}: {
  readonly playing: boolean;
  readonly busy?: boolean;
  readonly error?: string | null;
  readonly onClick?: () => void;
}) {
  const action = playing ? "Pause canvas" : "Play canvas";
  return (
    <button
      type="button"
      className={`station-icon-button station-pause${playing ? "" : " station-pause--paused"}`}
      data-testid="factory-pause"
      data-pause-state={playing ? "playing" : "paused"}
      aria-label={action}
      title={error ? `${action}: ${error}` : action}
      disabled={busy}
      onClick={onClick}
    >
      {playing ? (
        <Pause size={14} fill="currentColor" strokeWidth={1.5} aria-hidden />
      ) : (
        <Play size={14} fill="currentColor" strokeWidth={1.5} aria-hidden />
      )}
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
  return (
    <>
      <PauseSwitchFace playing={playing} busy={busy} error={error} onClick={onClick} />
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
  const [helpAnchor, setHelpAnchor] = useState<HTMLElement | null>(null);
  const closeHelp = () => setHelpAnchor(null);
  return (
    <header className="station-bar">
      {USAGE_ENABLED ? <UsageHud /> : null}
      <CanvasPicker canvases={canvases} canvasName={canvasName} busy={canvasLoading} authoring={authoring} onOpen={onOpen} onCreate={onCreate} onDelete={onDelete} />
      <CommandBarTrigger canvasName={canvasName} />
      <SaveStatus />
      <CommandGroupBar />
      <div className="station-actions relative ml-auto flex items-center gap-3">
        <UpdateChip />
        <NeedsYouButton />
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
            onClick={() => state$.observabilityOpen.set(!state$.observabilityOpen.peek())}
          >
            <ScrollText size={15} />
          </button>
        ) : null}
        {FLEET_UI_ENABLED && authoring ? (
          <button type="button" className="station-icon-button" aria-label="Open fleet manager" title="Fleet"
            style={{ borderColor: "var(--color-stroke)", color: HUE.steel }}
            onPointerEnter={prefetchFleetChunk}
            onFocus={prefetchFleetChunk}
            onClick={openFleet}>
            <Radar size={15} />
          </button>
        ) : null}
        {HELP_MAP_ENABLED ? (
          <>
            <button type="button" className="station-help-trigger" aria-label="Open interaction help" aria-expanded={helpAnchor !== null} aria-haspopup="dialog" onClick={(event) => setHelpAnchor(helpAnchor ? null : event.currentTarget)}>
              <CircleHelp size={15} />
            </button>
            {helpAnchor ? (
              <Popover anchor={helpAnchor} onClose={closeHelp} label="Interaction help" sides={HELP_SIDES} width={400} className="station-help">
                <CanvasInteractionMap onClose={closeHelp} />
              </Popover>
            ) : null}
          </>
        ) : null}
        <button className="station-icon-button" aria-label="Open settings" style={{ borderColor: "var(--color-stroke)", color: HUE.steel }} title="Settings" onClick={() => openSettings()}>
          <Settings2 size={15} />
        </button>
      </div>
    </header>
  );
}
