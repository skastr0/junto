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
import type { CanvasNode, EtherFlag } from "@shared/canvas";
import { executionGraphContextFromActorRefs, groupMembers } from "@shared/graph";
import type { MemberSeverity, RegionRollup } from "@shared/region-rollup";
import { formatNodeRef } from "@shared/node-ref";
import { state$, toggleFlagFilter } from "../../lib/state";
import { viewportBusy$ } from "../../lib/viewport-busy";
import { assignSlot, clearSlot, pruneSlotOrder, useRegionRollups } from "../../lib/region-rollups";
import {
  membersInDocumentOrder,
  regionDigitVerdict,
  type RegionRetapMemory,
} from "../../lib/region-retap";
import { hotbarNodeSeverity } from "../../lib/hotbar-signal";
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
import {
  deriveIdleHerdrQueue,
  nextIdleHerdrNodeId,
  type IdleHerdrEntry,
  type IdleHerdrInput,
} from "../../lib/idle-herdr-queue";
import {
  commandSelectionKind,
  primaryCommandActions,
  regionSlotCueLabel,
  slotIndexOf,
  type PrimaryCommandAction,
} from "../../lib/command-card";
import { playAlert } from "../../lib/sfx";
import { HUE, withAlpha } from "../../lib/theme";
import { useAlertAttention } from "../../lib/alert-attention";
import { kernel$ } from "../../lib/kernel-view";
import { specOf } from "../../lib/node-spec";
import { roleOf } from "@shared/physics";
import { openWorkDetail } from "../../lib/work-detail-open";
import { focusBlockerCause, resolveBlockerCause } from "../../lib/blocker-cause";
import { executionGraphForImpact } from "../../lib/impact-mode";
import { ConnectEditor } from "../InspectorFields";
import { StoppageRank } from "./StoppageRank";
import { EdgeCommandCard, PauseScopeKey } from "./RtsControls";
import { ensurePauseState, pause$, regionPausedIn } from "../../lib/pause-state";
import { ActivityMark } from "../ActivityMark";
import { KindSurface } from "./KindSurface";
import { RollCall } from "./RollCall";
import {
  collectOperatorAttention,
  OPERATOR_ATTENTION_HEADLINE,
} from "../../lib/operator-attention";
import "./RtsBottomBar.css";

const COLOR_OPTIONS: ReadonlyArray<{ readonly value: string; readonly label: string; readonly hue: string }> = [
  { value: "1", label: "red", hue: HUE.crimson },
  { value: "2", label: "orange", hue: HUE.orange },
  { value: "3", label: "gold", hue: HUE.gold },
  { value: "4", label: "green", hue: "#5FB98E" },
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
      title={mixed ? "mixed accents — pick to apply to all" : undefined}
    >
      <button
        type="button"
        className={`rts-swatch${defaultActive ? " is-active" : ""}`}
        title={mixed ? "set all to default accent" : "default accent"}
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

/** Assign node to first free slot 0–8 (or end if full). No-op if already slotted. */
const assignToFirstFreeSlot = (nodeId: string): void => {
  const order = pruneSlotOrder(state$.regionSlotOrder.peek(), liveNodeIds(state$.doc.peek()));
  if (slotIndexOf(order, nodeId) !== null) return;
  let target = Math.min(order.length, 8);
  for (let i = 0; i < 9; i++) {
    if (!order[i]) {
      target = i;
      break;
    }
  }
  state$.regionSlotOrder.set(assignSlot(order, nodeId, target));
};

/** Toggle hotkey slot: assign first free, or clear if already slotted. */
const toggleSlotAssignment = (nodeId: string): void => {
  const order = pruneSlotOrder(state$.regionSlotOrder.peek(), liveNodeIds(state$.doc.peek()));
  if (slotIndexOf(order, nodeId) !== null) {
    state$.regionSlotOrder.set(clearSlot(order, nodeId));
    return;
  }
  assignToFirstFreeSlot(nodeId);
};

function CommandCard({ regionRollup }: { readonly regionRollup?: RegionRollup }) {
  const doc = use$(state$.doc);
  const selectedNodeId = use$(state$.selectedNodeId);
  const selectedNodeIds = use$(state$.selectedNodeIds);
  const selectedEdgeId = use$(state$.selectedEdgeId);
  const multi = selectedNodeIds.length > 1;
  const node = !multi && selectedNodeId
    ? doc.nodes.find((candidate) => candidate.id === selectedNodeId)
    : undefined;

  // Relation selected: general edge controls left; pair controls live middle.
  if (!multi && !node && selectedEdgeId) {
    return <EdgeCommandCard edgeId={selectedEdgeId} />;
  }

  if (multi) {
    const selectedNodes = selectedNodeIds
      .map((id) => doc.nodes.find((n) => n.id === id))
      .filter((n): n is CanvasNode => n !== undefined);
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
              nodeIds={selectedNodeIds}
              color={sharedColor}
              mixed={mixedColor}
            />
          </div>
          <div className="rts-cmd-keys rts-cmd-keys--col" role="toolbar" aria-label="Multi-select actions">
            {FLAG_META.map(({ flag, hue, label, Icon }) => {
              const allOn = selectedNodes.every((n) => n.ether?.flags?.includes(flag));
              const someOn = selectedNodes.some((n) => n.ether?.flags?.includes(flag));
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
                    setFlagForNodes(selectedNodeIds, flag, allOn ? "clear" : "set")
                  }
                >
                  <Icon size={ICON} />
                </CmdKey>
              );
            })}
            <CmdKey
              label="Clear all flags"
              title="Clear blocker, attention, and parked on selection"
              onClick={() => setFlagForNodes(selectedNodeIds, null)}
            >
              <X size={ICON} />
            </CmdKey>
            <CmdKey label="Delete selection" danger onClick={() => deleteNodes(selectedNodeIds)}>
              <Trash2 size={ICON} />
            </CmdKey>
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

  return <NodeCommandCard nodeId={node.id} />;
}

function RegionCommandCard({
  node,
  regionRollup,
}: {
  readonly node: CanvasNode;
  readonly regionRollup: RegionRollup;
}) {
  const hold = Boolean(node.ether?.region?.hold);
  const slotOrder = use$(state$.regionSlotOrder);
  const slot = slotIndexOf(slotOrder, node.id);
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
      (node.ether?.flags?.includes("blocker") ?? false) ||
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
    const currentNodeId = node.id;
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

  const slotOrder = use$(state$.regionSlotOrder);
  const slot = slotIndexOf(slotOrder, node.id);

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
          onClick={() => toggleSlotAssignment(node.id)}
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
          <AccentColorSwatches nodeId={node.id} color={node.color} />
        </div>

        <div className="rts-cmd-keys rts-cmd-keys--col" role="toolbar" aria-label="Node actions">
          {executableRole ? (
            <PauseScopeKey scope={{ kind: "node", id: node.id }} />
          ) : null}
          {role === "sink" &&
          (entityKind === "task" || entityKind === "requests" || entityKind === "artifacts") ? (
            <CmdKey
              label="Open detail"
              title="open the work surface"
              onClick={() => openWorkDetail(node.id)}
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
          {showFlags
            ? FLAG_META.map(({ flag, hue, label, Icon }) => {
                const active = flags.includes(flag);
                return (
                  <CmdKey
                    key={flag}
                    label={active ? `Clear ${label}` : `Flag ${label}`}
                    active={active}
                    style={{ color: active ? hue : undefined }}
                    onClick={() => toggleFlag(node.id, flag)}
                  >
                    <Icon size={ICON} />
                  </CmdKey>
                );
              })
            : null}
          {primary.map(renderPrimary)}
          <CmdKey label="Focus" onClick={() => state$.focusNodeId.set(node.id)}>
            <Crosshair size={ICON} />
          </CmdKey>
          <CmdKey label="Edit" onClick={() => state$.editNodeId.set(node.id)}>
            <Pencil size={ICON} />
          </CmdKey>
          <CmdKey
            label={connectOpen ? "Close connect" : "Connect"}
            active={connectOpen}
            onClick={() => setConnectOpen((open) => !open)}
          >
            <Link2 size={ICON} />
          </CmdKey>
          <CmdKey
            label={copyStatus === "copied" ? "Copied" : copyStatus === "failed" ? "Copy failed" : "Copy reference"}
            title={copyDetail || "copy stable node reference"}
            active={copyStatus === "copied"}
            onClick={() => void copyReference()}
          >
            <Copy size={ICON} />
          </CmdKey>
          {kind === "default" ? (
            <CmdKey
              label="Select only this node"
              onClick={() => {
                state$.selectedNodeId.set(node.id);
                state$.selectedNodeIds.set([node.id]);
                state$.selectedEdgeId.set("");
              }}
            >
              <CircleDot size={ICON} />
            </CmdKey>
          ) : null}
          <CmdKey label="Delete" danger onClick={() => deleteNode(node.id)}>
            <Trash2 size={ICON} />
          </CmdKey>
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
  state$.selectedNodeId.set(nodeId);
  state$.selectedNodeIds.set([nodeId]);
  state$.selectedEdgeId.set("");
  state$.focusNodeId.set(nodeId);
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
 * Any node id (region or free). Severity from rollup / member map / flags / sinks.
 */
function HotbarChip({
  index,
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
  readonly nodeId: string;
  readonly label: string;
  readonly severity: MemberSeverity;
  readonly isRegion: boolean;
  readonly selected: boolean;
  readonly onDragStart: () => void;
  readonly onDragOver: (event: DragEvent) => void;
  readonly onDrop: () => void;
}) {
  const mark = signalMark(severity);
  const paused = use$(() =>
    isRegion ? regionPausedIn(pause$.state.get(), nodeId) : false,
  );
  const live = mark.mode === "wave" && !paused;
  const sev = paused ? "paused" : mark.kind;

  const chipStyle = {
    ["--rts-chip-hue" as string]: mark.hue,
    ["--rts-chip-hue-soft" as string]: withAlpha(mark.hue, 0.14),
    ["--rts-chip-hue-mid" as string]: withAlpha(mark.hue, 0.45),
    ["--rts-chip-hue-glow" as string]: withAlpha(mark.hue, 0.22),
  } as CSSProperties;

  return (
    <button
      type="button"
      className={[
        "rts-chip",
        "rts-chip--strip",
        selected ? "is-active" : "",
        `is-sev-${sev}`,
      ]
        .filter(Boolean)
        .join(" ")}
      data-severity={sev}
      data-node-id={nodeId}
      style={chipStyle}
      draggable
      aria-label={`Slot ${index + 1}: ${label}, ${paused ? "paused" : mark.label}`}
      aria-pressed={selected}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onClick={() => focusNode(nodeId)}
      title={`${label} — ${paused ? "paused" : mark.label}`}
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
      <span className="rts-chip__label">{label}</span>
    </button>
  );
}

/**
 * Permanent thin hotbar above command + kind: slots 1–9 (any node).
 * Fully controlled — empty until operator assigns.
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
  const slotOrder = use$(state$.regionSlotOrder);
  const doc = use$(state$.doc);
  const canvasName = use$(state$.canvasName);
  const dragFrom = useRef<number | null>(null);

  useEffect(() => {
    if (canvasName) ensurePauseState(canvasName);
  }, [canvasName]);

  // Prune deleted nodes only — never auto-fill from regions.
  useEffect(() => {
    const live = liveNodeIds(doc);
    const prev = state$.regionSlotOrder.peek();
    const next = pruneSlotOrder(prev, live);
    if (next.length !== prev.length || next.some((id, i) => id !== prev[i])) {
      state$.regionSlotOrder.set(next);
    }
  }, [doc]);

  const slots = useMemo(() => {
    const ids = pruneSlotOrder(slotOrder, liveNodeIds(doc));
    const nodeById = new Map(doc.nodes.map((n) => [n.id, n] as const));
    return ids
      .map((id, index) => {
        const node = nodeById.get(id);
        if (!node) return undefined;
        const isRegion = node.type === "group";
        const rollup = byId.get(id);
        const severity = hotbarNodeSeverity(node, {
          regionSeverity: rollup?.severity,
          memberSeverity: severityByNodeId.get(id),
        });
        return {
          index,
          nodeId: id,
          label: isRegion ? (rollup?.label ?? nodeTitle(node)) : nodeTitle(node),
          severity,
          isRegion,
        };
      })
      .filter(
        (s): s is {
          index: number;
          nodeId: string;
          label: string;
          severity: MemberSeverity;
          isRegion: boolean;
        } => s !== undefined,
      )
      .slice(0, 9);
  }, [slotOrder, doc, byId, severityByNodeId]);

  return (
    <div className="rts-region-strip" role="region" aria-label="Hotkey slots 1 to 9">
      {slots.length === 0 ? (
        <div className="rts-region-strip__empty">
          No slots — select a node, then ⌘/Ctrl+1–9
        </div>
      ) : (
        <div className="rts-region-strip__chips" role="toolbar" aria-label="Node hotbar">
          {slots.map((slot) => (
            <HotbarChip
              key={slot.nodeId}
              index={slot.index}
              nodeId={slot.nodeId}
              label={slot.label}
              severity={slot.severity}
              isRegion={slot.isRegion}
              selected={selectedNodeId === slot.nodeId}
              onDragStart={() => {
                dragFrom.current = slot.index;
              }}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => {
                const from = dragFrom.current;
                dragFrom.current = null;
                if (from === null || from === slot.index) return;
                const order = slots.map((s) => s.nodeId);
                const [moved] = order.splice(from, 1);
                if (!moved) return;
                order.splice(slot.index, 0, moved);
                state$.regionSlotOrder.set(order.slice(0, 9));
              }}
            />
          ))}
        </div>
      )}
      <IdleHerdrButton queue={idleQueue} />
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
          <button type="button" onClick={() => { state$.flagFilter.set(""); state$.selectedNodeId.set(""); state$.selectedNodeIds.set([]); state$.selectedEdgeId.set(""); }}>
            all
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Permanent attention pills in the notify strip (needs-input + blocked).
 * Complements StoppageRank (blast-radius stoppage) and the fixed dock.
 */
function OperatorAttentionPills({
  rollups,
}: {
  readonly rollups: ReadonlyArray<RegionRollup>;
}) {
  const items = useMemo(() => collectOperatorAttention(rollups), [rollups]);
  if (items.length === 0) return null;
  const visible = items.slice(0, 4);
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
            state$.selectedNodeId.set(item.nodeId);
            state$.selectedNodeIds.set([item.nodeId]);
            state$.selectedEdgeId.set("");
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
      const order = pruneSlotOrder(state$.regionSlotOrder.peek(), liveNodeIds(doc));

      // ⌘/Ctrl+1–9: assign the single selected node (any type) into the slot.
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
        state$.regionSlotOrder.set(assignSlot(order, nodeId, slotIndex));
        focusNode(nodeId);
        retap = null;
        return;
      }

      if (event.altKey || event.shiftKey) return;
      const nodeId = order[slotIndex];
      if (!nodeId) return;
      event.preventDefault();

      const node = doc.nodes.find((n) => n.id === nodeId);
      // Region re-tap cycles members; free nodes just focus.
      if (node?.type === "group") {
        const memberIds = membersInDocumentOrder(
          groupMembers(doc).get(nodeId) ?? [],
          doc.nodes.map((n) => n.id),
        );
        const { verdict, memory } = regionDigitVerdict(
          retap,
          slotIndex,
          performance.now(),
          memberIds.length,
        );
        retap = memory;

        if (verdict.kind === "select-member") {
          const memberId = memberIds[verdict.index];
          if (memberId) {
            focusNode(memberId);
            return;
          }
        }
      } else {
        retap = null;
      }

      focusNode(nodeId);
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
