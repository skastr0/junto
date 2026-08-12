import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type ReactNode,
} from "react";
import { use$ } from "@legendapp/state/react";
import {
  AlertTriangle,
  Ban,
  CircleDot,
  Copy,
  Crosshair,
  ExternalLink,
  Eye,
  HardHat,
  Hash,
  Link2,
  LocateFixed,
  Lock,
  LockOpen,
  PauseCircle,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import type { AgentSeatStateEvent } from "@shared/agent-seat-state";
import type { CanvasNode, EtherFlag } from "@shared/canvas";
import { HERDR_ENABLED } from "@shared/features";
import { executionGraphContextFromActorRefs, groupMembers } from "@shared/graph";
import { isBlockableNode } from "@shared/execution-graph";
import type { MemberSeverity, RegionRollup } from "@shared/region-rollup";
import { formatNodeRef } from "@shared/node-ref";
import type { WorkSurfaceActivity } from "@shared/terminal";
import {
  clearSelection,
  selectNode,
  state$,
  toggleFlagFilter,
} from "../../lib/state";
import { viewportBusy$ } from "../../lib/viewport-busy";
import { useRegionRollups } from "../../lib/region-rollups";
import {
  membersInDocumentOrder,
  regionDigitVerdict,
  REGION_RETAP_GAP_MS,
  type RegionRetapMemory,
} from "../../lib/region-retap";
import { activateNodeSurface } from "../../lib/activate-node-surface";
import {
  assignFixedSlot,
  clearHotbarNode,
  filterLeaseCandidateIds,
  fixedOrderOf,
  nodeIdAt,
  purgeNonEligibleSoftSlots,
  resolveHotbarSlots,
  slotIndexOf as hotbarSlotIndexOfNode,
  touchActiveMru,
} from "../../lib/hotbar-slots";
import { hotbarNodeSeverity, liveActivitySeverity } from "../../lib/hotbar-signal";
import { signalMark } from "../../lib/signal-mark";
import {
  deleteNode,
  deleteNodes,
  renameGroup,
  setNodeColor,
  setNodeColorForNodes,
  toggleFlag,
  setFlagForNodes,
  setRegionHold,
} from "../../lib/mutations";
import {
  classifyMultiSelection,
  multiSelectionLabel,
} from "../../lib/multi-selection";
import { nodeTitle, nodeTypeLabel } from "../../lib/presentation";
import { herdr$ } from "../../lib/herdr-state";
import { chatCoarse$ } from "../../lib/chat-state";
import {
  deriveIdleHerdrQueue,
  nextIdleHerdrNodeId,
  type IdleHerdrEntry,
  type IdleHerdrInput,
} from "../../lib/idle-herdr-queue";
import {
  commandSelectionKind,
  hotbarSlotIndexOf,
  primaryCommandActions,
  regionSlotCueLabel,
  type PrimaryCommandAction,
} from "../../lib/command-card";
import { playAlert } from "../../lib/sfx";
import { GREEN, HUE, withAlpha } from "../../lib/theme";
import { useAlertAttention } from "../../lib/alert-attention";
import { kernel$ } from "../../lib/kernel-view";
import { specOf } from "../../lib/node-spec";
import { roleOf } from "@shared/physics";
import { openWorkDetail } from "../../lib/work-detail-open";
import { focusBlockerCause, resolveBlockerCause } from "../../lib/blocker-cause";
import { executionGraphForImpact } from "../../lib/impact-mode";
import { ConnectEditor } from "../InspectorFields";
import { StoppageRank } from "./StoppageRank";
import { CompletedTaskNotifyStack } from "./CompletedTaskNotify";
import { EdgeCommandCard, PauseScopeKey } from "./RtsControls";
import { ensurePauseState, pause$, regionPausedIn } from "../../lib/pause-state";
import { ActivityMark } from "../ActivityMark";
import { KindSurface } from "./KindSurface";
import { RollCall } from "./RollCall";
import {
  agentSeat$,
  seatEventForNode,
  terminalStatusByNodeIdFromSeats,
} from "../../lib/agent-seat-state";
import {
  collectOperatorAttention,
  freestandingFromCanvasAttention,
  OPERATOR_ATTENTION_HEADLINE,
  OPERATOR_ATTENTION_STRIP_MAX,
} from "../../lib/operator-attention";
import "./RtsBottomBar.css";

const COLOR_OPTIONS: ReadonlyArray<{ readonly value: string; readonly label: string; readonly hue: string }> = [
  { value: "1", label: "red", hue: HUE.crimson },
  { value: "2", label: "orange", hue: HUE.orange },
  { value: "3", label: "gold", hue: HUE.gold },
  { value: "4", label: "green", hue: GREEN },
  { value: "5", label: "cyan", hue: HUE.cyan },
  { value: "6", label: "violet", hue: HUE.violet },
];

/** JSON Canvas accent presets — single node or multi-select mass apply. */
function AccentColorSwatches({
  nodeId,
  nodeIds,
  color,
  mixed = false,
}: {
  readonly nodeId?: string;
  /** When set, applies color to every id (multi-select). */
  readonly nodeIds?: ReadonlyArray<string>;
  readonly color: string | undefined;
  /** Selection has differing colors — no swatch pretends to be the active one. */
  readonly mixed?: boolean;
}) {
  const apply = (next: string | undefined) => {
    if (nodeIds && nodeIds.length > 0) {
      setNodeColorForNodes(nodeIds, next);
      return;
    }
    if (nodeId) setNodeColor(nodeId, next);
  };
  const defaultActive = !mixed && !color;
  return (
    <div
      className="rts-cmd-accents"
      aria-label="Accent color"
      title={mixed ? "Mixed accents — pick one to apply to all" : undefined}
    >
      <button
        type="button"
        className={`rts-swatch${defaultActive ? " is-active" : ""}`}
        title={mixed ? "Set all to default accent" : "Default accent"}
        aria-label="Use default accent"
        aria-pressed={defaultActive}
        onClick={() => apply(undefined)}
      >
        <span style={{ background: HUE.amber }} />
      </button>
      {COLOR_OPTIONS.map(({ value, label, hue }) => {
        const active = !mixed && color === value;
        return (
          <button
            key={value}
            type="button"
            className={`rts-swatch${active ? " is-active" : ""}`}
            title={mixed ? `set all to ${label}` : `${label} accent`}
            aria-label={`Set ${label} accent`}
            aria-pressed={active}
            onClick={() => apply(value)}
          >
            <span style={{ background: hue }} />
          </button>
        );
      })}
    </div>
  );
}

const FLAG_META: ReadonlyArray<{
  readonly flag: EtherFlag;
  readonly hue: string;
  readonly label: string;
  readonly Icon: typeof Ban;
}> = [
  { flag: "blocker", hue: HUE.crimson, label: "blocker", Icon: Ban },
  { flag: "attention", hue: HUE.amber, label: "attention", Icon: AlertTriangle },
  { flag: "parked", hue: HUE.violet, label: "parked", Icon: PauseCircle },
];

/** Compact square RTS key — fixed size, never stretches. */
function CmdKey({
  label,
  title,
  active,
  danger,
  disabled,
  style,
  onClick,
  children,
}: {
  readonly label: string;
  readonly title?: string;
  readonly active?: boolean;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  readonly style?: React.CSSProperties;
  readonly onClick?: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`rts-key${active ? " is-active" : ""}${danger ? " is-danger" : ""}`}
      aria-label={label}
      aria-pressed={active}
      title={title ?? label}
      disabled={disabled}
      style={style}
      onClick={onClick}
    >
      <span className="rts-key__icon">{children}</span>
    </button>
  );
}

const ICON = 12;

const isTextEditing = (target: EventTarget | null): boolean =>
  target instanceof Element && Boolean(target.closest("input, textarea, [contenteditable='true']"));

/** Live node ids for prune (document presence only). */
const liveNodeIds = (doc: { readonly nodes: ReadonlyArray<{ readonly id: string }> }): string[] =>
  doc.nodes.map((n) => n.id);

/**
 * Opportunistic hotbar leases are **actors only** (factory role).
 * Well-known: `agent`. Notes, tasks, regions, pages, etc. never auto-lease.
 * Operator fixed slots (⌘1–9) remain unrestricted.
 */
const isHotbarLeaseActor = (node: CanvasNode | undefined): boolean =>
  node !== undefined && roleOf(specOf(node)) === "actor";

const leaseEligibleActorIds = (
  nodes: ReadonlyArray<CanvasNode>,
): Set<string> => {
  const out = new Set<string>();
  for (const node of nodes) {
    if (isHotbarLeaseActor(node)) out.add(node.id);
  }
  return out;
};

/**
 * Actors that keep a hard lease while busy. Seat working/attention, or herdr
 * working/blocked, stick until idle — so idle soft-holds demote and newly
 * active actors without a lease can take those digits.
 */
const stickyWorkingNodeIds = (
  nodes: ReadonlyArray<CanvasNode>,
  herdrMetaByNodeId: Record<
    string,
    { meta?: { agentStatus?: string } } | undefined
  > = {},
): string[] => {
  const out: string[] = [];
  for (const node of nodes) {
    if (!isHotbarLeaseActor(node)) continue;
    const seat = seatEventForNode(node);
    if (seat?.state === "working" || seat?.state === "attention") {
      out.push(node.id);
      continue;
    }
    const herdr = herdrMetaByNodeId[node.id]?.meta?.agentStatus;
    if (herdr === "working" || herdr === "blocked") {
      out.push(node.id);
    }
  }
  return out;
};

/** Recompute leases after fixed mutations, activity MRU, or seat sticky set changes. */
const recomputeHotbar = (): void => {
  const doc = state$.doc.peek();
  const live = liveNodeIds(doc);
  const actors = leaseEligibleActorIds(doc.nodes);
  // Focus MRU orders fill among sticky actors only — it does not pin hard leases.
  let mru: ReadonlyArray<string> = filterLeaseCandidateIds(
    state$.hotbarActiveMru.peek(),
    actors,
  );
  const selected = state$.selectedNodeId.peek();
  if (selected && live.includes(selected) && actors.has(selected)) {
    mru = touchActiveMru(mru, selected);
  }
  state$.hotbarActiveMru.set([...mru]);
  const sticky = stickyWorkingNodeIds(doc.nodes, herdr$.metaByNodeId.peek());
  const next = purgeNonEligibleSoftSlots(
    resolveHotbarSlots(state$.hotbarSlots.peek(), live, mru, sticky),
    actors,
  );
  state$.hotbarSlots.set(next);
  // Compat mirror: dense fixed-only order for any remaining legacy readers.
  state$.regionSlotOrder.set(fixedOrderOf(next));
};

/** Assign node to first free slot as fixed. Empty preferred; then evicted. */
const assignToFirstFreeSlot = (nodeId: string): void => {
  const slots = state$.hotbarSlots.peek();
  if (hotbarSlotIndexOfNode(slots, nodeId) !== null) {
    // Already on bar (fixed / leased / evicted) — promote to fixed in place.
    const index = hotbarSlotIndexOfNode(slots, nodeId)!;
    if (slots[index]?.kind !== "fixed") {
      state$.hotbarSlots.set(assignFixedSlot(slots, nodeId, index));
      recomputeHotbar();
    }
    return;
  }
  let target = 0;
  let foundEmpty = false;
  for (let i = 0; i < 9; i++) {
    if (slots[i]?.kind === "empty") {
      target = i;
      foundEmpty = true;
      break;
    }
  }
  if (!foundEmpty) {
    for (let i = 0; i < 9; i++) {
      if (slots[i]?.kind === "evicted") {
        target = i;
        break;
      }
      target = Math.min(i + 1, 8);
    }
  }
  state$.hotbarSlots.set(assignFixedSlot(slots, nodeId, target));
  recomputeHotbar();
};

/** Toggle fixed assignment: clear if fixed, else fix into first free. */
const toggleSlotAssignment = (nodeId: string): void => {
  const slots = state$.hotbarSlots.peek();
  const index = hotbarSlotIndexOfNode(slots, nodeId);
  if (index !== null && slots[index]?.kind === "fixed") {
    state$.hotbarSlots.set(clearHotbarNode(slots, nodeId));
    recomputeHotbar();
    return;
  }
  assignToFirstFreeSlot(nodeId);
};

function CommandCard({ regionRollup }: { readonly regionRollup?: RegionRollup }) {
  const doc = use$(state$.doc);
  const selectedNodeId = use$(state$.selectedNodeId);
  const selectedNodeIds = use$(state$.selectedNodeIds);
  const selectedEdgeId = use$(state$.selectedEdgeId);
  // Multi is authoritative only when the multi set is live and not desynced
  // from a later single-id write (selectedNodeId alone after add/focus).
  const multi =
    selectedNodeIds.length > 1 &&
    (selectedNodeId === "" || selectedNodeIds.includes(selectedNodeId));
  const singleId = !multi
    ? selectedNodeId || (selectedNodeIds.length === 1 ? (selectedNodeIds[0] ?? "") : "")
    : "";
  const node = singleId
    ? doc.nodes.find((candidate) => candidate.id === singleId)
    : undefined;

  // Relation selected: general edge controls left; pair controls live middle.
  if (!multi && !node && selectedEdgeId) {
    return <EdgeCommandCard edgeId={selectedEdgeId} />;
  }

  if (multi) {
    const selectedNodes = selectedNodeIds
      .map((id) => doc.nodes.find((n) => n.id === id))
      .filter((n): n is CanvasNode => n !== undefined);
    // Live selection ids only — same document ether.flags truth as the card rail.
    const liveIds = selectedNodes.map((n) => n.id);
    const classified = classifyMultiSelection(selectedNodes);
    const colorsMatch =
      selectedNodes.length > 0 &&
      selectedNodes.every((n) => n.color === selectedNodes[0]?.color);
    const sharedColor = colorsMatch ? selectedNodes[0]?.color : undefined;
    const mixedColor = !colorsMatch;

    return (
      <div className="rts-panel rts-panel--cmd" data-testid="rts-multi-command">
        <div className="rts-panel__body rts-cmd-shell">
          <div className="rts-cmd-main">
            <div className="rts-cmd-head">
              <div className="rts-cmd__title">
                {classified.mode === "homogeneous" ? "shared settings" : "shared settings only"}
              </div>
              <div className="rts-cmd__live">{multiSelectionLabel(classified)}</div>
            </div>
            <AccentColorSwatches
              nodeIds={liveIds}
              color={sharedColor}
              mixed={mixedColor}
            />
          </div>
          <div className="rts-cmd-keys-rail" role="toolbar" aria-label="Multi-select actions">
            <div className="rts-cmd-keys-group" aria-label="Flags">
              {FLAG_META.map(({ flag, hue, label, Icon }) => {
                // active = all-on only (document ether.flags of each selected node).
                const allOn =
                  selectedNodes.length > 0 &&
                  selectedNodes.every((n) => n.ether?.flags?.includes(flag) ?? false);
                const someOn = selectedNodes.some((n) => n.ether?.flags?.includes(flag) ?? false);
                return (
                  <CmdKey
                    key={flag}
                    label={allOn ? `Clear ${label}` : `Flag ${label}`}
                    title={
                      allOn
                        ? `clear ${label} on selection`
                        : someOn
                          ? `set ${label} on all (partial)`
                          : `flag ${label}`
                    }
                    active={allOn}
                    style={allOn || someOn ? { color: hue, opacity: allOn ? 1 : 0.65 } : undefined}
                    onClick={() =>
                      setFlagForNodes(liveIds, flag, allOn ? "clear" : "set")
                    }
                  >
                    <Icon size={ICON} />
                  </CmdKey>
                );
              })}
            </div>
            <div className="rts-cmd-keys rts-cmd-keys--col" aria-label="Actions">
              <CmdKey
                label="Clear all flags"
                title="Clear blocker, attention, and parked on selection"
                onClick={() => setFlagForNodes(liveIds, null)}
              >
                <X size={ICON} />
              </CmdKey>
              <CmdKey label="Delete selection" danger onClick={() => deleteNodes(liveIds)}>
                <Trash2 size={ICON} />
              </CmdKey>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (node?.type === "group" && regionRollup) {
    return <RegionCommandCard node={node} regionRollup={regionRollup} />;
  }

  if (!node) {
    return (
      <div className="rts-panel rts-panel--cmd">
        <div className="rts-panel__body">
          <div className="rts-quiet rts-quiet--compact">No selection. Click a node or tap 1–9</div>
        </div>
      </div>
    );
  }

  return <NodeCommandCard nodeId={singleId} />;
}

function RegionCommandCard({
  node,
  regionRollup,
}: {
  readonly node: CanvasNode;
  readonly regionRollup: RegionRollup;
}) {
  const hold = Boolean(node.ether?.region?.hold);
  const hotbarSlots = use$(state$.hotbarSlots);
  const slot = hotbarSlotIndexOf(hotbarSlots, node.id);
  const primary = primaryCommandActions("region");
  const title = regionRollup.label || "unnamed region";
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(title);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setRenaming(false);
    setNameDraft(title);
  }, [node.id, title]);

  useEffect(() => {
    if (!renaming) return;
    nameRef.current?.focus();
    nameRef.current?.select();
  }, [renaming]);

  const commitRename = () => {
    setRenaming(false);
    const next = nameDraft.trim();
    if (next === title || (next === "" && !regionRollup.label)) return;
    renameGroup(node.id, next);
  };

  const cancelRename = () => {
    setRenaming(false);
    setNameDraft(title);
  };

  const primaryKey = (action: PrimaryCommandAction) => {
    switch (action) {
      case "hold-region":
        return (
          <CmdKey
            key={action}
            label={hold ? "Release hold" : "Hold contents"}
            title={hold ? "Holding contents — drag moves members" : "Hold contents when dragging"}
            active={hold}
            style={hold ? { color: HUE.amber } : undefined}
            onClick={() => setRegionHold(node.id, !hold)}
          >
            {hold ? <Lock size={ICON} /> : <LockOpen size={ICON} />}
          </CmdKey>
        );
      case "slot-cue":
        return (
          <CmdKey
            key={action}
            label={regionSlotCueLabel(slot)}
            title={
              slot !== null
                ? `Hotkey slot ${slot + 1} — click to unassign`
                : "Assign to next free slot (or ⌘/Ctrl+1–9)"
            }
            active={slot !== null}
            style={slot !== null ? { color: HUE.cyan } : undefined}
            onClick={() => toggleSlotAssignment(node.id)}
          >
            <Hash size={ICON} />
          </CmdKey>
        );
      default:
        return null;
    }
  };

  // Identity + accent + ops. No panel eyebrow, no severity stamp, no member
  // rollcall, no hold echo in meta (lock key is the hold state).
  // Rename is inline here — canvas plate rename from RTS was a focus no-op.
  return (
    <div className="rts-panel rts-panel--cmd">
      <div className="rts-panel__body rts-cmd-shell rts-cmd-shell--region">
        <div className="rts-cmd-region-main">
          <div className="rts-cmd-head">
            {renaming ? (
              <input
                ref={nameRef}
                data-focus-owner="canvas-draft"
                className="rts-cmd__title-input"
                aria-label="Region name"
                value={nameDraft}
                onChange={(event) => setNameDraft(event.target.value)}
                onBlur={commitRename}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitRename();
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    cancelRename();
                  }
                }}
              />
            ) : (
              <div className="rts-cmd__title" title={title}>{title}</div>
            )}
          </div>
          <AccentColorSwatches nodeId={node.id} color={node.color} />
          <RollCall rollup={regionRollup} />
        </div>
        <div className="rts-cmd-keys rts-cmd-keys--col" role="toolbar" aria-label="Region actions">
          <PauseScopeKey scope={{ kind: "region", id: node.id }} />
          {primary.map(primaryKey)}
          <CmdKey
            label={renaming ? "Cancel rename" : "Edit region name"}
            title={renaming ? "Cancel rename" : "Rename region"}
            active={renaming}
            onClick={() => {
              if (renaming) {
                cancelRename();
                return;
              }
              setNameDraft(title);
              setRenaming(true);
            }}
          >
            <Pencil size={ICON} />
          </CmdKey>
          <CmdKey label="Delete region" danger onClick={() => deleteNode(node.id)}>
            <Trash2 size={ICON} />
          </CmdKey>
        </div>
      </div>
    </div>
  );
}

function NodeCommandCard({ nodeId }: { readonly nodeId: string }) {
  const doc = use$(state$.doc);
  const canvasName = use$(state$.canvasName);
  const snapshots = use$(state$.snapshots);
  const actorRefs = use$(state$.actorRefs);
  const execution = use$(kernel$.execution);
  const executionRev = use$(kernel$.executionRev);
  const node = doc.nodes.find((candidate) => candidate.id === nodeId);
  const herdrMeta = use$(herdr$.metaByNodeId[nodeId]);
  const [connectOpen, setConnectOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const [copyDetail, setCopyDetail] = useState("");
  const copyRequest = useRef(0);

  useEffect(() => {
    copyRequest.current += 1;
    setCopyStatus("idle");
    setCopyDetail("");
    setConnectOpen(false);
  }, [canvasName, nodeId]);

  const blockerCause = useMemo(() => {
    if (!node) return null;
    const context = executionGraphContextFromActorRefs(canvasName, actorRefs);
    const graph = executionGraphForImpact(doc, execution, context);
    const shellBlocked =
      graph.blocked.has(node.id) ||
      graph.seedNodeIds.has(node.id) ||
      ((node.ether?.flags?.includes("blocker") ?? false) &&
        isBlockableNode(node)) ||
      (node.ether?.entity?.kind === "herdr" &&
        herdrMeta?.meta?.agentStatus === "blocked");
    if (!shellBlocked) return null;
    const blockedActorSeatId = actorRefs.find((ref) => ref.nodeId === node.id)?.seatId;
    return resolveBlockerCause(doc, graph, node.id, { blockedActorSeatId });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- executionRev is the kernel tick
  }, [actorRefs, canvasName, doc, execution, executionRev, herdrMeta?.meta?.agentStatus, node]);

  if (!node) {
    return (
      <div className="rts-panel rts-panel--cmd">
        <div className="rts-panel__body">
          <div className="rts-quiet rts-quiet--compact">No selection. Click a node or tap 1–9</div>
        </div>
      </div>
    );
  }

  // Document truth only — same ether.flags the node flag rail chips use for
  // operator flags (not kernel flagOverrides, not occupancy/live chrome).
  const flags = node.ether?.flags ?? [];
  const herdr = node.ether?.herdr;
  const kind = commandSelectionKind(node);
  const entityKind = node.ether?.entity?.kind;
  const agentStatus = herdrMeta?.meta?.agentStatus;
  // Physics role from the kind registry — never hardcoded per node.
  const role = roleOf(specOf(node));
  const executableRole = role === "actor" || role === "sink" || role === "scheduler";
  // Kind-specific actions (herdr open/mark-seen/kill etc.) live in the
  // middle-bar kind strip now; the left card keeps type/base + slot cue.
  const primary = kind === "herdr" ? (["slot-cue"] as const) : primaryCommandActions(kind);

  // Optional subtitle under the title (host/status) — never a kind/shell eyebrow.
  const subtitle = (() => {
    if (kind === "herdr" && herdr) {
      return agentStatus ? `${herdr.host} (${agentStatus})` : herdr.host;
    }
    return "";
  })();

  const copyReference = async (): Promise<void> => {
    const request = copyRequest.current + 1;
    copyRequest.current = request;
    const currentCanvasName = state$.canvasName.peek();
    const currentNodeId = nodeId;
    const matches = state$.doc.peek().nodes.filter((candidate) => candidate.id === currentNodeId);

    try {
      if (state$.selectedNodeId.peek() !== currentNodeId || matches.length !== 1) {
        throw new Error("node is no longer the current unique selection");
      }
      const ref = formatNodeRef({ canvasName: currentCanvasName, nodeId: currentNodeId });
      if (typeof navigator.clipboard?.writeText !== "function") {
        throw new Error("clipboard is unavailable");
      }
      await navigator.clipboard.writeText(ref);
      if (
        copyRequest.current !== request ||
        state$.canvasName.peek() !== currentCanvasName ||
        state$.selectedNodeId.peek() !== currentNodeId
      ) {
        return;
      }
      setCopyStatus("copied");
      setCopyDetail(ref);
    } catch (error) {
      if (copyRequest.current !== request) return;
      setCopyStatus("failed");
      setCopyDetail(error instanceof Error ? error.message : String(error));
    }
  };

  const hotbarSlots = use$(state$.hotbarSlots);
  const slot = hotbarSlotIndexOf(hotbarSlots, nodeId);

  // Kind-specific primaries + slot cue (any node). Entity actions live mid-strip.
  const renderPrimary = (action: PrimaryCommandAction) => {
    if (action === "open-link" && node.type === "link") {
      return (
        <CmdKey key={action} label="Open link" onClick={() => window.open(node.url, "_blank")}>
          <ExternalLink size={ICON} />
        </CmdKey>
      );
    }
    if (action === "slot-cue") {
      return (
        <CmdKey
          key={action}
          label={regionSlotCueLabel(slot)}
          title={
            slot !== null
              ? `Hotkey slot ${slot + 1} — click to unassign`
              : "Assign to next free slot (or ⌘/Ctrl+1–9)"
          }
          active={slot !== null}
          style={slot !== null ? { color: HUE.cyan } : undefined}
          onClick={() => toggleSlotAssignment(nodeId)}
        >
          <Hash size={ICON} />
        </CmdKey>
      );
    }
    return null;
  };

  // Operator flags: any selected node except bare map labels and regions
  // (region command has its own chrome). Physics "actor" is not the gate —
  // flagging a terminal for attention is legitimate operator intent.
  const showFlags = node.type !== "group" && entityKind !== "label";

  return (
    <div className="rts-panel rts-panel--cmd">
      <div className="rts-panel__body rts-cmd-shell">
        <div className="rts-cmd-main">
          <div className="rts-cmd-head">
            <div className="rts-cmd__title" title={nodeTitle(node)}>{nodeTitle(node)}</div>
            {subtitle ? <div className="rts-cmd__live">{subtitle}</div> : null}
          </div>
          <AccentColorSwatches nodeId={nodeId} color={node.color} />
        </div>

        <div className="rts-cmd-keys-rail" role="toolbar" aria-label="Node actions">
          {showFlags ? (
            <div className="rts-cmd-keys-group" aria-label="Flags">
              {FLAG_META.map(({ flag, hue, label, Icon }) => {
                const active = flags.includes(flag);
                return (
                  <CmdKey
                    key={flag}
                    label={active ? `Clear ${label}` : `Flag ${label}`}
                    active={active}
                    style={{ color: active ? hue : undefined }}
                    onClick={() => toggleFlag(nodeId, flag)}
                  >
                    <Icon size={ICON} />
                  </CmdKey>
                );
              })}
            </div>
          ) : null}
          <div className="rts-cmd-keys rts-cmd-keys--col" aria-label="Actions">
            {executableRole ? (
              <PauseScopeKey scope={{ kind: "node", id: nodeId }} />
            ) : null}
            {role === "sink" &&
            (entityKind === "task" || entityKind === "requests" || entityKind === "artifacts") ? (
              <CmdKey
                label="Open detail"
                title="Open the work surface"
                onClick={() => openWorkDetail(nodeId)}
              >
                <Eye size={ICON} />
              </CmdKey>
            ) : null}
            {blockerCause ? (
              <CmdKey
                label={
                  blockerCause.isSelf
                    ? blockerCause.openWorkDetail
                      ? "Open blocker cause"
                      : "Blocker cause"
                    : "Jump to blocker cause"
                }
                title={`Jump to cause: ${blockerCause.title}`}
                style={{ color: HUE.crimson }}
                onClick={() => focusBlockerCause(blockerCause)}
              >
                <LocateFixed size={ICON} />
              </CmdKey>
            ) : null}
            {primary.map(renderPrimary)}
            <CmdKey label="Focus" onClick={() => state$.focusNodeId.set(nodeId)}>
              <Crosshair size={ICON} />
            </CmdKey>
            {entityKind !== "agent" ? (
              <CmdKey label="Edit" onClick={() => state$.editNodeId.set(nodeId)}>
                <Pencil size={ICON} />
              </CmdKey>
            ) : null}
            <CmdKey
              label={connectOpen ? "Close connect" : "Connect"}
              active={connectOpen}
              onClick={() => setConnectOpen((open) => !open)}
            >
              <Link2 size={ICON} />
            </CmdKey>
            <CmdKey
              label={copyStatus === "copied" ? "Copied" : copyStatus === "failed" ? "Copy failed" : "Copy reference"}
              title={copyDetail || "Copy node reference"}
              active={copyStatus === "copied"}
              onClick={() => void copyReference()}
            >
              <Copy size={ICON} />
            </CmdKey>
            {kind === "default" ? (
              <CmdKey
                label="Select only this node"
                onClick={() => {
                  selectNode(nodeId);
                }}
              >
                <CircleDot size={ICON} />
              </CmdKey>
            ) : null}
            <CmdKey label="Delete" danger onClick={() => deleteNode(nodeId)}>
              <Trash2 size={ICON} />
            </CmdKey>
          </div>
        </div>

        {connectOpen ? (
          <div className="rts-cmd-pop">
            <ConnectEditor node={node} doc={doc} open={connectOpen} onOpenChange={setConnectOpen} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Build pure queue inputs from canvas nodes + herdr meta (v1: done only). */
const collectIdleHerdrInputs = (
  nodes: ReadonlyArray<CanvasNode>,
  metaByNodeId: Record<
    string,
    { meta?: { agentStatus?: string }; pendingSeen?: boolean } | undefined
  >,
): ReadonlyArray<IdleHerdrInput> => {
  const out: IdleHerdrInput[] = [];
  for (const node of nodes) {
    const isHerdr =
      node.ether?.herdr !== undefined || node.ether?.entity?.kind === "herdr";
    if (!isHerdr) continue;
    const cache = metaByNodeId[node.id];
    out.push({
      nodeId: node.id,
      isHerdr: true,
      agentStatus: cache?.meta?.agentStatus,
      pendingSeen: cache?.pendingSeen === true,
      // ACP permission is hermes-plane; herdr PTY has no chat binding in v1.
      permissionPending: false,
    });
  }
  return out;
};

const focusNode = (nodeId: string): void => {
  selectNode(nodeId);
  state$.focusNodeId.set(nodeId);
  // Only actors enter the opportunistic lease MRU. Regions / sinks / notes do not.
  const node = state$.doc.peek().nodes.find((n) => n.id === nodeId);
  if (isHotbarLeaseActor(node)) {
    state$.hotbarActiveMru.set(
      touchActiveMru(state$.hotbarActiveMru.peek(), nodeId),
    );
  }
  recomputeHotbar();
};

/** Focus then open the live surface when the node has one (actor model, etc.). */
const focusAndActivate = (
  nodeId: string,
  nodes: ReadonlyArray<CanvasNode>,
): void => {
  focusNode(nodeId);
  const node = nodes.find((n) => n.id === nodeId);
  if (node) activateNodeSurface(node);
};

const cycleIdleHerdr = (queue: ReadonlyArray<IdleHerdrEntry>): void => {
  if (queue.length === 0) return;
  const current =
    state$.focusNodeId.peek() ||
    state$.selectedNodeId.peek() ||
    undefined;
  const next = nextIdleHerdrNodeId(queue, current);
  if (!next) return;
  focusNode(next);
  playAlert("cycle");
};

function useIdleHerdrQueue(): ReadonlyArray<IdleHerdrEntry> {
  const doc = use$(state$.doc);
  const metaByNodeId = use$(herdr$.metaByNodeId) as Record<
    string,
    { meta?: { agentStatus?: string }; pendingSeen?: boolean } | undefined
  >;
  return useMemo(
    () => deriveIdleHerdrQueue(collectIdleHerdrInputs(doc.nodes, metaByNodeId ?? {})),
    // metaByNodeId is an observable object; re-read when identity/content changes via use$
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc.nodes, metaByNodeId],
  );
}

/** SC2 idle-worker badge — count of needs-you herdr nodes; click cycles focus. */
function IdleHerdrButton({ queue }: { readonly queue: ReadonlyArray<IdleHerdrEntry> }) {
  const count = queue.length;
  if (count === 0) return null;
  return (
    <button
      type="button"
      className="rts-idle-herdr"
      style={{ color: HUE.amber, borderColor: withAlpha(HUE.amber, 0.45) }}
      title={`Idle herdr — ${count} need you — F1 or .`}
      aria-label={`Idle herdr: ${count} need you. Cycle focus. Hotkey F1 or period.`}
      onClick={() => cycleIdleHerdr(queue)}
    >
      <HardHat size={11} aria-hidden />
      <span className="rts-idle-herdr__count">{count}</span>
    </button>
  );
}

/**
 * Hotbar chip: slot digit + name + signal motion.
 * `tenure`: empty | leased (active) | evicted (idle soft-hold) | fixed (operator).
 */
function HotbarChip({
  index,
  tenure,
  nodeId,
  label,
  severity,
  isRegion,
  selected,
  onDragStart,
  onDragOver,
  onDrop,
}: {
  readonly index: number;
  readonly tenure: "empty" | "fixed" | "leased" | "evicted";
  readonly nodeId?: string;
  readonly label: string;
  readonly severity: MemberSeverity;
  readonly isRegion: boolean;
  readonly selected: boolean;
  readonly onDragStart: () => void;
  readonly onDragOver: (event: DragEvent) => void;
  readonly onDrop: () => void;
}) {
  const empty = tenure === "empty" || !nodeId;
  const mark = signalMark(severity);
  const paused = use$(() =>
    !empty && isRegion && nodeId
      ? regionPausedIn(pause$.state.get(), nodeId)
      : false,
  );
  const live = !empty && tenure !== "evicted" && mark.mode === "wave" && !paused;
  const sev = empty ? "idle" : paused ? "paused" : mark.kind;

  const chipStyle = empty
    ? undefined
    : ({
        ["--rts-chip-hue" as string]: mark.hue,
        ["--rts-chip-hue-soft" as string]: withAlpha(mark.hue, 0.14),
        ["--rts-chip-hue-mid" as string]: withAlpha(mark.hue, 0.45),
        ["--rts-chip-hue-glow" as string]: withAlpha(mark.hue, 0.22),
      } as CSSProperties);

  const tenureLabel =
    tenure === "fixed"
      ? "fixed"
      : tenure === "leased"
        ? "leased"
        : tenure === "evicted"
          ? "idle hold"
          : "empty";

  return (
    <button
      type="button"
      className={[
        "rts-chip",
        "rts-chip--strip",
        `is-tenure-${tenure}`,
        selected && !empty ? "is-active" : "",
        `is-sev-${sev}`,
      ]
        .filter(Boolean)
        .join(" ")}
      data-severity={sev}
      data-tenure={tenure}
      data-node-id={nodeId}
      data-testid={`hotbar-slot-${index + 1}`}
      style={chipStyle}
      draggable={!empty && tenure === "fixed"}
      aria-label={
        empty
          ? `Slot ${index + 1}: empty — assign with ⌘${index + 1}`
          : `Slot ${index + 1}: ${label}, ${tenureLabel}, ${paused ? "paused" : mark.label}`
      }
      aria-pressed={selected && !empty}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onClick={() => {
        if (nodeId) focusNode(nodeId);
      }}
      onDoubleClick={(event) => {
        event.preventDefault();
        if (!nodeId) return;
        const doc = state$.doc.peek();
        focusAndActivate(nodeId, doc.nodes);
      }}
      title={
        empty
          ? `Empty slot ${index + 1} — ⌘${index + 1} fixes selection here; active nodes may lease it`
          : `${label} · ${tenureLabel} · ${paused ? "paused" : mark.label}${
              tenure === "leased"
                ? " · auto"
                : tenure === "evicted"
                  ? " · soft (yields to new activity)"
                  : ""
            }`
      }
    >
      <span className="rts-chip__slot" aria-hidden>
        {index + 1}
      </span>
      {live ? (
        <ActivityMark
          mode="wave"
          tone={mark.tone === "violet" ? "steel" : mark.tone}
          label={mark.label}
          size="inline"
          className="rts-chip__activity"
        />
      ) : null}
      <span className="rts-chip__label">{empty ? "·" : label}</span>
    </button>
  );
}

/**
 * Permanent thin hotbar above command + kind: always 9 slots.
 * Fixed = operator; leased = active; evicted = idle soft-hold; empty = free.
 */
function HotbarStrip({
  byId,
  idleQueue,
  severityByNodeId,
}: {
  readonly byId: ReadonlyMap<string, RegionRollup>;
  readonly idleQueue: ReadonlyArray<IdleHerdrEntry>;
  readonly severityByNodeId: ReadonlyMap<string, MemberSeverity>;
}) {
  const selectedNodeId = use$(state$.selectedNodeId);
  const hotbarSlots = use$(state$.hotbarSlots);
  const doc = use$(state$.doc);
  const canvasName = use$(state$.canvasName);
  const seatByBinding = use$(agentSeat$.byBindingId);
  const herdrMetaByNodeId = use$(herdr$.metaByNodeId);
  const dragFrom = useRef<number | null>(null);

  useEffect(() => {
    if (canvasName) ensurePauseState(canvasName);
  }, [canvasName]);

  // Prune dead ids + refresh leases on doc / selection / seat sticky changes.
  // Idle sticky seats demote to soft-hold (evicted), not vanish.
  useEffect(() => {
    recomputeHotbar();
  }, [doc, selectedNodeId, seatByBinding, herdrMetaByNodeId]);

  const slots = useMemo(() => {
    const nodeById = new Map(doc.nodes.map((n) => [n.id, n] as const));
    return hotbarSlots.map((slot, index) => {
      if (slot.kind === "empty") {
        return {
          index,
          tenure: "empty" as const,
          nodeId: undefined as string | undefined,
          label: "",
          severity: "idle" as MemberSeverity,
          isRegion: false,
        };
      }
      const node = nodeById.get(slot.nodeId);
      if (!node) {
        return {
          index,
          tenure: slot.kind,
          nodeId: slot.nodeId,
          label: slot.nodeId.slice(0, 8),
          severity: "idle" as MemberSeverity,
          isRegion: false,
        };
      }
      const isRegion = node.type === "group";
      const rollup = byId.get(slot.nodeId);
      // Live seat / herdr plane — same source as canvas ActivityMark so the
      // digit chip stays synchronized even for freestanding agents (Pi, etc.).
      const seat = seatEventForNode(node);
      const herdrStatus = herdrMetaByNodeId[slot.nodeId]?.meta?.agentStatus;
      const liveSeverity = liveActivitySeverity({
        seatState: seat?.state,
        herdrAgentStatus: herdrStatus,
      });
      const severity = hotbarNodeSeverity(node, {
        regionSeverity: rollup?.severity,
        memberSeverity: severityByNodeId.get(slot.nodeId),
        liveSeverity,
      });
      return {
        index,
        tenure: slot.kind,
        nodeId: slot.nodeId,
        label: isRegion
          ? (rollup?.label ?? nodeTitle(node))
          : nodeTitle(node),
        severity,
        isRegion,
      };
    });
  }, [hotbarSlots, doc, byId, severityByNodeId, seatByBinding, herdrMetaByNodeId]);

  return (
    <div className="rts-region-strip" role="region" aria-label="Hotkey slots 1 to 9">
      <div className="rts-region-strip__chips" role="toolbar" aria-label="Node hotbar">
        {slots.map((slot) => (
          <HotbarChip
            key={`slot-${slot.index}`}
            index={slot.index}
            tenure={slot.tenure}
            nodeId={slot.nodeId}
            label={slot.label}
            severity={slot.severity}
            isRegion={slot.isRegion}
            selected={
              slot.nodeId !== undefined && selectedNodeId === slot.nodeId
            }
            onDragStart={() => {
              if (slot.tenure === "fixed") dragFrom.current = slot.index;
            }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => {
              const from = dragFrom.current;
              dragFrom.current = null;
              if (from === null || from === slot.index) return;
              const current = state$.hotbarSlots.peek();
              const fromSlot = current[from];
              if (!fromSlot || fromSlot.kind !== "fixed") return;
              // Swap fixed assignment into drop index (promote target if needed).
              const movedId = fromSlot.nodeId;
              let next = assignFixedSlot(current, movedId, slot.index);
              state$.hotbarSlots.set(next);
              recomputeHotbar();
            }}
          />
        ))}
      </div>
      {HERDR_ENABLED ? <IdleHerdrButton queue={idleQueue} /> : null}
    </div>
  );
}

/** Middle third: kind surface only — region chips live on the strip above. */
function KindMiddle() {
  return (
    <div className="rts-panel rts-panel--mid">
      <div className="rts-panel__body rts-mid-body">
        <KindSurface />
      </div>
    </div>
  );
}

function MinimapChrome({ children }: { readonly children: ReactNode }) {
  const flagFilter = use$(state$.flagFilter);
  const doc = use$(state$.doc);
  const nodes = doc.nodes.filter((node) => node.type !== "group");
  const counts = FLAG_META.reduce((acc, { flag }) => {
    acc[flag] = nodes.filter((node) => node.ether?.flags?.includes(flag)).length;
    return acc;
  }, { blocker: 0, attention: 0, parked: 0 } as Record<EtherFlag, number>);

  return (
    <div className="rts-minimap-wrap">
      {children}
      <div className="rts-layer-toggles" aria-label="Flag layer toggles">
        {FLAG_META.map(({ flag, hue, label }) =>
          counts[flag] > 0 ? (
            <button
              key={flag}
              type="button"
              className={flagFilter === flag ? "is-active" : undefined}
              style={{ color: hue }}
              aria-pressed={flagFilter === flag}
              onClick={() => toggleFlagFilter(flag)}
            >
              {counts[flag]} {label}
            </button>
          ) : null,
        )}
        {flagFilter ? (
          <button type="button" onClick={() => { state$.flagFilter.set(""); clearSelection(); }}>
            all
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Permanent attention pills in the notify strip (needs-input + blocked).
 * Sole permanent visual attention surface (SFX is a separate opt-in product
 * gate). Sources: region rollups + canvas-wide graph/harness/flag freestanding
 * so nodes outside every region still appear. Complements StoppageRank.
 */
function OperatorAttentionPills({
  rollups,
}: {
  readonly rollups: ReadonlyArray<RegionRollup>;
}) {
  const doc = use$(state$.doc);
  const canvasName = use$(state$.canvasName);
  const actorRefs = use$(state$.actorRefs);
  const execution = use$(kernel$.execution);
  const executionRev = use$(kernel$.executionRev);
  const seatByBinding = use$(agentSeat$.byBindingId) as Record<
    string,
    AgentSeatStateEvent | undefined
  >;
  const needsLookByBinding = use$(agentSeat$.needsLookByBindingId) as Record<
    string,
    boolean | undefined
  >;
  const chatByAgent = use$(chatCoarse$) as Record<
    string,
    { readonly pendingPermissionId?: string } | undefined
  >;
  const herdrMetaByNodeId = use$(herdr$.metaByNodeId) as Record<
    string,
    { readonly meta?: { readonly agentStatus?: string } } | undefined
  >;

  const items = useMemo(() => {
    const fromRollups = collectOperatorAttention(rollups);
    const covered = new Set(fromRollups.map((i) => i.nodeId));
    const terminalStatus = terminalStatusByNodeIdFromSeats(
      doc.nodes,
      seatByBinding ?? {},
      needsLookByBinding ?? {},
    );
    const liveAttentionReasonsByNodeId = new Map<string, ReadonlyArray<string>>();
    const addAttentionReason = (nodeId: string, reason: string): void => {
      const reasons = liveAttentionReasonsByNodeId.get(nodeId) ?? [];
      if (reasons.includes(reason)) return;
      liveAttentionReasonsByNodeId.set(nodeId, [...reasons, reason]);
    };

    // Keep freestanding pills in lockstep with the card's fire state. Region
    // rollups already cover grouped ACP permissions, while this map covers
    // agents and work sinks outside every region.
    for (const node of doc.nodes) {
      const entityKind = node.ether?.entity?.kind;
      if (entityKind === "task" || entityKind === "requests") {
        const items =
          entityKind === "task"
            ? node.ether?.tasks?.items ?? []
            : node.ether?.requests?.items ?? [];
        for (const item of items) {
          if (item.state === "input-required" || item.state === "auth-required") {
            addAttentionReason(node.id, `work:${item.state}`);
            break;
          }
        }
      }

      const agentKey =
        entityKind === "agent" ? node.ether?.entity?.name : undefined;
      if (agentKey && chatByAgent?.[agentKey]?.pendingPermissionId) {
        addAttentionReason(node.id, "permission:pending");
      }

      const herdrStatus = herdrMetaByNodeId?.[node.id]?.meta?.agentStatus;
      if (herdrStatus === "blocked" || herdrStatus === "attention") {
        // Herdr is a display surface, but its live status still needs the
        // same permanent operator affordance as the card chrome.
        terminalStatus.set(node.id, {
          session: "running",
          harness: herdrStatus,
          source: "herdr",
        } satisfies WorkSurfaceActivity);
      }
    }
    const context = executionGraphContextFromActorRefs(canvasName, actorRefs);
    const graph = executionGraphForImpact(doc, execution, context);
    const blockedReasonsByNodeId = new Map<string, ReadonlyArray<string>>();
    for (const [nodeId, reasons] of graph.reasonsByNodeId) {
      blockedReasonsByNodeId.set(
        nodeId,
        reasons.map((reason) =>
          reason.kind === "work"
            ? `work:${reason.detail}`
            : reason.kind === "edge"
              ? `edge:${reason.detail}`
              : `seed:${reason.detail}`,
        ),
      );
    }
    const freestanding = freestandingFromCanvasAttention(
      doc.nodes.map((n) => ({
        id: n.id,
        label: nodeTitle(n),
        flags: n.ether?.flags,
      })),
      {
        blockedNodeIds: graph.blocked,
        blockedReasonsByNodeId,
        terminalStatusByNodeId: terminalStatus,
        attentionReasonsByNodeId: liveAttentionReasonsByNodeId,
        alreadyCovered: covered,
      },
    );
    return collectOperatorAttention(rollups, freestanding);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- executionRev stamps kernel execution
  }, [
    rollups,
    doc,
    seatByBinding,
    needsLookByBinding,
    chatByAgent,
    herdrMetaByNodeId,
    canvasName,
    actorRefs,
    execution,
    executionRev,
  ]);

  if (items.length === 0) return null;
  const visible = items.slice(0, OPERATOR_ATTENTION_STRIP_MAX);
  return (
    <div
      className="rts-notify-attention"
      role="group"
      aria-label="Operator attention required"
      data-testid="notify-attention-pills"
    >
      {visible.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`rts-notify-attention__pill rts-notify-attention__pill--${item.kind}`}
          title={`${OPERATOR_ATTENTION_HEADLINE[item.kind]} — ${item.label}`}
          aria-label={`${OPERATOR_ATTENTION_HEADLINE[item.kind]}: ${item.label}. Focus node.`}
          onClick={() => {
            selectNode(item.nodeId);
            state$.focusNodeId.set(item.nodeId);
          }}
        >
          {item.kind === "blocked" ? (
            <Ban size={10} aria-hidden />
          ) : (
            <AlertTriangle size={10} aria-hidden />
          )}
          <span className="rts-notify-attention__text">
            {item.kind === "blocked" ? "blocked" : "needs input"} — {item.label}
          </span>
        </button>
      ))}
      {items.length > visible.length ? (
        <span className="rts-notify-attention__more">+{items.length - visible.length}</span>
      ) : null}
    </div>
  );
}

/**
 * Thin strip above the minimap only — stoppage rank + permanent attention.
 * Parallel to the region strip (ops left+mid); keeps the minimap full-height.
 */
function NotifyStrip({ rollups }: { readonly rollups: ReadonlyArray<RegionRollup> }) {
  return (
    <div className="rts-notify-strip" role="region" aria-label="Notifications">
      <div className="rts-notify-strip__chrome">
        <span className="rts-notify-strip__label">notify</span>
      </div>
      <div className="rts-notify-strip__body">
        <OperatorAttentionPills rollups={rollups} />
        <StoppageRank />
      </div>
    </div>
  );
}

function useHotbarHotkeys(idleQueue: ReadonlyArray<IdleHerdrEntry>): void {
  // Keep latest queue without rebinding the listener every meta tick.
  const idleQueueRef = useRef(idleQueue);
  idleQueueRef.current = idleQueue;

  useEffect(() => {
    let retap: RegionRetapMemory | null = null;
    const onKey = (event: KeyboardEvent) => {
      if (isTextEditing(event.target)) return;

      // SC2 idle-worker: F1 (and `.`) cycles needs-you herdr nodes.
      if (
        HERDR_ENABLED &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        (event.key === "F1" || event.key === ".")
      ) {
        const queue = idleQueueRef.current;
        if (queue.length === 0) return;
        event.preventDefault();
        cycleIdleHerdr(queue);
        return;
      }

      const digit = event.key >= "1" && event.key <= "9" ? Number(event.key) : null;
      if (digit === null) return;
      const slotIndex = digit - 1;
      const doc = state$.doc.peek();
      const slots = state$.hotbarSlots.peek();

      // ⌘/Ctrl+1–9: fix the single selected node into this slot.
      if (event.metaKey || event.ctrlKey) {
        if (event.altKey || event.shiftKey) return;
        event.preventDefault();
        const selection = state$.selectedNodeIds.peek();
        const single = state$.selectedNodeId.peek();
        const nodeId =
          selection.length === 1
            ? selection[0]
            : selection.length === 0 && single
              ? single
              : undefined;
        if (!nodeId || !doc.nodes.some((n) => n.id === nodeId)) return;
        state$.hotbarSlots.set(assignFixedSlot(slots, nodeId, slotIndex));
        recomputeHotbar();
        focusNode(nodeId);
        retap = null;
        return;
      }

      if (event.altKey || event.shiftKey) return;
      const nodeId = nodeIdAt(slots, slotIndex);
      if (!nodeId) return;
      event.preventDefault();

      const node = doc.nodes.find((n) => n.id === nodeId);
      const nowMs = performance.now();
      // Region re-tap: first press → region; re-press → cycle members and
      // activate openable surfaces (actor model / terminal / work sinks).
      if (node?.type === "group") {
        const memberIds = membersInDocumentOrder(
          groupMembers(doc).get(nodeId) ?? [],
          doc.nodes.map((n) => n.id),
        );
        const { verdict, memory } = regionDigitVerdict(
          retap,
          slotIndex,
          nowMs,
          memberIds.length,
        );
        retap = memory;

        if (verdict.kind === "select-member") {
          const memberId = memberIds[verdict.index];
          if (memberId) {
            focusAndActivate(memberId, doc.nodes);
            return;
          }
        }
        focusNode(nodeId);
        return;
      }

      // Free slotted node: first press focuses; re-tap within the gap opens
      // the model when the node has an activatable surface (agent, terminal…).
      const within =
        retap !== null &&
        retap.slotIndex === slotIndex &&
        nowMs - retap.atMs <= REGION_RETAP_GAP_MS;
      retap = { slotIndex, atMs: nowMs, memberCursor: -1 };
      if (within) {
        focusAndActivate(nodeId, doc.nodes);
      } else {
        focusNode(nodeId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** Severity index for minimap nodeColor — built from latest rollups. */
function useSeverityByNodeId(rollups: ReadonlyArray<RegionRollup>): ReadonlyMap<string, MemberSeverity> {
  return useMemo(() => {
    const map = new Map<string, MemberSeverity>();
    for (const rollup of rollups) {
      for (const member of rollup.members) {
        const prev = map.get(member.nodeId);
        if (!prev || severityRank(member.severity) < severityRank(prev)) {
          map.set(member.nodeId, member.severity);
        }
      }
      map.set(rollup.regionId, rollup.severity);
    }
    return map;
  }, [rollups]);
}

const severityRank = (s: MemberSeverity): number =>
  s === "blocked" ? 0 : s === "attention" ? 1 : s === "working" ? 2 : s === "parked" ? 3 : 4;

export function RtsBottomBar({ minimap, tools }: { readonly minimap: ReactNode; readonly tools?: ReactNode }) {
  const idleQueue = useIdleHerdrQueue();
  useHotbarHotkeys(idleQueue);
  const rollups = useRegionRollups();
  useAlertAttention(rollups);
  const byId = useMemo(() => new Map(rollups.map((r) => [r.regionId, r])), [rollups]);
  const severityMap = useSeverityByNodeId(rollups);

  // Publish into state$ so MiniMap can subscribe (React data path, not a module ref).
  // Skip while panning — MiniMap is frozen and a severity push remounts its colors.
  useEffect(() => {
    if (viewportBusy$.peek()) {
      const off = viewportBusy$.onChange(() => {
        if (viewportBusy$.peek()) return;
        off();
        const next: Record<string, string> = {};
        for (const [id, severity] of severityMap) next[id] = severity;
        state$.regionSeverityByNodeId.set(next);
      });
      return off;
    }
    const next: Record<string, string> = {};
    for (const [id, severity] of severityMap) next[id] = severity;
    state$.regionSeverityByNodeId.set(next);
  }, [severityMap]);

  const selectedNodeId = use$(state$.selectedNodeId);
  const selectedRegion = selectedNodeId ? byId.get(selectedNodeId) : undefined;

  return (
    <div className="rts-shell" role="region" aria-label="RTS bottom bar">
      {/* Above notify + minimap cluster (bottom-right stack). */}
      <CompletedTaskNotifyStack />
      {/* Top row: ops strip spans command+kind; notify strip sits over minimap. */}
      <HotbarStrip
        byId={byId}
        idleQueue={idleQueue}
        severityByNodeId={severityMap}
      />
      <NotifyStrip rollups={rollups} />
      <CommandCard regionRollup={selectedRegion} />
      <KindMiddle />
      <div className="rts-right">
        {/* Tools after minimap in DOM + high z-index so they stay clickable. */}
        <div className="rts-minimap-slot">
          <MinimapChrome>{minimap}</MinimapChrome>
          {tools ? <div className="rts-field-tools-slot">{tools}</div> : null}
        </div>
      </div>
    </div>
  );
}
