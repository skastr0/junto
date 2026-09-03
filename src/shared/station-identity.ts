import type { CanvasNode } from "./canvas";

export type StationIdentity = {
  /** Human-facing station identity. Never the generic task-kind label. */
  readonly name: string;
  /** Full standing purpose authored on the sink contract. */
  readonly role?: string;
  /** How the displayed name was resolved. */
  readonly source: "title" | "instruction" | "id";
  /** Teaching copy for the last-resort unnamed state. */
  readonly namingHint?: string;
};

const GENERIC_TASK_TITLES = new Set(["task", "tasks"]);
const NAME_LIMIT = 52;
const SHORT_ID_LENGTH = 8;

const compact = (value: string | undefined): string | undefined => {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized ? normalized : undefined;
};

const authoredTitle = (node: CanvasNode): string | undefined => {
  let title: string | undefined;
  if (node.type === "text") {
    title = compact(node.text.split("\n")[0]?.replace(/^#+\s*/, ""));
  } else if (node.type === "group") {
    title = compact(node.label);
  } else if (node.type === "file") {
    title = compact(node.file.split("/").filter(Boolean).at(-1));
  } else if (node.type === "link") {
    title = compact(node.url);
  }
  return title && !GENERIC_TASK_TITLES.has(title.toLowerCase())
    ? title
    : undefined;
};

const projectedTitle = (node: CanvasNode): string | undefined => {
  const stationName = compact(node.ether?.tasks?.stationName);
  if (stationName && !GENERIC_TASK_TITLES.has(stationName.toLowerCase())) {
    return stationName;
  }
  // Live task projections mirror work briefs into node.text. Only an empty or
  // absent work projection can still expose the authorial first line directly.
  const items = node.ether?.tasks?.items;
  return items === undefined || items.length === 0
    ? authoredTitle(node)
    : undefined;
};

const shortInstruction = (instruction: string): string => {
  const firstSentence = instruction.split(/(?<=[.!?])\s/)[0] ?? instruction;
  if (firstSentence.length <= NAME_LIMIT) return firstSentence;
  const candidate = firstSentence.slice(0, NAME_LIMIT + 1);
  const boundary = candidate.lastIndexOf(" ");
  return `${candidate.slice(0, boundary > 24 ? boundary : NAME_LIMIT).trimEnd()}…`;
};

export const shortStationId = (nodeId: string): string => {
  const compactId = compact(nodeId) ?? "unknown";
  return compactId.length <= SHORT_ID_LENGTH
    ? compactId
    : compactId.slice(-SHORT_ID_LENGTH);
};

/**
 * One station identity projection for every renderer and work-plane surface.
 * Routing continues to use node ids; this helper owns display only.
 */
export const stationIdentity = (
  node: CanvasNode | undefined,
  fallbackNodeId?: string,
): StationIdentity => {
  const nodeId = node?.id ?? fallbackNodeId ?? "unknown";
  const role = compact(node?.ether?.tasks?.contract?.instruction);
  const title = node ? projectedTitle(node) : undefined;
  if (title) {
    return {
      name: title,
      ...(role ? { role } : {}),
      source: "title",
    };
  }
  if (role) {
    return {
      name: shortInstruction(role),
      role,
      source: "instruction",
    };
  }
  return {
    name: `Tasks ${shortStationId(nodeId)}`,
    source: "id",
    namingHint: "Name this node to name the station.",
  };
};

export const stationName = (
  node: CanvasNode | undefined,
  fallbackNodeId?: string,
): string => stationIdentity(node, fallbackNodeId).name;
