import { useId, useMemo, useState } from "react";
import type { Port } from "@shared/physics/schema";
import {
  Archive,
  ArrowLeftRight,
  ArrowRight,
  Blocks,
  Braces,
  Clock3,
  Eye,
  FileText,
  Folder,
  Globe2,
  Inbox,
  Link2,
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
  purpose: "A bridge to an existing terminal pane without taking ownership of the underlying process.",
  connections: [{ source: "Herdr", target: "Any node", direction: "relation", relationship: "keeps an existing pane visible as display context", mode: "context", ports: [] }],
};

export const DEFAULT_NODE_CATALOG_ENTRIES: readonly NodeCatalogEntry[] = [
  {
    id: "terminal", category: "shell", label: "Terminal", subtitle: "native shell",
    icon: SquareTerminal,
    purpose: "A managed shell on the selected host for commands, logs, and hands-on operator work.",
    connections: [{ source: "Terminal", target: "Any node", direction: "relation", relationship: "keeps shell work spatially adjacent as display context", mode: "context", ports: [] }],
  },
  ...(HERDR_ENABLED ? [HERDR_CATALOG_ENTRY] : []),
  {
    id: "tasks", category: "sinks", label: "Tasks", subtitle: "shared claim queue",
    icon: Blocks,
    purpose: "A durable work sink where connected agents inspect, claim, and submit discrete tasks.",
    behavior: "Submitted and working tasks stay calm. A tasks-criteria edge blocks only the claimant actor while a scoped item is input-required or auth-required.",
    connections: [
      { source: "Agent", target: "Tasks", direction: "directed", relationship: "reads, claims, and completes work", mode: "capability", ports: ["tasks.list", "tasks.claim", "tasks.update"] },
      { source: "Tasks", target: "Actor", direction: "directed", relationship: "blocks only its claimant during a human wait", mode: "criteria", ports: [] },
      { source: "Scheduler", target: "Tasks", direction: "directed", relationship: "enqueues work when its condition fires", mode: "effect", ports: [] },
    ],
  },
  {
    id: "requests", category: "sinks", label: "Requests", subtitle: "operator input required",
    icon: Inbox,
    purpose: "An operator-facing inbox for decisions and missing information surfaced by connected work.",
    behavior: "A tasks-criteria edge blocks only the claimant actor while its request is input-required or auth-required.",
    connections: [
      { source: "Agent", target: "Requests", direction: "directed", relationship: "surfaces an answerable operator request", mode: "capability", ports: ["request.escalate", "msg.list", "msg.send"] },
      { source: "Requests", target: "Actor", direction: "directed", relationship: "blocks only its claimant during a human wait", mode: "criteria", ports: [] },
      { source: "Scheduler", target: "Requests", direction: "directed", relationship: "projects the selected runtime flag on Command Center", mode: "effect", ports: [] },
    ],
  },
  {
    id: "artifacts", category: "sinks", label: "Artifacts", subtitle: "published parts shelf",
    icon: Archive,
    purpose: "A durable shelf for named outputs produced as work becomes real.",
    connections: [
      { source: "Agent", target: "Artifacts", direction: "directed", relationship: "records produced files and proof", mode: "capability", ports: ["artifact.publish"] },
      { source: "Scheduler", target: "Artifacts", direction: "directed", relationship: "projects the selected runtime flag on Command Center", mode: "effect", ports: [] },
    ],
  },
  {
    id: "board", category: "sinks", label: "Board", subtitle: "topics and posts",
    icon: Braces,
    purpose: "A shared Command Center discussion surface for durable topics, updates, and decisions.",
    connections: [
      { source: "Agent", target: "Board", direction: "directed", relationship: "creates topics and posts updates", mode: "capability", ports: ["board.create_topic", "board.post"] },
      { source: "Scheduler", target: "Board", direction: "directed", relationship: "projects the selected runtime flag on Command Center", mode: "effect", ports: [] },
    ],
  },
  {
    id: "page", category: "canvas", label: "Page", subtitle: "browser work surface",
    icon: Globe2,
    purpose: "A browser-backed work surface for a specific web context on the canvas.",
    connections: [{ source: "Agent", target: "Page", direction: "directed", relationship: "shares bounded browser context", mode: "capability", ports: ["browser.automate"] }],
  },
  {
    id: "cron", category: "schedule", label: "Cron", subtitle: "schedule on an interval",
    icon: Clock3,
    purpose: "A durable, home-scoped schedule that fires authored edge effects (enqueue tasks, set flags).",
    behavior: "Automation runs only with a configured station role while this canvas is playing. Pausing preserves the next due firing.",
    connections: [
      { source: "Cron", target: "Tasks", direction: "directed", relationship: "enqueues work when the interval is due", mode: "effect", ports: [] },
      { source: "Cron", target: "Non-region node", direction: "directed", relationship: "projects the selected runtime flag on Command Center", mode: "effect", ports: [] },
    ],
  },
  {
    id: "gauge", category: "schedule", label: "Gauge", subtitle: "live data condition",
    icon: Eye,
    purpose: "A hermes roster predicate (e.g. running). Rising edge can fire the same edge effects as cron.",
    behavior: "Rising-edge memory advances only while automation is enabled, so pausing cannot consume the next match.",
    connections: [
      { source: "Hermes stats", target: "Gauge", direction: "directed", relationship: "supplies the live value evaluated by the predicate", mode: "context", ports: [] },
      { source: "Gauge", target: "Tasks", direction: "directed", relationship: "enqueues work on a rising match", mode: "effect", ports: [] },
      { source: "Gauge", target: "Non-region node", direction: "directed", relationship: "projects the selected runtime flag on Command Center", mode: "effect", ports: [] },
    ],
  },
  {
    id: "relay", category: "schedule", label: "Relay", subtitle: "watch a node projection",
    icon: Workflow,
    purpose: "A scheduler that watches another node's typed projection and fires edge effects on a rising match.",
    behavior: "Rising-edge memory advances only while automation is enabled, so pausing cannot consume the next match.",
    connections: [
      { source: "Watched node", target: "Relay", direction: "directed", relationship: "supplies the typed projection evaluated by the predicate", mode: "context", ports: [] },
      { source: "Relay", target: "Tasks", direction: "directed", relationship: "enqueues work on a rising match", mode: "effect", ports: [] },
      { source: "Relay", target: "Non-region node", direction: "directed", relationship: "projects the selected runtime flag on Command Center", mode: "effect", ports: [] },
    ],
  },
  {
    id: "note", category: "canvas", label: "Note", subtitle: "freeform text",
    icon: FileText,
    purpose: "Freeform operator-authored context placed directly beside the work it explains.",
    connections: [{ source: "Note", target: "Any node", direction: "relation", relationship: "adds human-readable context to the map", mode: "context", ports: [] }],
  },
  {
    id: "label", category: "canvas", label: "Label", subtitle: "bare map text",
    icon: Type,
    purpose: "Geography-only text on the field — name a pocket inside a region without a card, box, or connectors.",
    behavior: "No handles, ports, or edges. Settings are text, optional accent color, and size.",
    connections: [],
  },
  {
    id: "file", category: "canvas", label: "File", subtitle: "workspace path",
    icon: Folder,
    purpose: "A workspace path pinned into the map so collaborators can see the durable source of a thing.",
    connections: [{ source: "File", target: "Agent", direction: "relation", relationship: "anchors the working source in context", mode: "context", ports: [] }],
  },
  {
    id: "link", category: "canvas", label: "Link", subtitle: "web reference",
    icon: Link2,
    purpose: "A web reference kept on the canvas as shared, human-authored context.",
    connections: [{ source: "Link", target: "Agent", direction: "relation", relationship: "offers an explicit reference", mode: "context", ports: [] }],
  },
  {
    id: "region", category: "canvas", label: "Region", subtitle: "spatial container",
    icon: SquareDashed,
    purpose: "Named geography that groups related work and can carry an operator briefing.",
    connections: [{ source: "Region", target: "Any node", direction: "relation", relationship: "contains and frames related work", mode: "context", ports: [] }],
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
            {primaryConnection.ports.length > 0 ? (
              <span className="node-deck-catalog__ports">
                {primaryConnection.ports.map((port) => (
                  <span key={port} className="node-deck-catalog__port">{port}</span>
                ))}
              </span>
            ) : (
              <span className="node-deck-catalog__edge-mode">{primaryConnection.mode} edge</span>
            )}
          </div>
          {secondaryConnections.length > 0 ? (
            <div className="node-deck-catalog__secondary-list" aria-label="Other useful connections">
              {secondaryConnections.map((connection) => (
                <div key={`${connection.source}-${connection.target}-${connection.relationship}`} className="node-deck-catalog__connection node-deck-catalog__connection--secondary">
                  <ConnectionMap connection={connection} accentClass={accentClass} />
                  <span className="node-deck-catalog__relationship">{connection.relationship}</span>
                  {connection.ports.length > 0 ? (
                    <span className="node-deck-catalog__ports">
                      {connection.ports.map((port) => (
                        <span key={port} className="node-deck-catalog__port">{port}</span>
                      ))}
                    </span>
                  ) : connection.mode === "criteria" ? (
                    <span className="node-deck-catalog__edge-mode">{connection.mode} edge</span>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}
