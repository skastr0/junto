import { memo, useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Trash2, X } from "lucide-react";
import { use$ } from "@legendapp/state/react";
import type { CanvasNode } from "@shared/canvas";
import type { AgentIdentity } from "@shared/ipc";
import { deriveExecutionGraph } from "@shared/execution-graph";
import { executionGraphContextFromActorRefs } from "@shared/graph";
import { deleteEdges, editEdgeLabel, setEdgeColor, setEdgeCriteria, toggleEdgeArrow } from "../lib/edge-mutations";
import { EdgeCapabilitySection, EdgeCriteriaEditor, EdgePortsAttenuator, NodeCapabilityInventory, NodeFieldEditors, NodePlacementSection } from "./InspectorFields";
import { clearSelection, state$ } from "../lib/state";
import { kernel$ } from "../lib/kernel-view";
import { DIM, GREEN, HUE, INK, SOURCE_HUE, withAlpha } from "../lib/theme";
import { resolveNodeConnections } from "../../shared/connections";
import { nodeDetail, nodeTitle, nodeTypeLabel } from "../lib/presentation";
import { getAgentAvatar, getAgentIdentity } from "../lib/agent";
import { connectionStateOf, herdr$, refreshHerdrMeta } from "../lib/herdr-state";
import { HarnessMark } from "./herdr/HarnessMark";
import { NoteMarkdown } from "../lib/note-markdown";
import { WaitingOnSection } from "./WaitingOnSection";

const COLOR_OPTIONS: ReadonlyArray<{ readonly value: string; readonly label: string; readonly hue: string }> = [
  { value: "1", label: "red", hue: HUE.crimson },
  { value: "2", label: "orange", hue: HUE.orange },
  { value: "3", label: "gold", hue: HUE.gold },
  { value: "4", label: "green", hue: GREEN },
  { value: "5", label: "cyan", hue: HUE.cyan },
  { value: "6", label: "violet", hue: HUE.violet },
];

function InspectorHeader({ eyebrow, title, onClose }: { readonly eyebrow: string; readonly title: string; readonly onClose: () => void }) {
  return <div className="inspector-header"><div><div className="inspector-eyebrow">{eyebrow}</div><div className="inspector-title">{title}</div></div><button className="inspector-close" aria-label="Close inspector" title="close inspector" onClick={onClose}><X size={14} /></button></div>;
}

// Accent lives on edges only here — node accent/flags/actions own the RTS command bar.
function AccentControls({ value, onChange }: { readonly value?: string; readonly onChange: (value?: string) => void }) {
  return <div className="inspector-section"><div className="inspector-section__label"><span className="inspector-color-dot" style={{ background: value ? undefined : HUE.amber }} /> accent</div><div className="inspector-colors"><button type="button" className="inspector-color-toggle inspector-color-toggle--default" aria-label="Use default accent" aria-pressed={!value} title="default accent" onClick={() => onChange()}><span /></button>{COLOR_OPTIONS.map(({ value: optionValue, label, hue }) => <button key={optionValue} type="button" className="inspector-color-toggle" aria-label={`Set ${label} accent`} aria-pressed={value === optionValue} title={`${label} accent`} style={{ color: hue, borderColor: value === optionValue ? withAlpha(hue, 0.65) : withAlpha(hue, 0.22), background: withAlpha(hue, value === optionValue ? 0.18 : 0.07) }} onClick={() => onChange(optionValue)}><span style={{ background: hue }} /></button>)}</div></div>;
}

// The entity readout, inspector-sized: one plain stat line plus a freshness
// row per connector — the same truth the card wears, with room to breathe.
function LiveReadout({ node }: { readonly node: CanvasNode }) {
  const snapshots = use$(state$.snapshots);
  const connections = resolveNodeConnections(node.ether?.entity, snapshots).filter((c) => c.source === "hermes");
  const hermes = connections[0]?.entity;
  const segments: string[] = [];
  if (hermes) {
    const status = hermes.stats.status;
    if (typeof status === "string" && status) segments.push(status);
    const model = hermes.stats.model;
    if (typeof model === "string" && model) segments.push(model);
  }
  return <div className="inspector-section">
    <div className="inspector-section__label">live readout</div>
    <div className="text-[13px] tabular-nums" style={{ color: "#EDE6DA" }}>{segments.join(" · ") || <span style={{ color: DIM }}>no live data</span>}</div>
    <div className="inspector-bindings mt-2">{connections.map((connection) => {
      const ok = connection.entity !== undefined;
      return <div className="inspector-binding" key={`${connection.source}:${connection.key}`}>
        <span className="inspector-binding__source" style={{ color: SOURCE_HUE[connection.source] }}>
          <i className="mr-1.5 inline-block size-[5px] rounded-full align-middle" style={{ background: SOURCE_HUE[connection.source], opacity: ok ? 1 : 0.3 }} />
          {connection.source}
        </span>
        <span>{connection.key}</span>
        <span style={{ color: ok ? SOURCE_HUE[connection.source] : DIM }}>{ok ? "fresh" : "stale"}</span>
      </div>;
    })}</div>
  </div>;
}

// Herdr inspector: glance essentials only (host + status + agent).
function HerdrSections({ node }: { readonly node: CanvasNode }) {
  const herdr = node.ether?.herdr;
  const metaCache = use$(herdr$.metaByNodeId[node.id]);
  const conn = use$(herdr$.connectionByNodeId[node.id]);
  if (!herdr) return null;
  const meta = metaCache?.meta;
  const connState = conn?.state ?? connectionStateOf(node.id);
  const reconnects = conn?.reconnectAttempts ?? 0;
  const status =
    reconnects > 0
      ? `${connState} · ${reconnects} reconnect${reconnects === 1 ? "" : "s"}`
      : connState;
  const agent = meta?.agent
    ? meta.agentStatus
      ? `${meta.agent} · ${meta.agentStatus}`
      : meta.agent
    : undefined;

  return <div className="inspector-section">
    <div className="inspector-section__label">herdr</div>
    <div className="inspector-bindings mt-2">
      {herdr.host ? (
        <div className="inspector-binding" title={herdr.host}>
          <span className="inspector-binding__source">host</span>
          <span>{herdr.host}</span>
        </div>
      ) : null}
      <div className="inspector-binding" title={status}>
        <span className="inspector-binding__source">status</span>
        <span>{status}</span>
      </div>
      {agent ? (
        <div className="inspector-binding" key="agent" title={agent} style={{ alignItems: "center" }}>
          <span className="inspector-binding__source">agent</span>
          <span className="flex min-w-0 items-center gap-1.5">
            <HarnessMark agent={meta?.agent} size={20} focused={meta?.focused === true} />
            <span className="truncate">{agent}</span>
          </span>
        </div>
      ) : null}
    </div>
    <div className="mt-2 flex items-center gap-2">
      <button
        type="button"
        className="rounded-md border px-2 py-1 text-[9px] uppercase tracking-[.12em] transition hover:bg-white/5"
        style={{ borderColor: "rgba(237,230,218,.14)", color: DIM }}
        onClick={() => void refreshHerdrMeta(node.id, herdr)}
      >
        refresh
      </button>
      {metaCache?.status === "loading" ? (
        <span className="text-[9px]" style={{ color: DIM }}>loading…</span>
      ) : null}
    </div>
    {metaCache?.status === "error" && metaCache.error ? (
      <div className="mt-1 text-[9px]" style={{ color: withAlpha(HUE.crimson, 0.75) }}>{metaCache.error}</div>
    ) : null}
  </div>;
}

// Agent details stay inspectorial. Conversation belongs to the ACP work
// surface, so this section intentionally stops at identity.
function AgentSections({ node }: { readonly node: CanvasNode }) {
  const entity = node.ether?.entity;
  const hermesKey = entity?.kind === "agent" ? entity.name : undefined;
  const rawName = (node.type === "text" ? node.text : "").split("\n")[0] ?? "";
  const [avatar, setAvatar] = useState<string | null>(null);
  const [identity, setIdentity] = useState<AgentIdentity | null>(null);

  useEffect(() => {
    if (!hermesKey) return;
    let cancelled = false;
    // getAgentAvatar/getAgentIdentity never reject (lib/agent.ts resolves a
    // miss to null) — the .catch is a floor against a future change to that.
    void getAgentAvatar(hermesKey).then((value) => { if (!cancelled) setAvatar(value); }).catch(() => undefined);
    void getAgentIdentity(hermesKey).then((value) => { if (!cancelled) setIdentity(value); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [hermesKey]);

  if (!hermesKey) return null;

  const displayName = identity?.displayName;

  return (
    <div className="inspector-section">
      <div className="inspector-section__label">identity</div>
      <div className="mt-2 flex items-center gap-2.5">
        <span className="shrink-0 overflow-hidden rounded-full" style={{ width: 36, height: 36, background: "rgba(255,255,255,.04)", border: "1px solid rgba(237,230,218,.12)" }}>
          {avatar ? <img src={avatar} alt="" className="size-full object-cover" /> : null}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px]" style={{ color: INK }} title={rawName}>{displayName ?? rawName}</div>
          {identity?.matrixUserId ? <div className="mt-0.5 truncate text-[9px]" style={{ color: DIM }}>{identity.matrixUserId}</div> : null}
          {identity?.homeRoomName ? <div className="mt-0.5 truncate text-[9px]" style={{ color: DIM }}>{identity.homeRoomName}</div> : null}
        </div>
      </div>
    </div>
  );
}

// Node accent / flags / focus / connect / delete / copy-ref live in the RTS
// command bar (lower-left). This panel keeps surface-specific detail only.
// Memoized so parent re-renders from unrelated doc churn (other-node drag stops
// that leave this node reference stable) do not rebuild the inspector tree.
const NodeInspector = memo(function NodeInspector({ node, onClose }: { readonly node: CanvasNode; readonly onClose: () => void }) {
  const isEntity = Boolean(node.ether?.entity);
  const isAgent = isEntity && node.ether?.entity?.kind === "agent";
  const detail =
    nodeDetail(node) || "";

  return <aside className="inspector-panel">
    <InspectorHeader eyebrow={nodeTypeLabel(node)} title={nodeTitle(node)} onClose={onClose} />
    <div className="inspector-body">
      {isEntity && node.ether?.entity?.kind === "herdr" ? (
        <HerdrSections key={node.id} node={node} />
      ) : isEntity && node.ether?.entity?.kind === "agent" ? (
        <LiveReadout node={node} />
      ) : !isEntity && node.type === "text" ? (
        <div className="inspector-detail note-surface">
          <NoteMarkdown source={node.text.split("\n").slice(1).join("\n").trim()} />
        </div>
      ) : detail ? (
        <div className="inspector-detail">{detail}</div>
      ) : null}
      {isAgent ? <AgentSections key={node.id} node={node} /> : null}
      <WaitingOnSection key={`waiting:${node.id}`} nodeId={node.id} />
      <NodePlacementSection key={`place:${node.id}`} node={node} />
      <NodeCapabilityInventory key={`cap:${node.id}`} node={node} />
      <NodeFieldEditors node={node} />
    </div>
  </aside>;
});

function EdgeInspector({ onClose }: { readonly onClose: () => void }) {
  const doc = use$(state$.doc);
  const canvasName = use$(state$.canvasName);
  const actorRefs = use$(state$.actorRefs);
  const edgeId = use$(state$.selectedEdgeId);
  const execution = use$(kernel$.execution);
  const edge = doc.edges.find((candidate) => candidate.id === edgeId);
  const [labelDraft, setLabelDraft] = useState(edge?.label ?? "");
  useEffect(() => setLabelDraft(edge?.label ?? ""), [edge?.label, edgeId]);
  if (!edge) return null;
  const source = doc.nodes.find((node) => node.id === edge.fromNode);
  const target = doc.nodes.find((node) => node.id === edge.toNode);
  // Match canvas: prefer kernel overlay, else cold derive (tasks work offline).
  const cold = execution
    ? null
    : deriveExecutionGraph(
        doc,
        executionGraphContextFromActorRefs(canvasName, actorRefs),
      );
  const livePhase =
    execution?.phaseByEdgeId?.[edge.id] ?? cold?.phaseByEdgeId.get(edge.id) ?? "relates";
  const liveDetail =
    execution?.detailByEdgeId?.[edge.id] ?? cold?.detailByEdgeId.get(edge.id) ?? "";
  const criteria = edge.ether?.criteria;
  const commitLabel = () => {
    if (labelDraft !== (edge.label ?? "")) editEdgeLabel(edge.id, labelDraft);
  };
  const eyebrow = criteria
    ? `live / ${livePhase} · ${criteria.mode}`
    : `soft / ${livePhase}`;
  return (
    <aside className="inspector-panel">
      <InspectorHeader eyebrow={eyebrow} title="execution edge" onClose={onClose} />
      <div className="inspector-body">
        <div className="inspector-edge">
          <span>{source ? nodeTitle(source) : edge.fromNode}</span>
          <ArrowRight size={14} style={{ color: HUE.amber }} />
          <span>{target ? nodeTitle(target) : edge.toNode}</span>
        </div>
        <EdgeCapabilitySection edge={edge} fromNode={source} toNode={target} />
        <EdgePortsAttenuator edge={edge} />
        <EdgeCriteriaEditor
          edgeId={edge.id}
          fromNode={source}
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
        <AccentControls value={edge.color} onChange={(color) => setEdgeColor(edge.id, color)} />
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
              <ArrowLeft size={13} />
              source
            </button>
            <button
              type="button"
              aria-label="Toggle target arrow"
              aria-pressed={edge.toEnd === "arrow"}
              className={edge.toEnd === "arrow" ? "is-active" : ""}
              onClick={() => toggleEdgeArrow(edge.id, "to")}
            >
              <ArrowRight size={13} />
              target
            </button>
          </div>
        </div>
        <div className="inspector-actions">
          {criteria ? (
            <button onClick={() => setEdgeCriteria(edge.id, undefined)}>
              clear criteria
            </button>
          ) : null}
          <button className="inspector-action--danger" onClick={() => deleteEdges([edge.id])}>
            <Trash2 size={13} />
            delete edge
          </button>
        </div>
      </div>
    </aside>
  );
}

export function InspectorPanel() {
  // Select the inspected node by id so other nodes' drag stops (which keep
  // this node reference stable via syncPositions map) do not re-render us.
  const node = use$(() => {
    const id = state$.selectedNodeId.get();
    if (!id) return undefined;
    return state$.doc.get().nodes.find((candidate) => candidate.id === id);
  });
  const edgeId = use$(state$.selectedEdgeId);
  const onClose = () => { clearSelection(); };
  if (node) return <NodeInspector node={node} onClose={onClose} />;
  if (edgeId) return <EdgeInspector onClose={onClose} />;
  return null;
}
