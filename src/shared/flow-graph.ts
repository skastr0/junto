import { Schema } from "effect";
import type { Canvas } from "./model/canvas";
import { TASK_PATH_VERBS, type TaskPathVerb } from "./physics/verbs";

// Task path graph derived from the `flows` verb. Pure — no I/O.
// A `flows` wire runs from the upstream board to the downstream one, so the
// hop needs no separate direction config. The flow graph must
// be a DAG: a hop that would close a cycle is rejected with FlowCycleError at
// mutation time and at act time. The `derives` graph is held to the same, on
// its own: a board may flow into one board and derive back from it.

/** All the path reads of a canvas: its wires. A whole Canvas is one. */
type Wired = Pick<Canvas, "wires">;

/** One configured task path hop. */
export type FlowHop = {
  readonly edgeId: string;
  readonly source: string;
  readonly destination: string;
};

/** Typed rejection for a flow configuration that closes a cycle. */
export class FlowCycleError extends Schema.TaggedError<FlowCycleError>()(
  "FlowCycleError",
  {
    /** Tasks node ids along the cycle, in walk order; the first id closes it. */
    cycle: Schema.Array(Schema.String),
    message: Schema.String,
  },
) {}

/** All configured hops, in the order the canvas holds its wires. */
export const flowHops = (canvas: Wired): ReadonlyArray<FlowHop> => {
  const hops: FlowHop[] = [];
  for (const wire of canvas.wires.values()) {
    if (wire.verb === "flows") {
      hops.push({ edgeId: wire.id, source: wire.from, destination: wire.to });
    }
  }
  return hops;
};

const adjacency = (canvas: Wired, verb: TaskPathVerb = "flows"): ReadonlyMap<string, ReadonlyArray<string>> => {
  const next = new Map<string, string[]>();
  for (const wire of canvas.wires.values()) {
    if (wire.verb !== verb) continue;
    const out = next.get(wire.from);
    if (out === undefined) next.set(wire.from, [wire.to]);
    else if (!out.includes(wire.to)) out.push(wire.to);
  }
  return next;
};

/** The boards a board derives into, deduped in wire order. */
export const deriveTargets = (canvas: Wired, nodeId: string): ReadonlyArray<string> =>
  adjacency(canvas, "derives").get(nodeId) ?? [];

/**
 * Reject any cycle in the flow graph or the derives graph, each on its own.
 * Returns the first cycle found (walk order, deterministic in wire order), or
 * undefined for a valid DAG.
 */
export const validateFlowDag = (canvas: Wired): FlowCycleError | undefined => {
  for (const verb of TASK_PATH_VERBS) {
    const cycle = cycleIn(adjacency(canvas, verb));
    if (cycle !== undefined) return cycle;
  }
  return undefined;
};

const cycleIn = (next: ReadonlyMap<string, ReadonlyArray<string>>): FlowCycleError | undefined => {
  // Iterative DFS with three colors: unvisited, on-stack, done.
  const done = new Set<string>();
  const onStack = new Set<string>();
  const findCycle = (start: string): string[] | undefined => {
    const path: string[] = [];
    const stack: Array<{ readonly node: string; edgeIndex: number }> = [
      { node: start, edgeIndex: 0 },
    ];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      if (frame.edgeIndex === 0) {
        onStack.add(frame.node);
        path.push(frame.node);
      }
      const out = next.get(frame.node) ?? [];
      if (frame.edgeIndex >= out.length) {
        onStack.delete(frame.node);
        done.add(frame.node);
        path.pop();
        stack.pop();
        continue;
      }
      const target = out[frame.edgeIndex]!;
      frame.edgeIndex += 1;
      if (onStack.has(target)) {
        return [...path.slice(path.indexOf(target))];
      }
      if (!done.has(target)) {
        stack.push({ node: target, edgeIndex: 0 });
      }
    }
    return undefined;
  };
  for (const source of next.keys()) {
    if (done.has(source)) continue;
    const cycle = findCycle(source);
    if (cycle !== undefined) {
      return new FlowCycleError({
        cycle,
        message: `task path must stay a DAG; cycle: ${cycle.join(" -> ")} -> ${cycle[0]}`,
      });
    }
  }
  return undefined;
};

/** Direct next boards, deduped in wire order. */
export const flowDestinations = (
  canvas: Wired,
  nodeId: string,
): ReadonlyArray<string> => {
  const out: string[] = [];
  for (const hop of flowHops(canvas)) {
    if (hop.source === nodeId && !out.includes(hop.destination)) {
      out.push(hop.destination);
    }
  }
  return out;
};

/** Direct previous boards, deduped in wire order. */
export const flowSources = (
  canvas: Wired,
  nodeId: string,
): ReadonlyArray<string> => {
  const out: string[] = [];
  for (const hop of flowHops(canvas)) {
    if (hop.destination === nodeId && !out.includes(hop.source)) {
      out.push(hop.source);
    }
  }
  return out;
};

/**
 * Every board a task starting at `fromNodeId` can still visit, including the
 * starting board. Terminates on cyclic input via the visited set.
 */
export const reachableBoards = (
  canvas: Wired,
  fromNodeId: string,
): ReadonlySet<string> => {
  const next = adjacency(canvas);
  const visited = new Set<string>([fromNodeId]);
  const queue: string[] = [fromNodeId];
  while (queue.length > 0) {
    const node = queue.shift()!;
    for (const target of next.get(node) ?? []) {
      if (!visited.has(target)) {
        visited.add(target);
        queue.push(target);
      }
    }
  }
  return visited;
};
