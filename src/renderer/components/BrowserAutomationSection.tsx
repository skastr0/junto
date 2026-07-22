import type { CanvasNode } from "@shared/canvas";
import { useMemo } from "react";
import { formatNodeRef } from "@shared/node-ref";
import { roleOf, resolveSpec } from "@shared/physics";
import { isGroup } from "@shared/graph";
import { DIM, HUE, INK, withAlpha } from "../lib/theme";

/**
 * Browser access is process-bind + human-drawn edges — no enable/grant ceremony.
 * All physics actors (agent | terminal | herdr) may wield browser tools when
 * process-bound and edged to page sinks.
 */
export function BrowserAutomationSection({
  canvasName,
  node,
}: {
  readonly canvasName: string;
  readonly node: CanvasNode;
}) {
  const kind = node.ether?.entity?.kind;
  const role = roleOf(
    resolveSpec({ isGroup: isGroup(node), kind }),
  );
  // Physics actors only — furniture/sinks/schedulers do not wield browser tools.
  const eligible = role === "actor" && (kind === "agent" || kind === "terminal" || kind === "herdr");

  const selfRef = useMemo(() => {
    try {
      return formatNodeRef({ canvasName, nodeId: node.id });
    } catch {
      return undefined;
    }
  }, [canvasName, node.id]);

  if (!eligible) return null;

  const seatHint =
    kind === "agent"
      ? "Open this agent chat so Vellum registers its process"
      : kind === "herdr"
        ? "Refresh the herdr pane so Vellum registers its process"
        : "Start this terminal so Vellum registers its process";

  return (
    <div className="inspector-section">
      <div className="inspector-section__label">browser access</div>
      <p className="text-xs mb-2" style={{ color: withAlpha(INK, 0.75) }}>
        Process-bind + edges. {seatHint}, draw edges to page nodes, then run{" "}
        <code style={{ color: HUE.cyan }}>vellum-browser</code> from that process tree.
        Actors: agent, terminal, herdr. No enable grant.
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
      {kind === "terminal" && typeof node.ether?.terminal?.bindingId === "string" && (
        <div className="inspector-binding text-xs" style={{ color: DIM }}>
          binding {node.ether.terminal.bindingId}
        </div>
      )}
      <p className="text-xs mt-2" style={{ color: withAlpha(INK, 0.55) }}>
        Draw an edge from this card to a page node to authorize targets. Scope is
        live edges (and optional port attenuation), not a grant list.
      </p>
    </div>
  );
}
