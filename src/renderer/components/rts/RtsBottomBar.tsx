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
  FlaskConical,
  HardHat,
  Hash,
  Link2,
  LocateFixed,
  Lock,
  LockOpen,
  PauseCircle,
  Pencil,
  Shield,
  Trash2,
  Zap,
} from "lucide-react";
import type { CanvasNode, EtherFlag } from "@shared/canvas";
import { executionGraphContextFromActorRefs, groupMembers } from "@shared/graph";
import type { MemberSeverity, RegionRollup } from "@shared/region-rollup";
import { formatNodeRef } from "@shared/node-ref";
import { state$, toggleFlagFilter } from "../../lib/state";
import { viewportBusy$ } from "../../lib/viewport-busy";
import { assignSlot, mergeSlotOrder, useRegionRollups } from "../../lib/region-rollups";
import {
  membersInDocumentOrder,
  regionDigitVerdict,
  type RegionRetapMemory,
} from "../../lib/region-retap";
import { signalMark, signalMarkForMember } from "../../lib/signal-mark";
import {
  deleteNode,
  deleteNodes,
  setNodeColor,
  toggleFlag,
  setFlagForNodes,
  addNode,
  setRegionHold,
} from "../../lib/mutations";
import { makeGroupNode } from "../../lib/node-factories";
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
import { armRegion, disarmOrphan, kernel$, pulseRegion } from "../../lib/kernel-view";
import { useAlertAttention } from "../../lib/alert-attention";
import { specOf } from "../../lib/node-spec";
import { roleOf } from "@shared/physics";
import { openWorkDetail } from "../../lib/work-detail-open";
import { focusBlockerCause, resolveBlockerCause } from "../../lib/blocker-cause";
import { executionGraphForImpact } from "../../lib/impact-mode";
import { ConnectEditor } from "../InspectorFields";
import { PulseTray } from "../PulseTray";
import { StoppageRank } from "./StoppageRank";
import { EdgeCommandCard, PauseScopeKey } from "./RtsControls";
import { ensurePauseState, pause$, regionPausedIn } from "../../lib/pause-state";
import { ActivityMark } from "../ActivityMark";
import { KindSurface } from "./KindSurface";
import "./RtsBottomBar.css";

const COLOR_OPTIONS: ReadonlyArray<{ readonly value: string; readonly label: string; readonly hue: string }> = [
  { value: "1", label: "red", hue: HUE.crimson },
  { value: "2", label: "orange", hue: HUE.orange },
  { value: "3", label: "gold", hue: HUE.gold },
  { value: "4", label: "green", hue: "#5FB98E" },
  { value: "5", label: "cyan", hue: HUE.cyan },
  { value: "6", label: "violet", hue: HUE.violet },
];

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

const createRegionFromIds = (ids: ReadonlyArray<string>): string | undefined => {
  const targets = state$.doc.peek().nodes.filter((node) => ids.includes(node.id) && node.type !== "group");
  if (targets.length === 0) return undefined;
  const pad = 48;
  const minX = Math.min(...targets.map((node) => node.x)) - pad;
  const minY = Math.min(...targets.map((node) => node.y)) - pad;
  const maxX = Math.max(...targets.map((node) => node.x + node.width)) + pad;
  const maxY = Math.max(...targets.map((node) => node.y + node.height)) + pad;
  const region = makeGroupNode(minX, minY, { width: maxX - minX, height: maxY - minY });
  addNode(region, { edit: false, focus: false });
  return region.id;
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
    return (
      <div className="rts-panel rts-panel--cmd">
        <div className="rts-panel__label">command · multi</div>
        <div className="rts-panel__body rts-cmd-shell">
          <div className="rts-cmd-head">
            <div className="rts-cmd__meta">{selectedNodeIds.length} selected</div>
            <div className="rts-cmd__title">selection</div>
          </div>
          <div className="rts-cmd-keys" role="toolbar" aria-label="Multi-select actions">
            <CmdKey
              label="Flag blocker"
              onClick={() => setFlagForNodes(selectedNodeIds, "blocker")}
              style={{ color: HUE.crimson }}
            >
              <Ban size={ICON} />
            </CmdKey>
            <CmdKey
              label="Flag attention"
              onClick={() => setFlagForNodes(selectedNodeIds, "attention")}
              style={{ color: HUE.amber }}
            >
              <AlertTriangle size={ICON} />
            </CmdKey>
            <CmdKey
              label="Flag parked"
              onClick={() => setFlagForNodes(selectedNodeIds, "parked")}
              style={{ color: HUE.violet }}
            >
              <PauseCircle size={ICON} />
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
        <div className="rts-panel__label">command</div>
        <div className="rts-panel__body">
          <div className="rts-quiet rts-quiet--compact">No selection · click a node or tap 1–9</div>
        </div>
      </div>
    );
  }

  return <NodeCommandCard nodeId={node.id} />;
}

const ROLLCALL_VISIBLE = 4;

function RegionCommandCard({
  node,
  regionRollup,
}: {
  readonly node: CanvasNode;
  readonly regionRollup: RegionRollup;
}) {
  const mark = signalMark(regionRollup.severity);
  const members = regionRollup.members;
  const visible = members.slice(0, ROLLCALL_VISIBLE);
  const extra = members.length - visible.length;
  const armed = Boolean(use$(kernel$.armed[node.id]));
  const hold = Boolean(node.ether?.region?.hold);
  const slotOrder = use$(state$.regionSlotOrder);
  const slot = slotIndexOf(slotOrder, node.id);
  const [armBusy, setArmBusy] = useState(false);

  const primary = primaryCommandActions("region");

  const toggleArm = () => {
    if (armBusy) return;
    setArmBusy(true);
    void armRegion(node.id, !armed)
      .catch(() => undefined)
      .finally(() => setArmBusy(false));
  };

  const runPulse = (dry = false) => {
    void pulseRegion(node.id, dry ? { dry: true } : undefined).catch(() => undefined);
  };

  const assignToFirstFree = () => {
    const order = mergeSlotOrder(
      state$.regionSlotOrder.peek(),
      state$.doc.peek().nodes.filter((n) => n.type === "group").map((n) => n.id),
    );
    if (slotIndexOf(order, node.id) !== null) {
      // Already slotted — keep order; chip already shows the index.
      return;
    }
    // First free index 0–8, else append (assignSlot clamps to 0–8).
    let target = Math.min(order.length, 8);
    for (let i = 0; i < 9; i++) {
      if (!order[i]) {
        target = i;
        break;
      }
    }
    state$.regionSlotOrder.set(assignSlot(order, node.id, target));
  };

  const primaryKey = (action: PrimaryCommandAction) => {
    switch (action) {
      case "arm-region":
        return (
          <CmdKey
            key={action}
            label={armed ? "Disarm region" : "Arm region"}
            title={armed ? "armed — click to disarm" : "disarmed — click to arm (real agent turns)"}
            active={armed}
            style={{ color: armed ? HUE.amber : undefined }}
            disabled={armBusy}
            onClick={toggleArm}
          >
            <Shield size={ICON} />
          </CmdKey>
        );
      case "pulse-region":
        return (
          <CmdKey key={action} label="Pulse region" title="pulse now · spends turns when armed" onClick={() => runPulse(false)}>
            <Zap size={ICON} />
          </CmdKey>
        );
      case "dry-pulse-region":
        return (
          <CmdKey
            key={action}
            label="Dry pulse"
            title="dry pulse · briefing only, no agent turns"
            onClick={() => runPulse(true)}
          >
            <FlaskConical size={ICON} />
          </CmdKey>
        );
      case "hold-region":
        return (
          <CmdKey
            key={action}
            label={hold ? "Release hold" : "Hold contents"}
            title={hold ? "holding contents — drag moves members" : "hold contents when dragging"}
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
            title={slot !== null ? `hotkey slot ${slot + 1}` : "assign to next free slot (or Ctrl+1–9)"}
            active={slot !== null}
            style={slot !== null ? { color: HUE.cyan } : undefined}
            onClick={assignToFirstFree}
          >
            <Hash size={ICON} />
          </CmdKey>
        );
      default:
        return null;
    }
  };

  const memberCount = regionRollup.counts.total;
  const metaBits: ReactNode[] = [
    <span key="members">{memberCount === 1 ? "1 member" : `${memberCount} members`}</span>,
  ];
  if (regionRollup.counts.blocked > 0) {
    metaBits.push(
      <span key="b" style={{ color: HUE.crimson }}> · {regionRollup.counts.blocked}b</span>,
    );
  }
  if (regionRollup.counts.attention > 0) {
    metaBits.push(
      <span key="a" style={{ color: HUE.amber }}> · {regionRollup.counts.attention}a</span>,
    );
  }
  if (regionRollup.counts.working > 0) {
    metaBits.push(
      <span key="w" style={{ color: HUE.cyan }}> · {regionRollup.counts.working}w</span>,
    );
  }
  if (armed) {
    metaBits.push(<span key="armed" style={{ color: HUE.amber }}> · armed</span>);
  }
  if (hold) {
    metaBits.push(<span key="hold" style={{ color: HUE.amber }}> · hold</span>);
  }
  // Slot lives on the Hash key only — meta used to print `1 · #1` which
  // looked like a duplicated index.

  // Keys: pause + 5 primary + rename + delete = 8 → 2×4 grid (fits 120px panel).
  // Focus is free via the region hotbar chip; field forms live on the kind strip.
  return (
    <div className="rts-panel rts-panel--cmd">
      <div className="rts-panel__label">
        command
        <span className="rts-signal" style={{ color: mark.hue }} title={mark.label}>
          {mark.symbol} {mark.label}
        </span>
      </div>
      {/* Two-column: identity+members left, keys right — no empty dead zone */}
      <div className="rts-panel__body rts-cmd-shell rts-cmd-shell--region">
        <div className="rts-cmd-region-main">
          <div className="rts-cmd-head">
            <div className="rts-cmd__title" title={regionRollup.label}>{regionRollup.label}</div>
            <div className="rts-cmd__meta">{metaBits}</div>
          </div>
          {members.length > 0 ? (
            <div className="rts-rollcall-strip" aria-label="Region members">
              {visible.map((member) => {
                const m = signalMarkForMember(member);
                return (
                  <button
                    key={member.nodeId}
                    type="button"
                    className="rts-rollcall-pill"
                    title={`${member.label} · ${m.label}`}
                    aria-label={`${member.label}, ${m.label}`}
                    onClick={() => {
                      state$.selectedNodeId.set(member.nodeId);
                      state$.selectedNodeIds.set([member.nodeId]);
                      state$.selectedEdgeId.set("");
                      state$.focusNodeId.set(member.nodeId);
                    }}
                  >
                    <span style={{ color: m.hue }} aria-hidden>{m.symbol}</span>
                    <span className="rts-rollcall-pill__label">{member.label}</span>
                  </button>
                );
              })}
              {extra > 0 ? <span className="rts-rollcall-more">+{extra}</span> : null}
            </div>
          ) : (
            <div className="rts-quiet rts-quiet--compact">empty region</div>
          )}
        </div>
        <div className="rts-cmd-keys rts-cmd-keys--col" role="toolbar" aria-label="Region actions">
          <PauseScopeKey scope={{ kind: "region", id: node.id }} />
          {primary.map(primaryKey)}
          <CmdKey label="Edit region name" onClick={() => state$.editNodeId.set(node.id)}>
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
        <div className="rts-panel__label">command</div>
        <div className="rts-panel__body">
          <div className="rts-quiet rts-quiet--compact">No selection · click a node or tap 1–9</div>
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
  // middle-bar kind strip now; the left card keeps type/base actions only.
  const primary = kind === "herdr" ? [] : primaryCommandActions(kind);

  const metaLine = (() => {
    if (kind === "herdr" && herdr) {
      const status = agentStatus ? ` · ${agentStatus}` : "";
      return `herdr · ${herdr.host}${status}`;
    }
    return nodeTypeLabel(node);
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

  // Only the link type action renders here now — every entity-kind action
  // (herdr open/mark-seen/kill, agent chat, …) lives in the middle-bar strip,
  // and region actions render in RegionCommandCard.
  const renderPrimary = (action: PrimaryCommandAction) =>
    action === "open-link" && node.type === "link" ? (
      <CmdKey key={action} label="Open link" onClick={() => window.open(node.url, "_blank")}>
        <ExternalLink size={ICON} />
      </CmdKey>
    ) : null;

  return (
    <div className="rts-panel rts-panel--cmd">
      <div className="rts-panel__label">command · {role !== "geography" ? role : kind}</div>
      <div className="rts-panel__body rts-cmd-shell">
        <div className="rts-cmd-head">
          <div className="rts-cmd__meta">{metaLine}</div>
          <div className="rts-cmd__title" title={nodeTitle(node)}>{nodeTitle(node)}</div>
        </div>

        <div className="rts-cmd-accents" aria-label="Accent color">
          <button
            type="button"
            className={`rts-swatch${!node.color ? " is-active" : ""}`}
            title="default accent"
            aria-label="Use default accent"
            aria-pressed={!node.color}
            onClick={() => setNodeColor(node.id, undefined)}
          >
            <span style={{ background: HUE.amber }} />
          </button>
          {COLOR_OPTIONS.map(({ value, label, hue }) => (
            <button
              key={value}
              type="button"
              className={`rts-swatch${node.color === value ? " is-active" : ""}`}
              title={`${label} accent`}
              aria-label={`Set ${label} accent`}
              aria-pressed={node.color === value}
              onClick={() => setNodeColor(node.id, value)}
            >
              <span style={{ background: hue }} />
            </button>
          ))}
        </div>

        {/* Role base actions + flags + shared utilities — kind actions live middle */}
        <div className="rts-cmd-keys" role="toolbar" aria-label="Node actions">
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
              title={`jump to cause · ${blockerCause.title}`}
              style={{ color: HUE.crimson }}
              onClick={() => focusBlockerCause(blockerCause)}
            >
              <LocateFixed size={ICON} />
            </CmdKey>
          ) : null}
          {executableRole ? <span className="rts-cmd-keys__rule" aria-hidden /> : null}
          {FLAG_META.map(({ flag, hue, label, Icon }) => {
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
          })}
          <span className="rts-cmd-keys__rule" aria-hidden />
          {primary.map(renderPrimary)}
          {primary.length > 0 ? <span className="rts-cmd-keys__rule" aria-hidden /> : null}
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
      title={`Idle herdr · ${count} need you · F1 or .`}
      aria-label={`Idle herdr: ${count} need you. Cycle focus. Hotkey F1 or period.`}
      onClick={() => cycleIdleHerdr(queue)}
    >
      <HardHat size={11} aria-hidden />
      <span className="rts-idle-herdr__count">{count}</span>
    </button>
  );
}

/**
 * Region hotbar chip: slot digit + name only.
 * Severity/pause live in surface language (wash, pulse, moving border) +
 * house ActivityMark for live states — never count badges or pause glyphs.
 */
function RegionChip({
  index,
  rollup,
  selected,
  onDragStart,
  onDragOver,
  onDrop,
}: {
  readonly index: number;
  readonly rollup: RegionRollup;
  readonly selected: boolean;
  readonly onDragStart: () => void;
  readonly onDragOver: (event: DragEvent) => void;
  readonly onDrop: () => void;
}) {
  const mark = signalMark(rollup.severity);
  const paused = use$(() => regionPausedIn(pause$.state.get(), rollup.regionId));
  const live = mark.mode === "wave" && !paused;
  // Parked severity or explicit pause scope both dim the chip; pause wins for motion.
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
      style={chipStyle}
      draggable
      aria-label={`Region slot ${index + 1}: ${rollup.label}, ${paused ? "paused" : mark.label}`}
      aria-pressed={selected}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onClick={() => focusNode(rollup.regionId)}
      title={`${rollup.label} — ${paused ? "paused" : mark.label}`}
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
      <span className="rts-chip__label">{rollup.label}</span>
    </button>
  );
}

/**
 * Permanent thin hotbar above command + kind: region slots 1–9.
 * Always visible; never competes with the kind middle for vertical space.
 */
function RegionStrip({
  rollups,
  byId,
  idleQueue,
}: {
  readonly rollups: ReadonlyArray<RegionRollup>;
  readonly byId: ReadonlyMap<string, RegionRollup>;
  readonly idleQueue: ReadonlyArray<IdleHerdrEntry>;
}) {
  const selectedNodeId = use$(state$.selectedNodeId);
  const slotOrder = use$(state$.regionSlotOrder);
  const canvasName = use$(state$.canvasName);
  const dragFrom = useRef<number | null>(null);

  // Pause wash on chips needs the pause plane; refresh when canvas opens.
  useEffect(() => {
    if (canvasName) ensurePauseState(canvasName);
  }, [canvasName]);

  // Chips from rollups (cold shell always includes every group on the open
  // document — never gate the strip on IPC alone).
  const slots = useMemo(() => {
    const ids = mergeSlotOrder(slotOrder, rollups.map((r) => r.regionId));
    return ids
      .map((id, index) => {
        const rollup = byId.get(id);
        return rollup ? { index, rollup } : undefined;
      })
      .filter((s): s is { index: number; rollup: RegionRollup } => s !== undefined)
      .slice(0, 9);
  }, [slotOrder, rollups, byId]);

  // Keep slot order in sync with rollup region ids (presentational only).
  useEffect(() => {
    const liveIds = rollups.map((r) => r.regionId);
    if (liveIds.length === 0) return;
    const next = mergeSlotOrder(state$.regionSlotOrder.peek(), liveIds);
    const prev = state$.regionSlotOrder.peek();
    if (next.length !== prev.length || next.some((id, i) => id !== prev[i])) {
      state$.regionSlotOrder.set(next);
    }
  }, [rollups]);

  return (
    <div className="rts-region-strip" role="region" aria-label="Region slots 1 to 9">
      {slots.length === 0 ? (
        <div className="rts-region-strip__empty">
          No regions yet — group nodes, or Ctrl+1–9 on a selection
        </div>
      ) : (
        <div className="rts-region-strip__chips" role="toolbar" aria-label="Region hotbar">
          {slots.map(({ index, rollup }) => (
            <RegionChip
              key={rollup.regionId}
              index={index}
              rollup={rollup}
              selected={selectedNodeId === rollup.regionId}
              onDragStart={() => {
                dragFrom.current = index;
              }}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => {
                const from = dragFrom.current;
                dragFrom.current = null;
                if (from === null || from === index) return;
                const order = slots.map((s) => s.rollup.regionId);
                const [moved] = order.splice(from, 1);
                if (!moved) return;
                order.splice(index, 0, moved);
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
      <div className="rts-panel__label">kind</div>
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

function OrphanNotices() {
  const orphaned = use$(kernel$.orphaned) as ReadonlyArray<string> | undefined;
  const orphans = orphaned ?? [];
  if (orphans.length === 0) return null;
  return (
    <div className="rts-notify-strip__group" aria-label="Orphaned arming">
      {orphans.map((key) => (
        <div key={key} className="rts-orphan" title={key}>
          <span className="rts-orphan__key">{key}</span>
          <button type="button" onClick={() => void disarmOrphan(key)}>
            disarm
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * Thin strip above the minimap only — stoppage / orphans / pulse.
 * Parallel to the region strip (ops left+mid); keeps the minimap full-height.
 */
function NotifyStrip() {
  return (
    <div className="rts-notify-strip" role="region" aria-label="Notifications">
      <div className="rts-notify-strip__chrome">
        <span className="rts-notify-strip__label">notify</span>
      </div>
      <div className="rts-notify-strip__body">
        <OrphanNotices />
        <StoppageRank />
        <div className="rts-notify-strip__pulse">
          <PulseTray embedded />
        </div>
      </div>
    </div>
  );
}

function useRegionHotkeys(idleQueue: ReadonlyArray<IdleHerdrEntry>): void {
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
      const order = mergeSlotOrder(
        state$.regionSlotOrder.peek(),
        doc.nodes.filter((n) => n.type === "group").map((n) => n.id),
      );

      if (event.metaKey || event.ctrlKey) {
        event.preventDefault();
        const selection = state$.selectedNodeIds.peek();
        const single = state$.selectedNodeId.peek();
        const ids = selection.length > 0 ? selection : single ? [single] : [];
        // Prefer assigning an already-selected region into the slot.
        const selectedRegion = ids.find((id) => doc.nodes.some((n) => n.id === id && n.type === "group"));
        const regionId = selectedRegion ?? createRegionFromIds(ids);
        if (!regionId) return;
        state$.regionSlotOrder.set(assignSlot(order, regionId, slotIndex));
        focusNode(regionId);
        retap = null;
        return;
      }

      if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
      const regionId = order[slotIndex];
      if (!regionId) return;
      event.preventDefault();

      // Membership matches region rollups (groupMembers); cycle in document order.
      const memberIds = membersInDocumentOrder(
        groupMembers(doc).get(regionId) ?? [],
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

      focusNode(regionId);
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
  useRegionHotkeys(idleQueue);
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
      <RegionStrip rollups={rollups} byId={byId} idleQueue={idleQueue} />
      <NotifyStrip />
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
