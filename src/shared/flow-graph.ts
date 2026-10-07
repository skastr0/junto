import { Schema } from "effect";
import type { CanvasNode } from "./canvas";
import type { Canvas } from "./model/canvas";
import { NodeSpec, resolveSpec } from "./physics/kinds";

// Task path graph derived from the `feeds` verb. Pure — no I/O.
// A `feeds` wire runs from the upstream board to the downstream one, so the
// hop needs no separate direction config. The flow graph must
// be a DAG: a hop that would close a cycle is rejected with FlowCycleError at
// mutation time and at act time.

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

const isSinkSpec = NodeSpec.$is("Sink");

/**
 * A Tasks node, the only board a hop may name. Sending on writes the row
 * into the destination's `ether.tasks` (`workTaskTransition`), and no other
 * sink kind projects that: a pad/board/page/requests destination would take
 * delivery of work it can never show, claim, or close.
 */
export const isTaskSinkNode = (node: CanvasNode | undefined): boolean => {
  const spec = resolveSpec({
    isGroup: node?.type === "group",
    kind: node?.ether?.entity?.kind,
  });
  return isSinkSpec(spec) && spec.kind === "task";
};

/** All configured hops, in the order the canvas holds its wires. */
export const flowHops = (canvas: Wired): ReadonlyArray<FlowHop> => {
  const hops: FlowHop[] = [];
  for (const wire of canvas.wires.values()) {
    if (wire.verb === "feeds") {
      hops.push({ edgeId: wire.id, source: wire.from, destination: wire.to });
    }
  }
  return hops;
};

const adjacency = (canvas: Wired): ReadonlyMap<string, ReadonlyArray<string>> => {
  const next = new Map<string, string[]>();
  for (const hop of flowHops(canvas)) {
    const out = next.get(hop.source);
    if (out === undefined) next.set(hop.source, [hop.destination]);
    else if (!out.includes(hop.destination)) out.push(hop.destination);
  }
  return next;
};

/**
 * Reject any cycle in the flow graph. Returns the first cycle found (walk
 * order, deterministic in wire order), or undefined for a valid DAG.
 */
export const validateFlowDag = (canvas: Wired): FlowCycleError | undefined => {
  const next = adjacency(canvas);
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
