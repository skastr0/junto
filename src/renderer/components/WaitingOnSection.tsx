import { useMemo } from "react";
import { use$ } from "@legendapp/state/react";
import { executionGraphContextFromActorRefs } from "@shared/graph";
import { waitingOnPath, formatWaitingOnLines } from "@shared/impact";
import { selectNode, state$ } from "../lib/state";
import { kernel$ } from "../lib/kernel-view";
import { executionGraphForImpact } from "../lib/impact-mode";
import { HUE, HUE_TEXT } from "../lib/theme";
import { useCanvas } from "../lib/use-model";
import { useCanvasWorkItems } from "../lib/use-work-sink";

/**
 * Inspector "Waiting on…" — walks from the selected blocked seat to the task
 * node holding it, or names a task node's own stop.
 */
export function WaitingOnSection({ nodeId }: { readonly nodeId: string }) {
  const execution = use$(kernel$.execution);
  const executionRev = use$(kernel$.executionRev);
  const canvasName = use$(state$.canvasName);
  const actorRefs = use$(state$.actorRefs);
  const itemsOf = useCanvasWorkItems(canvasName);
  const canvas = useCanvas(canvasName);

  const path = useMemo(() => {
    const context = executionGraphContextFromActorRefs(
      canvasName,
      actorRefs,
      itemsOf,
    );
    const graph = executionGraphForImpact(canvas, execution, context);
    // Blocked seats and the task nodes holding them; empty for the rest.
    return waitingOnPath(canvas, graph, nodeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actorRefs, canvasName, canvas, execution, executionRev, nodeId, itemsOf]);

  if (!path || path.hops.length === 0) return null;

  const lines = formatWaitingOnLines(path, canvas);
  if (lines.length === 0) return null;

  return (
    <div className="inspector-section" aria-label="Waiting on">
      <div className="inspector-section__label" style={{ color: HUE_TEXT.crimson }}>
        Waiting on…
      </div>
      <ol className="inspector-waiting-on" style={{ margin: 0, paddingLeft: 16, listStyle: "decimal" }}>
        {lines.map((line, i) => {
          const hop = path.hops[i];
          const isSeed = hop?.role === "generator" || hop?.role === "apex";
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
