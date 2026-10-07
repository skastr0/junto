import { countRender } from "../../lib/performance/surface-commits";
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
  Crosshair,
  ExternalLink,
  LocateFixed,
  Maximize2,
  Trash2,
} from "lucide-react";
import { executionGraphContextFromActorRefs } from "@shared/graph";
import { accentColor, borderColor, HUE, withAlpha } from "../../lib/theme";
import { resizeNode } from "../../lib/geometry";
import { deleteNode } from "../../lib/mutations";
import { state$, toggleConnectionFocus } from "../../lib/state";
import { VERB_COLOR_TOKEN, type Verb } from "@shared/physics";
import { verbHandleId, verbsForDraw } from "../../lib/edge-mutations";
import { deriveOccupancy } from "@shared/occupancy";
import {
  useSeatAttentionReasons,
  useSeatOccupancyClue,
} from "../../lib/occupancy-feed";
import { actorOccupancyAttr } from "../../lib/occupancy-chrome";
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
import { IconButton, ToolbarPill } from "../ui";
import type { NodeKind } from "@shared/model";
import { holdsWork, kindMayBeBlocked, kindWord, nodeAttention, physicsKind, roleOfKind } from "../../lib/model-kind";
import { canvasOfState } from "../../lib/model-store";
import { modelStore, useNodeValue } from "../../lib/use-model";
import { useCanvasWorkItems, useSinkAttention } from "../../lib/use-work-sink";

const HANDLE_SIDES = [["top", Position.Top], ["right", Position.Right], ["bottom", Position.Bottom], ["left", Position.Left]] as const;

/**
 * Landing zones bleed past the card so the choice is made by approach, not by
 * pixel aim: the two halves already catch the wire before it reaches the edge.
 */
const VERB_ZONE_BLEED = 16;

const NO_CONNECTION_DRAG = { fromId: "", fromKind: "" } as const;

const NO_VERBS: ReadonlyArray<Verb> = [];

/** The verb-table kind of the card a wire is being drawn from, off its flow data. */
const fromKindOf = (data: unknown): string => {
  const kind = (data as { readonly kind?: NodeKind } | undefined)?.kind;
  return kind === undefined ? "" : (physicsKind(kind) ?? "");
};

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
function VerbLandingZones({ id, kind }: { readonly id: string; readonly kind: NodeKind | undefined }) {
  const updateNodeInternals = useUpdateNodeInternals();
  const drag = useConnection((connection) =>
    connection.inProgress && connection.fromNode
      ? {
          fromId: connection.fromNode.id,
          fromKind: fromKindOf(connection.fromNode.data),
        }
      : NO_CONNECTION_DRAG,
  );
  const offered =
    drag.fromId === "" || drag.fromId === id || kind === undefined
      ? NO_VERBS
      : verbsForDraw(drag.fromKind, physicsKind(kind)).verbs;
  const zones = offered.length === 2 ? offered : NO_VERBS;
  // Handles that appear mid-drag are invisible to React Flow until the node's
  // internals are measured again.
  const zoneKey = zones.join(",");
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, updateNodeInternals, zoneKey]);
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

function ConnectionHandles({ id, kind }: { readonly id: string; readonly kind: NodeKind | undefined }) {
  return <>{HANDLE_SIDES.map(([name, pos]) => <Handle key={`s-${name}`} id={`s-${name}`} aria-label={`Connect from ${name}`} type="source" position={pos} className={`junto-handle junto-handle--source junto-handle--${name}`} />)}{HANDLE_SIDES.map(([name, pos]) => <Handle key={`t-${name}`} id={`t-${name}`} aria-label={`Connect to ${name}`} type="target" position={pos} className={`junto-handle junto-handle--target junto-handle--${name}`} />)}<VerbLandingZones id={id} kind={kind} /></>;
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
  canvas,
  id,
  selected,
  onMaximize,
  toolbarExtras,
  shellBlocked,
}: {
  readonly canvas: string;
  readonly id: string;
  readonly selected: boolean;
  readonly onMaximize?: () => void;
  readonly toolbarExtras?: ReactNode;
  /** Graph blocked or seed chrome — may have a resolvable cause. */
  readonly shellBlocked: boolean;
}) {
  const connectionFocused = use$(() => state$.connectionFocusNodeId.get() === id);
  // Multi-select: RTS bar owns bulk actions — suppress floating pills.
  const multiSelect = use$(() => state$.selectedNodeIds.get().length > 1);
  // The work the blocker walk reads, held only while this card can show a cause.
  const walking = selected && shellBlocked;
  const itemsOf = useCanvasWorkItems(walking ? canvas : "");

  // Only resolve the waiting-on path while selected + blocked. One selector:
  // Legend State tracks only what a selector actually reads, so an
  // unselected/unblocked card reads no observables and never re-renders on
  // kernel ticks or canvas changes.
  const cause = use$(() => {
    if (!walking) return null;
    const execution = kernel$.execution.get();
    kernel$.executionRev.get(); // kernel-tick dep: execution identity can stay stable while blocked/reasons flip
    const actorRefs = state$.actorRefs.get();
    const model = canvasOfState(canvas, modelStore.canvas$(canvas).get());
    const context = executionGraphContextFromActorRefs(canvas, actorRefs, itemsOf);
    const graph = executionGraphForImpact(model, execution, context);
    const blockedActorSeatId = actorRefs.find((ref) => ref.nodeId === id)?.seatId;
    return resolveBlockerCause(model, graph, id, { blockedActorSeatId, itemsOf });
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
            toggleConnectionFocus(id);
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
          tone="danger"
          aria-label="Delete node"
          title="Delete node"
          onPointerDown={(event) => {
            if (stopNodeGestureUnlessMultiSelect(event, { preventDefault: true })) return;
            event.preventDefault();
            deleteNode(id);
          }}
        >
          <Trash2 size={14} />
        </IconButton>
      </ToolbarPill>
    </NodeToolbar>
  );
}

export function NodeShell({
  canvas,
  id,
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
  readonly canvas: string;
  readonly id: string;
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
  countRender("node-shell", id);
  // The node, read from the store one field at a time: the shell hears its
  // kind, colour and who sits in it, and not a move, a resize or a rename.
  const kind = useNodeValue(canvas, id, (node) => node?.kind);
  const color = useNodeValue(canvas, id, (node) => node?.color);
  const bindingId = useNodeValue(canvas, id, (node) =>
    node?.kind === "agent" || node?.kind === "terminal" ? node.bindingId : undefined,
  );
  const agentKey = useNodeValue(canvas, id, (node) => (node?.kind === "agent" ? node.agentKey : undefined));
  const overseer = useNodeValue(canvas, id, (node) => node?.kind === "agent" && node.overseer);
  // Stoppage chrome is derived, never authored: an actor seat the execution
  // graph blocks (a claimed item waiting on input or auth).
  const shellBlocked = blocked && kind !== undefined && kindMayBeBlocked(kind);
  // Occupancy is vacancy (empty/gone/parked) on actor seats. Working /
  // attention wash comes from SeatFacts, not this spectrum.
  const occupancyClue = useSeatOccupancyClue(agentKey, bindingId);
  const occupancyState = deriveOccupancy({
    hasOccupant: occupancyClue?.hasOccupant ?? false,
    activity: occupancyClue?.activity,
    lastSeenAtMs: occupancyClue?.lastSeenAtMs,
    nowMs: Date.now(),
  });
  const seatEvent = use$(
    agentSeat$.byBindingId[bindingId ?? "__junto-shell-no-binding__"],
  );
  const needsLook = use$(
    agentSeat$.needsLookByBindingId[bindingId ?? "__junto-shell-no-binding__"],
  );
  const session = use$(
    terminal$.sessionByBindingId[bindingId ?? "__junto-shell-no-binding__"],
  );
  const attentionReasons = useSeatAttentionReasons(agentKey);
  // A seat in the model always runs a managed harness.
  const managedSeat = kind === "agent";
  const isActorSeat = (kind !== undefined && roleOfKind(kind) === "actor") || managedSeat;
  const seatFacts = seatFactsForNode({
    nodeId: id,
    seatEvent,
    session,
    graphBlocked: blocked,
    attentionReasons,
    managedSeat,
    needsLook: needsLook === true,
  });
  const preamble = use$(() => preambleByNodeId$[id].get());
  // Fire/ice glance. A card that holds work reads its counts from the work
  // store by node id; every other card asks for nothing.
  const glance = useSinkAttention(canvas, id, holdsWork(kind));
  const attention = kind === undefined ? "idle" : nodeAttention(kind, glance, blocked);
  // Actor / managed seats: SeatFacts owns attention wash. Occupancy is vacancy.
  const liveSeatAttention = isActorSeat
    ? notifyItem(seatFacts) === "attention" ||
      seatFacts.seatState === "attention"
    : occupancyState === "attention";
  const occupancyAttr = isActorSeat
    ? actorOccupancyAttr(occupancyState)
    : occupancyState;
  const accent = accentColor(color);
  const border = bare
    ? selected
      ? withAlpha(accent, 0.55)
      : "transparent"
    : shellBlocked
      ? HUE.crimson
      : liveSeatAttention
        ? withAlpha(HUE.amber, 0.52)
        : borderColor(color, selected);
  const background = bare
    ? "transparent"
    : shellBlocked
      ? `linear-gradient(135deg, ${withAlpha(HUE.crimson, 0.12)}, color-mix(in oklab, var(--color-ground) 92%, transparent))`
      : liveSeatAttention
        ? `linear-gradient(135deg, ${withAlpha(HUE.amber, 0.09)}, color-mix(in oklab, var(--color-ground) 96%, transparent))`
        : "linear-gradient(135deg, color-mix(in oklab, var(--color-raise) 94%, transparent), color-mix(in oklab, var(--color-ground) 96%, transparent))";
  const shadow = bare
    ? selected
      ? `0 0 0 1px ${withAlpha(accent, 0.35)}`
      : "none"
    : selected
      ? `0 0 0 1px ${withAlpha(shellBlocked ? HUE.crimson : accent, 0.25)}, 0 12px 30px var(--color-shadow-2)`
      : shellBlocked
        ? `0 0 0 1px ${withAlpha(HUE.crimson, 0.18)}, 0 10px 28px var(--color-shadow-2)`
        : liveSeatAttention
          ? `0 0 0 1px ${withAlpha(HUE.amber, 0.14)}, 0 10px 28px var(--color-shadow-2)`
          : "0 10px 28px var(--color-shadow-2)";
  // Shift+click multi-select dominates all node chrome (labels, open, edit).
  const multiSelectCapture = useShiftMultiSelectDominance(id);
  // Pulse wash for derived seat stoppage.
  return (
    <div
      className={`junto-node group relative flex h-full w-full flex-col overflow-visible ${bare ? "junto-node--bare rounded-sm px-1 py-0.5" : "rounded-[10px] px-3.5 py-3"} ${shellBlocked ? "junto-blocker" : ""}`}
      onMouseEnter={onHoverEnter}
      onMouseLeave={onHoverLeave}
      data-node-kind={kind === undefined ? undefined : kindWord(kind)}
      data-bare={bare ? "true" : undefined}
      data-blocked={shellBlocked ? "true" : undefined}
      data-seat-attention={liveSeatAttention ? "true" : undefined}
      data-overseer={overseer ? "true" : undefined}
      data-occupancy={occupancyAttr}
      data-attention={attention === "idle" && liveSeatAttention ? "fire" : attention}
      onPointerDownCapture={multiSelectCapture.onPointerDownCapture}
      onClickCapture={multiSelectCapture.onClickCapture}
      style={{
        border: `1px solid ${bare ? border : selected ? withAlpha(shellBlocked ? HUE.crimson : accent, 0.75) : border}`,
        background,
        boxShadow: shadow,
      }}
    >
      {preamble ? <PreambleBubble nodeId={id} bubble={preamble} selected={selected} /> : null}
      {resizable ? (
        <NodeResizer
          isVisible={selected}
          minWidth={bare ? 48 : 170}
          minHeight={bare ? 24 : 72}
          // Never paint amber/gold resize chrome over stoppage crimson.
          color={shellBlocked ? HUE.crimson : accent}
          handleClassName="junto-resize-handle"
          lineClassName="junto-resize-line"
          onResizeEnd={(_event, params) => resizeNode(id, params)}
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
      {showHandles ? <ConnectionHandles id={id} kind={kind} /> : null}
      {toolbar === "minimal" ? (
        <MinimalNodeToolbar selected={selected} nodeId={id} />
      ) : (
        <NodeActions
          canvas={canvas}
          id={id}
          selected={selected}
          onMaximize={onMaximize}
          toolbarExtras={toolbarExtras}
          shellBlocked={shellBlocked}
        />
      )}
      {/* No status chips on the card: the ring and the line under the name
          say blocked and needs input, once. */}
      <div className="junto-node__body min-h-0 flex-1 overflow-hidden">
        <div className="h-full min-h-0 overflow-hidden">{children}</div>
      </div>
      {overlay}
    </div>
  );
}
