import type { NodeId } from "./base";
import type { Node, TaskBoard } from "./kinds";
import { regionName } from "./canvas";

// What a node is called, in one place, so a card, a list, a sentence about a
// wire and a screen reader all say the same word.

const compact = (value: string | undefined): string | undefined => {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized ? normalized : undefined;
};

/** A name that only repeats the kind says nothing, so it counts as unnamed. */
const named = (
  value: string | undefined,
  generic: ReadonlyArray<string>,
): string | undefined => {
  const name = compact(value);
  return name !== undefined && !generic.includes(name.toLowerCase())
    ? name
    : undefined;
};

const NAME_LIMIT = 52;
const SHORT_ID_LENGTH = 8;

const shortInstructions = (instructions: string): string => {
  const firstSentence = instructions.split(/(?<=[.!?])\s/)[0] ?? instructions;
  if (firstSentence.length <= NAME_LIMIT) return firstSentence;
  const candidate = firstSentence.slice(0, NAME_LIMIT + 1);
  const boundary = candidate.lastIndexOf(" ");
  return `${candidate.slice(0, boundary > 24 ? boundary : NAME_LIMIT).trimEnd()}…`;
};

export const shortNodeId = (id: string): string => {
  const compactId = compact(id) ?? "unknown";
  return compactId.length <= SHORT_ID_LENGTH
    ? compactId
    : compactId.slice(-SHORT_ID_LENGTH);
};

export type TaskBoardTitle = {
  readonly name: string;
  /** Where the name came from. Anything but `name` means: ask for one. */
  readonly source: "name" | "instructions" | "id";
};

/**
 * A task board is called by its name, else by the start of its instructions,
 * else "Tasks" and the end of its id. `fallbackId` names a board that is no
 * longer on the canvas.
 */
export const taskBoardTitle = (
  board: TaskBoard | undefined,
  fallbackId?: NodeId | string,
): TaskBoardTitle => {
  const name = named(board?.name, ["task", "tasks"]);
  if (name !== undefined) return { name, source: "name" };
  const instructions = compact(board?.contract?.instructions);
  if (instructions !== undefined) {
    return { name: shortInstructions(instructions), source: "instructions" };
  }
  const shortId = shortNodeId(board?.id ?? fallbackId ?? "unknown");
  return {
    name: ["task", "tasks"].includes(shortId.toLowerCase())
      ? "Tasks"
      : `Tasks ${shortId}`,
    source: "id",
  };
};

const firstLine = (text: string): string | undefined =>
  compact(text.split(/\r?\n/, 1)[0]);

/** What any node is called. Never empty. */
export const titleOf = (node: Node): string => {
  switch (node.kind) {
    case "agent":
      return compact(node.label) ?? node.agentKey;
    case "region":
      return regionName(node);
    case "task":
      return taskBoardTitle(node).name;
    case "requests":
      return named(node.name, ["request", "requests"]) ?? "requests";
    case "note":
    case "label":
      return firstLine(node.text) ?? node.kind;
    case "file":
      return node.path.split("/").pop() || node.path;
    case "link":
    case "page":
      return node.url || node.kind;
    case "git":
      return compact(node.label) ?? (node.cwd.split("/").pop() || node.cwd);
    case "terminal":
    case "artifacts":
    case "board":
    case "pad":
    case "sheet":
    case "cron":
    case "relay":
    case "watcher":
      return compact(node.label) ?? node.kind;
  }
};
