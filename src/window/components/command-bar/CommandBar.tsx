import { use$ } from "@legendapp/state/react";
import { Search, X } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Node, NodeOf } from "@shared/model";
import { titleOf } from "@shared/model/title";
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
  type AgentStanding,
} from "../../lib/command-bar";
import { closeOperatorModal } from "../../lib/operator-modal";
import { detailOf } from "../../lib/node-presentation";
import { useRegionRollups } from "../../lib/region-rollups";
import { regionPaths, regionTrails, type RegionStep } from "../../lib/region-path";
import { regionTallyParts } from "../../lib/region-glance";
import { seatSaying } from "../../lib/seat-line";
import { agentSeat$ } from "../../lib/agent-seat-state";
import { seatSignalRollups$ } from "../../lib/agent-signals-state";
import { kernel$ } from "../../lib/kernel-view";
import { state$ } from "../../lib/state";
import { terminal$ } from "../../lib/terminal-state";
import { useCanvas } from "../../lib/use-model";
import { accentColor, HUE, HUE_TEXT } from "../../lib/theme";
import { KindMark } from "../NodeKindMark";
import { RegionCrumb } from "../RegionCrumb";
import { SeatRingView, seatStandingOf, useSeatGlanceOf, type SeatGlance } from "../SeatRing";
import { Kbd } from "../ui";
import { claimFocus } from "../../lib/focus-ownership";
import { OperatorModalShell } from "../operator-modal/OperatorModalShell";
import { keyIs } from "../../lib/key-match";
import { isModalLayerOpen } from "../../lib/modal-stack";

/**
 * cmd+K command bar — quick node navigation plus a quick-actions mode.
 *
 * A centered floating palette that fills most of the window height. Agents
 * lead the list, most urgent first (see filterCommandBarNodes). Typing
 * filters the LIST; the canvas never changes while searching. In node mode
 * Enter carries on what the operator was doing: over the canvas it goes to
 * the node (select + one-shot camera fit), over a working modal it opens the
 * node there. cmd+Enter always opens.
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
function RegionDetail({ node }: { readonly node: NodeOf<"region"> }) {
  const tally = useRegionRollups((rows) => rows.find((row) => row.regionId === node.id)?.counts ?? null) ?? undefined;
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
  const briefing = node.instruction?.trim().split("\n")[0];
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
    words = <span style={{ color: HUE_TEXT.amber }}>{saying.text}</span>;
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
  trail,
  accent,
}: {
  readonly node: Node;
  readonly trail: ReadonlyArray<RegionStep> | undefined;
  readonly accent?: boolean;
}) {
  return (
    <span className="command-bar__row-head">
      <span
        className="command-bar__row-title"
        style={accent && node.color ? { color: accentColor(node.color) } : undefined}
      >
        {titleOf(node)}
      </span>
      {trail ? (
        <RegionCrumb trail={trail} className="command-bar__row-path" testId="command-bar-row-crumb" />
      ) : null}
    </span>
  );
}

type RowFaceProps = { readonly node: Node; readonly trail: ReadonlyArray<RegionStep> | undefined };

function AgentRowFace({ node, trail }: { readonly node: NodeOf<"agent">; readonly trail: ReadonlyArray<RegionStep> | undefined }) {
  const glance = useSeatGlanceOf(node);
  return (
    <>
      <span className="command-bar__mark command-bar__mark--seat">
        <SeatRingView node={node} px={28} glance={glance} />
      </span>
      <span className="command-bar__row-main">
        <RowHead node={node} trail={trail} accent />
        <span className="command-bar__row-detail">
          <AgentDetail glance={glance} />
        </span>
      </span>
    </>
  );
}

function NodeRowFace({ node, trail }: RowFaceProps) {
  if (node.kind === "agent") return <AgentRowFace node={node} trail={trail} />;
  return (
    <>
      <KindMark node={node} className="command-bar__mark" />
      <span className="command-bar__row-main">
        <RowHead node={node} trail={trail} />
        <span className="command-bar__row-detail">
          {node.kind === "region" ? <RegionDetail node={node} /> : detailOf(node)}
        </span>
      </span>
    </>
  );
}

type CommandBarRow =
  | { readonly kind: "node"; readonly node: Node; readonly index: number; readonly position: number }
  | { readonly kind: "action"; readonly action: CommandBarAction; readonly position: number };

/** A row's identity: it holds the cursor when the list re-ranks under it. */
const rowKeyOf = (row: CommandBarRow): string =>
  row.kind === "node" ? row.node.id : `action:${row.action.id}`;

// One option row. Memoized on its content: a keystroke re-filters the list,
// but a row whose node, slot and active state did not move does not repaint
// its ring. The seat's own glance still updates inside the row's hooks.
const CommandBarNodeRow = memo(function CommandBarNodeRow({
  node,
  index,
  position,
  isActive,
  trail,
  onHover,
  onCommit,
}: {
  readonly node: Node;
  readonly index: number;
  readonly position: number;
  readonly isActive: boolean;
  readonly trail: ReadonlyArray<RegionStep> | undefined;
  readonly onHover: (key: string) => void;
  readonly onCommit: (node: Node, open: boolean) => void;
}) {
  return (
    <div
      id={`command-bar-option-${index}`}
      role="option"
      aria-selected={isActive}
      data-index={position}
      className={["command-bar__row", isActive ? "command-bar__row--active" : ""].filter(Boolean).join(" ")}
      onPointerMove={() => onHover(node.id)}
      onPointerDown={(event) => {
        event.preventDefault();
        onCommit(node, event.metaKey || event.ctrlKey);
      }}
    >
      <NodeRowFace node={node} trail={trail} />
      <span className="command-bar__row-kind">{node.kind}</span>
    </div>
  );
});

const CommandBarActionRow = memo(function CommandBarActionRow({
  action,
  position,
  isActive,
  onHover,
  onCommit,
}: {
  readonly action: CommandBarAction;
  readonly position: number;
  readonly isActive: boolean;
  readonly onHover: (key: string) => void;
  readonly onCommit: (action: CommandBarAction) => void;
}) {
  return (
    <div
      id={`command-bar-action-${position}`}
      role="option"
      aria-selected={isActive}
      data-index={position}
      className={[
        "command-bar__row",
        "command-bar__row--action",
        isActive ? "command-bar__row--active" : "",
      ].filter(Boolean).join(" ")}
      onPointerMove={() => onHover(`action:${action.id}`)}
      onPointerDown={(event) => {
        event.preventDefault();
        onCommit(action);
      }}
    >
      <span className="command-bar__row-icon">
        <action.icon size={13} />
      </span>
      <span className="command-bar__row-main">
        <span className="command-bar__row-title">{action.label}</span>
        <span className="command-bar__row-detail">{action.detail}</span>
      </span>
      {action.hotkey ? <Kbd>{action.hotkey}</Kbd> : null}
    </div>
  );
});

export function CommandBar() {
  const canvas = useCanvas(use$(state$.canvasName));
  const nodes = useMemo(() => [...canvas.nodes.values()].sort((a, b) => a.z - b.z), [canvas]);
  const recentIds = use$(state$.hotbarActiveMru);
  const [query, setQuery] = useState("");
  const [tabMode, setTabMode] = useState<"nodes" | "actions">("nodes");
  // The cursor is a row, not a position: a live re-rank moves the list, never the selection.
  const [activeKey, setActiveKey] = useState<string | undefined>(undefined);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    claimFocus(inputRef.current, "open");
  }, []);

  // Catalog is rebuilt once per open so labels reflect live state.
  const actions = useMemo(() => buildCommandBarActions(), []);
  const mode = commandBarMode(query, tabMode);
  // Agents lead the list in the palette's one order (the Palette view). Live: a
  // seat's state change re-ranks the list while it is open, and the cursor
  // stays on its row. The map keeps its identity while every agent's
  // {group, since} is unchanged: the selector re-runs on any seat-store ping,
  // and a fresh Map each time would re-rank (and repaint) the whole list for
  // a change that moved nothing.
  const standingsCache = useRef<ReadonlyMap<string, AgentStanding>>(new Map());
  const standingById = use$((): ReadonlyMap<string, AgentStanding> => {
    // Track the coarse stamps the standings read, not the per-seat paths:
    // agentSeat$'s rev moves on every seat write, executionRev on the kernel
    // snapshot, the rollups record and the session map on their own changes.
    // The standings themselves are peeked, so one ping re-reads them without
    // re-subscribing hundreds of paths.
    agentSeat$.rev.get();
    kernel$.executionRev.get();
    seatSignalRollups$.get();
    terminal$.sessionByBindingId.get();
    const agents = nodes.filter((node): node is NodeOf<"agent"> => node.kind === "agent");
    const previous = standingsCache.current;
    let dirty = agents.length !== previous.size;
    if (!dirty) {
      for (const node of agents) {
        const standing = seatStandingOf(node, false);
        const before = previous.get(node.id);
        if (before === undefined || before.group !== standing.group || before.since !== standing.since) {
          dirty = true;
          break;
        }
      }
    }
    if (!dirty) return previous;
    const next = new Map<string, AgentStanding>();
    for (const node of agents) next.set(node.id, seatStandingOf(node, false));
    standingsCache.current = next;
    return next;
  });
  // Region paths are derived once per canvas change, never per keystroke.
  const regionPathById = useMemo(() => regionPaths(canvas), [canvas]);
  const regionTrailById = useMemo(() => regionTrails(canvas), [canvas]);
  const nodeMatches = useMemo(
    () => filterCommandBarNodes(nodes, query, recentIds, standingById, regionPathById),
    [nodes, query, recentIds, standingById, regionPathById],
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
    setActiveKey(undefined);
  }, [query, mode]);

  // The cursor's row, wherever the ranking has put it.
  const found = rows.findIndex((row) => rowKeyOf(row) === activeKey);
  const active = found === -1 ? 0 : found;
  const firstKey = rows[0] ? rowKeyOf(rows[0]) : undefined;

  // Pin the cursor to a row at once (a fresh list, or its row left it), so a
  // re-rank never carries it along with whatever is on top.
  useEffect(() => {
    if (found === -1 && firstKey !== undefined) setActiveKey(firstKey);
  }, [found, firstKey]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, activeKey]);

  // Read once per open: search sits over whatever the operator was in.
  const overModal = useMemo(() => isModalLayerOpen("working"), []);

  const commitNode = useCallback(
    (node: Node, open: boolean): void => {
      focusCanvasNode(node.id);
      if (open || overModal) activateNodeSurface(node.id);
      closeCommandBar();
    },
    [overModal],
  );
  const commitAction = useCallback((action: CommandBarAction): void => {
    action.run();
    closeCommandBar();
  }, []);
  const commit = (row: CommandBarRow, open: boolean): void => {
    if (row.kind === "node") commitNode(row.node, open);
    else commitAction(row.action);
  };
  const hoverRow = useCallback((key: string) => setActiveKey(key), []);

  const rowKeyAt = (position: number): string | undefined => {
    const row = rows[position];
    return row ? rowKeyOf(row) : undefined;
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      setActiveKey(rowKeyAt(Math.min(active + 1, rows.length - 1)));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      setActiveKey(rowKeyAt(Math.max(active - 1, 0)));
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
      commit(row, keyIs(event, "inSearch.open"));
      return;
    }
  };

  const activeRow = rows[active];
  const activeRowKey = activeRow ? rowKeyOf(activeRow) : undefined;
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
              // A press must not pull the caret out of the field; the click is
              // the clear, and it is the one activation a pointer, Enter or
              // Space on the button, and a screen reader's invoke all produce.
              onPointerDown={(event) => event.preventDefault()}
              onClick={(event) => {
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
                <CommandBarNodeRow
                  key={row.node.id}
                  node={row.node}
                  index={row.index}
                  position={row.position}
                  isActive={rowKeyOf(row) === activeRowKey}
                  trail={regionTrailById.get(row.node.id)}
                  onHover={hoverRow}
                  onCommit={commitNode}
                />
              ) : (
                <CommandBarActionRow
                  key={row.action.id}
                  action={row.action}
                  position={row.position}
                  isActive={rowKeyOf(row) === activeRowKey}
                  onHover={hoverRow}
                  onCommit={commitAction}
                />
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
                <span className="command-bar__hint" data-testid="command-bar-enter-hint">
                  {overModal ? "open" : "go to"}
                </span>
                {overModal ? null : (
                  <>
                    <Kbd>⌘↵</Kbd>
                    <span className="command-bar__hint">open</span>
                  </>
                )}
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
