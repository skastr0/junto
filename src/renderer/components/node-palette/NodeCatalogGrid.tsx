import { useId, useMemo, useState, type FocusEvent, type MouseEvent } from "react";
import {
  Archive,
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
  type LucideIcon,
} from "lucide-react";

export type NodeCatalogCategory = "shell" | "sinks" | "schedule" | "canvas";

export type NodeCatalogConnection = {
  /** The kind of node at the other end of a useful edge. */
  readonly target: string;
  /** Plain-language summary of the collaboration over that edge. */
  readonly relationship: string;
  /** The edge plane this relationship uses. */
  readonly mode: "capability" | "effect" | "context";
  /** Capability grants the edge can carry. */
  readonly ports: readonly string[];
};

/**
 * The presentation contract between the palette shell and its catalog.  The
 * shell can replace the defaults as product descriptions become richer.
 */
export type NodeCatalogEntry = {
  readonly id: string;
  readonly kind: string;
  readonly category: NodeCatalogCategory;
  readonly label: string;
  readonly subtitle: string;
  readonly icon: LucideIcon;
  /** A text utility, deliberately applied to the icon stroke only. */
  readonly accentClass: string;
  readonly purpose: string;
  /** Omit for furniture that has no live attention or blocking semantics. */
  readonly attention?: string;
  readonly connections: readonly NodeCatalogConnection[];
};

export const DEFAULT_NODE_CATALOG_ENTRIES: readonly NodeCatalogEntry[] = [
  {
    id: "terminal", kind: "terminal", category: "shell", label: "Terminal", subtitle: "native shell",
    icon: SquareTerminal, accentClass: "text-cyan",
    purpose: "A managed shell on the selected host for commands, logs, and hands-on operator work.",
    connections: [{ target: "Any node", relationship: "keeps shell work spatially adjacent as display context", mode: "context", ports: [] }],
  },
  {
    id: "herdr", kind: "herdr", category: "shell", label: "Herdr", subtitle: "attach an existing pane",
    icon: PanelTop, accentClass: "text-indigo",
    purpose: "A bridge to an existing terminal pane without taking ownership of the underlying process.",
    connections: [{ target: "Any node", relationship: "keeps an existing pane visible as display context", mode: "context", ports: [] }],
  },
  {
    id: "tasks", kind: "task", category: "sinks", label: "Tasks", subtitle: "shared claim queue",
    icon: Blocks, accentClass: "text-gold",
    purpose: "A durable work sink where connected agents inspect, claim, and submit discrete tasks.",
    attention: "Submitted and working tasks do not block anyone. Only an input-required task stops its connected actor.",
    connections: [{ target: "Agent", relationship: "agent reads, claims, and completes work", mode: "capability", ports: ["tasks.list", "tasks.claim", "tasks.update"] }],
  },
  {
    id: "requests", kind: "requests", category: "sinks", label: "Requests", subtitle: "operator input required",
    icon: Inbox, accentClass: "text-orange",
    purpose: "An operator-facing inbox for decisions and missing information surfaced by connected work.",
    attention: "Input-required requests create visible attention; connect them to the actor that needs the answer.",
    connections: [{ target: "Agent", relationship: "surfaces an answerable operator request", mode: "capability", ports: ["request.escalate", "msg.list", "msg.send"] }],
  },
  {
    id: "artifacts", kind: "artifacts", category: "sinks", label: "Artifacts", subtitle: "published parts shelf",
    icon: Archive, accentClass: "text-green",
    purpose: "A durable shelf for named outputs produced as work becomes real.",
    connections: [{ target: "Agent", relationship: "records produced files and proof", mode: "capability", ports: ["artifact.publish"] }],
  },
  {
    id: "board", kind: "board", category: "sinks", label: "Board", subtitle: "topics and posts",
    icon: Braces, accentClass: "text-amber",
    purpose: "A shared Command Center discussion surface for durable topics, updates, and decisions.",
    connections: [{ target: "Agent", relationship: "creates topics and posts updates", mode: "capability", ports: ["board.create_topic", "board.post"] }],
  },
  {
    id: "page", kind: "page", category: "canvas", label: "Page", subtitle: "browser work surface",
    icon: Globe2, accentClass: "text-cyan",
    purpose: "A browser-backed work surface for a specific web context on the canvas.",
    connections: [{ target: "Agent", relationship: "shares bounded browser context", mode: "capability", ports: ["browser.automate"] }],
  },
  {
    id: "timer", kind: "timer", category: "schedule", label: "Cron", subtitle: "schedule on an interval",
    icon: Clock3, accentClass: "text-violet",
    purpose: "A durable, home-scoped schedule that fires authored edge effects (enqueue tasks, set flags).",
    attention: "Connect cron → task with an effect edge to mint work. Actors still pull via the claim tick.",
    connections: [{ target: "Task", relationship: "enqueues work on fire", mode: "effect", ports: [] }],
  },
  {
    id: "watcher", kind: "watcher", category: "schedule", label: "Gauge", subtitle: "live data condition",
    icon: Eye, accentClass: "text-violet",
    purpose: "A hermes roster predicate (e.g. running). Rising edge can fire the same edge effects as cron.",
    attention: "Hermes roster stats are thin today (running 0/1). Effects need an outbound edge.",
    connections: [{ target: "Task", relationship: "enqueues work when condition trips", mode: "effect", ports: [] }],
  },
  {
    id: "note", kind: "text", category: "canvas", label: "Note", subtitle: "freeform text",
    icon: FileText, accentClass: "text-gold",
    purpose: "Freeform operator-authored context placed directly beside the work it explains.",
    connections: [{ target: "Any node", relationship: "adds human-readable context to the map", mode: "context", ports: [] }],
  },
  {
    id: "file", kind: "file", category: "canvas", label: "File", subtitle: "workspace path",
    icon: Folder, accentClass: "text-indigo",
    purpose: "A workspace path pinned into the map so collaborators can see the durable source of a thing.",
    connections: [{ target: "Agent", relationship: "anchors the working source in context", mode: "context", ports: [] }],
  },
  {
    id: "link", kind: "link", category: "canvas", label: "Link", subtitle: "web reference",
    icon: Link2, accentClass: "text-cyan",
    purpose: "A web reference kept on the canvas as shared, human-authored context.",
    connections: [{ target: "Agent", relationship: "offers an explicit reference", mode: "context", ports: [] }],
  },
  {
    id: "region", kind: "group", category: "canvas", label: "Region", subtitle: "spatial container",
    icon: SquareDashed, accentClass: "text-green",
    purpose: "Named geography that groups related work and can carry an operator briefing.",
    connections: [{ target: "Any node", relationship: "contains and frames related work", mode: "context", ports: [] }],
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
  const [openId, setOpenId] = useState<string>();
  const descriptionId = useId();
  const visibleEntries = useMemo(
    () => entries.filter((entry) => (category === "all" || entry.category === category) && matchesQuery(entry, query)),
    [category, entries, query],
  );

  const dismissIfLeaving = (entryId: string, event: MouseEvent<HTMLButtonElement> | FocusEvent<HTMLButtonElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setOpenId((current) => current === entryId ? undefined : current);
  };

  return (
    <section
      aria-label="Node catalog"
      className={`node-deck-catalog min-h-0 overflow-y-auto overflow-x-hidden pr-1 ${className}`}
    >
      {visibleEntries.length > 0 ? (
        <ul className="node-deck-catalog__grid grid grid-cols-1 gap-3 p-1 sm:grid-cols-2" role="list">
          {visibleEntries.map((entry) => {
            const Icon = entry.icon;
            const isOpen = openId === entry.id;
            const popoverId = `${descriptionId}-${entry.id}`;
            return (
              <li key={entry.id} className="node-deck-catalog__item relative min-w-0">
                <button
                  type="button"
                  className="node-deck-catalog__card group relative flex min-h-[112px] w-full items-start gap-3 rounded-[7px] border border-stroke bg-raise px-4 py-3 text-left shadow-[inset_0_1px_0_rgb(237_230_218_/_0.025)] outline-none transition-[border-color,transform] duration-150 hover:border-stroke-hi focus-visible:border-amber focus-visible:ring-1 focus-visible:ring-amber/60"
                  aria-describedby={isOpen ? popoverId : undefined}
                  aria-expanded={isOpen}
                  onClick={() => onSelect(entry)}
                  onMouseEnter={() => setOpenId(entry.id)}
                  onMouseLeave={(event) => dismissIfLeaving(entry.id, event)}
                  onFocus={() => setOpenId(entry.id)}
                  onBlur={(event) => dismissIfLeaving(entry.id, event)}
                >
                  <Icon aria-hidden="true" size={25} strokeWidth={1.7} className={`node-deck-catalog__icon mt-0.5 shrink-0 ${entry.accentClass}`} />
                  <span className="node-deck-catalog__summary min-w-0">
                    <span className="node-deck-catalog__label block font-display text-[17px] font-semibold uppercase leading-none tracking-wide text-ink">
                      {entry.label}
                    </span>
                    <span className="node-deck-catalog__subtitle mt-2 block truncate font-mono text-[11px] text-dim">
                      {entry.subtitle}
                    </span>
                    <span className="node-deck-catalog__hint mt-3 block font-mono text-[9px] uppercase tracking-[0.16em] text-faint group-hover:text-ink-2 group-focus-visible:text-ink-2">
                      inspect · click to add
                    </span>
                  </span>

                  {isOpen ? (
                    <CatalogExplanation entry={entry} id={popoverId} />
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="node-deck-catalog__empty border border-dashed border-stroke px-4 py-10 text-center font-mono text-[11px] text-dim">
          No catalog entries match this view.
        </div>
      )}
    </section>
  );
}

function CatalogExplanation({ entry, id }: { readonly entry: NodeCatalogEntry; readonly id: string }) {
  const Icon = entry.icon;
  return (
    <span
      id={id}
      role="tooltip"
      className="node-deck-catalog__popover absolute inset-x-2 top-[calc(100%_-_9px)] z-30 grid gap-4 rounded-[8px] border border-stroke-hi bg-ground p-4 text-left shadow-[0_18px_52px_rgb(0_0_0_/_0.56)]"
    >
      <span className="node-deck-catalog__popover-head flex items-start gap-3 border-b border-stroke pb-3">
        <span className={`node-deck-catalog__popover-icon shrink-0 ${entry.accentClass}`} aria-hidden="true">
          <Icon size={21} strokeWidth={1.7} />
        </span>
        <span className="min-w-0">
          <span className="block font-mono text-[9px] uppercase tracking-[0.16em] text-faint">Node description</span>
          <span className="block font-display text-[17px] font-semibold uppercase tracking-wide text-ink">{entry.label}</span>
          <span className="mt-1 block font-mono text-[11px] leading-5 text-ink-2">{entry.purpose}</span>
        </span>
      </span>

      {entry.attention ? (
        <span className="node-deck-catalog__attention grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 font-mono text-[10px] leading-4 text-dim">
          <span className="text-amber">consequence</span>
          <span>{entry.attention}</span>
        </span>
      ) : null}

      <span className="node-deck-catalog__connections grid gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint">Connects to</span>
        {entry.connections.map((connection) => (
          <span key={`${entry.id}-${connection.target}`} className="node-deck-catalog__connection grid gap-2 border-l border-stroke-hi pl-3">
            <span className="node-deck-catalog__connection-map flex items-center gap-2 font-display text-[13px] uppercase tracking-wide text-ink">
              <span className="rounded-[3px] border border-stroke px-1.5 py-1">{entry.label}</span>
              <span aria-hidden="true" className={`flex items-center gap-1 text-base leading-none ${entry.accentClass}`}>
                <span className="h-px w-4 bg-current opacity-70" />→
              </span>
              <span className="rounded-[3px] border border-stroke px-1.5 py-1">{connection.target}</span>
            </span>
            <span className="font-mono text-[10px] leading-4 text-dim">{connection.relationship}</span>
            {connection.ports.length > 0 ? (
              <span className="flex flex-wrap gap-1.5">
                {connection.ports.map((port) => (
                  <span key={port} className="node-deck-catalog__port rounded-[3px] border border-stroke px-1.5 py-0.5 font-mono text-[9px] text-ink-2">
                    {port}
                  </span>
                ))}
              </span>
            ) : (
              <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-faint">
                {connection.mode} edge
              </span>
            )}
          </span>
        ))}
      </span>
    </span>
  );
}
