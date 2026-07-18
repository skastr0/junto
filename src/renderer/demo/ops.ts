import { observable } from "@legendapp/state";
import type { CanvasDoc, CanvasNode, EtherFlag } from "@shared/canvas";
import type { DemoBeat, DemoOp, DemoScenario } from "@shared/demo";
import { beatMs } from "@shared/demo";
import { commitDoc } from "../lib/mutations";
import { state$ } from "../lib/state";
import { playAlert } from "../lib/sfx";
import { demoCamera } from "./camera-bridge";

// Demo/scripting engine only. Applies one scenario beat's ops against the
// live app: doc-mutating ops fold into a single commitDoc (no undo entry —
// this is a film set, not an editable document), the rest drive selection,
// sfx, the herdr transport, the HUD badge, and the camera.

/** hud op toggles this; DemoLayer renders nothing while it's false. */
export const demoHud$ = observable(true);

const without = <T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> => {
  const { [key]: _removed, ...rest } = value;
  return rest;
};

const DOC_OP_KINDS = new Set<DemoOp["kind"]>(["add-nodes", "add-edges", "remove-nodes", "flag"]);

const applyFlag = (node: CanvasNode, flag: EtherFlag, on: boolean): CanvasNode => {
  const flags = node.ether?.flags ?? [];
  const has = flags.includes(flag);
  if (on === has) return node;
  if (!on) {
    if (!node.ether) return node;
    const nextFlags = flags.filter((f) => f !== flag);
    const nextEther = nextFlags.length > 0 ? { ...node.ether, flags: nextFlags } : without(node.ether, "flags");
    return (Object.keys(nextEther).length > 0 ? { ...node, ether: nextEther } : without(node, "ether")) as CanvasNode;
  }
  return { ...node, ether: { ...(node.ether ?? {}), flags: [...flags, flag] } } as CanvasNode;
};

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
      case "flag": {
        const targets = new Set(op.nodeIds);
        return {
          ...acc,
          nodes: acc.nodes.map((node) => (targets.has(node.id) ? applyFlag(node, op.flag, op.on) : node)),
        };
      }
      default:
        return acc;
    }
  }, doc);

/** Execute every op in one scheduled beat. Doc-mutating ops (add-nodes,
 * add-edges, remove-nodes, flag) fold into ONE commitDoc call so the graph
 * rebuilds exactly once per beat. */
export const executeBeat = (scenario: DemoScenario, beat: DemoBeat): void => {
  if (beat.ops.some((op) => DOC_OP_KINDS.has(op.kind))) {
    commitDoc(applyDocOps(state$.doc.peek(), beat.ops), true, false);
  }

  const herdrPromises: Array<Promise<unknown>> = [];

  for (const op of beat.ops) {
    switch (op.kind) {
      case "select":
        state$.selectedNodeIds.set(op.nodeIds);
        state$.selectedNodeId.set(op.nodeIds[0] ?? "");
        break;
      case "herdr": {
        const result = window.vellum?.demoCommand(op.command);
        if (result) herdrPromises.push(result.catch(() => undefined));
        break;
      }
      case "sfx":
        playAlert(op.id);
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
      default:
        // add-nodes / add-edges / remove-nodes / flag already applied above.
        break;
    }
  }

  if (herdrPromises.length > 0) void Promise.allSettled(herdrPromises);
};
