import { use$, useObservable } from "@legendapp/state/react";
import { useEffect, useRef, useState } from "react";
import { CircleHelp, Pause, Play, Plus, Radar, Search, Settings2, Trash2, X } from "lucide-react";
import type { CanvasSummary } from "@shared/ipc";
import type { CanvasPauseState } from "@shared/pause";
import { state$ } from "../lib/state";
import { retrySave } from "../lib/mutations";
import { openSettings } from "../lib/settings-state";
import { openFleet, prefetchFleetChunk } from "../lib/fleet-state";
import { GREEN, HUE, INK, withAlpha } from "../lib/theme";
import { Dropdown } from "./ui";
import { CanvasInteractionMap } from "./help/CanvasInteractionMap";
import { FirstPlayConfirm } from "./FirstPlayConfirm";
import { UsageHud } from "./UsageHud";

function CanvasPicker({
  canvases,
  canvasName,
  busy,
  onOpen,
  onCreate,
  onDelete,
}: {
  readonly canvases: ReadonlyArray<CanvasSummary>;
  readonly canvasName: string;
  readonly busy: boolean;
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
          title={busy ? "opening canvas…" : "switch canvas"}
          value={canvasName}
          uppercase
          emptyLabel="no canvases"
          placeholder="select canvas"
          options={canvases.map((canvas) => ({ value: canvas.name, label: canvas.name }))}
          onChange={onOpen}
        />
        {busy ? <span className="station-context__loading" role="status" aria-live="polite">opening</span> : null}
        <button type="button" className="station-canvas__action" disabled={busy} title="new canvas" aria-label="New canvas" onClick={() => createOpen$.set(true)}>
          <Plus size={14} />
        </button>
        <button type="button" className="station-canvas__action station-canvas__action--danger" disabled={busy || !canvasName} title="delete canvas" aria-label="Delete canvas" onClick={openDelete}>
          <Trash2 size={14} />
        </button>
      </div>
      {createOpen ? (
        <div className="canvas-dialog-backdrop" role="presentation" onMouseDown={closeCreate}>
          <form className="canvas-dialog" role="dialog" aria-modal="true" aria-labelledby="canvas-dialog-title" onSubmit={submitCreate} onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Escape") closeCreate(); }}>
            <h2 id="canvas-dialog-title">New canvas</h2>
            <p>Choose a short name for this canvas.</p>
            <label className="canvas-dialog__field">
              <span>name</span>
              <input autoFocus aria-label="Canvas name" value={createName} onChange={(event) => createName$.set(event.target.value)} placeholder="research" />
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
              <button type="button" className="canvas-dialog__cancel" autoFocus onClick={closeDelete}>cancel</button>
              <button type="submit" className="canvas-dialog__danger">delete</button>
            </div>
          </form>
        </div>
      ) : null}
    </>
  );
}

function SearchField({ canvasName }: { readonly canvasName: string }) {
  const value = use$(state$.searchQuery);
  const label = `Search ${canvasName || "portfolio"}`;
  const setSearch = (next: string) => {
    state$.searchQuery.set(next);
    state$.selectedNodeId.set("");
    state$.selectedEdgeId.set("");
  };
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true']")) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
      }
      if (!event.metaKey && !event.ctrlKey && event.key === "/") {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  return <label className="station-search" title="Search nodes · / or ⌘K"><Search size={14} /><input ref={inputRef} aria-label={label} value={value} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setSearch(""); inputRef.current?.blur(); } }} placeholder="search nodes" />{value ? <button type="button" className="station-search__clear" aria-label="Clear search" onClick={() => setSearch("")}><X size={13} /></button> : null}</label>;
}

// Factory pause switch (app-state, main-owned). The canvas is born paused;
// PAUSED is the prominent state, playing stays quiet. First play routes
// through FirstPlayConfirm (everPlayed latch); pausing is always instant.
// State is fetched per canvas switch and refreshed from each write result —
// no push channel (pause flips only through this control today).
function FactoryPauseControl({ canvasName }: { readonly canvasName: string }) {
  const [pauseState, setPauseState] = useState<CanvasPauseState | undefined>(undefined);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPauseState(undefined);
    setConfirmOpen(false);
    setError("");
    if (!canvasName) return;
    let cancelled = false;
    void window.vellum
      ?.factoryPauseState(canvasName)
      .then((state) => {
        if (!cancelled) setPauseState(state);
      })
      .catch(() => {
        // Unreachable backend: leave the control unrendered rather than lie.
      });
    return () => {
      cancelled = true;
    };
  }, [canvasName]);

  if (!canvasName || !pauseState) return null;

  const apply = async (paused: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await window.vellum?.factoryPauseSet(
        canvasName,
        { kind: "canvas" },
        paused,
      );
      if (!result) return;
      if (result.ok) {
        setPauseState(result.state);
        setError("");
      } else {
        setError(result.error);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const onClick = () => {
    if (pauseState.playing) {
      void apply(true); // pausing is always instant
      return;
    }
    if (!pauseState.everPlayed) {
      setConfirmOpen(true);
      return;
    }
    void apply(false);
  };

  const playing = pauseState.playing;
  return (
    <>
      <button
        type="button"
        data-testid="factory-pause"
        data-pause-state={playing ? "playing" : "paused"}
        aria-label={playing ? "Pause factory" : "Play factory"}
        title={
          error
            ? `pause switch: ${error}`
            : playing
              ? "factory playing — click to pause"
              : "factory paused — click to play"
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
          cursor: busy ? "wait" : "pointer",
          border: "1px solid",
          ...(playing
            ? {
                color: GREEN,
                borderColor: withAlpha(GREEN, 0.28),
                background: "rgba(255,255,255,0.02)",
              }
            : {
                color: HUE.amber,
                borderColor: withAlpha(HUE.amber, 0.55),
                background: withAlpha(HUE.amber, 0.12),
                boxShadow: `0 0 0 3px ${withAlpha(HUE.amber, 0.08)}`,
              }),
        }}
      >
        {playing ? <Play size={11} fill="currentColor" /> : <Pause size={11} fill="currentColor" />}
        <span>{playing ? "playing" : "paused"}</span>
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
          onConfirm={() => {
            setConfirmOpen(false);
            void apply(false);
          }}
          onCancel={() => setConfirmOpen(false)}
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
      <UsageHud />
      <CanvasPicker canvases={canvases} canvasName={canvasName} busy={canvasLoading} onOpen={onOpen} onCreate={onCreate} onDelete={onDelete} />
      <SearchField canvasName={canvasName} />
      <SaveStatus />
      <div className="station-actions relative ml-auto flex items-center gap-3">
        <FactoryPauseControl canvasName={canvasName} />
        <button type="button" className="station-icon-button" aria-label="Open fleet manager" title="fleet"
          style={{ borderColor: "rgba(237,230,218,0.16)", color: HUE.steel }}
          onPointerEnter={prefetchFleetChunk}
          onFocus={prefetchFleetChunk}
          onClick={() => { setHelpOpen(false); openFleet(); }}>
          <Radar size={15} />
        </button>
        <button type="button" className="station-help-trigger" aria-label="Open interaction help" aria-expanded={helpOpen} aria-haspopup="dialog" onClick={() => setHelpOpen((open) => !open)}>
          <CircleHelp size={14} />
        </button>
        {helpOpen ? <CanvasInteractionMap onClose={() => setHelpOpen(false)} /> : null}
        <button className="station-icon-button" aria-label="Open settings" style={{ borderColor: "rgba(237,230,218,0.16)", color: HUE.steel }} title="settings" onClick={() => { setHelpOpen(false); openSettings(); }}>
          <Settings2 size={15} />
        </button>
      </div>
    </header>
  );
}
