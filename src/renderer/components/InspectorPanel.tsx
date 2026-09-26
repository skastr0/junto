import { memo, useEffect, useState } from "react";
import { X } from "lucide-react";
import { use$ } from "@legendapp/state/react";
import type { CanvasNode } from "@shared/canvas";
import { isHarnessId } from "@shared/managed-terminal-templates";
import { NodeCapabilityInventory, NodeFieldEditors, NodePlacementSection } from "./InspectorFields";
import { clearSelection, state$ } from "../lib/state";
import { DIM, GREEN, HUE, INK, withAlpha } from "../lib/theme";
import { nodeDetail, nodeTitle, nodeTypeLabel } from "../lib/presentation";
import { SeatRing } from "./SeatRing";
import { CustomizeAgentButton } from "./agent-editor/AgentEditor";
import { OverseerMark } from "./OverseerMark";
import { isOverseerSeat } from "../lib/overseer-set";
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

// Accent lives on edges only here — node accent/actions own the RTS command bar.
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
  const overseer = isOverseerSeat(node);
  return (
    <div className="inspector-section" data-overseer={overseer ? "true" : undefined}>
      <div className="inspector-section__label">seat</div>
      <div className="mt-2 flex items-center gap-2.5">
        <CustomizeAgentButton identity={node.id} name={nodeTitle(node)} hint>
          <SeatRing node={node} px={48} />
        </CustomizeAgentButton>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px]" style={{ color: INK }} title={nodeTitle(node)}>
            {nodeTitle(node)}
          </div>
          <div className="mt-0.5 truncate text-[9px]" style={{ color: DIM }}>
            {managed ? harness : "agent seat"}
          </div>
          {overseer ? (
            <div className="mt-1">
              <OverseerMark size="card" />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}



// Node accent / focus / connect / delete / copy-ref live in the RTS
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

/**
 * Nodes only. A relation has no panel: its verb, its endpoints, and its delete
 * all read off the RTS bottom bar, which is the entire edge surface.
 */
export function InspectorPanel() {
  // Select the inspected node by id so other nodes' drag stops (which keep
  // this node reference stable via syncPositions map) do not re-render us.
  const node = use$(() => {
    const id = state$.selectedNodeId.get();
    if (!id) return undefined;
    return state$.doc.get().nodes.find((candidate) => candidate.id === id);
  });
  const onClose = () => { clearSelection(); };
  if (node) return <NodeInspector node={node} onClose={onClose} />;
  return null;
}
