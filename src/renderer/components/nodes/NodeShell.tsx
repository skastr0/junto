import { useEffect, type ReactNode } from "react";
import { Handle, NodeResizer, NodeToolbar, Position } from "@xyflow/react";
import { use$ } from "@legendapp/state/react";
import {
  Ban,
  Crosshair,
  ExternalLink,
  LocateFixed,
  Maximize2,
  Pause,
  Play,
  Trash2,
  X,
} from "lucide-react";
import type { CanvasNode, EtherFlag } from "@shared/canvas";
import type { PreambleEvent } from "@shared/preamble";
import { executionGraphContextFromActorRefs } from "@shared/graph";
import { isExecutableNode } from "@shared/station";
import { accentColor, borderColor, HUE, withAlpha } from "../../lib/theme";
import { resizeNode } from "../../lib/geometry";
import { deleteNode, toggleFlag } from "../../lib/mutations";
import { state$, toggleConnectionFocus } from "../../lib/state";
import { ensurePauseState, nodePausedIn, pause$, setScopePaused } from "../../lib/pause-state";
import { herdr$ } from "../../lib/herdr-state";
import { isHerdrCanvasNode, nodeBlockPresentation } from "../../lib/node-block-state";
import { attentionOf } from "@shared/attention";
import { deriveOccupancy } from "@shared/occupancy";
import { useNodeOccupancyClue } from "../../lib/occupancy-feed";
import { kernel$ } from "../../lib/kernel-view";
import { executionGraphForImpact } from "../../lib/impact-mode";
import { dismissPreamble, preambleByNodeId$ } from "../../lib/preamble-state";
import { focusBlockerCause, resolveBlockerCause } from "../../lib/blocker-cause";
import {
  stopNodeGestureUnlessMultiSelect,
  useShiftMultiSelectDominance,
} from "../../lib/multi-select-gesture";
import { Chip, IconButton, ToolbarPill } from "../ui";

const HANDLE_SIDES = [["top", Position.Top], ["right", Position.Right], ["bottom", Position.Bottom], ["left", Position.Left]] as const;
const FLAG_HUES: Record<EtherFlag, string> = {
  blocker: HUE.crimson,
  attention: HUE.amber,
  parked: HUE.violet,
};

function PreambleBubble({
  nodeId,
  preamble,
}: {
  readonly nodeId: string;
  readonly preamble: PreambleEvent;
}) {
  return (
    <div
      className="vellum-node__preamble nodrag nopan"
      data-testid="node-preamble"
      data-node-id={nodeId}
      data-preamble-id={preamble.preambleId}
      role="status"
      aria-live="polite"
    >
      <span className="vellum-node__preamble-text">{preamble.text}</span>
      <button
        type="button"
        className="vellum-node__preamble-close nodrag nopan"
        aria-label="Dismiss preamble"
        title="Dismiss"
        onPointerDown={(event) => {
          if (stopNodeGestureUnlessMultiSelect(event, { preventDefault: true })) return;
          event.preventDefault();
        }}
        onClick={(event) => {
          if (stopNodeGestureUnlessMultiSelect(event, { preventDefault: true })) return;
          event.preventDefault();
          dismissPreamble(nodeId, preamble.preambleId);
        }}
      >
        <X size={11} />
      </button>
    </div>
  );
}

function ConnectionHandles() {
  return <>{HANDLE_SIDES.map(([name, pos]) => <Handle key={`s-${name}`} id={`s-${name}`} aria-label={`Connect from ${name}`} type="source" position={pos} className={`vellum-handle vellum-handle--source vellum-handle--${name}`} />)}{HANDLE_SIDES.map(([name, pos]) => <Handle key={`t-${name}`} id={`t-${name}`} aria-label={`Connect to ${name}`} type="target" position={pos} className={`vellum-handle vellum-handle--target vellum-handle--${name}`} />)}</>;
}

function MinimalNodeToolbar({
  selected,
  nodeId,
}: {
  readonly selected: boolean;
  readonly nodeId: string;
}) {
  const multiSelect = use$(() => state$.selectedNodeIds.get().length > 1);
  if (!selected || multiSelect) return null;
  return (
    <NodeToolbar isVisible position={Position.Top} offset={8}>
      <ToolbarPill>
        <IconButton
          className="nodrag nopan"
          tone="danger"
          aria-label="Delete label"
          title="Delete"
          onPointerDown={(event) => {
            if (stopNodeGestureUnlessMultiSelect(event, { preventDefault: true })) return;
            event.preventDefault();
            deleteNode(nodeId);
          }}
        >
          <Trash2 size={14} />
        </IconButton>
      </ToolbarPill>
    </NodeToolbar>
  );
}

function NodeActions({
  node,
  selected,
  onMaximize,
  toolbarExtras,
  flagBlocker,
  liveHerdrBlocked,
  shellBlocked,
  nodePaused,

}: {
  readonly node: CanvasNode;
  readonly selected: boolean;
  readonly onMaximize?: () => void;
  readonly toolbarExtras?: ReactNode;
  /** Document ether.flags includes blocker. */
  readonly flagBlocker: boolean;
  /** Live herdr agent_status blocked — not a document flag. */
  readonly liveHerdrBlocked: boolean;
  /** Graph blocked or seed chrome — may have a resolvable cause. */
  readonly shellBlocked: boolean;
  /** Node-scope pause (undefined = not an executable seat, no toggle). */
  readonly nodePaused?: boolean;

}) {
  // Toolbar toggle only mutates the document flag. Live herdr blocked paints
  // crimson but clear still means "clear flag" (or no-op if flag absent).
  const chromeBlocker = flagBlocker || liveHerdrBlocked;
  const connectionFocused = use$(() => state$.connectionFocusNodeId.get() === node.id);
  // Multi-select: RTS bar owns bulk actions — suppress floating pills.
  const multiSelect = use$(() => state$.selectedNodeIds.get().length > 1);
  const title = flagBlocker
    ? "clear blocker flag"
    : liveHerdrBlocked
      ? "herdr blocked (live) — flag to pin"
      : "flag blocker";

  // Only resolve the waiting-on path while selected + blocked. One selector:
  // Legend State tracks only what a selector actually reads, so an
  // unselected/unblocked card reads no observables and never re-renders on
  // kernel ticks or doc changes (the old five use$ subscriptions re-rendered
  // every card per tick; the memo only skipped the cause walk).
  const cause = use$(() => {
    if (!selected || !shellBlocked) return null;
    const doc = state$.doc.get();
    const execution = kernel$.execution.get();
    kernel$.executionRev.get(); // kernel-tick dep: execution identity can stay stable while blocked/reasons flip
    const canvasName = state$.canvasName.get();
    const actorRefs = state$.actorRefs.get();
    const context = executionGraphContextFromActorRefs(canvasName, actorRefs);
    const graph = executionGraphForImpact(doc, execution, context);
    const blockedActorSeatId = actorRefs.find((ref) => ref.nodeId === node.id)?.seatId;
    return resolveBlockerCause(doc, graph, node.id, { blockedActorSeatId });
  });

  if (!selected || multiSelect) return null;
  return (
    <NodeToolbar isVisible position={Position.Top} offset={8}>
      <ToolbarPill>
        {onMaximize ? (
          <IconButton
            className="nodrag nopan"
            aria-label="Expand note editor"
            title="Expand editor"
            onPointerDown={(event) => {
              if (stopNodeGestureUnlessMultiSelect(event, { preventDefault: true })) return;
              event.preventDefault();
              onMaximize();
            }}
          >
            <Maximize2 size={14} />
          </IconButton>
        ) : null}
        {toolbarExtras}
        <IconButton
          className="nodrag nopan"
          aria-label={connectionFocused ? "Clear node focus" : "Focus node"}
          aria-pressed={connectionFocused}
          title={connectionFocused ? "Clear connection focus" : "Show this node's connections"}
          data-testid="node-toolbar-focus"
          data-focused={connectionFocused ? "true" : "false"}
          style={connectionFocused ? { color: HUE.cyan } : undefined}

          onPointerDown={(event) => {
            if (stopNodeGestureUnlessMultiSelect(event, { preventDefault: true })) return;
            event.preventDefault();
          }}
          onClick={(event) => {
            if (stopNodeGestureUnlessMultiSelect(event, { preventDefault: true })) return;
            event.preventDefault();
            toggleConnectionFocus(node.id);
          }}
        >
          <Crosshair size={14} />
        </IconButton>
        {cause ? (
          <IconButton
            className="nodrag nopan"
            aria-label={
              cause.isSelf
                ? cause.openWorkDetail
                  ? `Open blocker cause: ${cause.title}`
                  : `Focus blocker cause: ${cause.title}`
                : `Jump to blocker cause: ${cause.title}`
            }
            style={{ color: HUE.crimson }}
            title={
              cause.isSelf
                ? cause.openWorkDetail
                  ? `open cause - ${cause.title}`
                  : `blocker cause - ${cause.title}`
                : `jump to cause - ${cause.title}`
            }
            data-testid="node-toolbar-blocker-cause"
            onPointerDown={(event) => {
              if (stopNodeGestureUnlessMultiSelect(event, { preventDefault: true })) return;
              event.preventDefault();
              focusBlockerCause(cause);
            }}
          >
            <LocateFixed size={14} />
          </IconButton>
        ) : null}
        {nodePaused !== undefined ? (
          <IconButton
            className="nodrag nopan"
            aria-label={nodePaused ? "Resume node" : "Pause node"}
            style={{ color: nodePaused ? HUE.amber : undefined }}
            title={nodePaused ? "Resume" : "Pause"}
            data-testid="node-toolbar-pause"
            data-paused={nodePaused ? "true" : "false"}
            onPointerDown={(event) => {
              if (stopNodeGestureUnlessMultiSelect(event, { preventDefault: true })) return;
              event.preventDefault();
              void setScopePaused({ kind: "node", id: node.id }, !nodePaused);
            }}
          >
            {nodePaused ? <Play size={14} /> : <Pause size={14} />}
          </IconButton>
        ) : null}
        <IconButton
          className="nodrag nopan"
          aria-label={flagBlocker ? "Clear blocker flag" : "Flag blocker"}
          style={{ color: chromeBlocker ? HUE.crimson : undefined }}
          title={title}
          onPointerDown={(event) => {
            if (stopNodeGestureUnlessMultiSelect(event, { preventDefault: true })) return;
            event.preventDefault();
            toggleFlag(node.id, "blocker");
          }}
        >
          <Ban size={14} />
        </IconButton>
        <IconButton
          className="nodrag nopan"
          tone="danger"
          aria-label="Delete node"
          title="Delete node"
          onPointerDown={(event) => {
            if (stopNodeGestureUnlessMultiSelect(event, { preventDefault: true })) return;
            event.preventDefault();
            deleteNode(node.id);
          }}
        >
          <Trash2 size={14} />
        </IconButton>
      </ToolbarPill>
    </NodeToolbar>
  );
}

export function NodeShell({
  node,
  selected,
  blocked,
  onMaximize,
  onOpen,
  openIcon,
  openTitle,
  toolbarExtras,
  resizable = true,
  /** When false, no source/target handles (labels). */
  showHandles = true,
  /**
   * Bare map furniture: no fill, no card border; selection is a light outline.
   * Used by geography labels so they read as free text on the field.
   */
  bare = false,
  /** Full factory toolbar vs delete-only (labels). */
  toolbar = "full",

  children,
}: {
  readonly node: CanvasNode;
  readonly selected: boolean;
  readonly blocked: boolean;
  readonly onMaximize?: () => void;
  readonly onOpen?: () => void;
  readonly openIcon?: ReactNode;
  readonly openTitle?: string;
  readonly toolbarExtras?: ReactNode;
  /** Fixed-geometry instruments (actors) do not expose meaningless resizing. */
  readonly resizable?: boolean;
  readonly showHandles?: boolean;
  readonly bare?: boolean;
  readonly toolbar?: "full" | "minimal";

  readonly children: ReactNode;
}) {
  // Live herdr meta: agent_status blocked paints shell chrome without a doc flag.
  const herdrMeta = use$(herdr$.metaByNodeId[node.id]);
  const herdrAgentStatus = isHerdrCanvasNode(node) ? herdrMeta?.meta?.agentStatus : undefined;
  const { isBlocker, shellBlocked, liveHerdrBlocked, flags } = nodeBlockPresentation({
    node,
    graphBlocked: blocked,
    herdrAgentStatus,
  });
  // Occupancy (S5 cut 2): derived, never document truth (I11) — this never
  // writes to `node`. ActivityFeed today only has an opinion on agent seats
  // (ACP chat plane) and document flags; every other node renders "empty".
  const occupancyClue = useNodeOccupancyClue(node);
  const occupancyState = deriveOccupancy({
    hasOccupant: occupancyClue?.hasOccupant ?? false,
    activity: occupancyClue?.activity,
    lastSeenAtMs: occupancyClue?.lastSeenAtMs,
    flags: occupancyClue?.flags,
    nowMs: Date.now(),
  });
  const preamble = use$(() => preambleByNodeId$[node.id].get());
  // Fire/ice glance: document + blocked prop (phase graph lives upstream).
  const attention = attentionOf(
    node,
    blocked
      ? {
          phaseByEdgeId: new Map(),
          detailByEdgeId: new Map(),
          edgeEvalById: new Map(),
          blocked: new Set([node.id]),
          blockedEdgeIds: new Set(),
          reasonsByNodeId: new Map(),
          seedNodeIds: new Set(),
        }
      : {
          phaseByEdgeId: new Map(),
          detailByEdgeId: new Map(),
          edgeEvalById: new Map(),
          blocked: new Set(),
          blockedEdgeIds: new Set(),
          reasonsByNodeId: new Map(),
          seedNodeIds: new Set(),
        },
  );
  const flagBlocker = flags.includes("blocker");
  const flagAttention = flags.includes("attention");
  // Live managed-seat attention (occupancy) paints amber without a doc flag.
  const liveSeatAttention = occupancyState === "attention" && !flagAttention;
  // Executable seats get pause chrome; placement class/tier lives in the
  // inspector only (not on the card body).
  const executable = isExecutableNode(node);
  // Node-scope pause (executable seats only). Fine-grained selector: only
  // this node re-renders when its own pausedNodes membership flips.
  const nodePaused = use$(() =>
    executable ? nodePausedIn(pause$.state.get(), node.id) : false,
  );
  useEffect(() => {
    if (!executable) return;
    ensurePauseState(state$.canvasName.peek());
  }, [executable, node.id]);
  const primaryFlag: EtherFlag | undefined = isBlocker
    ? "blocker"
    : flagAttention || liveSeatAttention
      ? "attention"
      : flags.includes("parked")
        ? "parked"
        : undefined;
  const primaryHue = primaryFlag ? FLAG_HUES[primaryFlag] : undefined;
  const accent = accentColor(node.color);
  const border = bare
    ? selected
      ? withAlpha(accent, 0.55)
      : "transparent"
    : shellBlocked
      ? HUE.crimson
      : primaryHue
        ? withAlpha(primaryHue, 0.52)
        : borderColor(node.color, selected);
  const background = bare
    ? "transparent"
    : shellBlocked
      ? `linear-gradient(135deg, ${withAlpha(HUE.crimson, 0.12)}, color-mix(in oklab, var(--color-ground) 92%, transparent))`
      : primaryFlag === "attention"
        ? `linear-gradient(135deg, ${withAlpha(HUE.amber, 0.09)}, color-mix(in oklab, var(--color-ground) 96%, transparent))`
        : primaryFlag === "parked"
          ? `linear-gradient(135deg, ${withAlpha(HUE.violet, 0.09)}, color-mix(in oklab, var(--color-ground) 96%, transparent))`
          : "linear-gradient(135deg, color-mix(in oklab, var(--color-raise) 94%, transparent), color-mix(in oklab, var(--color-ground) 96%, transparent))";
  const shadow = bare
    ? selected
      ? `0 0 0 1px ${withAlpha(accent, 0.35)}`
      : "none"
    : selected
      ? `0 0 0 1px ${withAlpha(shellBlocked ? HUE.crimson : accent, 0.25)}, 0 12px 30px var(--color-shadow-2)`
      : shellBlocked
        ? `0 0 0 1px ${withAlpha(HUE.crimson, 0.18)}, 0 10px 28px var(--color-shadow-2)`
        : primaryFlag === "attention"
          ? `0 0 0 1px ${withAlpha(HUE.amber, 0.14)}, 0 10px 28px var(--color-shadow-2)`
          : primaryFlag === "parked"
            ? `0 0 0 1px ${withAlpha(HUE.violet, 0.14)}, 0 10px 28px var(--color-shadow-2)`
            : "0 10px 28px var(--color-shadow-2)";
  // Shift+click multi-select dominates all node chrome (labels, open, edit).
  const multiSelectCapture = useShiftMultiSelectDominance(node.id);
  // Pulse wash for stoppage chrome (graph blocked, flag, herdr).
  // isBlocker alone used to skip actors blocked only by upstream criteria.
  return (
    <div
      className={`vellum-node group relative flex h-full w-full flex-col overflow-visible ${bare ? "vellum-node--bare rounded-sm px-1 py-0.5" : "rounded-[10px] px-3.5 py-3"} ${shellBlocked ? "vellum-blocker" : ""}`}
      data-node-kind={node.ether?.entity?.kind ?? node.type}
      data-bare={bare ? "true" : undefined}
      data-blocked={shellBlocked ? "true" : undefined}
      data-herdr-blocked={liveHerdrBlocked ? "true" : undefined}
      data-seat-attention={liveSeatAttention ? "true" : undefined}
      data-occupancy={occupancyState}
      data-attention={attention === "idle" && liveSeatAttention ? "fire" : attention}
      onPointerDownCapture={multiSelectCapture.onPointerDownCapture}
      onClickCapture={multiSelectCapture.onClickCapture}
      style={{
        border: `1px solid ${bare ? border : selected ? withAlpha(isBlocker || shellBlocked ? HUE.crimson : accent, 0.75) : border}`,
        background,
        boxShadow: shadow,
      }}
    >
      {preamble ? <PreambleBubble nodeId={node.id} preamble={preamble} /> : null}
      {resizable ? (
        <NodeResizer
          isVisible={selected}
          minWidth={bare ? 48 : 170}
          minHeight={bare ? 24 : 72}
          // Never paint amber/gold resize chrome over stoppage crimson.
          color={shellBlocked || isBlocker ? HUE.crimson : accent}
          handleClassName="vellum-resize-handle"
          lineClassName="vellum-resize-line"
          onResizeEnd={(_event, params) => resizeNode(node.id, params)}
        />
      ) : null}
      {onOpen ? (
        <button
          className="vellum-node__open nodrag nopan absolute right-2 top-2 z-10 grid size-6 place-items-center rounded text-cyan-300/70 transition hover:bg-white/10 hover:text-cyan-200"
          aria-label={openTitle ?? "Open external link"}
          title={openTitle ?? "Open link"}

          onPointerDown={(event) => {
            if (stopNodeGestureUnlessMultiSelect(event, { preventDefault: true })) return;
            event.preventDefault();
            onOpen();
          }}
        >
          {openIcon ?? <ExternalLink size={12} />}
        </button>
      ) : null}
      {showHandles ? <ConnectionHandles /> : null}
      {toolbar === "minimal" ? (
        <MinimalNodeToolbar selected={selected} nodeId={node.id} />
      ) : (
        <NodeActions
          node={node}
          selected={selected}
          onMaximize={onMaximize}
          toolbarExtras={toolbarExtras}
          flagBlocker={flagBlocker}
          liveHerdrBlocked={liveHerdrBlocked}
          shellBlocked={shellBlocked}
          nodePaused={executable ? nodePaused : undefined}
        />
      )}
      {!bare && (flags.length > 0 || liveHerdrBlocked || liveSeatAttention || (shellBlocked && !flagBlocker && !liveHerdrBlocked)) ? (

        <div className="vellum-node__flag-rail">
          {shellBlocked && !flagBlocker && !liveHerdrBlocked ? (
            <span
              key="graph-blocked"
              className="vellum-node__flag vellum-node__flag--blocked-live"
              title="Blocked — waiting on connected work"
              style={{
                color: FLAG_HUES.blocker,
                borderColor: withAlpha(FLAG_HUES.blocker, 0.36),
                background: withAlpha(FLAG_HUES.blocker, 0.09),
              }}
            >
              blocked
            </span>
          ) : null}
          {liveHerdrBlocked && !flagBlocker ? (
            <span
              key="herdr-blocked"
              className="vellum-node__flag vellum-node__flag--blocked-live"
              title="Blocked"
              style={{
                color: FLAG_HUES.blocker,
                borderColor: withAlpha(FLAG_HUES.blocker, 0.36),
                background: withAlpha(FLAG_HUES.blocker, 0.09),
              }}
            >
              blocker
            </span>
          ) : null}
          {liveSeatAttention ? (
            <Chip key="seat-attention" tone="amber" title="Needs your input">
              needs input
            </Chip>
          ) : null}
          {flags.map((flag) => (
            <span
              key={flag}
              className="vellum-node__flag"
              style={{
                color: FLAG_HUES[flag],
                borderColor: withAlpha(FLAG_HUES[flag], 0.36),
                background: withAlpha(FLAG_HUES[flag], 0.09),
              }}
            >
              {flag}
            </span>
          ))}
        </div>
      ) : null}
      <div className="vellum-node__body min-h-0 flex-1 overflow-hidden">
        <div className="h-full min-h-0 overflow-hidden">{children}</div>
      </div>
    </div>
  );
}
