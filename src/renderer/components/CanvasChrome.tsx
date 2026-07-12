import { use$ } from "@legendapp/state/react";
import { CircleDot, Link2, MousePointer2, Plus } from "lucide-react";
import type { EtherEdgeKind, EtherFlag } from "@shared/canvas";
import { searchText } from "../lib/presentation";
import { clearGraphFilters, state$, toggleFlagFilter } from "../lib/state";
import { HUE } from "../lib/theme";

function CanvasReadout({ name, countLabel, edges, regions }: { readonly name: string; readonly countLabel: string; readonly edges: number; readonly regions: number }) {
  return (
    <div className="field-readout pointer-events-none absolute left-5 top-5 z-20 hidden w-[230px] md:block">
      <div className="field-readout__eyebrow"><span className="field-readout__signal" />canvas</div>
      <div className="field-readout__title">{name || "portfolio"}</div>
      <div className="field-readout__rule" />
      <div className="field-readout__stats">
        <span><strong>{countLabel}</strong> nodes</span>
        <span><strong>{edges.toString().padStart(2, "0")}</strong> edges</span>
        <span><strong>{regions.toString().padStart(2, "0")}</strong> regions</span>
      </div>
    </div>
  );
}

const EDGE_ITEMS: ReadonlyArray<{ readonly kind: EtherEdgeKind; readonly label: string; readonly lineClass: string }> = [
  { kind: "depends", label: "depends", lineClass: "field-legend__line--amber" },
  { kind: "blocks", label: "blocks", lineClass: "field-legend__line--crimson" },
  { kind: "relates", label: "relates", lineClass: "field-legend__line--steel" },
];

function EdgeLegend() {
  const edgeFilter = use$(state$.edgeFilter);
  const toggleFilter = (kind: EtherEdgeKind) => {
    state$.edgeFilter.set(edgeFilter === kind ? "" : kind);
    state$.selectedEdgeId.set("");
  };
  return (
    <div className="field-legend pointer-events-auto absolute bottom-5 left-5 z-20 hidden items-center gap-3 md:flex">
      <span className="field-legend__title"><CircleDot size={12} /> graph key</span>
      {EDGE_ITEMS.map(({ kind, label, lineClass }) => <button key={kind} type="button" className={`field-legend__item field-legend__item--button${edgeFilter === kind ? " is-active" : ""}`} aria-label={`Show ${label} edges`} aria-pressed={edgeFilter === kind} title={`filter ${label} edges`} onClick={() => toggleFilter(kind)}><i className={`field-legend__line ${lineClass}`} />{label}</button>)}
      {edgeFilter ? <button type="button" className="field-legend__clear" aria-label="Show all edges" onClick={() => { state$.edgeFilter.set(""); state$.selectedEdgeId.set(""); }}>all</button> : null}
    </div>
  );
}

const FLAG_ITEMS: ReadonlyArray<{ readonly flag: EtherFlag; readonly label: string; readonly hue: string }> = [
  { flag: "blocker", label: "blocker", hue: HUE.crimson },
  { flag: "attention", label: "attention", hue: HUE.amber },
  { flag: "parked", label: "parked", hue: HUE.violet },
];

function CanvasHint({ counts }: { readonly counts: Readonly<Record<EtherFlag, number>> }) {
  const flagFilter = use$(state$.flagFilter);
  return (
    <div className="field-hint pointer-events-auto absolute bottom-5 right-5 z-20 hidden items-center gap-2 md:flex">
      <MousePointer2 size={12} /><span>double-click add · drag to move</span><Link2 size={12} /><span className="field-hint__secondary">drag an edge dot to connect</span>
      <div className="field-hint__filters">{FLAG_ITEMS.map(({ flag, label, hue }) => counts[flag] > 0 ? <button key={flag} type="button" className={`field-hint__flag${flagFilter === flag ? " is-active" : ""}`} aria-label={`Show ${label} nodes`} aria-pressed={flagFilter === flag} style={{ color: hue }} onClick={() => toggleFlagFilter(flag)}>{counts[flag]} {label}</button> : null)}{flagFilter ? <button type="button" className="field-hint__clear" aria-label="Show all flags" onClick={() => { state$.flagFilter.set(""); state$.selectedNodeId.set(""); state$.selectedEdgeId.set(""); }}>all</button> : null}</div>
    </div>
  );
}

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
  const name = use$(state$.canvasName);
  const searchQuery = use$(state$.searchQuery);
  const nodes = doc.nodes.filter((node) => node.type !== "group");
  const regions = doc.nodes.filter((node) => node.type === "group");
  const edgeFilter = use$(state$.edgeFilter);
  const flagFilter = use$(state$.flagFilter);
  const query = searchQuery.trim().toLowerCase();
  const flagCounts = FLAG_ITEMS.reduce((counts, { flag }) => { counts[flag] = nodes.filter((node) => node.ether?.flags?.includes(flag)).length; return counts; }, { blocker: 0, attention: 0, parked: 0 } as Record<EtherFlag, number>);
  const filteredNodes = flagFilter ? nodes.filter((node) => node.ether?.flags?.includes(flagFilter)) : nodes;
  const visibleCount = query ? filteredNodes.filter((node) => searchText(node).includes(query)).length : filteredNodes.length;
  const countLabel = query ? `${visibleCount.toString().padStart(2, "0")} / ${nodes.length.toString().padStart(2, "0")}` : visibleCount.toString().padStart(2, "0");
  const visibleIds = new Set(filteredNodes.map((node) => node.id));
  const visibleEdges = doc.edges.filter((edge) => visibleIds.has(edge.fromNode) && visibleIds.has(edge.toNode) && (!edgeFilter || (edge.ether?.kind ?? "relates") === edgeFilter)).length;
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
      <CanvasReadout name={name} countLabel={countLabel} edges={visibleEdges} regions={regions.length} />
      <EdgeLegend />
      <CanvasHint counts={flagCounts} />
      <FilterTray />
      <CanvasEmpty reason={emptyReason} searchQuery={searchQuery} filterLabel={filterLabel} hasNodes={nodes.length > 0} />
    </>
  );
}
