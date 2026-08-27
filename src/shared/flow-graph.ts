import { Schema } from "effect";
import type { CanvasDoc, CanvasNode } from "./canvas";
import { NodeSpec, resolveSpec } from "./physics/kinds";

// Task-flow graph derived from the `feeds` verb. Pure — no I/O.
// A `feeds` edge is stored in its own direction (fromNode is the upstream
// station), so the hop needs no separate direction config. The flow graph must
// be a DAG: a hop that would close a cycle is rejected with FlowCycleError at
// mutation time and at act time.

/** One configured task-flow hop. */
export type FlowHop = {
  readonly edgeId: string;
  readonly source: string;
  readonly destination: string;
};

/** Typed rejection for a flow configuration that closes a cycle. */
export class FlowCycleError extends Schema.TaggedError<FlowCycleError>()(
  "FlowCycleError",
  {
    /** Station node ids along the cycle, in walk order; the first id closes it. */
    cycle: Schema.Array(Schema.String),
    message: Schema.String,
  },
) {}

const isSinkSpec = NodeSpec.$is("Sink");

/**
 * A task sink — the only station a hop may name. Forwarding writes the row
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

/** Both endpoints of a hop must be task sinks — the pair a flow config needs. */
export const isTaskFlowPair = (
  fromNode: CanvasNode | undefined,
  toNode: CanvasNode | undefined,
): boolean => isTaskSinkNode(fromNode) && isTaskSinkNode(toNode);

/** All configured hops in document edge order. */
export const flowHops = (doc: CanvasDoc): ReadonlyArray<FlowHop> =>
  doc.edges.flatMap((edge) =>
    edge.ether?.verb === "feeds"
      ? [{ edgeId: edge.id, source: edge.fromNode, destination: edge.toNode }]
      : [],
  );

const adjacency = (doc: CanvasDoc): ReadonlyMap<string, ReadonlyArray<string>> => {
  const next = new Map<string, string[]>();
  for (const hop of flowHops(doc)) {
    const out = next.get(hop.source);
    if (out === undefined) next.set(hop.source, [hop.destination]);
    else if (!out.includes(hop.destination)) out.push(hop.destination);
  }
  return next;
};

/**
 * Reject any cycle in the flow graph. Returns the first cycle found (walk
 * order, deterministic in document edge order), or undefined for a valid DAG.
 */
export const validateFlowDag = (doc: CanvasDoc): FlowCycleError | undefined => {
  const next = adjacency(doc);
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
        message: `task flow must stay a DAG; cycle: ${cycle.join(" -> ")} -> ${cycle[0]}`,
      });
    }
  }
  return undefined;
};

/** Direct forward stations from a sink, deduped in document edge order. */
export const flowDestinations = (
  doc: CanvasDoc,
  nodeId: string,
): ReadonlyArray<string> => {
  const out: string[] = [];
  for (const hop of flowHops(doc)) {
    if (hop.source === nodeId && !out.includes(hop.destination)) {
      out.push(hop.destination);
    }
  }
  return out;
};

/** Direct upstream stations of a sink, deduped in document edge order. */
export const flowSources = (
  doc: CanvasDoc,
  nodeId: string,
): ReadonlyArray<string> => {
  const out: string[] = [];
  for (const hop of flowHops(doc)) {
    if (hop.destination === nodeId && !out.includes(hop.source)) {
      out.push(hop.source);
    }
  }
  return out;
};

/**
 * Every station a journey starting at `fromNodeId` can still visit — BFS over
 * flow edges, INCLUDING `fromNodeId` itself (the journey visits its next stop,
 * so claims addressed there remain answerable; fork-waiver accounting depends
 * on this). Terminates on cyclic input via the visited set.
 */
export const reachableStations = (
  doc: CanvasDoc,
  fromNodeId: string,
): ReadonlySet<string> => {
  const next = adjacency(doc);
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
