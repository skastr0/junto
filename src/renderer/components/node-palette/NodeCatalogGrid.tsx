import { useMemo } from "react";
import {
  Archive,
  Blocks,
  FileText,
  GitBranch,
  Globe2,
  PanelTop,
  SquareDashed,
  SquareTerminal,
  Type,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import {
  ARTIFACTS_ENABLED,
  BROWSER_ENABLED,
  TASKS_ENABLED,
} from "@shared/features";
import { fuzzyMatch } from "../../lib/fuzzy-match";
import { PickerCard, PickerCardGrid } from "../ui";

export type NodeCatalogCategory = "shell" | "sinks" | "canvas";

/**
 * Catalog color is semantic: every node inherits the hue of its category.
 * Keep crimson out of this map; it is reserved for live blocker attention.
 */
export const NODE_CATALOG_CATEGORY_ACCENT: Readonly<Record<NodeCatalogCategory, string>> = {
  shell: "text-cyan",
  sinks: "text-amber",
  canvas: "text-indigo",
};

/**
 * The presentation contract between the palette shell and its catalog.  The
 * shell can replace the defaults as product descriptions become richer.
 */
export type NodeCatalogEntry = {
  readonly id: string;
  readonly category: NodeCatalogCategory;
  readonly label: string;
  readonly icon: LucideIcon;
  /** The node's own one-line description, shown on its card. */
  readonly purpose: string;
};

export const DEFAULT_NODE_CATALOG_ENTRIES: readonly NodeCatalogEntry[] = [
  {
    id: "terminal", category: "shell", label: "Terminal",
    icon: SquareTerminal,
    purpose: "A shell on the selected machine for commands, logs, and hands-on work.",
  },
  ...(TASKS_ENABLED ? [{
    id: "tasks", category: "sinks", label: "Tasks",
    icon: Blocks,
    purpose: "A work queue. Connected agents pick up tasks and turn in finished work.",
  } satisfies NodeCatalogEntry] : []),
  ...(ARTIFACTS_ENABLED ? [{
    id: "artifacts", category: "sinks", label: "Artifacts",
    icon: Archive,
    purpose: "A shelf for finished outputs: files, results, and proof of work.",
  } satisfies NodeCatalogEntry] : []),
  {
    id: "automations", category: "sinks", label: "Automations",
    icon: Workflow,
    purpose: "Schedules and triggers that mail seats and file tasks in this region.",
  },
  {
    id: "git", category: "sinks", label: "Git",
    icon: GitBranch,
    purpose: "Browse commits and diffs for a repository on this machine.",
  },
  ...(BROWSER_ENABLED ? [{
    id: "page", category: "canvas", label: "Page",
    icon: Globe2,
    purpose: "A browser page that lives on the canvas.",
  } satisfies NodeCatalogEntry] : []),
  {
    id: "note", category: "canvas", label: "Note",
    icon: FileText,
    purpose: "Freeform text placed beside the work it explains.",
  },
  {
    id: "label", category: "canvas", label: "Label",
    icon: Type,
    purpose: "Bare text on the map. Name an area without a card, box, or connectors.",
  },
  {
    id: "region", category: "canvas", label: "Region",
    icon: SquareDashed,
    purpose: "A named area that groups related work and can carry a briefing.",
  },
];

export type NodeCatalogGridProps = {
  readonly query?: string;
  readonly category?: NodeCatalogCategory | "all";
  readonly entries?: readonly NodeCatalogEntry[];
  readonly onSelect: (entry: NodeCatalogEntry) => void;
  readonly className?: string;
};

/** Identity fields rank fuzzily; the description is substring-only. */
export const catalogMatchesQuery = (
  entry: NodeCatalogEntry,
  query: string,
): boolean => {
  if (!query.trim()) return true;
  return fuzzyMatch(query, {
    identity: [entry.label, entry.id, entry.category],
    metadata: [entry.purpose],
  }) !== null;
};

const matchesQuery = catalogMatchesQuery;

export function NodeCatalogGrid({
  query = "",
  category = "all",
  entries = DEFAULT_NODE_CATALOG_ENTRIES,
  onSelect,
  className = "",
}: NodeCatalogGridProps) {
  const visibleEntries = useMemo(
    () => entries.filter((entry) => (category === "all" || entry.category === category) && matchesQuery(entry, query)),
    [category, entries, query],
  );

  return (
    <section
      aria-label="Node catalog"
      className={`node-deck-catalog min-h-0 ${className}`}
    >
      {visibleEntries.length > 0 ? (
        <PickerCardGrid className="node-deck-catalog__grid">
          {visibleEntries.map((entry) => {
            const Icon = entry.icon;
            return (
              <PickerCard
                key={entry.id}
                kind="catalog"
                art={
                  <Icon
                    aria-hidden="true"
                    size={26}
                    strokeWidth={1.7}
                    className={NODE_CATALOG_CATEGORY_ACCENT[entry.category]}
                  />
                }
                title={entry.label}
                body={entry.purpose}
                onActivate={() => onSelect(entry)}
              />
            );
          })}
        </PickerCardGrid>
      ) : (
        <div
          className="node-deck-catalog__empty border border-dashed border-stroke px-4 py-10 text-center font-mono text-[11px] text-dim"
          role="status"
        >
          No catalog entries match this view.
        </div>
      )}
    </section>
  );
}
