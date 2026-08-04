import { useId, useMemo, useState } from "react";
import type { Port } from "@shared/physics/schema";
import {
  Archive,
  ArrowLeftRight,
  ArrowRight,
  Blocks,
  Braces,
  Clock3,
  FileText,
  Globe2,
  Inbox,
  PanelTop,
  SquareDashed,
  SquareTerminal,
  Type,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { HERDR_ENABLED } from "@shared/features";

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

export type NodeCatalogConnection = {
  readonly source: string;
  /** The kind of node at the other end of a useful edge. */
  readonly target: string;
  readonly direction: "directed" | "relation";
  /** Plain-language summary of the collaboration over that edge. */
  readonly relationship: string;
  /** The edge plane this relationship uses. */
  readonly mode: "capability" | "effect" | "criteria" | "context";
  /** Capability grants the edge can carry. */
  readonly ports: ReadonlyArray<Port>;
};

/**
 * The presentation contract between the palette shell and its catalog.  The
 * shell can replace the defaults as product descriptions become richer.
 */
export type NodeCatalogEntry = {
  readonly id: string;
  readonly category: NodeCatalogCategory;
  readonly label: string;
  readonly subtitle: string;
  readonly icon: LucideIcon;
  readonly purpose: string;
  /** Short operational constraint; never a re-derived live attention state. */
  readonly behavior?: string;
  readonly connections: readonly NodeCatalogConnection[];
};

const HERDR_CATALOG_ENTRY: NodeCatalogEntry = {
  id: "herdr", category: "shell", label: "Herdr", subtitle: "attach an existing pane",
  icon: PanelTop,
  purpose: "Shows an existing terminal pane on the canvas without taking it over.",
  connections: [],
};

export const DEFAULT_NODE_CATALOG_ENTRIES: readonly NodeCatalogEntry[] = [
  {
    id: "terminal", category: "shell", label: "Terminal", subtitle: "a shell on your machine",
    icon: SquareTerminal,
    purpose: "A shell on the selected machine for commands, logs, and hands-on work.",
    connections: [],
  },
  ...(HERDR_ENABLED ? [HERDR_CATALOG_ENTRY] : []),
  {
    id: "tasks", category: "sinks", label: "Tasks", subtitle: "shared work queue",
    icon: Blocks,
    purpose: "A work queue. Connected agents pick up tasks and turn in finished work.",
    behavior: "A task waiting on your answer pauses only the agent working on it.",
    connections: [
      { source: "Agent", target: "Tasks", direction: "directed", relationship: "picks up and finishes tasks", mode: "capability", ports: [] },
      { source: "Cron or Relay", target: "Tasks", direction: "directed", relationship: "adds a task when it fires", mode: "effect", ports: [] },
    ],
  },
  {
    id: "requests", category: "sinks", label: "Requests", subtitle: "questions for you",
    icon: Inbox,
    purpose: "Questions from agents that only you can answer.",
    behavior: "An open question pauses only the agent that asked it.",
    connections: [
      { source: "Agent", target: "Requests", direction: "directed", relationship: "asks you for a decision or a missing detail", mode: "capability", ports: [] },
    ],
  },
  {
    id: "artifacts", category: "sinks", label: "Artifacts", subtitle: "finished work shelf",
    icon: Archive,
    purpose: "A shelf for finished outputs: files, results, and proof of work.",
    connections: [
      { source: "Agent", target: "Artifacts", direction: "directed", relationship: "publishes finished work", mode: "capability", ports: [] },
    ],
  },
  {
    id: "board", category: "sinks", label: "Board", subtitle: "topics and posts",
    icon: Braces,
    purpose: "A shared board for topics, updates, and decisions.",
    connections: [
      { source: "Agent", target: "Board", direction: "directed", relationship: "posts topics and updates", mode: "capability", ports: [] },
    ],
  },
  {
    id: "page", category: "canvas", label: "Page", subtitle: "a browser page",
    icon: Globe2,
    purpose: "A browser page that lives on the canvas.",
    connections: [{ source: "Agent", target: "Page", direction: "directed", relationship: "drives the page", mode: "capability", ports: [] }],
  },
  {
    id: "cron", category: "schedule", label: "Cron", subtitle: "fires on a schedule",
    icon: Clock3,
    purpose: "Fires on a schedule to add tasks or set flags automatically.",
    behavior: "Runs only while the canvas is playing. Pausing keeps the next firing.",
    connections: [
      { source: "Cron", target: "Tasks", direction: "directed", relationship: "adds a task on schedule", mode: "effect", ports: [] },
    ],
  },
  // Gauge (hermes stat_threshold) is product-hidden and not a product peer of
  // cron/relay. Hermes = fleet join, not automation. Future external-input
  // actuator (webhook / poll) is a new surface — not “fix this hermes stub.”
  {
    id: "relay", category: "schedule", label: "Relay", subtitle: "reacts to changes",
    icon: Workflow,
    purpose: "Watches a connected node and acts when something happens.",
    behavior: "Runs only while the canvas is playing. Pausing keeps the next firing.",
    connections: [
      { source: "Watched node", target: "Relay", direction: "directed", relationship: "the relay watches it", mode: "context", ports: [] },
      { source: "Relay", target: "Tasks", direction: "directed", relationship: "adds a task when it fires", mode: "effect", ports: [] },
    ],
  },
  {
    id: "note", category: "canvas", label: "Note", subtitle: "freeform text",
    icon: FileText,
    purpose: "Freeform text placed beside the work it explains.",
    connections: [],
  },
  {
    id: "label", category: "canvas", label: "Label", subtitle: "bare map text",
    icon: Type,
    purpose: "Bare text on the map. Name an area without a card, box, or connectors.",
    connections: [],
  },
  {
    id: "region", category: "canvas", label: "Region", subtitle: "groups related work",
    icon: SquareDashed,
    purpose: "A named area that groups related work and can carry a briefing.",
    connections: [],
  },
];

export type NodeCatalogGridProps = {
  readonly query?: string;
  readonly category?: NodeCatalogCategory | "all";
  readonly entries?: readonly NodeCatalogEntry[];
  readonly onSelect: (entry: NodeCatalogEntry) => void;
  readonly className?: string;
};

const matchesQuery = (entry: NodeCatalogEntry, query: string): boolean => {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return true;
  return [entry.label, entry.subtitle, entry.purpose, entry.category]
    .some((value) => value.toLocaleLowerCase().includes(normalized));
};

export function NodeCatalogGrid({
  query = "",
  category = "all",
  entries = DEFAULT_NODE_CATALOG_ENTRIES,
  onSelect,
  className = "",
}: NodeCatalogGridProps) {
  const [activeId, setActiveId] = useState<string>();
  const descriptionId = useId();
  const visibleEntries = useMemo(
    () => entries.filter((entry) => (category === "all" || entry.category === category) && matchesQuery(entry, query)),
    [category, entries, query],
  );

  const activeEntry = visibleEntries.find((entry) => entry.id === activeId) ?? visibleEntries[0];
  const detailId = activeEntry ? `${descriptionId}-${activeEntry.id}` : undefined;

  return (
    <section
      aria-label="Node catalog"
      className={`node-deck-catalog min-h-0 ${className}`}
    >
      {visibleEntries.length > 0 ? (
        <>
          <ul className="node-deck-catalog__grid grid grid-cols-1 gap-2 p-1 sm:grid-cols-2" role="list">
            {visibleEntries.map((entry) => {
              const Icon = entry.icon;
              const accentClass = NODE_CATALOG_CATEGORY_ACCENT[entry.category];
              const isActive = activeEntry?.id === entry.id;
              return (
                <li key={entry.id} className="node-deck-catalog__item min-w-0">
                  <button
                    type="button"
                    className="node-deck-catalog__card group flex min-h-[76px] w-full items-start gap-3 rounded-[7px] border border-stroke px-3 py-3 text-left outline-none transition-[border-color,background-color] duration-150 hover:border-stroke-hi focus-visible:border-amber focus-visible:ring-1 focus-visible:ring-amber/60"
                    data-active={isActive || undefined}
                    aria-describedby={isActive ? detailId : undefined}
                    onClick={() => onSelect(entry)}
                    onMouseEnter={() => setActiveId(entry.id)}
                    onFocus={() => setActiveId(entry.id)}
                  >
                    <Icon aria-hidden="true" size={23} strokeWidth={1.7} className={`node-deck-catalog__icon mt-0.5 shrink-0 ${accentClass}`} />
                    <span className="node-deck-catalog__summary min-w-0">
                      <span className="node-deck-catalog__label block font-mono text-[15px] font-semibold leading-none text-ink">
                        {entry.label}
                      </span>
                      <span className="node-deck-catalog__subtitle mt-1.5 block truncate font-mono text-[10px] leading-4 text-dim">
                        {entry.subtitle}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {activeEntry && detailId ? <CatalogDetail entry={activeEntry} id={detailId} /> : null}
        </>
      ) : (
        <div className="node-deck-catalog__empty border border-dashed border-stroke px-4 py-10 text-center font-mono text-[11px] text-dim">
          No catalog entries match this view.
        </div>
      )}
    </section>
  );
}

function ConnectionArrow({
  direction,
}: {
  readonly direction: NodeCatalogConnection["direction"];
}) {
  const Arrow = direction === "directed" ? ArrowRight : ArrowLeftRight;
  return <Arrow aria-hidden="true" size={18} strokeWidth={1.7} />;
}

function ConnectionMap({
  connection,
  accentClass,
}: {
  readonly connection: NodeCatalogConnection;
  readonly accentClass: string;
}) {
  return (
    <span className="node-deck-catalog__connection-map flex min-w-0 items-center gap-2 font-mono text-[12px] font-medium text-ink">
      <span className="node-deck-catalog__endpoint truncate">{connection.source}</span>
      <span aria-hidden="true" className={`node-deck-catalog__arrow shrink-0 ${accentClass}`}>
        <ConnectionArrow direction={connection.direction} />
      </span>
      <span className="node-deck-catalog__endpoint truncate">{connection.target}</span>
    </span>
  );
}

function CatalogDetail({ entry, id }: { readonly entry: NodeCatalogEntry; readonly id: string }) {
  const Icon = entry.icon;
  const accentClass = NODE_CATALOG_CATEGORY_ACCENT[entry.category];
  const [primaryConnection, ...secondaryConnections] = entry.connections;
  return (
    <aside
      id={id}
      aria-label={`${entry.label} details`}
      className="node-deck-catalog__detail"
    >
      <div className="node-deck-catalog__detail-copy">
        <span className={`node-deck-catalog__detail-icon shrink-0 ${accentClass}`} aria-hidden="true">
          <Icon size={21} strokeWidth={1.7} />
        </span>
        <div className="min-w-0">
          <strong className="block font-mono text-[14px] font-semibold text-ink">{entry.label}</strong>
          <p className="node-deck-catalog__purpose">{entry.purpose}</p>
          {entry.behavior ? <p className="node-deck-catalog__behavior"><span>Behavior:</span> {entry.behavior}</p> : null}
        </div>
      </div>

      {primaryConnection ? (
        <div className="node-deck-catalog__relationships">
          <div className="node-deck-catalog__connection node-deck-catalog__connection--primary">
            <ConnectionMap connection={primaryConnection} accentClass={accentClass} />
            <span className="node-deck-catalog__relationship">{primaryConnection.relationship}</span>
          </div>
          {secondaryConnections.length > 0 ? (
            <div className="node-deck-catalog__secondary-list" aria-label="Other useful connections">
              {secondaryConnections.map((connection) => (
                <div key={`${connection.source}-${connection.target}-${connection.relationship}`} className="node-deck-catalog__connection node-deck-catalog__connection--secondary">
                  <ConnectionMap connection={connection} accentClass={accentClass} />
                  <span className="node-deck-catalog__relationship">{connection.relationship}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}
