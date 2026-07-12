import { use$ } from "@legendapp/state/react";
import { Activity, CircleDot, Link2, MousePointer2, Plus } from "lucide-react";
import type { EntitySource } from "@shared/entities";
import type { EtherEdgeKind, EtherFlag } from "@shared/canvas";
import type { SnapshotState } from "@shared/entities";
import { searchText } from "../lib/presentation";
import { clearGraphFilters, state$, toggleFlagFilter, toggleSourceFilter } from "../lib/state";
import { DIM, HUE, SOURCE_HUE } from "../lib/theme";

const SOURCES = ["tower", "quasar", "booth", "hermes"] as const;

function FieldReadout({ name, countLabel, links, regions }: { readonly name: string; readonly countLabel: string; readonly links: number; readonly regions: number }) {
  return (
    <div className="field-readout pointer-events-none absolute left-5 top-5 z-20 hidden w-[230px] md:block">
      <div className="field-readout__eyebrow"><span className="field-readout__signal" />live surface / 01</div>
      <div className="field-readout__title">{name || "portfolio"}</div>
      <div className="field-readout__meta">{name || "portfolio"} field · spatial document</div>
      <div className="field-readout__rule" />
      <div className="field-readout__stats">
        <span><strong>{countLabel}</strong> nodes</span>
        <span><strong>{links.toString().padStart(2, "0")}</strong> links</span>
        <span><strong>{regions.toString().padStart(2, "0")}</strong> regions</span>
      </div>
    </div>
  );
}

function FieldStatus({ snapshots }: { readonly snapshots: SnapshotState }) {
  const sourceFilter = use$(state$.sourceFilter);
  return (
    <div className="field-status pointer-events-auto absolute right-5 top-5 z-20 hidden items-center gap-3 lg:flex">
      <span className="field-status__label"><Activity size={13} /> signal integrity</span>
      <div className="field-status__sources">
        {SOURCES.map((source) => {
          const ok = snapshots.bundles.find((item) => item.source === source)?.ok ?? false;
          return <button key={source} type="button" className={`field-status__source${sourceFilter === source ? " is-active" : ""}`} aria-label={`Show ${source} signals`} aria-pressed={sourceFilter === source} title={`filter ${source} signals`} style={{ color: ok ? SOURCE_HUE[source] : DIM }} onClick={() => toggleSourceFilter(source)}><span className="field-status__dot" style={{ background: ok ? SOURCE_HUE[source] : DIM }} />{source}</button>;
        })}
        {sourceFilter ? <button type="button" className="field-status__clear" aria-label="Show all sources" onClick={() => { state$.sourceFilter.set(""); state$.selectedNodeId.set(""); state$.selectedEdgeId.set(""); }}>all</button> : null}
      </div>
    </div>
  );
}

const EDGE_ITEMS: ReadonlyArray<{ readonly kind: EtherEdgeKind; readonly label: string; readonly lineClass: string }> = [
  { kind: "depends", label: "depends", lineClass: "field-legend__line--amber" },
  { kind: "blocks", label: "blocks", lineClass: "field-legend__line--crimson" },
  { kind: "relates", label: "relates", lineClass: "field-legend__line--steel" },
];

function FieldLegend() {
  const edgeFilter = use$(state$.edgeFilter);
  const toggleFilter = (kind: EtherEdgeKind) => {
    state$.edgeFilter.set(edgeFilter === kind ? "" : kind);
    state$.selectedEdgeId.set("");
  };
  return (
    <div className="field-legend pointer-events-auto absolute bottom-5 left-5 z-20 hidden items-center gap-3 md:flex">
      <span className="field-legend__title"><CircleDot size={12} /> graph key</span>
      {EDGE_ITEMS.map(({ kind, label, lineClass }) => <button key={kind} type="button" className={`field-legend__item field-legend__item--button${edgeFilter === kind ? " is-active" : ""}`} aria-label={`Show ${label} relations`} aria-pressed={edgeFilter === kind} title={`filter ${label} relations`} onClick={() => toggleFilter(kind)}><i className={`field-legend__line ${lineClass}`} />{label}</button>)}
      {edgeFilter ? <button type="button" className="field-legend__clear" aria-label="Show all relations" onClick={() => { state$.edgeFilter.set(""); state$.selectedEdgeId.set(""); }}>all</button> : null}
    </div>
  );
}

const FLAG_ITEMS: ReadonlyArray<{ readonly flag: EtherFlag; readonly label: string; readonly hue: string }> = [
  { flag: "blocker", label: "blocker", hue: HUE.crimson },
  { flag: "attention", label: "attention", hue: HUE.amber },
  { flag: "parked", label: "parked", hue: HUE.violet },
];

function FieldHint({ counts }: { readonly counts: Readonly<Record<EtherFlag, number>> }) {
  const flagFilter = use$(state$.flagFilter);
  return (
    <div className="field-hint pointer-events-auto absolute bottom-5 right-5 z-20 hidden items-center gap-2 md:flex">
      <MousePointer2 size={12} /><span>double-click add · drag to move · connect in inspector</span><Link2 size={12} /><span className="field-hint__secondary">select edge · delete</span>
      <div className="field-hint__filters">{FLAG_ITEMS.map(({ flag, label, hue }) => counts[flag] > 0 ? <button key={flag} type="button" className={`field-hint__flag${flagFilter === flag ? " is-active" : ""}`} aria-label={`Show ${label} signals`} aria-pressed={flagFilter === flag} style={{ color: hue }} onClick={() => toggleFlagFilter(flag)}>{counts[flag]} {label}</button> : null)}{flagFilter ? <button type="button" className="field-hint__clear" aria-label="Show all flags" onClick={() => { state$.flagFilter.set(""); state$.selectedNodeId.set(""); state$.selectedEdgeId.set(""); }}>all</button> : null}</div>
    </div>
  );
}

type EmptyReason = "search" | "source" | "flag" | "empty";

function FieldEmpty({ reason, searchQuery, filterLabel, hasNodes }: { readonly reason?: EmptyReason; readonly searchQuery: string; readonly filterLabel: string; readonly hasNodes: boolean }) {
  if (hasNodes && !reason) return null;
  const isSearch = reason === "search";
  const isFiltered = reason === "source" || reason === "flag";
  return (
    <div className="field-empty pointer-events-none absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2">
      <div className="field-empty__reticle"><span /><span /><span /><span /></div>
      <div className="field-empty__eyebrow">{isSearch ? "no matching signal" : isFiltered ? <><Activity size={12} /> filter returned no signal</> : <><Plus size={12} /> awaiting first signal</>}</div>
      <div className="field-empty__title">{isSearch || isFiltered ? "field quiet" : "empty field"}</div>
      <div className="field-empty__copy">{isSearch ? <>No project, source, or entity matches<br /><strong>{searchQuery}</strong>.</> : isFiltered ? <>No signals matched<br /><strong>{filterLabel}</strong>.</> : <>Double-click anywhere to place a note.<br />This field will take shape here.</>}</div>
      {isFiltered ? <button type="button" className="field-empty__clear pointer-events-auto" aria-label="Clear filters" onClick={clearGraphFilters}>clear filters</button> : null}
    </div>
  );
}

function FieldDensityWarning({ count }: { readonly count: number }) {
  return <div className="field-density-warning absolute left-1/2 top-5 z-20 -translate-x-1/2"><span><strong>{count}</strong> signals in field</span><button type="button" aria-label="Open manifest view" title="open manifest view" onClick={() => state$.viewMode.set("manifest")}><CircleDot size={12} />open manifest</button></div>;
}

function FilterTray() {
  const edgeFilter = use$(state$.edgeFilter);
  const sourceFilter = use$(state$.sourceFilter);
  const flagFilter = use$(state$.flagFilter);
  if (!edgeFilter && !sourceFilter && !flagFilter) return null;
  return <div className="field-filter-tray absolute left-1/2 top-5 z-20 -translate-x-1/2"><span className="field-filter-tray__label">filters</span>{sourceFilter ? <span className="field-filter-tray__chip field-filter-tray__chip--source">source / {sourceFilter}</span> : null}{edgeFilter ? <span className="field-filter-tray__chip field-filter-tray__chip--edge">relation / {edgeFilter}</span> : null}{flagFilter ? <span className="field-filter-tray__chip field-filter-tray__chip--flag">flag / {flagFilter}</span> : null}<button type="button" aria-label="Clear all filters" onClick={clearGraphFilters}>clear</button></div>;
}

export function FieldChrome() {
  const doc = use$(state$.doc);
  const snapshots = use$(state$.snapshots);
  const name = use$(state$.canvasName);
  const searchQuery = use$(state$.searchQuery);
  const nodes = doc.nodes.filter((node) => node.type !== "group");
  const regions = doc.nodes.filter((node) => node.type === "group");
  const sourceFilter = use$(state$.sourceFilter);
  const edgeFilter = use$(state$.edgeFilter);
  const flagFilter = use$(state$.flagFilter);
  const query = searchQuery.trim().toLowerCase();
  const sourceNodes = sourceFilter ? nodes.filter((node) => node.ether?.bindings?.some((binding) => binding.source === sourceFilter)) : nodes;
  const flagCounts = FLAG_ITEMS.reduce((counts, { flag }) => { counts[flag] = sourceNodes.filter((node) => node.ether?.flags?.includes(flag)).length; return counts; }, { blocker: 0, attention: 0, parked: 0 } as Record<EtherFlag, number>);
  const filteredNodes = flagFilter ? sourceNodes.filter((node) => node.ether?.flags?.includes(flagFilter)) : sourceNodes;
  const visibleCount = query ? filteredNodes.filter((node) => searchText(node).includes(query)).length : filteredNodes.length;
  const countLabel = query ? `${visibleCount.toString().padStart(2, "0")} / ${sourceNodes.length.toString().padStart(2, "0")}` : visibleCount.toString().padStart(2, "0");
  const visibleIds = new Set(filteredNodes.map((node) => node.id));
  const visibleLinks = doc.edges.filter((edge) => visibleIds.has(edge.fromNode) && visibleIds.has(edge.toNode) && (!edgeFilter || (edge.ether?.kind ?? "relates") === edgeFilter)).length;
  const emptyReason: EmptyReason | undefined = query && visibleCount === 0
    ? "search"
    : sourceFilter && sourceNodes.length === 0
      ? "source"
      : flagFilter && filteredNodes.length === 0
        ? "flag"
        : nodes.length === 0
          ? "empty"
          : undefined;
  const filterLabel = emptyReason === "source" ? sourceFilter : emptyReason === "flag" ? flagFilter : "";

  return (
    <>
      <FieldReadout name={name} countLabel={countLabel} links={visibleLinks} regions={regions.length} />
      <FieldStatus snapshots={snapshots} />
      <FieldLegend />
      <FieldHint counts={flagCounts} />
      <FilterTray />
      {nodes.length > 180 && !query && !edgeFilter && !sourceFilter && !flagFilter ? <FieldDensityWarning count={nodes.length} /> : null}
      <FieldEmpty reason={emptyReason} searchQuery={searchQuery} filterLabel={filterLabel} hasNodes={nodes.length > 0} />
    </>
  );
}
