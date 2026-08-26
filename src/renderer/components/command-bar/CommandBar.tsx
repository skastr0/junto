import { use$ } from "@legendapp/state/react";
import {
  Bot,
  Clock,
  Columns3,
  File,
  FileText,
  GitBranch,
  Globe,
  Inbox,
  Link2,
  ListTodo,
  Map,
  Package,
  PenLine,
  Search,
  SquareTerminal,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CanvasNode } from "@shared/canvas";
import { activateNodeSurface } from "../../lib/activate-node-surface";
import {
  buildCommandBarActions,
  commandBarMode,
  filterCommandBarActions,
  type CommandBarAction,
} from "../../lib/command-bar-actions";
import {
  closeCommandBar,
  filterCommandBarNodes,
  focusCanvasNode,
  openCommandBar,
} from "../../lib/command-bar";
import { nodeDetail, nodeTitle, nodeTypeLabel } from "../../lib/presentation";
import { state$ } from "../../lib/state";
import { Chip, Kbd, type ChipTone } from "../ui";

/**
 * cmd+K command bar — quick node navigation plus a quick-actions mode.
 *
 * A centered floating palette. Typing filters the LIST; the canvas never
 * changes while searching. Node mode commits the existing focus path
 * (select + one-shot camera fit); cmd+Enter also opens the node surface.
 * ">" (or Tab) switches to actions mode: existing renderer commands only,
 * Enter runs, Escape closes.
 *
 * Host is always mounted for the global hotkey (cmd+K / "/"); the panel is
 * portal-rendered only while open so per-session state (query, mode, active
 * row) resets on every open.
 */

const LIST_CAP = 100;

const KIND_ICONS: Record<string, typeof Bot> = {
  agent: Bot,
  terminal: SquareTerminal,
  task: ListTodo,
  requests: Inbox,
  artifacts: Package,
  board: Columns3,
  pad: PenLine,
  page: Globe,
  cron: Clock,
  relay: GitBranch,
  git: GitBranch,
};

const TYPE_ICONS: Record<string, typeof Bot> = {
  text: FileText,
  file: File,
  link: Link2,
  group: Map,
};

const KIND_TONES: Record<string, ChipTone> = {
  agent: "amber",
  terminal: "cyan",
  task: "steel",
  requests: "violet",
  artifacts: "green",
  board: "violet",
  pad: "cyan",
  page: "cyan",
  cron: "steel",
  relay: "amber",
  git: "steel",
  region: "amber",
  note: "steel",
  file: "steel",
  link: "steel",
};

const kindIcon = (node: CanvasNode) => {
  const kind = node.ether?.entity?.kind ?? "";
  const Icon = KIND_ICONS[kind] ?? TYPE_ICONS[node.type] ?? FileText;
  return <Icon size={13} />;
};

const kindTone = (node: CanvasNode): ChipTone => {
  const kind = node.ether?.entity?.kind ?? "";
  if (KIND_TONES[kind]) return KIND_TONES[kind];
  return KIND_TONES[nodeTypeLabel(node)] ?? "steel";
};

export function CommandBarHost() {
  const open = use$(state$.commandBarOpen);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true']")) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (state$.commandBarOpen.peek()) closeCommandBar();
        else openCommandBar();
        return;
      }
      if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key === "/") {
        event.preventDefault();
        openCommandBar();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  if (!open) return null;
  return createPortal(<CommandBarPanel />, document.body);
}

type CommandBarRow =
  | { readonly kind: "node"; readonly node: CanvasNode; readonly index: number; readonly position: number }
  | { readonly kind: "action"; readonly action: CommandBarAction; readonly position: number };

function CommandBarPanel() {
  const doc = use$(state$.doc);
  const recentIds = use$(state$.hotbarActiveMru);
  const [query, setQuery] = useState("");
  const [tabMode, setTabMode] = useState<"nodes" | "actions">("nodes");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Catalog is rebuilt once per open so labels reflect live state.
  const actions = useMemo(() => buildCommandBarActions(), []);
  const mode = commandBarMode(query, tabMode);
  const nodeMatches = useMemo(
    () => filterCommandBarNodes(doc.nodes, query, recentIds),
    [doc.nodes, query, recentIds],
  );
  const actionMatches = useMemo(
    () => filterCommandBarActions(actions, query),
    [actions, query],
  );

  const rows: ReadonlyArray<CommandBarRow> =
    mode === "actions"
      ? actionMatches.map((action, position) => ({ kind: "action", action, position }))
      : nodeMatches
          .slice(0, LIST_CAP)
          .map((match, position) => ({
            kind: "node",
            node: match.node,
            index: match.index,
            position,
          }));

  useEffect(() => {
    setActive(0);
  }, [query, mode]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const commit = (row: CommandBarRow, activate: boolean): void => {
    if (row.kind === "node") {
      focusCanvasNode(row.node.id);
      if (activate) activateNodeSurface(row.node);
    } else {
      row.action.run();
    }
    closeCommandBar();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeCommandBar();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      setActive((current) => Math.min(current + 1, rows.length - 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      setActive((current) => Math.max(current - 1, 0));
      return;
    }
    if (event.key === "Tab") {
      // Mode toggle (VS Code convention); keep focus in the box.
      event.preventDefault();
      event.stopPropagation();
      setTabMode((current) => (current === "nodes" ? "actions" : "nodes"));
      return;
    }
    if (event.key === "Enter") {
      const row = rows[active];
      if (!row) return;
      event.preventDefault();
      event.stopPropagation();
      commit(row, event.metaKey || event.ctrlKey);
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      event.stopPropagation();
      closeCommandBar();
      return;
    }
  };

  const activeRow = rows[active];
  const activeId = activeRow
    ? activeRow.kind === "node"
      ? `command-bar-option-${activeRow.index}`
      : `command-bar-action-${activeRow.position}`
    : undefined;
  const trimmedCount =
    mode === "actions" ? actionMatches.length : nodeMatches.length;
  const capped = mode === "nodes" && trimmedCount > LIST_CAP;
  const countLabel =
    mode === "actions"
      ? `${trimmedCount} ${trimmedCount === 1 ? "action" : "actions"}`
      : capped
        ? `${rows.length} of ${trimmedCount} nodes`
        : `${trimmedCount} ${trimmedCount === 1 ? "node" : "nodes"}`;
  const searchLabel = mode === "actions" ? "Search actions" : "Search nodes";

  return (
    <div
      className="command-bar-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) closeCommandBar();
      }}
    >
      <div className="command-bar" role="dialog" aria-label="Command bar">
        <div className="command-bar__input-row">
          <Search size={14} />
          <input
            ref={inputRef}
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="command-bar-list"
            aria-activedescendant={activeId}
            aria-label={searchLabel}
            data-testid="command-bar-input"
            value={query}
            placeholder={mode === "actions" ? "type a command" : "search nodes"}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
          {query ? (
            <button
              type="button"
              className="command-bar__clear"
              aria-label="Clear search"
              onPointerDown={(event) => {
                event.preventDefault();
                setQuery("");
                inputRef.current?.focus();
              }}
            >
              <X size={13} />
            </button>
          ) : null}
        </div>
        <div className="command-bar__list" id="command-bar-list" role="listbox" ref={listRef}>
          {rows.length === 0 ? (
            <div className="command-bar__empty">
              {mode === "actions" ? "No commands match your search" : "No nodes match your search"}
            </div>
          ) : (
            rows.map((row) =>
              row.kind === "node" ? (
                <div
                  key={row.node.id}
                  id={`command-bar-option-${row.index}`}
                  role="option"
                  aria-selected={row.position === active}
                  data-index={row.position}
                  className={[
                    "command-bar__row",
                    row.position === active ? "command-bar__row--active" : "",
                  ].filter(Boolean).join(" ")}
                  onPointerMove={() => setActive(row.position)}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    commit(row, event.metaKey || event.ctrlKey);
                  }}
                >
                  <span className="command-bar__row-icon">{kindIcon(row.node)}</span>
                  <span className="command-bar__row-main">
                    <span className="command-bar__row-title">{nodeTitle(row.node)}</span>
                    <span className="command-bar__row-detail">{nodeDetail(row.node)}</span>
                  </span>
                  <Chip tone={kindTone(row.node)}>{nodeTypeLabel(row.node)}</Chip>
                </div>
              ) : (
                <div
                  key={row.action.id}
                  id={`command-bar-action-${row.position}`}
                  role="option"
                  aria-selected={row.position === active}
                  data-index={row.position}
                  className={[
                    "command-bar__row",
                    "command-bar__row--action",
                    row.position === active ? "command-bar__row--active" : "",
                  ].filter(Boolean).join(" ")}
                  onPointerMove={() => setActive(row.position)}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    commit(row, false);
                  }}
                >
                  <span className="command-bar__row-icon">
                    <row.action.icon size={13} />
                  </span>
                  <span className="command-bar__row-main">
                    <span className="command-bar__row-title">{row.action.label}</span>
                    <span className="command-bar__row-detail">{row.action.detail}</span>
                  </span>
                  {row.action.hotkey ? <Kbd>{row.action.hotkey}</Kbd> : null}
                </div>
              )
            )
          )}
        </div>
        <div className="command-bar__footer">
          <span className="command-bar__count">{countLabel}</span>
          <span className="command-bar__hints">
            <Kbd>↑↓</Kbd>
            <span className="command-bar__hint">navigate</span>
            {mode === "actions" ? (
              <>
                <Kbd>↵</Kbd>
                <span className="command-bar__hint">run</span>
                <Kbd>tab</Kbd>
                <span className="command-bar__hint">nodes</span>
              </>
            ) : (
              <>
                <Kbd>↵</Kbd>
                <span className="command-bar__hint">focus</span>
                <Kbd>⌘↵</Kbd>
                <span className="command-bar__hint">focus + open</span>
                <Kbd>tab</Kbd>
                <span className="command-bar__hint">actions</span>
              </>
            )}
            <Kbd>esc</Kbd>
            <span className="command-bar__hint">close</span>
          </span>
        </div>
      </div>
    </div>
  );
}
