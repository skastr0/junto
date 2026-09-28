import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { use$ } from "@legendapp/state/react";
import {
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
  Pencil,
  Trash2,
} from "lucide-react";
import type { CanvasNode } from "@shared/canvas";
import { executionGraphContextFromActorRefs } from "@shared/graph";
import type { MemberSeverity, RegionRollup } from "@shared/region-rollup";
import { formatNodeRef } from "@shared/node-ref";
import { selectNode, state$ } from "../../lib/state";
import { viewportBusy$ } from "../../lib/viewport-busy";
import { useRegionRollups } from "../../lib/region-rollups";
import { toggleSlotAssignment } from "../../lib/command-group-runtime";
import {
  deleteNode,
  deleteNodes,
  renameGroup,
  setRegionHold,
} from "../../lib/mutations";
import {
  classifyMultiSelection,
  multiSelectionLabel,
} from "../../lib/multi-selection";
import { nodeTitle, nodeTypeLabel } from "../../lib/presentation";
import {
  commandSelectionKind,
  hotbarSlotIndexOf,
  primaryCommandActions,
  regionSlotCueLabel,
  type PrimaryCommandAction,
} from "../../lib/command-card";
import { HUE } from "../../lib/theme";
import { useAlertAttention } from "../../lib/alert-attention";
import { kernel$ } from "../../lib/kernel-view";
import { specOf } from "../../lib/node-spec";
import { roleOf } from "@shared/physics";
import { openWorkDetail } from "../../lib/work-detail-open";
import { focusBlockerCause, resolveBlockerCause } from "../../lib/blocker-cause";
import { executionGraphForImpact } from "../../lib/impact-mode";
import { ConnectEditor } from "../InspectorFields";
import { EdgeCommandCard } from "./RtsControls";
import { KindSurface } from "./KindSurface";
import { RollCall } from "./RollCall";
import { claimFocus } from "../../lib/focus-ownership";
import { AccentColorSwatches } from "./AccentColorPicker";
import "./RtsBottomBar.css";

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
            <div className="rts-cmd-keys rts-cmd-keys--col" aria-label="Actions">
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
    claimFocus(nameRef.current, "open", { select: true });
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
    if (!graph.blocked.has(node.id)) return null;
    const blockedActorSeatId = actorRefs.find((ref) => ref.nodeId === node.id)?.seatId;
    return resolveBlockerCause(doc, graph, node.id, { blockedActorSeatId });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- executionRev is the kernel tick
  }, [actorRefs, canvasName, doc, execution, executionRev, node]);

  if (!node) {
    return (
      <div className="rts-panel rts-panel--cmd">
        <div className="rts-panel__body">
          <div className="rts-quiet rts-quiet--compact">No selection. Click a node or tap 1–9</div>
        </div>
      </div>
    );
  }

  const kind = commandSelectionKind(node);
  const entityKind = node.ether?.entity?.kind;
  // Physics role from the kind registry — never hardcoded per node.
  const role = roleOf(specOf(node));
  // Kind-specific actions live in the middle-bar kind strip now; the left
  // card keeps type/base + slot cue.
  const primary = primaryCommandActions(kind);

  // Optional subtitle under the title (host/status) — never a kind/shell eyebrow.
  const subtitle = "";

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
          <div className="rts-cmd-keys rts-cmd-keys--col" aria-label="Actions">
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
            {entityKind !== "agent" && entityKind !== "artifacts" ? (
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
  return <div className="rts-minimap-wrap">{children}</div>;
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
  s === "blocked"
    ? 0
    : s === "attention"
      ? 1
      : s === "working"
        ? 2
        : s === "ready"
          ? 3
          : 4;

export function RtsBottomBar({ minimap, tools }: { readonly minimap: ReactNode; readonly tools?: ReactNode }) {
  const rollups = useRegionRollups();
  useAlertAttention(rollups);
  const byId = useMemo(() => new Map(rollups.map((r) => [r.regionId, r])), [rollups]);
  const severityMap = useSeverityByNodeId(rollups);

  // Publish into state$ so MiniMap can subscribe (React data path, not a module ref).
  // Skip while panning — MiniMap is frozen and a severity push remounts its colors.
  useEffect(() => {
    const publish = (): void => {
      const next: Record<string, string> = {};
      for (const [id, severity] of severityMap) next[id] = severity;
      state$.regionSeverityByNodeId.set(next);
      // Region tallies ride along for the overview tier's region plates.
      const counts: Record<string, RegionRollup["counts"]> = {};
      for (const rollup of rollups) counts[rollup.regionId] = rollup.counts;
      state$.regionCountsByNodeId.set(counts);
    };
    if (viewportBusy$.peek()) {
      const off = viewportBusy$.onChange(() => {
        if (viewportBusy$.peek()) return;
        off();
        publish();
      });
      return off;
    }
    publish();
  }, [severityMap, rollups]);

  const selectedNodeId = use$(state$.selectedNodeId);
  const selectedRegion = selectedNodeId ? byId.get(selectedNodeId) : undefined;

  return (
    <div className="rts-shell" role="region" aria-label="RTS bottom bar">
      {/* One row: command, kind, minimap. Command groups live in the top bar,
          needs-you in the top-right inbox. */}
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
