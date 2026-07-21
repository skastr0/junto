import type { CanvasNode } from "@shared/canvas";
import { useMemo } from "react";
import { formatNodeRef } from "@shared/node-ref";
import { DIM, HUE, INK, withAlpha } from "../lib/theme";

/**
 * Browser access is process-bind + human-drawn edges — no enable/grant ceremony.
 * Agent and herdr cards show how tools admit; scope is live edges to page nodes.
 */
export function BrowserAutomationSection({
  canvasName,
  node,
}: {
  readonly canvasName: string;
  readonly node: CanvasNode;
}) {
  const kind = node.ether?.entity?.kind;
  const eligible = kind === "agent" || kind === "herdr";

  const selfRef = useMemo(() => {
    try {
      return formatNodeRef({ canvasName, nodeId: node.id });
    } catch {
      return undefined;
    }
  }, [canvasName, node.id]);

  if (!eligible) {
    return (
      <div className="inspector-section">
        <div className="inspector-section__label">browser access</div>
        <p className="text-xs" style={{ color: withAlpha(INK, 0.65) }}>
          Only agent and herdr nodes use process-bound browser tools.
        </p>
      </div>
    );
  }

  return (
    <div className="inspector-section">
      <div className="inspector-section__label">browser access</div>
      <p className="text-xs mb-2" style={{ color: withAlpha(INK, 0.75) }}>
        Process-bind + edges. Open this agent (or refresh the herdr pane) so Vellum
        registers its process, draw edges to page nodes, then run{" "}
        <code style={{ color: HUE.cyan }}>vellum-browser</code> from that process tree.
        No enable grant.
      </p>
      {selfRef !== undefined && (
        <div className="inspector-binding text-xs" style={{ color: DIM }}>
          node {selfRef}
        </div>
      )}
      {kind === "agent" && typeof node.ether?.entity?.name === "string" && (
        <div className="inspector-binding text-xs" style={{ color: DIM }}>
          hermes {node.ether.entity.name}
        </div>
      )}
      {kind === "herdr" && typeof node.ether?.herdr?.paneId === "string" && (
        <div className="inspector-binding text-xs" style={{ color: DIM }}>
          pane {node.ether.herdr.paneId}
        </div>
      )}
      <p className="text-xs mt-2" style={{ color: withAlpha(INK, 0.55) }}>
        Draw an edge from this card to a page node to authorize targets. Scope is
        live edges, not a grant list.
      </p>
    </div>
  );
}
