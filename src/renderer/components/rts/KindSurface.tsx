/**
 * Middle RTS third — kind surface.
 *
 * Identity + live glance + kind action keys live here. Dense node/edge field
 * editors open in a FocusSurface form (not a sidebar). Reuses pristine
 * InspectorFields editors as-is; this file is glue only.
 */
import { useEffect, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { RefreshCw, Settings2, X } from "lucide-react";
import type { CanvasEdge, CanvasNode } from "@shared/canvas";
import type { AgentIdentity } from "@shared/ipc";
import { state$ } from "../../lib/state";
import { kernel$ } from "../../lib/kernel-view";
import { getAgentAvatar, getAgentIdentity } from "../../lib/agent";
import { resolveNodeConnections } from "../../../shared/connections";
import { nodeDetail, nodeTitle, nodeTypeLabel } from "../../lib/presentation";
import { DIM, HUE, SOURCE_HUE } from "../../lib/theme";
import { connectionStateOf, herdr$, refreshHerdrMeta } from "../../lib/herdr-state";
import { FocusSurface } from "../FocusSurface";
import { OverlayHeader, IconButton } from "../ui";
import { HarnessMark } from "../herdr/HarnessMark";
import { WaitingOnSection } from "../WaitingOnSection";
import { NoteMarkdown } from "../../lib/note-markdown";
import {
  EdgeCapabilitySection,
  EdgeCriteriaEditor,
  EdgePortsAttenuator,
  NodeCapabilityInventory,
  NodeFieldEditors,
  NodePlacementSection,
} from "../InspectorFields";
import {
  deleteEdges,
  editEdgeLabel,
  setEdgeCriteria,
  toggleEdgeArrow,
} from "../../lib/edge-mutations";
import { KindActions, EdgePairStrip, KindKey } from "./RtsControls";
import "./rts-controls.css";

const ICON = 12;

function AgentIdentityRow({ node }: { readonly node: CanvasNode }) {
  const entity = node.ether?.entity;
  const hermesKey = entity?.kind === "agent" ? entity.name : undefined;
  const rawName = (node.type === "text" ? node.text : "").split("\n")[0] ?? "";
  const [avatar, setAvatar] = useState<string | null>(null);
  const [identity, setIdentity] = useState<AgentIdentity | null>(null);
  const snapshots = use$(state$.snapshots);

  useEffect(() => {
    if (!hermesKey) return;
    let cancelled = false;
    void getAgentAvatar(hermesKey)
      .then((value) => {
        if (!cancelled) setAvatar(value);
      })
      .catch(() => undefined);
    void getAgentIdentity(hermesKey)
      .then((value) => {
        if (!cancelled) setIdentity(value);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [hermesKey]);

  if (!hermesKey) return null;

  const connections = resolveNodeConnections(entity, snapshots).filter((c) => c.source === "hermes");
  const hermes = connections[0]?.entity;
  const liveBits: string[] = [];
  if (hermes) {
    const status = hermes.stats.status;
    if (typeof status === "string" && status) liveBits.push(status);
    const model = hermes.stats.model;
    if (typeof model === "string" && model) liveBits.push(model);
  }
  const live = liveBits.join(" · ") || "no live data";
  const stale = connections.length > 0 && !connections[0]?.entity;

  return (
    <div className="rts-kind-id" title={identity?.matrixUserId ?? hermesKey}>
      <span className="rts-kind-id__avatar" aria-hidden>
        {avatar ? <img src={avatar} alt="" /> : null}
      </span>
      <div className="rts-kind-id__text">
        <div className="rts-kind-id__name">{identity?.displayName ?? (rawName || nodeTitle(node))}</div>
        <div className="rts-kind-id__live" style={{ color: stale ? DIM : SOURCE_HUE.hermes }}>
          {stale ? "hermes · stale" : live}
        </div>
      </div>
    </div>
  );
}

function HerdrGlance({ node }: { readonly node: CanvasNode }) {
  const herdr = node.ether?.herdr;
  const metaCache = use$(herdr$.metaByNodeId[node.id]);
  const conn = use$(herdr$.connectionByNodeId[node.id]);
  if (!herdr) return null;
  const meta = metaCache?.meta;
  const connState = conn?.state ?? connectionStateOf(node.id);
  const agent = meta?.agent
    ? meta.agentStatus
      ? `${meta.agent} · ${meta.agentStatus}`
      : meta.agent
    : undefined;

  return (
    <div className="rts-kind-id">
      <span className="rts-kind-id__avatar rts-kind-id__avatar--mark" aria-hidden>
        <HarnessMark agent={meta?.agent} size={22} focused={meta?.focused === true} />
      </span>
      <div className="rts-kind-id__text">
        <div className="rts-kind-id__name">{nodeTitle(node)}</div>
        <div className="rts-kind-id__live">
          {herdr.host}
          {agent ? ` · ${agent}` : ""}
          {` · ${connState}`}
        </div>
      </div>
      <KindKey
        label="Refresh herdr meta"
        title="refresh pane meta"
        onClick={() => void refreshHerdrMeta(node.id, herdr)}
      >
        <RefreshCw size={ICON} />
      </KindKey>
    </div>
  );
}

function NodeFormFocus({
  node,
  onClose,
}: {
  readonly node: CanvasNode;
  readonly onClose: () => void;
}) {
  const kind = node.ether?.entity?.kind;
  return (
    <FocusSurface
      measure="form"
      height="fit"
      layer="detail"
      label={`${nodeTypeLabel(node)} fields`}
      onClose={onClose}
      closeOnEscape
      closeOnBackdrop
      panelClassName="rts-kind-form-panel nowheel"
    >
      <OverlayHeader
        eyebrow={kind ?? nodeTypeLabel(node)}
        title={nodeTitle(node)}
        status="edit fields · esc closes"
        actions={
          <IconButton aria-label="Close fields" title="Close fields" onClick={onClose}>
            <X size={14} />
          </IconButton>
        }
      />
      <div className="rts-kind-form-body inspector-body">
        <WaitingOnSection nodeId={node.id} />
        <NodePlacementSection node={node} />
        <NodeCapabilityInventory node={node} />
        {!node.ether?.entity && node.type === "text" ? (
          <div className="inspector-detail note-surface">
            <NoteMarkdown source={node.text.split("\n").slice(1).join("\n").trim()} />
          </div>
        ) : null}
        {node.ether?.entity && nodeDetail(node) ? (
          <div className="inspector-detail">{nodeDetail(node)}</div>
        ) : null}
        <NodeFieldEditors node={node} />
      </div>
    </FocusSurface>
  );
}

function EdgeFormFocus({
  edge,
  onClose,
}: {
  readonly edge: CanvasEdge;
  readonly onClose: () => void;
}) {
  const doc = use$(state$.doc);
  const execution = use$(kernel$.execution);
  const fromNode = doc.nodes.find((n) => n.id === edge.fromNode);
  const toNode = doc.nodes.find((n) => n.id === edge.toNode);
  const [labelDraft, setLabelDraft] = useState(edge.label ?? "");
  useEffect(() => setLabelDraft(edge.label ?? ""), [edge.label, edge.id]);

  const livePhase = execution?.phaseByEdgeId?.[edge.id] ?? "relates";
  const liveDetail = execution?.detailByEdgeId?.[edge.id] ?? "";
  const criteria = edge.ether?.criteria;
  const commitLabel = () => {
    if (labelDraft !== (edge.label ?? "")) editEdgeLabel(edge.id, labelDraft);
  };

  return (
    <FocusSurface
      measure="form"
      height="fit"
      layer="detail"
      label="Relation fields"
      onClose={onClose}
      closeOnEscape
      closeOnBackdrop
      panelClassName="rts-kind-form-panel nowheel"
    >
      <OverlayHeader
        eyebrow={criteria ? `live · ${livePhase}` : `soft · ${livePhase}`}
        title="execution edge"
        status={`${fromNode ? nodeTitle(fromNode) : edge.fromNode} → ${toNode ? nodeTitle(toNode) : edge.toNode}`}
        actions={
          <IconButton aria-label="Close fields" title="Close fields" onClick={onClose}>
            <X size={14} />
          </IconButton>
        }
      />
      <div className="rts-kind-form-body inspector-body">
        <EdgeCapabilitySection edge={edge} fromNode={fromNode} toNode={toNode} />
        <EdgePortsAttenuator edge={edge} />
        <EdgeCriteriaEditor
          edgeId={edge.id}
          fromNode={fromNode}
          livePhase={livePhase}
          liveDetail={liveDetail}
        />
        <label className="inspector-edge-label">
          <span>optional label</span>
          <input
            aria-label="Edit edge label"
            value={labelDraft}
            placeholder={livePhase}
            onChange={(event) => setLabelDraft(event.target.value)}
            onBlur={commitLabel}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitLabel();
                event.currentTarget.blur();
              }
              if (event.key === "Escape") {
                setLabelDraft(edge.label ?? "");
                event.currentTarget.blur();
              }
            }}
          />
        </label>
        <div className="inspector-edge-ends">
          <span>arrow ends</span>
          <div>
            <button
              type="button"
              aria-label="Toggle source arrow"
              aria-pressed={edge.fromEnd === "arrow"}
              className={edge.fromEnd === "arrow" ? "is-active" : ""}
              onClick={() => toggleEdgeArrow(edge.id, "from")}
            >
              source
            </button>
            <button
              type="button"
              aria-label="Toggle target arrow"
              aria-pressed={edge.toEnd === "arrow"}
              className={edge.toEnd === "arrow" ? "is-active" : ""}
              onClick={() => toggleEdgeArrow(edge.id, "to")}
            >
              target
            </button>
          </div>
        </div>
        <div className="inspector-actions">
          {criteria ? (
            <button type="button" onClick={() => setEdgeCriteria(edge.id, undefined)}>
              clear criteria
            </button>
          ) : null}
          <button
            type="button"
            className="inspector-action--danger"
            onClick={() => {
              deleteEdges([edge.id]);
              onClose();
            }}
          >
            delete edge
          </button>
        </div>
      </div>
    </FocusSurface>
  );
}

/** Compact placement chips without the tall inspector section chrome. */
function PlacementGlance({ node }: { readonly node: CanvasNode }) {
  if (!node.ether?.entity && node.type !== "group") return null;
  return (
    <div className="rts-kind-place">
      <NodePlacementSection node={node} />
    </div>
  );
}

/**
 * Full kind middle surface: glance + actions + Fields focus form.
 */
export function KindSurface() {
  const doc = use$(state$.doc);
  const selectedNodeId = use$(state$.selectedNodeId);
  const selectedNodeIds = use$(state$.selectedNodeIds);
  const selectedEdgeId = use$(state$.selectedEdgeId);
  const [formOpen, setFormOpen] = useState(false);

  useEffect(() => {
    setFormOpen(false);
  }, [selectedNodeId, selectedEdgeId, selectedNodeIds.length]);

  if (selectedNodeIds.length > 1) {
    return (
      <div className="rts-quiet rts-quiet--compact">
        Multi-select · kind actions need a single node
      </div>
    );
  }

  if (selectedEdgeId) {
    const edge = doc.edges.find((candidate) => candidate.id === selectedEdgeId);
    if (!edge) {
      return <div className="rts-quiet rts-quiet--compact">Select a node · or tap 1–9</div>;
    }
    return (
      <div className="rts-kind-surface">
        <EdgePairStrip edge={edge} />
        <div className="rts-kind-strip" role="toolbar" aria-label="Relation fields">
          <KindKey
            label={formOpen ? "Close fields" : "Open fields"}
            title="ports · criteria · label"
            active={formOpen}
            onClick={() => setFormOpen((open) => !open)}
          >
            <Settings2 size={ICON} />
          </KindKey>
        </div>
        {formOpen ? <EdgeFormFocus edge={edge} onClose={() => setFormOpen(false)} /> : null}
      </div>
    );
  }

  if (!selectedNodeId) {
    return <div className="rts-quiet rts-quiet--compact">Select a node · or tap 1–9</div>;
  }

  const node = doc.nodes.find((candidate) => candidate.id === selectedNodeId);
  if (!node) {
    return <div className="rts-quiet rts-quiet--compact">Select a node · or tap 1–9</div>;
  }

  if (node.type === "group") {
    return (
      <div className="rts-kind-surface">
        <div className="rts-quiet rts-quiet--compact">
          Region · arm · pulse · rollcall live on the left
        </div>
        <div className="rts-kind-strip" role="toolbar" aria-label="Region fields">
          <KindKey
            label={formOpen ? "Close fields" : "Open fields"}
            title="spawn defaults · pulse briefing · label"
            active={formOpen}
            onClick={() => setFormOpen((open) => !open)}
          >
            <Settings2 size={ICON} />
          </KindKey>
        </div>
        {formOpen ? <NodeFormFocus node={node} onClose={() => setFormOpen(false)} /> : null}
      </div>
    );
  }

  const kind = node.ether?.entity?.kind;
  const hasKindActions =
    kind !== undefined &&
    ["agent", "herdr", "terminal", "task", "requests", "watcher", "timer"].includes(kind);

  return (
    <div className="rts-kind-surface">
      {kind === "agent" ? <AgentIdentityRow node={node} /> : null}
      {kind === "herdr" ? <HerdrGlance node={node} /> : null}
      {kind && kind !== "agent" && kind !== "herdr" ? (
        <div className="rts-kind-id rts-kind-id--compact">
          <div className="rts-kind-id__text">
            <div className="rts-kind-id__name">{nodeTitle(node)}</div>
            <div className="rts-kind-id__live">{kind}</div>
          </div>
        </div>
      ) : null}
      {!kind ? (
        <div className="rts-kind-id rts-kind-id--compact">
          <div className="rts-kind-id__text">
            <div className="rts-kind-id__name">{nodeTitle(node)}</div>
            <div className="rts-kind-id__live">{nodeTypeLabel(node)}</div>
          </div>
        </div>
      ) : null}

      <PlacementGlance node={node} />

      <div className="rts-kind-strip" role="toolbar" aria-label={kind ? `${kind} actions` : "node actions"}>
        {kind ? <span className="rts-kind-strip__label">{kind}</span> : null}
        {hasKindActions ? <KindActions node={node} /> : null}
        <KindKey
          label={formOpen ? "Close fields" : "Open fields"}
          title="placement · label · kind fields"
          active={formOpen}
          style={{ color: formOpen ? HUE.amber : undefined }}
          onClick={() => setFormOpen((open) => !open)}
        >
          <Settings2 size={ICON} />
        </KindKey>
      </div>

      {formOpen ? <NodeFormFocus node={node} onClose={() => setFormOpen(false)} /> : null}
    </div>
  );
}
