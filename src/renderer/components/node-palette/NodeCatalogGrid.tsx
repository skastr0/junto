import { useId, useMemo, useState } from "react";
import { ALL_PORTS, type Port } from "@shared/physics/schema";
import { contractOf, familyColorToken, type WireFamily } from "@shared/physics";
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
import { HUE } from "../../lib/theme";

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
  readonly subtitle: string;
  readonly icon: LucideIcon;
  readonly purpose: string;
  /** Short operational constraint; never a re-derived live attention state. */
  readonly behavior?: string;
};

/**
 * Human labels for access ports — the same wording the wire sheet uses.
 * Complete over Port so a new port cannot ship a raw token here.
 */
const ACCESS_PORT_LABEL: Record<Port, string> = {
  "tasks.list": "List tasks",
  "tasks.create": "Create tasks",
  "tasks.claim": "Claim tasks",
  "tasks.update": "Update tasks",
  "msg.list": "List messages",
  "msg.send": "Send mail",
  "msg.prompt": "Prompt immediately",
  "seat.wait": "Wait on seat",
  "terminal.read": "Observe terminal",
  "verdict.post": "Post verdict",
  "artifact.publish": "Publish artifacts",
  "browser.automate": "Drive browser",
  "board.list": "List board",
  "board.create_topic": "Create topics",
  "board.post": "Post to board",
  "board.mark_read": "Mark board read",
  "pad.read": "Read pad",
  "sheet.read": "Read sheet",
  "pad.patch": "Patch pad",
  "relay.trigger": RELAY_ENABLED ? "Fire the relay" : "Trigger automation",
};

/** Catalog entry id → contract kind. Entries absent here have no wires. */
const CATALOG_CONTRACT_KIND: Partial<Record<string, string>> = {
  tasks: "task",
  requests: "requests",
  artifacts: "artifacts",
  board: "board",
  pad: "pad",
  sheet: "sheet",
  page: "page",
  cron: "cron",
  relay: "relay",
};

/** Plain line for entries that take no wires. */
export const NO_WIRES_COPY: Partial<Record<string, string>> = {
  note: "No wires — sits on the map.",
  label: "No wires — sits on the map.",
  region: "No wires — sits on the map.",
  terminal: "No wires — open it and work by hand.",
  git: "No wires — visualization only.",
};

export type CatalogWireLine = {
  readonly family: WireFamily;
  readonly text: string;
};

/**
 * Derive the wire explainer from the node contract: ports → access,
 * events → watch, inputs → effect. Never a hand-written row.
 */
export const catalogWireLines = (entryId: string): readonly CatalogWireLine[] => {
  const contract = contractOf(CATALOG_CONTRACT_KIND[entryId]);
  if (!contract) return [];
  const lines: CatalogWireLine[] = [];
  if (contract.ports.length > 0) {
    // Contract ports arrive in hash order; present them in schema order.
    const ports = [...contract.ports].sort(
      (a, b) => ALL_PORTS.indexOf(a) - ALL_PORTS.indexOf(b),
    );
    lines.push({
      family: "access",
      text: `Agents can: ${ports.map((port) => ACCESS_PORT_LABEL[port]).join(", ")}`,
    });
  }
  if (RELAY_ENABLED && contract.events.length > 0) {
    lines.push({
      family: "watch",
      text: `A relay can watch: ${contract.events.map((event) => event.label).join(", ")}`,
    });
  }
  if ((CRON_ENABLED || RELAY_ENABLED) && contract.inputs.length > 0) {
    const actors = CRON_ENABLED && RELAY_ENABLED
      ? "Cron and relay"
      : CRON_ENABLED
        ? "Cron"
        : "Relay";
    lines.push({
      family: "effect",
      text: `${actors} can: ${contract.inputs.map((input) => input.label).join(", ")}`,
    });
  }
  return lines;
};


export const DEFAULT_NODE_CATALOG_ENTRIES: readonly NodeCatalogEntry[] = [
  {
    id: "terminal", category: "shell", label: "Terminal", subtitle: "a shell on your machine",
    icon: SquareTerminal,
    purpose: "A shell on the selected machine for commands, logs, and hands-on work.",
  },
  ...(TASKS_ENABLED ? [{
    id: "tasks", category: "sinks", label: "Tasks", subtitle: "shared work queue",
    icon: Blocks,
    purpose: "A work queue. Connected agents pick up tasks and turn in finished work.",
    behavior: "A task waiting on your answer pauses only the agent working on it.",
  } satisfies NodeCatalogEntry] : []),
  ...(REQUESTS_ENABLED ? [{
    id: "requests", category: "sinks", label: "Requests", subtitle: "questions for you",
    icon: Inbox,
    purpose: "Questions from agents that only you can answer.",
    behavior: "An open question pauses only the agent that asked it.",
  } satisfies NodeCatalogEntry] : []),
  ...(ARTIFACTS_ENABLED ? [{
    id: "artifacts", category: "sinks", label: "Artifacts", subtitle: "finished work shelf",
    icon: Archive,
    purpose: "A shelf for finished outputs: files, results, and proof of work.",
  } satisfies NodeCatalogEntry] : []),
  ...(BOARD_ENABLED ? [{
    id: "board", category: "sinks", label: "Board", subtitle: "topics and posts",
    icon: Braces,
    purpose: "A shared board for topics, updates, and decisions.",
  } satisfies NodeCatalogEntry] : []),
  ...(PAD_ENABLED ? [{
    id: "pad", category: "sinks", label: "Pad", subtitle: "images, shapes, ink, pins",
    icon: PenLine,
    purpose: "A shared page. You mark; wired agents read the same page and patch boxes and pins.",
  } satisfies NodeCatalogEntry] : []),
  ...(SHEET_ENABLED ? [{
    id: "sheet", category: "sinks", label: "Sheet", subtitle: "a small grid of numbers and names",
    icon: Table,
    purpose: "Jot numbers and names in rows and columns beside the work. Wired agents can read it.",
    behavior: "You author it; agents read it. There is no agent write path.",
  } satisfies NodeCatalogEntry] : []),
  {
    id: "git", category: "sinks", label: "Git", subtitle: "commit browser",
    icon: GitBranch,
    purpose: "Browse commits and diffs for a repository on this machine.",
  },
  ...(BROWSER_ENABLED ? [{
    id: "page", category: "canvas", label: "Page", subtitle: "a browser page",
    icon: Globe2,
    purpose: "A browser page that lives on the canvas.",
  } satisfies NodeCatalogEntry] : []),
  ...(CRON_ENABLED ? [{
    id: "cron", category: "schedule", label: "Cron", subtitle: "fires on a schedule",
    icon: Clock3,
    purpose: "Fires on a schedule to add tasks or set flags automatically.",
    behavior: "Runs only while the canvas is playing. Pausing keeps the next firing.",
  } satisfies NodeCatalogEntry] : []),
  // Gauge (hermes stat_threshold) is product-hidden and not a product peer of
  // cron/relay. Hermes = fleet join, not automation. Future external-input
  // actuator (webhook / poll) is a new surface — not “fix this hermes stub.”
  ...(RELAY_ENABLED ? [{
    id: "relay", category: "schedule", label: "Relay", subtitle: "reacts to changes",
    icon: Workflow,
    purpose: "Watches a connected node and acts when something happens.",
    behavior: "Runs only while the canvas is playing. Pausing keeps the next firing.",
  } satisfies NodeCatalogEntry] : []),
  {
    id: "note", category: "canvas", label: "Note", subtitle: "freeform text",
    icon: FileText,
    purpose: "Freeform text placed beside the work it explains.",
  },
  {
    id: "label", category: "canvas", label: "Label", subtitle: "bare map text",
    icon: Type,
    purpose: "Bare text on the map. Name an area without a card, box, or connectors.",
  },
  {
    id: "region", category: "canvas", label: "Region", subtitle: "groups related work",
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

/** Identity fields rank fuzzily; prose (subtitle, purpose) is substring-only. */
export const catalogMatchesQuery = (
  entry: NodeCatalogEntry,
  query: string,
): boolean => {
  if (!query.trim()) return true;
  return fuzzyMatch(query, {
    identity: [entry.label, entry.id, entry.category],
    metadata: [entry.subtitle, entry.purpose],
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

/** Fixed family hues — same mapping the canvas wires render with. */
const FAMILY_HUE: Record<ReturnType<typeof familyColorToken>, string> = {
  steel: HUE.steel,
  cyan: HUE.cyan,
  violet: HUE.violet,
  amber: HUE.amber,
};

function WireExplainer({ entryId }: { readonly entryId: string }) {
  const noWires = NO_WIRES_COPY[entryId];
  const lines = noWires ? [] : catalogWireLines(entryId);
  if (!noWires && lines.length === 0) return null;
  return (
    <div className="node-deck-catalog__wires" aria-label="Wires">
      <span className="node-deck-catalog__wires-title">Wires</span>
      {noWires ? (
        <p className="node-deck-catalog__wires-none">{noWires}</p>
      ) : (
        lines.map((line) => (
          <div key={line.family} className="node-deck-catalog__wire">
            <span
              aria-hidden="true"
              className="node-deck-catalog__wire-dot"
              style={{ background: FAMILY_HUE[familyColorToken(line.family)] }}
            />
            <span className="node-deck-catalog__wire-family">{line.family}</span>
            <span className="node-deck-catalog__wire-text">{line.text}</span>
          </div>
        ))
      )}
    </div>
  );
}

function CatalogDetail({ entry, id }: { readonly entry: NodeCatalogEntry; readonly id: string }) {
  const Icon = entry.icon;
  const accentClass = NODE_CATALOG_CATEGORY_ACCENT[entry.category];
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

      <WireExplainer entryId={entry.id} />
    </aside>
  );
}
