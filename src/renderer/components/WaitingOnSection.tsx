import { useMemo } from "react";
import { use$ } from "@legendapp/state/react";
import { executionGraphContextFromActorRefs } from "@shared/graph";
import { waitingOnPath, formatWaitingOnLines } from "@shared/impact";
import { selectNode, state$ } from "../lib/state";
import { kernel$ } from "../lib/kernel-view";
import { executionGraphForImpact } from "../lib/impact-mode";
import { HUE } from "../lib/theme";

/**
 * Inspector "Waiting on…" — reverse-walks reasonsByNodeId from the selected
 * blocked node to the stoppage seed, listing each relay hop.
 */
export function WaitingOnSection({ nodeId }: { readonly nodeId: string }) {
  const doc = use$(state$.doc);
  const execution = use$(kernel$.execution);
  const executionRev = use$(kernel$.executionRev);
  const canvasName = use$(state$.canvasName);
  const actorRefs = use$(state$.actorRefs);

  const path = useMemo(() => {
    const context = executionGraphContextFromActorRefs(canvasName, actorRefs);
    const graph = executionGraphForImpact(doc, execution, context);
    // Only show for blocked nodes or nodes inside a stoppage cone.
    if (!graph.blocked.has(nodeId) && !graph.seedNodeIds.has(nodeId)) {
      // Generators still surface a short path (themselves).
      const evalHasGenerate = doc.edges.some(
        (e) => e.fromNode === nodeId && graph.edgeEvalById.get(e.id)?.generates,
      );
      if (!evalHasGenerate) return null;
    }
    return waitingOnPath(doc, graph, nodeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actorRefs, canvasName, doc, execution, executionRev, nodeId]);

  if (!path || path.hops.length === 0) return null;

  const lines = formatWaitingOnLines(path, doc);
  if (lines.length === 0) return null;

  return (
    <div className="inspector-section" aria-label="Waiting on">
      <div className="inspector-section__label" style={{ color: HUE.crimson }}>
        Waiting on…
      </div>
      <ol className="inspector-waiting-on" style={{ margin: 0, paddingLeft: 16, listStyle: "decimal" }}>
        {lines.map((line, i) => {
          const hop = path.hops[i];
          const isSeed = hop?.role === "seed" || hop?.role === "generator" || hop?.role === "apex";
          return (
            <li
              key={`${hop?.nodeId ?? i}:${line}`}
              style={{
                fontSize: 11,
                lineHeight: 1.45,
                color: isSeed ? HUE.crimson : undefined,
                marginBottom: 2,
              }}
            >
              <button
                type="button"
                className="inspector-waiting-on__hop"
                style={{
                  background: "transparent",
                  border: 0,
                  padding: 0,
                  color: "inherit",
                  cursor: hop ? "pointer" : "default",
                  textAlign: "left",
                  font: "inherit",
                }}
                title={hop ? `Focus ${hop.nodeId}` : undefined}
                onClick={() => {
                  if (!hop) return;
                  selectNode(hop.nodeId);
                  state$.focusNodeId.set(hop.nodeId);
                }}
              >
                {line}
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
