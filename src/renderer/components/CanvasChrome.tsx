import { use$ } from "@legendapp/state/react";
import { Plus } from "lucide-react";
import { searchText } from "../lib/presentation";
import { clearGraphFilters, state$ } from "../lib/state";

// EdgeLegend + CanvasHint removed per docs/rts-bottom-bar.md.
// CanvasReadout removed — pure noise.
// UsageHud (station usage rail) lives in the station TopBar — left of the canvas switcher.

type EmptyReason = "search" | "flag" | "empty";

function CanvasEmpty({ reason, searchQuery, filterLabel, hasNodes }: { readonly reason?: EmptyReason; readonly searchQuery: string; readonly filterLabel: string; readonly hasNodes: boolean }) {
  if (hasNodes && !reason) return null;
  const isSearch = reason === "search";
  const isFiltered = reason === "flag";
  return (
    <div className="field-empty pointer-events-none absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2">
      <div className="field-empty__reticle"><span /><span /><span /><span /></div>
      <div className="field-empty__eyebrow">{isSearch ? "no matching node" : isFiltered ? "filter returned nothing" : <><Plus size={12} /> awaiting first node</>}</div>
      <div className="field-empty__title">{isSearch || isFiltered ? "canvas quiet" : "empty canvas"}</div>
      <div className="field-empty__copy">{isSearch ? <>No node matches<br /><strong>{searchQuery}</strong>.</> : isFiltered ? <>No nodes matched<br /><strong>{filterLabel}</strong>.</> : <>Double-click anywhere to place a note.<br />This canvas will take shape here.</>}</div>
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
  const searchQuery = use$(state$.searchQuery);
  const nodes = doc.nodes.filter((node) => node.type !== "group");
  const flagFilter = use$(state$.flagFilter);
  const query = searchQuery.trim().toLowerCase();
  const filteredNodes = flagFilter ? nodes.filter((node) => node.ether?.flags?.includes(flagFilter)) : nodes;
  const visibleCount = query ? filteredNodes.filter((node) => searchText(node).includes(query)).length : filteredNodes.length;
  const emptyReason: EmptyReason | undefined = query && visibleCount === 0
    ? "search"
    : flagFilter && filteredNodes.length === 0
      ? "flag"
      : nodes.length === 0
        ? "empty"
        : undefined;
  const filterLabel = emptyReason === "flag" ? flagFilter : "";

  return (
    <>
      <FilterTray />
      <CanvasEmpty reason={emptyReason} searchQuery={searchQuery} filterLabel={filterLabel} hasNodes={nodes.length > 0} />
    </>
  );
}
