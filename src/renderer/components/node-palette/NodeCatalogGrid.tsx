import { useMemo } from "react";
import {
  Archive,
  Blocks,
  Braces,
  Clock3,
  FileText,
  GitBranch,
  Globe2,
  Inbox,
  PanelTop,
  PenLine,
  SquareDashed,
  SquareTerminal,
  Table,
  Type,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import {
  ARTIFACTS_ENABLED,
  BOARD_ENABLED,
  BROWSER_ENABLED,
  CRON_ENABLED,
  PAD_ENABLED,
  RELAY_ENABLED,
  REQUESTS_ENABLED,
  SHEET_ENABLED,
  TASKS_ENABLED,
} from "@shared/features";
import { fuzzyMatch } from "../../lib/fuzzy-match";

export type NodeCatalogCategory = "shell" | "sinks" | "schedule" | "canvas";

/**
 * Catalog color is semantic: every node inherits the hue of its category.
 * Keep crimson out of this map; it is reserved for live blocker attention.
 */
export const NODE_CATALOG_CATEGORY_ACCENT: Readonly<Record<NodeCatalogCategory, string>> = {
  shell: "text-cyan",
  sinks: "text-amber",
  schedule: "text-violet",
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
  ...(REQUESTS_ENABLED ? [{
    id: "requests", category: "sinks", label: "Requests",
    icon: Inbox,
    purpose: "Questions from agents that only you can answer.",
  } satisfies NodeCatalogEntry] : []),
  ...(ARTIFACTS_ENABLED ? [{
    id: "artifacts", category: "sinks", label: "Artifacts",
    icon: Archive,
    purpose: "A shelf for finished outputs: files, results, and proof of work.",
  } satisfies NodeCatalogEntry] : []),
  ...(BOARD_ENABLED ? [{
    id: "board", category: "sinks", label: "Board",
    icon: Braces,
    purpose: "A shared board for topics, updates, and decisions.",
  } satisfies NodeCatalogEntry] : []),
  ...(PAD_ENABLED ? [{
    id: "pad", category: "sinks", label: "Pad",
    icon: PenLine,
    purpose: "A shared page. You mark; connected agents read the same page and patch boxes and pins.",
  } satisfies NodeCatalogEntry] : []),
  ...(SHEET_ENABLED ? [{
    id: "sheet", category: "sinks", label: "Sheet",
    icon: Table,
    purpose: "Jot numbers and names in rows and columns beside the work. Connected agents can read it.",
  } satisfies NodeCatalogEntry] : []),
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
  ...(CRON_ENABLED ? [{
    id: "cron", category: "schedule", label: "Cron",
    icon: Clock3,
    purpose: "Fires on a schedule to add tasks or wake agents automatically.",
  } satisfies NodeCatalogEntry] : []),
  // Gauge (hermes stat_threshold) is product-hidden and not a product peer of
  // cron/relay. Hermes = fleet join, not automation. Future external-input
  // actuator (webhook / poll) is a new surface — not “fix this hermes stub.”
  ...(RELAY_ENABLED ? [{
    id: "relay", category: "schedule", label: "Relay",
    icon: Workflow,
    purpose: "Watches a connected node and acts when something happens.",
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
        <ul className="node-deck-catalog__grid grid grid-cols-1 gap-2 p-1 sm:grid-cols-2" role="list">
          {visibleEntries.map((entry) => {
            const Icon = entry.icon;
            const accentClass = NODE_CATALOG_CATEGORY_ACCENT[entry.category];
            return (
              <li key={entry.id} className="node-deck-catalog__item min-w-0">
                <button
                  type="button"
                  className="node-deck-catalog__card group flex min-h-[76px] w-full items-start gap-3 rounded-[7px] border border-stroke px-3 py-3 text-left outline-none transition-[border-color,background-color] duration-150 hover:border-stroke-hi focus-visible:border-amber focus-visible:ring-1 focus-visible:ring-amber/60"
                  onClick={() => onSelect(entry)}
                >
                  <Icon aria-hidden="true" size={23} strokeWidth={1.7} className={`node-deck-catalog__icon mt-0.5 shrink-0 ${accentClass}`} />
                  <span className="node-deck-catalog__summary min-w-0">
                    <span className="node-deck-catalog__label block font-mono text-[15px] font-semibold leading-none text-ink">
                      {entry.label}
                    </span>
                    <span className="node-deck-catalog__purpose mt-2 block font-mono text-[10px] leading-[1.5] text-dim">
                      {entry.purpose}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
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
