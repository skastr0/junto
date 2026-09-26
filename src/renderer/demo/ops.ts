import { observable } from "@legendapp/state";
import type { CanvasDoc } from "@shared/canvas";
import type { DemoBeat, DemoOp, DemoScenario } from "@shared/demo";
import { beatMs } from "@shared/demo";
import { formatNodeRef } from "@shared/node-ref";
import { cycleAlertFocus } from "../lib/alert-attention";
import { commitDoc } from "../lib/mutations";
import { selectNodes, state$ } from "../lib/state";
import { playDemoCue } from "../lib/sound";
import { demoCamera } from "./camera-bridge";

// Demo/scripting engine only. Applies one scenario beat's ops against the
// live app: doc-mutating ops fold into a single commitDoc (no undo entry —
// this is a film set, not an editable document), the rest drive selection,
// sfx, the HUD badge, and the camera.

/** hud op toggles this; DemoLayer renders nothing while it's false. */
export const demoHud$ = observable(true);

const DOC_OP_KINDS = new Set<DemoOp["kind"]>(["add-nodes", "add-edges", "remove-nodes"]);

const applyDocOps = (doc: CanvasDoc, ops: ReadonlyArray<DemoOp>): CanvasDoc =>
  ops.reduce<CanvasDoc>((acc, op) => {
    switch (op.kind) {
      case "add-nodes":
        return { ...acc, nodes: [...acc.nodes, ...op.nodes] };
      case "add-edges":
        return { ...acc, edges: [...acc.edges, ...op.edges] };
      case "remove-nodes": {
        const removed = new Set(op.ids);
        return {
          nodes: acc.nodes.filter((node) => !removed.has(node.id)),
          edges: acc.edges.filter((edge) => !removed.has(edge.fromNode) && !removed.has(edge.toNode)),
        };
      }
      default:
        return acc;
    }
  }, doc);

/** Execute every op in one scheduled beat. Doc-mutating ops (add-nodes,
 * add-edges, remove-nodes) fold into ONE commitDoc call so the graph
 * rebuilds exactly once per beat. */
export const executeBeat = (scenario: DemoScenario, beat: DemoBeat): void => {
  if (beat.ops.some((op) => DOC_OP_KINDS.has(op.kind))) {
    commitDoc(applyDocOps(state$.doc.peek(), beat.ops), true, false);
  }

  for (const op of beat.ops) {
    switch (op.kind) {
      case "select":
        selectNodes(op.nodeIds);
        break;
      case "sfx":
        playDemoCue(op.id);
        break;
      case "hud":
        demoHud$.set(op.show);
        break;
      case "camera-fit":
        demoCamera.fitNodes(op.nodeIds, op.durationBeats * beatMs(scenario.bpm), {
          padding: op.padding,
          maxZoom: op.maxZoom,
        });
        break;
      case "camera-center":
        demoCamera.center(op.x, op.y, op.zoom, op.durationBeats * beatMs(scenario.bpm));
        break;
      case "tween-nodes":
        demoCamera.tweenNodes(
          op.moves,
          op.durationBeats * beatMs(scenario.bpm),
          op.easing ?? "in-out",
          (moves) => {
            // Reconcile the document once at tween end. Position-only write:
            // React Flow already sits at the final frame, so no rebuild.
            const byId = new Map(moves.map((move) => [move.id, move]));
            const doc = state$.doc.peek();
            commitDoc(
              {
                ...doc,
                nodes: doc.nodes.map((node) => {
                  const move = byId.get(node.id);
                  return move ? { ...node, x: Math.round(move.x), y: Math.round(move.y) } : node;
                }),
              },
              false,
              false,
            );
          },
        );
        break;
      case "alert-cycle":
        cycleAlertFocus();
        break;
      case "page-open": {
        try {
          const ref = formatNodeRef({
            canvasName: state$.canvasName.peek(),
            nodeId: op.nodeId,
          });
          void window.junto?.browserOpen?.({ ref }).catch(() => undefined);
        } catch {
          // Invalid canvas name / node id — surface nothing mid-take.
        }
        break;
      }
      default:
        // add-nodes / add-edges / remove-nodes / flag already applied above.
        break;
    }
  }
};
