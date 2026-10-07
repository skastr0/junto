import { observable } from "@legendapp/state";
import type { Command } from "@shared/model";
import type { Canvas } from "@shared/model/canvas";
import type { DemoBeat, DemoOp, DemoScenario } from "@shared/demo";
import { beatMs } from "@shared/demo";
import { formatNodeRef } from "@shared/node-ref";
import { stepToNextAgent } from "../lib/urgency-step";
import { commitCommands } from "../lib/mutations";
import { added, moved, removed, topZ } from "../lib/model-edits";
import { canvasAfter } from "../lib/model-undo";
import { selectNodes, state$ } from "../lib/state";
import { playDemoCue } from "../lib/sound";
import { demoCamera } from "./camera-bridge";

// Demo/scripting engine only. Applies one scenario beat's ops against the
// live app: graph ops become one command act (no undo entry — this is a film
// set), the rest drive selection,
// sfx, the HUD badge, and the camera.

/** hud op toggles this; DemoLayer renders nothing while it's false. */
export const demoHud$ = observable(true);

const GRAPH_OP_KINDS = new Set<DemoOp["kind"]>(["add-nodes", "add-edges", "remove-nodes"]);

const commandsForBeat = (canvas: Canvas, ops: ReadonlyArray<DemoOp>): ReadonlyArray<Command> => {
  let at = canvas;
  const commands: Command[] = [];
  for (const op of ops) {
    let next: ReadonlyArray<Command> = [];
    switch (op.kind) {
      case "add-nodes": {
        const z = topZ(at);
        next = added(at, op.nodes.map((node, index) => ({ ...node, z: z + index })));
        break;
      }
      case "add-edges": {
        next = added(at, [], op.edges);
        break;
      }
      case "remove-nodes":
        next = removed(at, op.ids);
        break;
      default:
        break;
    }
    commands.push(...next);
    at = next.reduce(canvasAfter, at);
  }
  return commands;
};

/** A new take starts empty in main and the window's native store. */
export const resetDemoCanvas = (): void => {
  commitCommands(canvas => removed(canvas, [...canvas.nodes.keys()], [...canvas.wires.keys()]), { remember: false });
};

/** Execute every op in one scheduled beat. Graph ops share one command act. */
export const executeBeat = (scenario: DemoScenario, beat: DemoBeat): void => {
  if (beat.ops.some((op) => GRAPH_OP_KINDS.has(op.kind))) {
    commitCommands(canvas => commandsForBeat(canvas, beat.ops), { remember: false });
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
            // Persist one native Move at tween end, after the visual frames.
            const byId = new Map(moves.map((move) => [move.id, move]));
            commitCommands(canvas => moved(canvas, byId), { remember: false });
          },
        );
        break;
      case "alert-cycle":
        stepToNextAgent();
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
