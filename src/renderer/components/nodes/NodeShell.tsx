import { useEffect, useMemo, type ReactNode } from "react";
import { Handle, NodeResizer, NodeToolbar, Position } from "@xyflow/react";
import { use$ } from "@legendapp/state/react";
import {
  Ban,
  Crosshair,
  ExternalLink,
  LocateFixed,
  Maximize2,
  Pause,
  Pencil,
  Play,
  Trash2,
} from "lucide-react";
import type { CanvasNode, EtherFlag } from "@shared/canvas";
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
import { focusBlockerCause, resolveBlockerCause } from "../../lib/blocker-cause";
import { Chip, IconButton, ToolbarPill } from "../ui";

const HANDLE_SIDES = [["top", Position.Top], ["right", Position.Right], ["bottom", Position.Bottom], ["left", Position.Left]] as const;
const FLAG_HUES: Record<EtherFlag, string> = {
  blocker: HUE.crimson,
  attention: HUE.amber,
  parked: HUE.violet,
};

function ConnectionHandles() {
  return <>{HANDLE_SIDES.map(([name, pos]) => <Handle key={`s-${name}`} id={`s-${name}`} aria-label={`Connect from ${name}`} type="source" position={pos} className={`vellum-handle vellum-handle--source vellum-handle--${name}`} />)}{HANDLE_SIDES.map(([name, pos]) => <Handle key={`t-${name}`} id={`t-${name}`} aria-label={`Connect to ${name}`} type="target" position={pos} className={`vellum-handle vellum-handle--target vellum-handle--${name}`} />)}</>;
}

function NodeActions({
  node,
  selected,
  onEdit,
  onMaximize,
  toolbarExtras,
  flagBlocker,
  liveHerdrBlocked,
  shellBlocked,
  nodePaused,
}: {
  readonly node: CanvasNode;
  readonly selected: boolean;
  readonly onEdit?: () => void;
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
  const title = flagBlocker
    ? "clear blocker flag"
    : liveHerdrBlocked
      ? "herdr blocked (live) — flag to pin"
      : "flag blocker";

  // Only resolve the waiting-on path while selected + blocked — keeps idle
  // cards off the kernel/doc subscription for this walk.
  const doc = use$(state$.doc);
  const execution = use$(kernel$.execution);
  const executionRev = use$(kernel$.executionRev);
  const canvasName = use$(state$.canvasName);
  const actorRefs = use$(state$.actorRefs);
  const cause = useMemo(() => {
    if (!selected || !shellBlocked) return null;
    const context = executionGraphContextFromActorRefs(canvasName, actorRefs);
    const graph = executionGraphForImpact(doc, execution, context);
    const blockedActorSeatId = actorRefs.find((ref) => ref.nodeId === node.id)?.seatId;
    return resolveBlockerCause(doc, graph, node.id, { blockedActorSeatId });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- executionRev is the kernel tick; execution object identity alone can stay stable while blocked/reasons flip
  }, [
    selected,
    shellBlocked,
    node.id,
    doc,
    execution,
    executionRev,
    canvasName,
    actorRefs,
  ]);

  return (
    <NodeToolbar isVisible={selected} position={Position.Top} offset={8}>
      <ToolbarPill>
        {onEdit ? (
          <IconButton
            className="nodrag nopan"
            aria-label="Edit item"
            title="edit item"
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onEdit();
            }}
          >
            <Pencil size={14} />
          </IconButton>
        ) : null}
        {onMaximize ? (
          <IconButton
            className="nodrag nopan"
            aria-label="Expand note editor"
            title="expand editor"
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
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
          title={connectionFocused ? "clear connection focus" : "focus node connections"}
          data-testid="node-toolbar-focus"
          data-focused={connectionFocused ? "true" : "false"}
          style={connectionFocused ? { color: HUE.cyan } : undefined}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
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
                  ? `open cause · ${cause.title}`
                  : `blocker cause · ${cause.title}`
                : `jump to cause · ${cause.title}`
            }
            data-testid="node-toolbar-blocker-cause"
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
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
            title={nodePaused ? "node paused — click to resume" : "pause node (seat stops acting)"}
            data-testid="node-toolbar-pause"
            data-paused={nodePaused ? "true" : "false"}
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
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
            event.preventDefault();
            event.stopPropagation();
            toggleFlag(node.id, "blocker");
          }}
        >
          <Ban size={14} />
        </IconButton>
        <IconButton
          className="nodrag nopan"
          tone="danger"
          aria-label="Delete node"
          title="delete node"
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
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
  onEdit,
  onMaximize,
  onOpen,
  openIcon,
  openTitle,
  toolbarExtras,
  inlineEdit = true,
  resizable = true,
  children,
}: {
  readonly node: CanvasNode;
  readonly selected: boolean;
  readonly blocked: boolean;
  readonly onEdit?: () => void;
  readonly onMaximize?: () => void;
  readonly onOpen?: () => void;
  readonly openIcon?: ReactNode;
  readonly openTitle?: string;
  readonly toolbarExtras?: ReactNode;
  // Set false when the card body owns its edit gesture (herdr renames inline)
  // so the corner pencil can't collide with card chrome. The NodeActions
  // toolbar pencil still appears — it shares the same onEdit.
  readonly inlineEdit?: boolean;
  /** Fixed-geometry instruments (actors) do not expose meaningless resizing. */
  readonly resizable?: boolean;
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
  const border = shellBlocked
    ? HUE.crimson
    : primaryHue
      ? withAlpha(primaryHue, 0.52)
      : borderColor(node.color, selected);
  const background = shellBlocked
    ? `linear-gradient(135deg, ${withAlpha(HUE.crimson, 0.12)}, rgba(18,15,13,0.92))`
    : primaryFlag === "attention"
      ? `linear-gradient(135deg, ${withAlpha(HUE.amber, 0.09)}, rgba(14,13,12,0.96))`
      : primaryFlag === "parked"
        ? `linear-gradient(135deg, ${withAlpha(HUE.violet, 0.09)}, rgba(14,13,12,0.96))`
        : "linear-gradient(135deg, rgba(30,25,20,0.94), rgba(14,13,12,0.96))";
  const shadow = selected
    ? `0 0 0 1px ${withAlpha(shellBlocked ? HUE.crimson : accent, 0.25)}, 0 12px 30px rgba(0,0,0,0.22)`
    : shellBlocked
      ? `0 0 0 1px ${withAlpha(HUE.crimson, 0.18)}, 0 10px 28px rgba(0,0,0,0.18)`
      : primaryFlag === "attention"
        ? `0 0 0 1px ${withAlpha(HUE.amber, 0.14)}, 0 10px 28px rgba(0,0,0,0.18)`
        : primaryFlag === "parked"
          ? `0 0 0 1px ${withAlpha(HUE.violet, 0.14)}, 0 10px 28px rgba(0,0,0,0.18)`
          : "0 10px 28px rgba(0,0,0,0.18)";
  // Pulse + corner spin for any stoppage chrome (graph blocked, flag, herdr).
  // isBlocker alone used to skip actors blocked only by upstream criteria.
  return (
    <div
      className={`vellum-node group relative flex h-full w-full flex-col overflow-visible rounded-[10px] px-3.5 py-3 ${shellBlocked ? "vellum-blocker" : ""}`}
      data-node-kind={node.ether?.entity?.kind ?? node.type}
      data-blocked={shellBlocked ? "true" : undefined}
      data-herdr-blocked={liveHerdrBlocked ? "true" : undefined}
      data-seat-attention={liveSeatAttention ? "true" : undefined}
      data-occupancy={occupancyState}
      data-attention={attention === "idle" && liveSeatAttention ? "fire" : attention}
      style={{
        border: `1px solid ${selected ? withAlpha(isBlocker || shellBlocked ? HUE.crimson : accent, 0.75) : border}`,
        background,
        boxShadow: shadow,
      }}
    >
      {resizable ? (
        <NodeResizer
          isVisible={selected}
          minWidth={170}
          minHeight={72}
          color={accent}
          handleClassName="vellum-resize-handle"
          lineClassName="vellum-resize-line"
          onResizeEnd={(_event, params) => resizeNode(node.id, params)}
        />
      ) : null}
      {onEdit && inlineEdit ? (
        <button
          className="vellum-node__edit nodrag nopan absolute right-2 top-2 z-10 grid size-6 place-items-center rounded text-dim transition hover:bg-white/10 hover:text-ink"
          aria-label="Edit item"
          title="edit item"
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onEdit();
          }}
        >
          <Pencil size={12} />
        </button>
      ) : null}
      {onOpen ? (
        <button
          className="vellum-node__open nodrag nopan absolute right-10 top-2 z-10 grid size-6 place-items-center rounded text-cyan-300/70 transition hover:bg-white/10 hover:text-cyan-200"
          aria-label={openTitle ?? "Open external link"}
          title={openTitle ?? "open external link"}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onOpen();
          }}
        >
          {openIcon ?? <ExternalLink size={12} />}
        </button>
      ) : null}
      <ConnectionHandles />
      <NodeActions
        node={node}
        selected={selected}
        onEdit={onEdit}
        onMaximize={onMaximize}
        toolbarExtras={toolbarExtras}
        flagBlocker={flagBlocker}
        liveHerdrBlocked={liveHerdrBlocked}
        shellBlocked={shellBlocked}
        nodePaused={executable ? nodePaused : undefined}
      />
      {flags.length > 0 || liveHerdrBlocked || liveSeatAttention || (shellBlocked && !flagBlocker && !liveHerdrBlocked) ? (
        <div className="vellum-node__flag-rail">
          {shellBlocked && !flagBlocker && !liveHerdrBlocked ? (
            <span
              key="graph-blocked"
              className="vellum-node__flag vellum-node__flag--blocked-live"
              title="blocked — waiting on upstream"
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
              title="herdr blocked (live)"
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
            <Chip key="seat-attention" tone="amber" title="needs operator input">
              !
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
