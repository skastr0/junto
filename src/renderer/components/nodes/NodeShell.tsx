import type { ReactNode } from "react";
import { Handle, NodeResizer, NodeToolbar, Position } from "@xyflow/react";
import { use$ } from "@legendapp/state/react";
import { Ban, ExternalLink, Maximize2, Pencil, Trash2 } from "lucide-react";
import type { CanvasNode, EtherFlag } from "@shared/canvas";
import { actorClassLabel, resolveNodePlacement, tierLabel } from "@shared/physics";
import { isExecutableNode } from "@shared/station";
import { accentColor, borderColor, HUE, withAlpha } from "../../lib/theme";
import { resizeNode } from "../../lib/geometry";
import { deleteNode, toggleFlag } from "../../lib/mutations";
import { herdr$ } from "../../lib/herdr-state";
import { isHerdrCanvasNode, nodeBlockPresentation } from "../../lib/node-block-state";
import { deriveOccupancy } from "@shared/occupancy";
import { useNodeOccupancyClue } from "../../lib/occupancy-feed";
import { Chip, IconButton, ToolbarPill, type ChipTone } from "../ui";

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
}) {
  // Toolbar toggle only mutates the document flag. Live herdr blocked paints
  // crimson but clear still means "clear flag" (or no-op if flag absent).
  const chromeBlocker = flagBlocker || liveHerdrBlocked;
  const title = flagBlocker
    ? "clear blocker flag"
    : liveHerdrBlocked
      ? "herdr blocked (live) — flag to pin"
      : "flag blocker";
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
  const flagBlocker = flags.includes("blocker");
  // Placement chips (S11/I18): class · tier · host on executable seats.
  // Pure resolve — no live fleet producer (null PlacementView pattern).
  const showPlacement = isExecutableNode(node);
  const placement = showPlacement ? resolveNodePlacement(node) : undefined;
  const placementChipTone: ChipTone =
    placement?.class === "facility"
      ? "steel"
      : placement?.class === "external"
        ? "violet"
        : placement?.class === "station"
          ? "cyan"
          : "amber";
  const primaryFlag: EtherFlag | undefined = isBlocker
    ? "blocker"
    : flags.includes("attention")
      ? "attention"
      : flags.includes("parked")
        ? "parked"
        : undefined;
  const primaryHue = primaryFlag ? FLAG_HUES[primaryFlag] : undefined;
  const accent = accentColor(node.color);
  const border = isBlocker ? HUE.crimson : primaryHue ? withAlpha(primaryHue, 0.52) : borderColor(node.color, selected);
  const background = shellBlocked
    ? `linear-gradient(135deg, ${withAlpha(HUE.crimson, 0.12)}, rgba(18,15,13,0.92))`
    : primaryFlag === "attention"
      ? `linear-gradient(135deg, ${withAlpha(HUE.amber, 0.09)}, rgba(14,13,12,0.96))`
      : primaryFlag === "parked"
        ? `linear-gradient(135deg, ${withAlpha(HUE.violet, 0.09)}, rgba(14,13,12,0.96))`
        : "linear-gradient(135deg, rgba(30,25,20,0.94), rgba(14,13,12,0.96))";
  const shadow = selected
    ? `0 0 0 1px ${withAlpha(accent, 0.25)}, 0 12px 30px rgba(0,0,0,0.22)`
    : isBlocker
      ? `0 0 0 1px ${withAlpha(HUE.crimson, 0.18)}, 0 10px 28px rgba(0,0,0,0.18)`
      : primaryFlag === "attention"
        ? `0 0 0 1px ${withAlpha(HUE.amber, 0.14)}, 0 10px 28px rgba(0,0,0,0.18)`
        : primaryFlag === "parked"
          ? `0 0 0 1px ${withAlpha(HUE.violet, 0.14)}, 0 10px 28px rgba(0,0,0,0.18)`
          : "0 10px 28px rgba(0,0,0,0.18)";
  return (
    <div
      className={`vellum-node group relative flex h-full w-full flex-col overflow-visible rounded-[10px] px-3.5 py-3 ${isBlocker ? "vellum-blocker" : ""}`}
      data-blocked={shellBlocked ? "true" : undefined}
      data-herdr-blocked={liveHerdrBlocked ? "true" : undefined}
      data-occupancy={occupancyState}
      style={{
        border: `1px solid ${selected ? withAlpha(isBlocker ? HUE.crimson : accent, 0.75) : border}`,
        background,
        boxShadow: shadow,
      }}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={170}
        minHeight={72}
        color={accent}
        handleClassName="vellum-resize-handle"
        lineClassName="vellum-resize-line"
        onResizeEnd={(_event, params) => resizeNode(node.id, params)}
      />
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
      />
      {flags.length > 0 || liveHerdrBlocked || showPlacement ? (
        <div className="vellum-node__flag-rail">
          {liveHerdrBlocked && !flagBlocker ? (
            <span
              key="herdr-blocked"
              className="vellum-node__flag"
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
          {showPlacement && placement ? (
            <>
              <Chip
                tone={placementChipTone}
                title={`placement · ${placement.class} · tier ${placement.tier}${placement.assignment ? ` · ${placement.assignment}` : ""}`}
              >
                {actorClassLabel(placement.class)}
              </Chip>
              <Chip tone={placementChipTone} title={`runtime tier ${placement.tier}`}>
                {tierLabel(placement.tier)}
              </Chip>
              {placement.assignment && placement.assignment !== "local" ? (
                <Chip tone="steel" title={`assigned host ${placement.assignment}`}>
                  {placement.assignment}
                </Chip>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
      <div className="vellum-node__body min-h-0 flex-1 overflow-hidden">
        <div className="h-full min-h-0 overflow-hidden">{children}</div>
      </div>
    </div>
  );
}
