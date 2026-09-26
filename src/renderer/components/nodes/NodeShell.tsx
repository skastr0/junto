import {
  useEffect,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  Handle,
  NodeResizer,
  NodeToolbar,
  Position,
  useConnection,
  useUpdateNodeInternals,
} from "@xyflow/react";
import { use$ } from "@legendapp/state/react";
import {
  Ban,
  Crosshair,
  ExternalLink,
  LocateFixed,
  Maximize2,
  Trash2,
} from "lucide-react";
import type { CanvasNode, EtherFlag } from "@shared/canvas";
import { executionGraphContextFromActorRefs } from "@shared/graph";
import { accentColor, borderColor, HUE, withAlpha } from "../../lib/theme";
import { resizeNode } from "../../lib/geometry";
import { deleteNode, toggleFlag } from "../../lib/mutations";
import { state$, toggleConnectionFocus } from "../../lib/state";
import { nodeBlockPresentation } from "../../lib/node-block-state";
import { attentionOf } from "@shared/attention";
import { isHarnessId } from "@shared/managed-terminal-templates";
import { resolveTerminalBinding } from "@shared/terminal";
import { roleOf, VERB_COLOR_TOKEN, type Verb } from "@shared/physics";
import { verbHandleId, verbsForDraw } from "../../lib/edge-mutations";
import { deriveOccupancy } from "@shared/occupancy";
import {
  useNodeAttentionReasons,
  useNodeOccupancyClue,
} from "../../lib/occupancy-feed";
import { actorOccupancyAttr } from "../../lib/occupancy-chrome";
import { specOf } from "../../lib/node-spec";
import { agentSeat$ } from "../../lib/agent-seat-state";
import { terminal$ } from "../../lib/terminal-state";
import {
  notifyItem,
  seatFactsForNode,
} from "../../lib/seat-projections";
import { kernel$ } from "../../lib/kernel-view";
import { executionGraphForImpact } from "../../lib/impact-mode";
import { preambleByNodeId$ } from "../../lib/preamble-state";
import { PreambleBubble } from "./PreambleBubble";
import { focusBlockerCause, resolveBlockerCause } from "../../lib/blocker-cause";
import {
  stopNodeGestureUnlessMultiSelect,
  useShiftMultiSelectDominance,
} from "../../lib/multi-select-gesture";
import { Chip, IconButton, ToolbarPill } from "../ui";
import { isOverseerSeat } from "../../lib/overseer-set";

const HANDLE_SIDES = [["top", Position.Top], ["right", Position.Right], ["bottom", Position.Bottom], ["left", Position.Left]] as const;
const FLAG_HUES: Record<EtherFlag, string> = {
  blocker: HUE.crimson,
  attention: HUE.amber,
  parked: HUE.violet,
};

/**
 * Landing zones bleed past the card so the choice is made by approach, not by
 * pixel aim: the two halves already catch the wire before it reaches the edge.
 */
const VERB_ZONE_BLEED = 16;

const NO_CONNECTION_DRAG = { fromId: "", fromKind: "" } as const;

const NO_VERBS: ReadonlyArray<Verb> = [];

/**
 * Zone geometry, plus the verb's hue as `--zone-hue`.
 *
 * Only the shape is inline. The paint is in the stylesheet, because the half
 * under the cursor has to be the one that reads loudest and an inline colour
 * cannot be overridden by the state rule that says so — a generic accept ring
 * would land on top of it instead, in a colour that on this canvas is not this
 * verb. The fallback hue only has to keep the two halves apart until the
 * stylesheet names them, so it is positional rather than a second claim about
 * what the verb means.
 */
const verbZoneStyle = (verb: Verb, first: boolean): CSSProperties => {
  const shared: CSSProperties = {
    position: "absolute",
    top: -VERB_ZONE_BLEED,
    bottom: -VERB_ZONE_BLEED,
    width: `calc(50% + ${VERB_ZONE_BLEED}px)`,
    height: "auto",
    minWidth: 0,
    minHeight: 0,
    transform: "none",
    ["--zone-hue" as string]: `var(${VERB_COLOR_TOKEN[verb]}, ${first ? HUE.cyan : HUE.violet})`,
  };
  return first
    ? { ...shared, left: -VERB_ZONE_BLEED }
    : { ...shared, right: -VERB_ZONE_BLEED };
};

/**
 * The two-verb choice, made by where the wire lands. A pair with one verb
 * needs no choice and shows nothing; a pair with none never gets here.
 *
 * Lives in its own component so the hooks that follow a live connection
 * re-render a drop target, never the whole card.
 */
function VerbLandingZones({ node }: { readonly node: CanvasNode }) {
  const updateNodeInternals = useUpdateNodeInternals();
  const drag = useConnection((connection) =>
    connection.inProgress && connection.fromNode
      ? {
          fromId: connection.fromNode.id,
          fromKind:
            (connection.fromNode.data as unknown as { readonly node?: CanvasNode })
              .node?.ether?.entity?.kind ?? "",
        }
      : NO_CONNECTION_DRAG,
  );
  const offered =
    drag.fromId === "" || drag.fromId === node.id
      ? NO_VERBS
      : verbsForDraw(drag.fromKind, node.ether?.entity?.kind).verbs;
  const zones = offered.length === 2 ? offered : NO_VERBS;
  // Handles that appear mid-drag are invisible to React Flow until the node's
  // internals are measured again.
  const zoneKey = zones.join(",");
  useEffect(() => {
    updateNodeInternals(node.id);
  }, [node.id, updateNodeInternals, zoneKey]);
  if (zones.length === 0) return null;
  return (
    <>
      {zones.map((verb, index) => (
        <Handle
          key={verb}
          id={verbHandleId(verb)}
          type="target"
          position={index === 0 ? Position.Left : Position.Right}
          className="junto-handle junto-verb-zone"
          data-verb={verb}
          aria-label={`Connect as ${verb}`}
          style={verbZoneStyle(verb, index === 0)}
        />
      ))}
    </>
  );
}

function ConnectionHandles({ node }: { readonly node: CanvasNode }) {
  return <>{HANDLE_SIDES.map(([name, pos]) => <Handle key={`s-${name}`} id={`s-${name}`} aria-label={`Connect from ${name}`} type="source" position={pos} className={`junto-handle junto-handle--source junto-handle--${name}`} />)}{HANDLE_SIDES.map(([name, pos]) => <Handle key={`t-${name}`} id={`t-${name}`} aria-label={`Connect to ${name}`} type="target" position={pos} className={`junto-handle junto-handle--target junto-handle--${name}`} />)}<VerbLandingZones node={node} /></>;
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
  shellBlocked,
}: {
  readonly node: CanvasNode;
  readonly selected: boolean;
  readonly onMaximize?: () => void;
  readonly toolbarExtras?: ReactNode;
  /** Document ether.flags includes blocker. */
  readonly flagBlocker: boolean;
  /** Graph blocked or seed chrome — may have a resolvable cause. */
  readonly shellBlocked: boolean;
}) {
  const chromeBlocker = flagBlocker;
  const connectionFocused = use$(() => state$.connectionFocusNodeId.get() === node.id);
  // Multi-select: RTS bar owns bulk actions — suppress floating pills.
  const multiSelect = use$(() => state$.selectedNodeIds.get().length > 1);
  const title = flagBlocker ? "clear blocker flag" : "flag blocker";

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
  /** Full crew toolbar vs delete-only (labels). */
  toolbar = "full",
  /**
   * Rendered after the clipped body, inside the shell's own overflow-visible
   * box. A hover popover belongs here: the body clips its children, so an
   * overlay mounted inside the card is painted away.
   */
  overlay,
  onHoverEnter,
  onHoverLeave,

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
  readonly overlay?: ReactNode;
  readonly onHoverEnter?: () => void;
  readonly onHoverLeave?: (event: MouseEvent<HTMLDivElement>) => void;

  readonly children: ReactNode;
}) {
  const { isBlocker, shellBlocked, flags } = nodeBlockPresentation({
    node,
    graphBlocked: blocked,
  });
  // Occupancy is vacancy (empty/gone/parked) on actor seats. Working /
  // attention wash comes from SeatFacts, not this spectrum.
  const occupancyClue = useNodeOccupancyClue(node);
  const occupancyState = deriveOccupancy({
    hasOccupant: occupancyClue?.hasOccupant ?? false,
    activity: occupancyClue?.activity,
    lastSeenAtMs: occupancyClue?.lastSeenAtMs,
    flags: occupancyClue?.flags,
    nowMs: Date.now(),
  });
  const nativeBinding = resolveTerminalBinding(node);
  const bindingId =
    nativeBinding?.kind === "native" ? nativeBinding.bindingId : undefined;
  const seatEvent = use$(
    agentSeat$.byBindingId[bindingId ?? "__junto-shell-no-binding__"],
  );
  const needsLook = use$(
    agentSeat$.needsLookByBindingId[bindingId ?? "__junto-shell-no-binding__"],
  );
  const session = use$(
    terminal$.sessionByBindingId[bindingId ?? "__junto-shell-no-binding__"],
  );
  const attentionReasons = useNodeAttentionReasons(node);
  const harness = node.ether?.terminal?.harness;
  const managedSeat = typeof harness === "string" && isHarnessId(harness);
  const isActorSeat = roleOf(specOf(node)) === "actor" || managedSeat;
  const overseer = isOverseerSeat(node);
  const seatFacts = seatFactsForNode({
    nodeId: node.id,
    seatEvent,
    session,
    graphBlocked: blocked,
    flags,
    attentionReasons,
    managedSeat,
    needsLook: needsLook === true,
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
  // Actor / managed seats: SeatFacts owns attention wash. Occupancy is vacancy.
  const liveSeatAttention = isActorSeat
    ? (notifyItem(seatFacts) === "attention" ||
        seatFacts.seatState === "attention") &&
      !flagAttention
    : occupancyState === "attention" && !flagAttention;
  const occupancyAttr = isActorSeat
    ? actorOccupancyAttr(occupancyState)
    : occupancyState;
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
  // Pulse wash for stoppage chrome (graph blocked, flag).
  // isBlocker alone used to skip actors blocked only by upstream criteria.
  return (
    <div
      className={`junto-node group relative flex h-full w-full flex-col overflow-visible ${bare ? "junto-node--bare rounded-sm px-1 py-0.5" : "rounded-[10px] px-3.5 py-3"} ${shellBlocked ? "junto-blocker" : ""}`}
      onMouseEnter={onHoverEnter}
      onMouseLeave={onHoverLeave}
      data-node-kind={node.ether?.entity?.kind ?? node.type}
      data-bare={bare ? "true" : undefined}
      data-blocked={shellBlocked ? "true" : undefined}
      data-seat-attention={liveSeatAttention ? "true" : undefined}
      data-overseer={overseer ? "true" : undefined}
      data-occupancy={occupancyAttr}
      data-attention={attention === "idle" && liveSeatAttention ? "fire" : attention}
      onPointerDownCapture={multiSelectCapture.onPointerDownCapture}
      onClickCapture={multiSelectCapture.onClickCapture}
      style={{
        border: `1px solid ${bare ? border : selected ? withAlpha(isBlocker || shellBlocked ? HUE.crimson : accent, 0.75) : border}`,
        background,
        boxShadow: shadow,
      }}
    >
      {preamble ? <PreambleBubble nodeId={node.id} bubble={preamble} selected={selected} /> : null}
      {resizable ? (
        <NodeResizer
          isVisible={selected}
          minWidth={bare ? 48 : 170}
          minHeight={bare ? 24 : 72}
          // Never paint amber/gold resize chrome over stoppage crimson.
          color={shellBlocked || isBlocker ? HUE.crimson : accent}
          handleClassName="junto-resize-handle"
          lineClassName="junto-resize-line"
          onResizeEnd={(_event, params) => resizeNode(node.id, params)}
        />
      ) : null}
      {onOpen ? (
        <button
          className="junto-node__open nodrag nopan absolute right-2 top-2 z-10 grid size-6 place-items-center rounded text-cyan-300/70 transition hover:bg-white/10 hover:text-cyan-200"
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
      {showHandles ? <ConnectionHandles node={node} /> : null}
      {toolbar === "minimal" ? (
        <MinimalNodeToolbar selected={selected} nodeId={node.id} />
      ) : (
        <NodeActions
          node={node}
          selected={selected}
          onMaximize={onMaximize}
          toolbarExtras={toolbarExtras}
          flagBlocker={flagBlocker}
          shellBlocked={shellBlocked}
        />
      )}
      {!bare && (flags.length > 0 || liveSeatAttention || (shellBlocked && !flagBlocker)) ? (

        <div className="junto-node__flag-rail">
          {shellBlocked && !flagBlocker ? (
            <span
              key="graph-blocked"
              className="junto-node__flag junto-node__flag--blocked-live"
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
          {liveSeatAttention ? (
            <Chip key="seat-attention" tone="amber" title="Needs your input">
              needs input
            </Chip>
          ) : null}
          {flags.map((flag) => (
            <span
              key={flag}
              className="junto-node__flag"
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
      <div className="junto-node__body min-h-0 flex-1 overflow-hidden">
        <div className="h-full min-h-0 overflow-hidden">{children}</div>
      </div>
      {overlay}
    </div>
  );
}
