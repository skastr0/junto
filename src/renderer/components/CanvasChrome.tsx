import { use$ } from "@legendapp/state/react";
import { clearGraphFilters, state$ } from "../lib/state";
import { modelStore } from "../lib/use-model";

// EdgeLegend + CanvasHint removed per docs/rts-bottom-bar.md.
// CanvasReadout removed — pure noise.
// UsageHud (station usage rail) lives in the station TopBar — left of the canvas switcher.

function CanvasEmpty({ hasNodes }: { readonly hasNodes: boolean }) {
  if (hasNodes) return null;
  return (
    <div className="field-empty pointer-events-none absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2">
      <div className="field-empty__reticle" aria-hidden><span /><span /><span /><span /></div>
      <div className="field-empty__title">empty canvas</div>
      <div className="field-empty__copy">Right-click or click Add item<br />to create your first node.</div>
    </div>
  );
}

function FilterTray() {
  const edgeFilter = use$(state$.edgeFilter);
  if (!edgeFilter) return null;
  return <div className="field-filter-tray absolute left-1/2 top-5 z-20 -translate-x-1/2"><span className="field-filter-tray__label">filters</span>{edgeFilter ? <span className="field-filter-tray__chip field-filter-tray__chip--edge">edge / {edgeFilter}</span> : null}<button type="button" aria-label="Clear all filters" onClick={clearGraphFilters}>clear</button></div>;
}

export function CanvasChrome() {
  // Whether anything but a region is on the canvas. A node's kind never
  // changes, so only the list of ids is followed.
  const hasNodes = use$(() => {
    const canvas = state$.canvasName.get();
    return modelStore.canvas$(canvas).nodeIds.get().some((id) => modelStore.node$(canvas, id).peek()?.kind !== "region");
  });

  return (
    <>
      <FilterTray />
      <CanvasEmpty hasNodes={hasNodes} />
    </>
  );
}
