import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Crosshair, ExternalLink, Link2, RotateCw, Trash2, X } from "lucide-react";
import { use$ } from "@legendapp/state/react";
import type { CanvasNode } from "@shared/canvas";
import type { AgentIdentity } from "@shared/ipc";
import { deleteNode, setNodeColor } from "../lib/mutations";
import { cycleEdgeKind, deleteEdges, editEdgeLabel, setEdgeColor, toggleEdgeArrow } from "../lib/edge-mutations";
import { state$ } from "../lib/state";
import { DIM, HUE, INK, SOURCE_HUE, withAlpha } from "../lib/theme";
import { entityReadout } from "../lib/entity-readout";
import { nodeDetail, nodeTitle, nodeTypeLabel } from "../lib/presentation";
import { getAgentAvatar, getAgentIdentity } from "../lib/agent";
import { getVellumApi } from "../lib/vellum-api";
import { ConnectEditor, NodeFieldEditors, NodeFlagControls } from "./InspectorFields";
import { ProjectBrowseSection } from "./InspectorBrowse";
const COLOR_OPTIONS: ReadonlyArray<{ readonly value: string; readonly label: string; readonly hue: string }> = [
  { value: "1", label: "red", hue: HUE.crimson },
  { value: "2", label: "orange", hue: HUE.orange },
  { value: "3", label: "gold", hue: HUE.gold },
  { value: "4", label: "green", hue: "#5FB98E" },
  { value: "5", label: "cyan", hue: HUE.cyan },
  { value: "6", label: "violet", hue: HUE.violet },
];

function InspectorHeader({ eyebrow, title, onClose }: { readonly eyebrow: string; readonly title: string; readonly onClose: () => void }) {
  return <div className="inspector-header"><div><div className="inspector-eyebrow">{eyebrow}</div><div className="inspector-title">{title}</div></div><button className="inspector-close" aria-label="Close inspector" title="close inspector" onClick={onClose}><X size={14} /></button></div>;
}

function AccentControls({ value, onChange }: { readonly value?: string; readonly onChange: (value?: string) => void }) {
  return <div className="inspector-section"><div className="inspector-section__label"><span className="inspector-color-dot" style={{ background: value ? undefined : HUE.amber }} /> accent</div><div className="inspector-colors"><button type="button" className="inspector-color-toggle inspector-color-toggle--default" aria-label="Use default accent" aria-pressed={!value} title="default accent" onClick={() => onChange()}><span /></button>{COLOR_OPTIONS.map(({ value: optionValue, label, hue }) => <button key={optionValue} type="button" className="inspector-color-toggle" aria-label={`Set ${label} accent`} aria-pressed={value === optionValue} title={`${label} accent`} style={{ color: hue, borderColor: value === optionValue ? withAlpha(hue, 0.65) : withAlpha(hue, 0.22), background: withAlpha(hue, value === optionValue ? 0.18 : 0.07) }} onClick={() => onChange(optionValue)}><span style={{ background: hue }} /></button>)}</div></div>;
}

// The entity readout, inspector-sized: one plain stat line plus a freshness
// row per connector — the same truth the card wears, with room to breathe.
function LiveReadout({ node }: { readonly node: CanvasNode }) {
  const snapshots = use$(state$.snapshots);
  const { segments, dots } = entityReadout(node.ether?.bindings, snapshots);
  const bindings = node.ether?.bindings ?? [];
  return <div className="inspector-section">
    <div className="inspector-section__label">live readout</div>
    <div className="text-[13px] tabular-nums" style={{ color: "#EDE6DA" }}>{segments.join(" · ") || <span style={{ color: DIM }}>no live data</span>}</div>
    <div className="inspector-bindings mt-2">{bindings.map((binding, i) => {
      const ok = dots[i]?.ok ?? false;
      return <div className="inspector-binding" key={`${binding.source}:${binding.ref.key}`}>
        <span className="inspector-binding__source" style={{ color: SOURCE_HUE[binding.source] }}>
          <i className="mr-1.5 inline-block size-[5px] rounded-full align-middle" style={{ background: SOURCE_HUE[binding.source], opacity: ok ? 1 : 0.3 }} />
          {binding.source}
        </span>
        <span>{binding.ref.key}</span>
        <span style={{ color: ok ? SOURCE_HUE[binding.source] : DIM }}>{ok ? "fresh" : "stale"}</span>
      </div>;
    })}</div>
  </div>;
}

// Identity (avatar + displayName + matrixUserId + homeRoomName) plus v1
// fire-and-response messaging for one hermes agent. No session history —
// the last reply just stays on screen until the next send replaces it.
function AgentSections({ node }: { readonly node: CanvasNode }) {
  const hermesKey = (node.ether?.bindings ?? []).find((binding) => binding.source === "hermes")?.ref.key;
  const rawName = (node.type === "text" ? node.text : "").split("\n")[0] ?? "";
  const [avatar, setAvatar] = useState<string | null>(null);
  const [identity, setIdentity] = useState<AgentIdentity | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [reply, setReply] = useState<{ readonly text: string; readonly at: number } | undefined>(undefined);
  const [sendError, setSendError] = useState("");

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

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setSendError("");
    try {
      const api = getVellumApi();
      if (!api || typeof api.agentMessage !== "function") throw new Error("agent messaging unreachable");
      const result = await api.agentMessage(hermesKey, text);
      if (result.ok && result.reply) {
        setReply({ text: result.reply, at: Date.now() });
      } else {
        setSendError(result.error ?? "agent did not reply");
      }
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  };

  return <>
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
    <div className="inspector-section">
      <div className="inspector-section__label">message</div>
      <div className="inspector-editor mt-2">
        <textarea aria-label="Message this agent" rows={3} placeholder="fire a message at this agent…" value={draft} disabled={sending} onChange={(event) => setDraft(event.target.value)} />
      </div>
      <button
        type="button"
        className="mt-2 w-full rounded-md border py-1.5 text-[9px] uppercase tracking-[.12em] transition disabled:cursor-not-allowed disabled:opacity-35"
        style={{ borderColor: withAlpha(HUE.amber, 0.35), background: withAlpha(HUE.amber, 0.08), color: HUE.amber }}
        disabled={sending || !draft.trim()}
        onClick={() => void send()}
      >
        {sending ? "sending…" : "send"}
      </button>
      {sending ? <div className="vellum-dot--pulse mt-2 text-[10px]" style={{ color: DIM }}>waiting for {displayName ?? rawName}… (can take a minute)</div> : null}
      {sendError ? <div className="mt-2 text-[10px]" style={{ color: withAlpha(HUE.crimson, 0.75) }}>{sendError}</div> : null}
      {reply ? <div className="mt-2">
        <div className="text-[8px] uppercase tracking-[.14em]" style={{ color: DIM }}>reply · {new Date(reply.at).toLocaleTimeString()}</div>
        <pre className="nowheel mt-1 max-h-[300px] overflow-y-auto whitespace-pre-wrap text-[11px] leading-relaxed" style={{ color: INK, fontFamily: "ui-monospace, SFMono-Regular, monospace" }}>{reply.text}</pre>
      </div> : null}
    </div>
  </>;
}

function NodeInspector({ node, onClose }: { readonly node: CanvasNode; readonly onClose: () => void }) {
  const bindings = node.ether?.bindings ?? [];
  const doc = use$(state$.doc);
  const [connectOpen, setConnectOpen] = useState(false);
  const isEntity = Boolean(node.ether?.entity);
  return <aside className="inspector-panel">
    <InspectorHeader eyebrow={nodeTypeLabel(node)} title={nodeTitle(node)} onClose={onClose} />
    <div className="inspector-body">
      {!isEntity ? <div className="inspector-detail">{nodeDetail(node) || "No description recorded."}</div> : null}
      {isEntity ? <LiveReadout node={node} /> : null}
      {isEntity && node.ether?.entity?.kind === "project" ? <ProjectBrowseSection key={node.id} node={node} /> : null}
      {isEntity && node.ether?.entity?.kind === "agent" ? <AgentSections key={node.id} node={node} /> : null}
      <NodeFieldEditors node={node} />
      {!isEntity && bindings.length > 0 ? <div className="inspector-section"><div className="inspector-section__label"><Link2 size={11} /> connectors</div><div className="inspector-bindings">{bindings.map((binding) => <div className="inspector-binding" key={`${binding.source}:${binding.ref.key}`}><span className="inspector-binding__source" style={{ color: SOURCE_HUE[binding.source] }}>{binding.source}</span><span>{binding.ref.key}</span></div>)}</div></div> : null}
      <AccentControls value={node.color} onChange={(color) => setNodeColor(node.id, color)} />
      <NodeFlagControls node={node} />
      <div className="inspector-actions"><button onClick={() => { state$.searchQuery.set(""); state$.edgeFilter.set(""); state$.flagFilter.set(""); state$.focusNodeId.set(node.id); }}><Crosshair size={13} />focus node</button>{node.type === "link" ? <button onClick={() => window.open(node.url, "_blank")}><ExternalLink size={13} />open link</button> : null}<button onClick={() => setConnectOpen((open) => !open)}><ArrowRight size={13} />connect to…</button><button className="inspector-action--danger" onClick={() => deleteNode(node.id)}><Trash2 size={13} />delete</button></div>
      <ConnectEditor node={node} doc={doc} open={connectOpen} onOpenChange={setConnectOpen} />
    </div>
  </aside>;
}

function EdgeInspector({ onClose }: { readonly onClose: () => void }) {
  const doc = use$(state$.doc);
  const edgeId = use$(state$.selectedEdgeId);
  const edge = doc.edges.find((candidate) => candidate.id === edgeId);
  const [labelDraft, setLabelDraft] = useState(edge?.label ?? "");
  useEffect(() => setLabelDraft(edge?.label ?? ""), [edge?.label, edgeId]);
  if (!edge) return null;
  const source = doc.nodes.find((node) => node.id === edge.fromNode);
  const target = doc.nodes.find((node) => node.id === edge.toNode);
  const kind = edge.ether?.kind ?? "relates";
  const commitLabel = () => {
    if (labelDraft !== (edge.label ?? "")) editEdgeLabel(edge.id, labelDraft);
  };
  return <aside className="inspector-panel"><InspectorHeader eyebrow={`connection / ${kind}`} title="graph relation" onClose={onClose} /><div className="inspector-body"><div className="inspector-edge"><span>{source ? nodeTitle(source) : edge.fromNode}</span><ArrowRight size={14} style={{ color: HUE.amber }} /><span>{target ? nodeTitle(target) : edge.toNode}</span></div><div className="inspector-detail">Label, accent, arrows, and kind are editable below.</div><label className="inspector-edge-label"><span>edge label</span><input aria-label="Edit edge label" value={labelDraft} placeholder={kind} onChange={(event) => setLabelDraft(event.target.value)} onBlur={commitLabel} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitLabel(); event.currentTarget.blur(); } if (event.key === "Escape") { setLabelDraft(edge.label ?? ""); event.currentTarget.blur(); } }} /></label><AccentControls value={edge.color} onChange={(color) => setEdgeColor(edge.id, color)} /><div className="inspector-edge-ends"><span>arrow ends</span><div><button type="button" aria-label="Toggle source arrow" aria-pressed={edge.fromEnd === "arrow"} className={edge.fromEnd === "arrow" ? "is-active" : ""} onClick={() => toggleEdgeArrow(edge.id, "from")}><ArrowLeft size={13} />source</button><button type="button" aria-label="Toggle target arrow" aria-pressed={edge.toEnd === "arrow"} className={edge.toEnd === "arrow" ? "is-active" : ""} onClick={() => toggleEdgeArrow(edge.id, "to")}><ArrowRight size={13} />target</button></div></div><div className="inspector-actions"><button onClick={() => cycleEdgeKind(edge.id)}><RotateCw size={13} />cycle kind</button><button className="inspector-action--danger" onClick={() => deleteEdges([edge.id])}><Trash2 size={13} />delete edge</button></div></div></aside>;
}

export function InspectorPanel() {
  const doc = use$(state$.doc);
  const nodeId = use$(state$.selectedNodeId);
  const edgeId = use$(state$.selectedEdgeId);
  const node = doc.nodes.find((candidate) => candidate.id === nodeId);
  const onClose = () => { state$.selectedNodeId.set(""); state$.selectedEdgeId.set(""); };
  if (node) return <NodeInspector node={node} onClose={onClose} />;
  if (edgeId) return <EdgeInspector onClose={onClose} />;
  return null;
}
