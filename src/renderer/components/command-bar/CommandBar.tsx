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
  closeCommandBar,
  filterCommandBarNodes,
  focusCanvasNode,
  openCommandBar,
} from "../../lib/command-bar";
import { nodeDetail, nodeTitle, nodeTypeLabel } from "../../lib/presentation";
import { state$ } from "../../lib/state";
import { Chip, Kbd, type ChipTone } from "../ui";

/**
 * cmd+K command bar — quick node navigation.
 *
 * A centered floating palette. Typing filters the LIST; the canvas never
 * changes while searching. Enter commits through the existing focus path
 * (select + one-shot camera fit). cmd+Enter also opens the node surface.
 *
 * Host is always mounted for the global hotkey (cmd+K / "/"); the panel is
 * portal-rendered only while open so per-session state (query, active row)
 * resets on every open.
 */

const LIST_CAP = 100;

const KIND_ICONS: Record<string, typeof Bot> = {
  agent: Bot,
  terminal: SquareTerminal,
  herdr: SquareTerminal,
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
  herdr: "cyan",
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

function CommandBarPanel() {
  const doc = use$(state$.doc);
  const recentIds = use$(state$.hotbarActiveMru);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(
    () => filterCommandBarNodes(doc.nodes, query, recentIds),
    [doc.nodes, query, recentIds],
  );
  const visible = matches.slice(0, LIST_CAP);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const commit = (node: CanvasNode, activate: boolean): void => {
    focusCanvasNode(node.id);
    if (activate) activateNodeSurface(node);
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
      setActive((current) => Math.min(current + 1, visible.length - 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      setActive((current) => Math.max(current - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      const match = visible[active];
      if (!match) return;
      event.preventDefault();
      event.stopPropagation();
      commit(match.node, event.metaKey || event.ctrlKey);
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      event.stopPropagation();
      closeCommandBar();
      return;
    }
    if (event.key === "Tab") {
      // Keep focus in the box; rows are pointer-committed.
      event.preventDefault();
    }
  };

  const activeId = visible[active] ? `command-bar-option-${visible[active].index}` : undefined;

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
            aria-label="Search nodes"
            data-testid="command-bar-input"
            value={query}
            placeholder="search nodes"
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
          {visible.length === 0 ? (
            <div className="command-bar__empty">No nodes match your search</div>
          ) : (
            visible.map((match, position) => (
              <div
                key={match.node.id}
                id={`command-bar-option-${match.index}`}
                role="option"
                aria-selected={position === active}
                data-index={position}
                className={[
                  "command-bar__row",
                  position === active ? "command-bar__row--active" : "",
                ].filter(Boolean).join(" ")}
                onPointerMove={() => setActive(position)}
                onPointerDown={(event) => {
                  event.preventDefault();
                  commit(match.node, event.metaKey || event.ctrlKey);
                }}
              >
                <span className="command-bar__row-icon">{kindIcon(match.node)}</span>
                <span className="command-bar__row-main">
                  <span className="command-bar__row-title">{nodeTitle(match.node)}</span>
                  <span className="command-bar__row-detail">{nodeDetail(match.node)}</span>
                </span>
                <Chip tone={kindTone(match.node)}>{nodeTypeLabel(match.node)}</Chip>
              </div>
            ))
          )}
        </div>
        <div className="command-bar__footer">
          <span className="command-bar__count">
            {matches.length > LIST_CAP
              ? `${visible.length} of ${matches.length} nodes`
              : `${matches.length} ${matches.length === 1 ? "node" : "nodes"}`}
          </span>
          <span className="command-bar__hints">
            <Kbd>↑↓</Kbd>
            <span className="command-bar__hint">navigate</span>
            <Kbd>↵</Kbd>
            <span className="command-bar__hint">focus</span>
            <Kbd>⌘↵</Kbd>
            <span className="command-bar__hint">focus + open</span>
            <Kbd>esc</Kbd>
            <span className="command-bar__hint">close</span>
          </span>
        </div>
      </div>
    </div>
  );
}
