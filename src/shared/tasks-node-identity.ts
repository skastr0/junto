import type { CanvasNode } from "./canvas";

/**
 * One Tasks-node identity projection for every product surface. The node is a
 * board, so display uses `ether.tasks.name`, then `contract.instructions`,
 * then "Tasks <short id>". Routing continues to use node ids; this helper
 * owns display only.
 */
export type TasksNodeIdentity = {
  readonly name: string;
  readonly source: "name" | "instructions" | "id";
  readonly namingHint?: string;
};

const GENERIC_TASK_NAMES = new Set(["task", "tasks"]);
const NAME_LIMIT = 52;
const SHORT_ID_LENGTH = 8;

const compact = (value: string | undefined): string | undefined => {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized ? normalized : undefined;
};

const authoredName = (node: CanvasNode): string | undefined => {
  const name = compact(node.ether?.tasks?.name);
  return name && !GENERIC_TASK_NAMES.has(name.toLowerCase())
    ? name
    : undefined;
};

const shortInstructions = (instructions: string): string => {
  const firstSentence = instructions.split(/(?<=[.!?])\s/)[0] ?? instructions;
  if (firstSentence.length <= NAME_LIMIT) return firstSentence;
  const candidate = firstSentence.slice(0, NAME_LIMIT + 1);
  const boundary = candidate.lastIndexOf(" ");
  return `${candidate.slice(0, boundary > 24 ? boundary : NAME_LIMIT).trimEnd()}…`;
};

export const shortTasksNodeId = (nodeId: string): string => {
  const compactId = compact(nodeId) ?? "unknown";
  return compactId.length <= SHORT_ID_LENGTH
    ? compactId
    : compactId.slice(-SHORT_ID_LENGTH);
};

export const tasksNodeIdentity = (
  node: CanvasNode | undefined,
  fallbackNodeId?: string,
): TasksNodeIdentity => {
  const nodeId = node?.id ?? fallbackNodeId ?? "unknown";
  const instructions = compact(node?.ether?.tasks?.contract?.instructions);
  const name = node ? authoredName(node) : undefined;
  if (name) {
    return {
      name,
      source: "name",
    };
  }
  if (instructions) {
    return {
      name: shortInstructions(instructions),
      source: "instructions",
    };
  }
  // A generic node id ("tasks") adds nothing after the "Tasks" prefix — the
  // fallback would read "Tasks tasks". Real ids still disambiguate.
  const shortId = shortTasksNodeId(nodeId);
  if (GENERIC_TASK_NAMES.has(shortId.toLowerCase())) {
    return {
      name: "Tasks",
      source: "id",
      namingHint: "Name this node to name the board.",
    };
  }
  return {
    name: `Tasks ${shortId}`,
    source: "id",
    namingHint: "Name this node to name the board.",
  };
};

export const tasksNodeName = (
  node: CanvasNode | undefined,
  fallbackNodeId?: string,
): string => tasksNodeIdentity(node, fallbackNodeId).name;
