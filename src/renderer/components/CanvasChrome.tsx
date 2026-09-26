import { use$ } from "@legendapp/state/react";
import { isCommandCenterAuthoring } from "../lib/canvas-boot";
import { clearGraphFilters, state$ } from "../lib/state";

// EdgeLegend + CanvasHint removed per docs/rts-bottom-bar.md.
// CanvasReadout removed — pure noise.
// UsageHud (station usage rail) lives in the station TopBar — left of the canvas switcher.

function CanvasEmpty({ hasNodes, authoring }: { readonly hasNodes: boolean; readonly authoring: boolean }) {
  if (hasNodes) return null;
  return (
    <div className="field-empty pointer-events-none absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2">
      <div className="field-empty__reticle" aria-hidden><span /><span /><span /><span /></div>
      <div className="field-empty__title">{authoring ? "empty canvas" : "no projected canvas"}</div>
      <div className="field-empty__copy">{authoring ? <>Right-click or click Add item<br />to create your first node.</> : <>This Remote shows Command Center canvases only.<br />Wait for a projection, or author on Command Center.</>}</div>
    </div>
  );
}

function FilterTray() {
  const edgeFilter = use$(state$.edgeFilter);
  if (!edgeFilter) return null;
  return <div className="field-filter-tray absolute left-1/2 top-5 z-20 -translate-x-1/2"><span className="field-filter-tray__label">filters</span>{edgeFilter ? <span className="field-filter-tray__chip field-filter-tray__chip--edge">edge / {edgeFilter}</span> : null}<button type="button" aria-label="Clear all filters" onClick={clearGraphFilters}>clear</button></div>;
}

export function CanvasChrome() {
  const doc = use$(state$.doc);
  const nodes = doc.nodes.filter((node) => node.type !== "group");
  const authoring = isCommandCenterAuthoring(use$(state$.settings.station.role));

  return (
    <>
      <FilterTray />
      <CanvasEmpty hasNodes={nodes.length > 0} authoring={authoring} />
    </>
  );
}
