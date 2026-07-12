import { ArrowUpRight, FolderOpen, Radio, ShieldAlert } from "lucide-react";
import { use$ } from "@legendapp/state/react";
import { useState } from "react";
import { state$ } from "../lib/state";
import { EntityBadges } from "./EntityBadges";
import { nodeDetail, nodeTitle, searchText } from "../lib/presentation";

type ManifestFilter = "all" | "projects" | "notes" | "files" | "links" | "flagged";

const FILTERS: ReadonlyArray<{ readonly value: ManifestFilter; readonly label: string }> = [
  { value: "all", label: "all" },
  { value: "projects", label: "projects" },
  { value: "notes", label: "notes" },
  { value: "files", label: "files" },
  { value: "links", label: "links" },
  { value: "flagged", label: "flagged" },
];

export function ManifestPanel() {
  const doc = use$(state$.doc);
  const query = use$(state$.searchQuery).trim().toLowerCase();
  const [filter, setFilter] = useState<ManifestFilter>("all");
  const nodes = doc.nodes.filter((node) => node.type !== "group");
  const typed = nodes.filter((node) => {
    if (filter === "all") return true;
    if (filter === "projects") return node.ether?.entity?.kind === "project";
    if (filter === "notes") return node.type === "text";
    if (filter === "files") return node.type === "file";
    if (filter === "links") return node.type === "link";
    return (node.ether?.flags?.length ?? 0) > 0;
  });
  const visible = typed.filter((node) => !query || searchText(node).includes(query));
  const filterLabel = FILTERS.find((item) => item.value === filter)?.label ?? "all";
  const summary = query
    ? `${visible.length} matching ${filter === "all" ? "signals" : filterLabel}`
    : filter === "all"
      ? `${nodes.length} signals across the current canvas`
      : `${visible.length} ${filterLabel} across the current canvas`;

  return (
    <main className="manifest-shell">
      <div className="manifest-header">
        <div>
          <div className="manifest-eyebrow"><Radio size={12} /> corpus manifest / live projection</div>
          <h1>Project index</h1>
          <p>{summary}</p>
        </div>
        <div className="manifest-header__meta">
          <span><strong>{doc.edges.length.toString().padStart(2, "0")}</strong> links</span>
          <span><strong>{doc.nodes.filter((node) => node.type === "group").length.toString().padStart(2, "0")}</strong> regions</span>
        </div>
      </div>

      <div className="manifest-toolbar" role="toolbar" aria-label="Manifest filters">
        <span className="manifest-toolbar__label">show</span>
        {FILTERS.map(({ value, label }) => {
          const count = value === "all"
            ? nodes.length
            : value === "projects"
              ? nodes.filter((node) => node.ether?.entity?.kind === "project").length
              : value === "notes"
                ? nodes.filter((node) => node.type === "text").length
                : value === "files"
                  ? nodes.filter((node) => node.type === "file").length
                  : value === "links"
                    ? nodes.filter((node) => node.type === "link").length
                    : nodes.filter((node) => (node.ether?.flags?.length ?? 0) > 0).length;
          return <button key={value} type="button" className={`manifest-filter${filter === value ? " is-active" : ""}`} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}<strong>{count}</strong></button>;
        })}
        {query ? <span className="manifest-toolbar__query">query / {query}</span> : null}
      </div>

      {visible.length === 0 ? (
        <div className="manifest-empty">
          <FolderOpen size={22} />
          <strong>no matching signals</strong>
          <span>Try a project name, source, or binding key.</span>
        </div>
      ) : (
        <div className="manifest-grid">
          {visible.map((node, index) => {
            const flags = node.ether?.flags ?? [];
            const isBlocker = flags.includes("blocker");
            const focusInField = () => {
              state$.searchQuery.set("");
              state$.edgeFilter.set("");
              state$.sourceFilter.set("");
              state$.flagFilter.set("");
              state$.viewMode.set("field");
              window.setTimeout(() => {
                state$.selectedNodeId.set(node.id);
                state$.focusNodeId.set(node.id);
              }, 0);
            };
            return (
              <button
                key={node.id}
                className="manifest-card"
                aria-label={`Focus ${nodeTitle(node)} in field`}
                onPointerDown={(event) => {
                  event.stopPropagation();
                }}
                onClick={(event) => { event.stopPropagation(); focusInField(); }}
              >
                <div className="manifest-card__topline">
                  <span className="manifest-card__index">{String(index + 1).padStart(2, "0")}</span>
                  <span className="manifest-card__kind">{node.ether?.entity?.kind ?? node.type}</span>
                  {isBlocker ? <ShieldAlert size={13} className="manifest-card__blocker" /> : flags.includes("attention") ? <span className="manifest-card__flag manifest-card__flag--attention">attention</span> : flags.includes("parked") ? <span className="manifest-card__flag manifest-card__flag--parked">parked</span> : null}
                  <ArrowUpRight size={13} className="manifest-card__arrow" />
                </div>
                <div className="manifest-card__title">{nodeTitle(node)}</div>
                <div className="manifest-card__detail">{nodeDetail(node)}</div>
                {node.ether?.entity ? (
                  <EntityBadges entity={node.ether.entity} bindings={node.ether.bindings} interactive={false} />
                ) : null}
              </button>
            );
          })}
        </div>
      )}
    </main>
  );
}
