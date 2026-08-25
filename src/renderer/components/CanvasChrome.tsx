import { use$ } from "@legendapp/state/react";
import { isCommandCenterAuthoring } from "../lib/canvas-boot";
import { clearGraphFilters, state$ } from "../lib/state";

// EdgeLegend + CanvasHint removed per docs/rts-bottom-bar.md.
// CanvasReadout removed — pure noise.
// UsageHud (station usage rail) lives in the station TopBar — left of the canvas switcher.

type EmptyReason = "flag" | "empty";

function CanvasEmpty({ reason, filterLabel, hasNodes, authoring }: { readonly reason?: EmptyReason; readonly filterLabel: string; readonly hasNodes: boolean; readonly authoring: boolean }) {
  if (hasNodes && !reason) return null;
  const isFiltered = reason === "flag";
  return (
    <div className="field-empty pointer-events-none absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2">
      <div className="field-empty__reticle" aria-hidden><span /><span /><span /><span /></div>
      {isFiltered ? (
        <div className="field-empty__eyebrow">filter returned nothing</div>
      ) : null}
      <div className="field-empty__title">{isFiltered ? "canvas quiet" : authoring ? "empty canvas" : "no projected canvas"}</div>
      <div className="field-empty__copy">{isFiltered ? <>No nodes matched<br /><strong>{filterLabel}</strong>.</> : authoring ? <>Right-click or click Add item<br />to create your first node.</> : <>This Remote shows Command Center canvases only.<br />Wait for a projection, or author on Command Center.</>}</div>
      {isFiltered ? <button type="button" className="field-empty__clear pointer-events-auto" aria-label="Clear filters" onClick={clearGraphFilters}>clear filters</button> : null}
    </div>
  );
}

function FilterTray() {
  const edgeFilter = use$(state$.edgeFilter);
  const flagFilter = use$(state$.flagFilter);
  if (!edgeFilter && !flagFilter) return null;
  return <div className="field-filter-tray absolute left-1/2 top-5 z-20 -translate-x-1/2"><span className="field-filter-tray__label">filters</span>{edgeFilter ? <span className="field-filter-tray__chip field-filter-tray__chip--edge">edge / {edgeFilter}</span> : null}{flagFilter ? <span className="field-filter-tray__chip field-filter-tray__chip--flag">flag / {flagFilter}</span> : null}<button type="button" aria-label="Clear all filters" onClick={clearGraphFilters}>clear</button></div>;
}

export function CanvasChrome() {
  const doc = use$(state$.doc);
  const nodes = doc.nodes.filter((node) => node.type !== "group");
  const flagFilter = use$(state$.flagFilter);
  const filteredNodes = flagFilter ? nodes.filter((node) => node.ether?.flags?.includes(flagFilter)) : nodes;
  const emptyReason: EmptyReason | undefined = flagFilter && filteredNodes.length === 0
    ? "flag"
    : nodes.length === 0
      ? "empty"
      : undefined;
  const filterLabel = emptyReason === "flag" ? flagFilter : "";
  const authoring = isCommandCenterAuthoring(use$(state$.settings.station.role));

  return (
    <>
      <FilterTray />
      <CanvasEmpty reason={emptyReason} filterLabel={filterLabel} hasNodes={nodes.length > 0} authoring={authoring} />
    </>
  );
}
