import { use$ } from "@legendapp/state/react";
import { Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CanvasNode, GroupNode } from "@shared/canvas";
import { harnessDisplayName } from "@shared/spawn-failure";
import { activateNodeSurface } from "../../lib/activate-node-surface";
import {
  buildCommandBarActions,
  commandBarMode,
  filterCommandBarActions,
  type CommandBarAction,
} from "../../lib/command-bar-actions";
import {
  filterCommandBarNodes,
  focusCanvasNode,
} from "../../lib/command-bar";
import { closeOperatorModal } from "../../lib/operator-modal";
import { nodeDetail, nodeTitle, nodeTypeLabel } from "../../lib/presentation";
import { regionPaths } from "../../lib/region-path";
import { regionTallyParts } from "../../lib/region-glance";
import { seatSaying } from "../../lib/seat-line";
import { state$ } from "../../lib/state";
import { accentColor, HUE } from "../../lib/theme";
import { NodeKindMark } from "../NodeKindMark";
import { RegionCrumb } from "../RegionCrumb";
import { SeatRingView, seatUrgencyNow, useSeatGlance, type SeatGlance } from "../SeatRing";
import { Kbd } from "../ui";
import { claimFocus } from "../../lib/focus-ownership";
import { OperatorModalShell } from "../operator-modal/OperatorModalShell";

/**
 * cmd+K command bar — quick node navigation plus a quick-actions mode.
 *
 * A centered floating palette that fills most of the window height. Agents
 * lead the list, most urgent first (see filterCommandBarNodes). Typing
 * filters the LIST; the canvas never changes while searching. Node mode commits the existing focus path
 * (select + one-shot camera fit); cmd+Enter also opens the node surface.
 * ">" (or Tab) switches to actions mode: existing renderer commands only,
 * Enter runs.
 *
 * An operator modal: OperatorModalHost owns the chords (cmd+K, "/") and
 * mounts this only while open, so per-session state (query, mode, active
 * row) resets on every open. The shell owns the frame, focus and Escape.
 */

const closeCommandBar = (): void => closeOperatorModal("search");

const LIST_CAP = 100;

const TALLY_HUES = {
  crimson: HUE.crimson,
  amber: HUE.amber,
  cyan: HUE.cyan,
  green: "var(--color-green)",
  steel: HUE.steel,
} as const;

/**
 * A region's line: what needs the operator inside it (the plate's tally,
 * idle members left out), else its briefing, else how much it holds.
 */
function RegionDetail({ node }: { readonly node: GroupNode }) {
  const tally = use$(() => state$.regionCountsByNodeId.get()[node.id]);
  const live = regionTallyParts(tally).filter((part) => part.tone !== "steel");
  if (live.length > 0) {
    return (
      <>
        {live.map((part, index) => (
          <span key={part.tone} style={{ color: TALLY_HUES[part.tone] }}>
            {index > 0 ? ", " : ""}
            {part.text}
          </span>
        ))}
      </>
    );
  }
  const briefing = node.ether?.region?.instruction?.trim().split("\n")[0];
  if (briefing) return <>{briefing}</>;
  const total = tally?.total ?? 0;
  return <>{total === 0 ? "empty" : total === 1 ? "1 node" : `${String(total)} nodes`}</>;
}

const SAYING_HUES = {
  amber: HUE.amber,
  cyan: HUE.cyan,
  green: "var(--color-green)",
  crimson: HUE.crimson,
  steel: HUE.steel,
} as const;

/** The seat's harness in words, then the line its canvas seat is saying. */
function AgentDetail({ glance }: { readonly glance: SeatGlance }) {
  const saying = seatSaying({
    activity: glance.activity,
    signal: glance.signal?.signal,
    failure: glance.failure,
    health: glance.health,
  });
  const harness = harnessDisplayName(glance.harness);
  let words: React.ReactNode;
  if (saying.kind === "signal") {
    words = (
      <>
        <span className="command-bar__saying-word" style={{ color: SAYING_HUES[saying.tone] }}>
          {saying.word}
        </span>{" "}
        {saying.text}
      </>
    );
  } else if (saying.kind === "failure") {
    words = <span style={{ color: HUE.amber }}>{saying.text}</span>;
  } else if (saying.kind === "reading") {
    words = (
      <>
        <span className="command-bar__saying-ai">AI</span>
        {saying.text}
      </>
    );
  } else {
    words = saying.tone ? <span style={{ color: SAYING_HUES[saying.tone] }}>{saying.text}</span> : saying.text;
  }
  return (
    <>
      {harness ? <span className="command-bar__harness">{harness} — </span> : null}
      {words}
    </>
  );
}

/** The node's title, then its region path in dim type when it sits in one. */
function RowHead({
  node,
  path,
  accent,
}: {
  readonly node: CanvasNode;
  readonly path: string | undefined;
  readonly accent?: boolean;
}) {
  return (
    <span className="command-bar__row-head">
      <span
        className="command-bar__row-title"
        style={accent && node.color ? { color: accentColor(node.color) } : undefined}
      >
        {nodeTitle(node)}
      </span>
      {path ? (
        <RegionCrumb path={path} className="command-bar__row-path" testId="command-bar-row-crumb" />
      ) : null}
    </span>
  );
}

type RowFaceProps = { readonly node: CanvasNode; readonly path: string | undefined };

function AgentRowFace({ node, path }: RowFaceProps) {
  const glance = useSeatGlance(node);
  return (
    <>
      <span className="command-bar__mark command-bar__mark--seat">
        <SeatRingView node={node} px={28} glance={glance} />
      </span>
      <span className="command-bar__row-main">
        <RowHead node={node} path={path} accent />
        <span className="command-bar__row-detail">
          <AgentDetail glance={glance} />
        </span>
      </span>
    </>
  );
}

function NodeRowFace({ node, path }: RowFaceProps) {
  if (node.ether?.entity?.kind === "agent") return <AgentRowFace node={node} path={path} />;
  return (
    <>
      <NodeKindMark node={node} className="command-bar__mark" />
      <span className="command-bar__row-main">
        <RowHead node={node} path={path} />
        <span className="command-bar__row-detail">
          {node.type === "group" ? <RegionDetail node={node} /> : nodeDetail(node)}
        </span>
      </span>
    </>
  );
}

type CommandBarRow =
  | { readonly kind: "node"; readonly node: CanvasNode; readonly index: number; readonly position: number }
  | { readonly kind: "action"; readonly action: CommandBarAction; readonly position: number };

export function CommandBar() {
  const doc = use$(state$.doc);
  const recentIds = use$(state$.hotbarActiveMru);
  const [query, setQuery] = useState("");
  const [tabMode, setTabMode] = useState<"nodes" | "actions">("nodes");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    claimFocus(inputRef.current, "open");
  }, []);

  // Catalog is rebuilt once per open so labels reflect live state.
  const actions = useMemo(() => buildCommandBarActions(), []);
  const mode = commandBarMode(query, tabMode);
  // Agents lead the list, most urgent first. Read once per open (and per doc
  // change), not live: rows never jump under the cursor. Each row's ring and
  // line stay live.
  const urgencyById = useMemo(
    () =>
      new Map(
        doc.nodes
          .filter((node) => node.ether?.entity?.kind === "agent")
          .map((node) => [node.id, seatUrgencyNow(node)] as const),
      ),
    [doc.nodes],
  );
  // Region paths are derived once per doc revision, never per keystroke.
  const regionPathById = useMemo(() => regionPaths(doc), [doc]);
  const nodeMatches = useMemo(
    () => filterCommandBarNodes(doc.nodes, query, recentIds, urgencyById, regionPathById),
    [doc.nodes, query, recentIds, urgencyById, regionPathById],
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
    <OperatorModalShell id="search" label="Command bar" width={700} fill panelClassName="command-bar">
        <div className="command-bar__input-row">
          <Search size={14} />
          <input
            ref={inputRef}
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
                claimFocus(inputRef.current, "gesture", { event });
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
                  <NodeRowFace node={row.node} path={regionPathById.get(row.node.id)} />
                  <span className="command-bar__row-kind">{nodeTypeLabel(row.node)}</span>
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
    </OperatorModalShell>
  );
}
