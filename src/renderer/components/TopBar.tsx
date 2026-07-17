import { use$, useObservable } from "@legendapp/state/react";
import { useEffect, useRef, useState } from "react";
import { Activity, CircleHelp, FileDown, Plus, RefreshCw, Search, Settings2, Trash2, X } from "lucide-react";
import type { EntitySource } from "@shared/entities";
import type { CanvasSummary } from "@shared/ipc";
import { state$ } from "../lib/state";
import { retrySave } from "../lib/mutations";
import { openSettings } from "../lib/settings-state";
import { HUE, INK, SOURCE_HUE } from "../lib/theme";
import { UsageHud } from "./UsageHud";

const SOURCES: ReadonlyArray<EntitySource> = ["tower", "quasar", "booth", "hermes"];

function SourceDot({ source, active, onClick }: { readonly source: EntitySource; readonly active: boolean; readonly onClick: () => void }) {
  const snapshots = use$(state$.snapshots);
  const bundle = snapshots.bundles.find((b) => b.source === source);
  const ok = bundle?.ok ?? false;
  const hue = ok ? SOURCE_HUE[source] : HUE.crimson;
  const when = bundle ? new Date(bundle.fetchedAt).toLocaleTimeString() : "never";
  return <button type="button" className={`station-source-button${active ? " is-active" : ""}`} aria-label={`${source} connector ${ok ? "fresh" : "stale"}`} aria-haspopup="dialog" aria-expanded={active} style={{ color: ok ? SOURCE_HUE[source] : "#8a8378" }} title={`${source} · ${ok ? "fresh" : "stale"} · ${when}`} onClick={onClick}><span className="size-2 rounded-full" style={{ background: hue, opacity: ok ? 0.9 : 0.5 }} />{source}</button>;
}

// Honest connector health: per-source dot + name + last-fetch detail. Lit when
// fresh, dim when stale/down. It never filters the canvas.
function ConnectorsPopover({ onClose }: { readonly onClose: () => void }) {
  const snapshots = use$(state$.snapshots);
  return <aside className="station-health-popover" role="dialog" aria-label="Connectors">
    <div className="station-health-popover__header"><div><div className="station-health-popover__eyebrow">adapter plane</div><strong>connectors</strong></div><button type="button" aria-label="Close connectors" onClick={onClose}>×</button></div>
    <div className="station-health-popover__list">{SOURCES.map((source) => {
      const bundle = snapshots.bundles.find((item) => item.source === source);
      const ok = bundle?.ok ?? false;
      const fetched = bundle ? new Date(bundle.fetchedAt).toLocaleTimeString() : "never";
      return <div key={source} className="station-health-popover__row"><span className="station-health-popover__name"><i style={{ background: ok ? SOURCE_HUE[source] : HUE.crimson }} />{source}</span><span className={ok ? "station-health-popover__ok" : "station-health-popover__error"}>{ok ? `fresh · ${fetched}` : bundle?.error ?? "stale"}</span></div>;
    })}</div>
  </aside>;
}

function HelpPopover({ onClose }: { readonly onClose: () => void }) {
  const shortcuts = [
    ["/ · ⌘K", "focus search"],
    ["double-click", "add a note"],
    ["drag card", "move a node"],
    ["drag edge dot", "connect nodes (drop anywhere on a card)"],
    ["select + corners", "resize a node"],
    ["click edge", "inspect edge"],
    ["Escape", "close overlays / clear selection"],
  ] as const;
  return <aside className="station-help-popover" role="dialog" aria-label="Interaction help">
    <div className="station-help-popover__header"><div><div className="station-help-popover__eyebrow">canvas protocol</div><strong>interaction map</strong></div><button type="button" aria-label="Close interaction help" onClick={onClose}>×</button></div>
    <div className="station-help-popover__list">{shortcuts.map(([key, action]) => <div className="station-help-popover__row" key={key}><kbd>{key}</kbd><span>{action}</span></div>)}<div className="station-help-popover__row"><kbd>fit all</kbd><span>frame the full graph</span></div></div>
  </aside>;
}

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
        <select
          className="station-select"
          disabled={busy}
          aria-busy={busy}
          aria-label="Active canvas"
          title={busy ? "opening canvas…" : "switch canvas"}
          value={canvasName}
          onChange={(e) => onOpen(e.target.value)}
        >
          {canvases.length === 0 ? <option value="">no canvases</option> : null}
          {canvases.map((canvas) => (
            <option key={canvas.name} value={canvas.name}>
              {canvas.name}
            </option>
          ))}
        </select>
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
  onExport,
  onRefresh,
}: {
  readonly onOpen: (name: string) => void;
  readonly onCreate: (name: string) => void;
  readonly onDelete: (name: string) => void;
  readonly onExport: () => void;
  readonly onRefresh: () => void;
}) {
  const canvases = use$(state$.canvases);
  const canvasName = use$(state$.canvasName);
  const canvasLoading = use$(state$.canvasLoading);
  const refreshing = use$(state$.refreshing);
  const exporting = use$(state$.exporting);
  const [healthOpen, setHealthOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  useEffect(() => {
    if (!healthOpen && !helpOpen) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") { setHealthOpen(false); setHelpOpen(false); } };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && !target.closest(".station-actions")) { setHealthOpen(false); setHelpOpen(false); }
    };
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [healthOpen, helpOpen]);
  return (
    <header className="station-bar">
      <UsageHud />
      <CanvasPicker canvases={canvases} canvasName={canvasName} busy={canvasLoading} onOpen={onOpen} onCreate={onCreate} onDelete={onDelete} />
      <SearchField canvasName={canvasName} />
      <SaveStatus />
      <div className="station-actions relative ml-auto flex items-center gap-3"><div className="station-sources">{SOURCES.map((source) => <SourceDot key={source} source={source} active={healthOpen} onClick={() => { setHelpOpen(false); setHealthOpen((open) => !open); }} />)}</div><button type="button" className="station-health-trigger" aria-label="Open connectors" aria-expanded={healthOpen} aria-haspopup="dialog" onClick={() => { setHelpOpen(false); setHealthOpen((open) => !open); }}><Activity size={14} /></button><button type="button" className="station-help-trigger" aria-label="Open interaction help" aria-expanded={helpOpen} aria-haspopup="dialog" onClick={() => { setHealthOpen(false); setHelpOpen((open) => !open); }}><CircleHelp size={14} /></button>{healthOpen ? <ConnectorsPopover onClose={() => setHealthOpen(false)} /> : null}{helpOpen ? <HelpPopover onClose={() => setHelpOpen(false)} /> : null}<button className="station-icon-button" aria-label="Open settings" style={{ borderColor: "rgba(237,230,218,0.16)", color: HUE.steel }} title="settings" onClick={() => { setHealthOpen(false); setHelpOpen(false); openSettings(); }}><Settings2 size={15} /></button><button className="station-icon-button" disabled={refreshing} aria-label={refreshing ? "Refreshing snapshots" : "Refresh snapshots"} style={{ borderColor: "rgba(237,230,218,0.16)", color: HUE.cyan }} title={refreshing ? "refreshing snapshots" : "refresh snapshots"} onClick={onRefresh}><RefreshCw size={15} className={refreshing ? "station-spin" : ""} /></button><button className="station-digest-button inline-flex items-center gap-2" disabled={exporting} aria-label={exporting ? "Exporting digest" : "Export digest"} style={{ borderColor: "rgba(232,163,61,.35)", color: HUE.amber }} title={exporting ? "exporting digest" : "export digest"} onClick={onExport}><FileDown size={14} className={exporting ? "station-spin" : ""} /><span>{exporting ? "syncing" : "digest"}</span></button></div>
    </header>
  );
}
