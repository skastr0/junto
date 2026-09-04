import type { CanvasDoc } from "@shared/canvas";
import type { RuleInForce } from "@shared/rules";
import type { TaskAdmission } from "@shared/work-model";
import { rulesInForce } from "@shared/rules";
import { resolveTaskAdmission } from "@shared/work-model";
import { flowDestinations, isTaskSinkNode } from "@shared/flow-graph";
import { tasksNodeName } from "@shared/tasks-node-identity";
import { nodeTitle } from "../../../lib/presentation";
import { admissionLabel } from "../../../lib/admission-labels";

export type TaskPathNode = {
  readonly nodeId: string;
  readonly label: string;
  readonly depth: number;
  readonly origin: boolean;
  readonly terminal: boolean;
  readonly destinations: ReadonlyArray<string>;
  readonly rules: ReadonlyArray<RuleInForce>;
  readonly admission: TaskAdmission;
  readonly waitMs?: number;
};

export type TaskPathStage = {
  readonly depth: number;
  readonly parents: ReadonlyArray<string>;
  readonly boards: ReadonlyArray<TaskPathNode>;
};

const parentsOf = (
  path: ReadonlyArray<TaskPathNode>,
  nodeId: string,
): ReadonlyArray<string> =>
  path
    .filter((board) => board.destinations.includes(nodeId))
    .map((board) => board.nodeId);

const sameParents = (
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
): boolean =>
  left.length === right.length &&
  left.every((id, index) => id === right[index]);

/**
 * Compact path columns. Boards at the same depth share a column only when
 * they have the same parents; independent paths never gain a false fork.
 */
export const groupPathByDepth = (
  path: ReadonlyArray<TaskPathNode>,
): ReadonlyArray<TaskPathStage> => {
  const stages: TaskPathStage[] = [];
  for (const board of path) {
    const parents = parentsOf(path, board.nodeId);
    const current = stages.at(-1);
    if (
      current !== undefined &&
      current.depth === board.depth &&
      sameParents(current.parents, parents)
    ) {
      stages[stages.length - 1] = {
        ...current,
        boards: [...current.boards, board],
      };
    } else {
      stages.push({ depth: board.depth, parents, boards: [board] });
    }
  }
  return stages;
};

export const taskPath = (
  doc: CanvasDoc,
  originNodeId: string,
): ReadonlyArray<TaskPathNode> => {
  const walked: Array<{ nodeId: string; depth: number }> = [];
  const seen = new Set([originNodeId]);
  const queue = [{ nodeId: originNodeId, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift()!;
    walked.push(current);
    for (const nodeId of flowDestinations(doc, current.nodeId)) {
      if (seen.has(nodeId)) continue;
      seen.add(nodeId);
      queue.push({ nodeId, depth: current.depth + 1 });
    }
  }
  return walked.map((entry, index) => {
    const node = doc.nodes.find((candidate) => candidate.id === entry.nodeId);
    const destinations = flowDestinations(doc, entry.nodeId);
    const contract = node?.ether?.tasks?.contract;
    return {
      ...entry,
      label: isTaskSinkNode(node)
        ? tasksNodeName(node, entry.nodeId)
        : node
          ? nodeTitle(node)
          : entry.nodeId,
      origin: index === 0,
      terminal: destinations.length === 0,
      destinations,
      rules: rulesInForce(doc, entry.nodeId),
      admission: resolveTaskAdmission(contract),
      ...(contract?.incoming?.waitMs
        ? { waitMs: contract.incoming.waitMs }
        : {}),
    };
  });
};

export const formatDepth = (depth: number): string =>
  depth <= 0 ? "here" : depth === 1 ? "Next" : `${depth} boards on`;

export { admissionLabel };
