import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Crosshair, ExternalLink, Link2, RotateCw, Trash2, X } from "lucide-react";
import { use$ } from "@legendapp/state/react";
import type { CanvasNode } from "@shared/canvas";
import { deleteNode, setNodeColor } from "../lib/mutations";
import { cycleEdgeKind, deleteEdges, editEdgeLabel, setEdgeColor, toggleEdgeArrow } from "../lib/edge-mutations";
import { state$ } from "../lib/state";
import { HUE, SOURCE_HUE, withAlpha } from "../lib/theme";
import { nodeDetail, nodeTitle, nodeTypeLabel } from "../lib/presentation";
import { EntityBadges } from "./EntityBadges";
import { ConnectEditor, NodeFieldEditors, NodeFlagControls } from "./InspectorFields";
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

function NodeInspector({ node, onClose }: { readonly node: CanvasNode; readonly onClose: () => void }) {
  const bindings = node.ether?.bindings ?? [];
  const doc = use$(state$.doc);
  const [connectOpen, setConnectOpen] = useState(false);
  return <aside className="inspector-panel">
    <InspectorHeader eyebrow={nodeTypeLabel(node)} title={nodeTitle(node)} onClose={onClose} />
    <div className="inspector-body">
      <div className="inspector-detail">{nodeDetail(node) || "No description recorded."}</div>
      {node.ether?.entity ? <div className="inspector-section"><div className="inspector-section__label">live readout</div><EntityBadges bindings={node.ether.bindings} /></div> : null}
      <div className="inspector-grid"><span>type<strong>{nodeTypeLabel(node)}</strong></span><span>geometry<strong>{node.width} × {node.height}</strong></span><span>position<strong>{node.x}, {node.y}</strong></span></div>
      <NodeFieldEditors node={node} />
      {bindings.length > 0 ? <div className="inspector-section"><div className="inspector-section__label"><Link2 size={11} /> connectors</div><div className="inspector-bindings">{bindings.map((binding) => <div className="inspector-binding" key={`${binding.source}:${binding.ref.key}`}><span className="inspector-binding__source" style={{ color: SOURCE_HUE[binding.source] }}>{binding.source}</span><span>{binding.ref.key}</span></div>)}</div></div> : null}
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
