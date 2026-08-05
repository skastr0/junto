import { memo, useEffect, useState } from "react";
import { X } from "lucide-react";
import { use$ } from "@legendapp/state/react";
import type { CanvasNode } from "@shared/canvas";
import { isHarnessId } from "@shared/managed-terminal-templates";
import { deleteEdges } from "../lib/edge-mutations";
import { NodeCapabilityInventory, NodeFieldEditors, NodePlacementSection } from "./InspectorFields";
import { edgeSheetTitle, WireSheetBody } from "./edges/WireSheet";
import { clearSelection, state$ } from "../lib/state";
import { DIM, GREEN, HUE, INK, withAlpha } from "../lib/theme";
import { nodeDetail, nodeTitle, nodeTypeLabel } from "../lib/presentation";
import { HERDR_ENABLED } from "@shared/features";
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
  return <div className="inspector-header"><div><div className="inspector-eyebrow">{eyebrow}</div><div className="inspector-title">{title}</div></div><button className="inspector-close" aria-label="Close inspector" title="Close inspector" onClick={onClose}><X size={14} /></button></div>;
}

// Accent lives on edges only here — node accent/flags/actions own the RTS command bar.
function AccentControls({ value, onChange }: { readonly value?: string; readonly onChange: (value?: string) => void }) {
  return <div className="inspector-section"><div className="inspector-section__label"><span className="inspector-color-dot" style={{ background: value ? undefined : HUE.amber }} /> accent</div><div className="inspector-colors"><button type="button" className="inspector-color-toggle inspector-color-toggle--default" aria-label="Use default accent" aria-pressed={!value} title="Default accent" onClick={() => onChange()}><span /></button>{COLOR_OPTIONS.map(({ value: optionValue, label, hue }) => <button key={optionValue} type="button" className="inspector-color-toggle" aria-label={`Set ${label} accent`} aria-pressed={value === optionValue} title={`${label} accent`} style={{ color: hue, borderColor: value === optionValue ? withAlpha(hue, 0.65) : withAlpha(hue, 0.22), background: withAlpha(hue, value === optionValue ? 0.18 : 0.07) }} onClick={() => onChange(optionValue)}><span style={{ background: hue }} /></button>)}</div></div>;
}

/** Seat-native agent readout — harness + document label only. */
function AgentSeatSection({ node }: { readonly node: CanvasNode }) {
  const harness =
    typeof node.ether?.terminal?.harness === "string"
      ? node.ether.terminal.harness
      : undefined;
  const managed = harness !== undefined && isHarnessId(harness);
  return (
    <div className="inspector-section">
      <div className="inspector-section__label">seat</div>
      <div className="mt-2 flex items-center gap-2.5">
        <HarnessMark agent={managed ? harness : undefined} size={28} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px]" style={{ color: INK }} title={nodeTitle(node)}>
            {nodeTitle(node)}
          </div>
          <div className="mt-0.5 truncate text-[9px]" style={{ color: DIM }}>
            {managed ? harness : "agent seat"}
          </div>
        </div>
      </div>
    </div>
  );
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
      ? `${connState} - ${reconnects} reconnect${reconnects === 1 ? "" : "s"}`
      : connState;
  const agent = meta?.agent
    ? meta.agentStatus
      ? `${meta.agent} - ${meta.agentStatus}`
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
        style={{ borderColor: "var(--color-stroke)", color: DIM }}
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

// Node accent / flags / focus / connect / delete / copy-ref live in the RTS
// command bar (lower-left). This panel keeps surface-specific detail only.
// Memoized so parent re-renders from unrelated doc churn (other-node drag stops
// that leave this node reference stable) do not rebuild the inspector tree.
const NodeInspector = memo(function NodeInspector({ node, onClose }: { readonly node: CanvasNode; readonly onClose: () => void }) {
  const isEntity = Boolean(node.ether?.entity);
  const isAgent = isEntity && node.ether?.entity?.kind === "agent";
  const isLabel = node.ether?.entity?.kind === "label";
  const detail =
    nodeDetail(node) || "";

  return <aside className="inspector-panel">
    <InspectorHeader eyebrow={nodeTypeLabel(node)} title={nodeTitle(node)} onClose={onClose} />
    <div className="inspector-body">
      {isLabel ? (
        <div className="inspector-detail">Bare map text - color and size from the canvas controls</div>
      ) : HERDR_ENABLED && isEntity && node.ether?.entity?.kind === "herdr" ? (
        <HerdrSections key={node.id} node={node} />
      ) : isAgent ? (
        <AgentSeatSection key={node.id} node={node} />
      ) : !isEntity && node.type === "text" ? (
        <div className="inspector-detail note-surface">
          <NoteMarkdown source={node.text.split("\n").slice(1).join("\n").trim()} />
        </div>
      ) : detail ? (
        <div className="inspector-detail">{detail}</div>
      ) : null}
      {!isLabel ? <WaitingOnSection key={`waiting:${node.id}`} nodeId={node.id} /> : null}
      {!isLabel && node.type !== "group" ? (
        <NodePlacementSection key={`place:${node.id}`} node={node} />
      ) : null}
      {!isLabel ? <NodeCapabilityInventory key={`cap:${node.id}`} node={node} /> : null}
      <NodeFieldEditors node={node} />
    </div>
  </aside>;
});

function EdgeInspector({ onClose }: { readonly onClose: () => void }) {
  const doc = use$(state$.doc);
  const edgeId = use$(state$.selectedEdgeId);
  const edge = doc.edges.find((candidate) => candidate.id === edgeId);
  if (!edge) return null;
  const source = doc.nodes.find((node) => node.id === edge.fromNode);
  const target = doc.nodes.find((node) => node.id === edge.toNode);
  const title = edgeSheetTitle(edge, source, target);
  return (
    <aside className="inspector-panel">
      <InspectorHeader
        eyebrow={
          source && target
            ? `${nodeTitle(source)} → ${nodeTitle(target)}`
            : "Selected link"
        }
        title={title}
        onClose={onClose}
      />
      <div className="inspector-body">
        <WireSheetBody
          edge={edge}
          fromNode={source}
          toNode={target}
          showDelete
          onDelete={() => deleteEdges([edge.id])}
        />
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
