import type { CanvasNode } from "@shared/canvas";
import type { CanvasReadResult } from "@shared/ipc";
import type { LiveAttention } from "@shared/overseer-live";
import { taskBrief } from "@shared/task";
import type { Task, TaskState } from "@shared/work-model";

export const LIVE_CONTEXT_LIMITS = Object.freeze({
  bytes: 32_768,
  quietBytes: 500,
  nodes: 48,
  edges: 96,
  tasksPerNode: 12,
});

interface SemanticTask {
  readonly id: string;
  readonly brief: string;
  readonly state: TaskState;
  readonly claimedBy?: string;
}

interface SemanticNode {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly geometry: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly host?: string;
  readonly overseer: boolean;
  readonly flags: ReadonlyArray<string>;
  readonly tasks: ReadonlyArray<SemanticTask>;
  readonly omittedTasks: number;
  readonly artifactIds: ReadonlyArray<string>;
  readonly artifactCount: number;
}

interface SemanticEdge {
  readonly id: string;
  readonly fromNode: string;
  readonly toNode: string;
  readonly verb: string | null;
}

export interface LiveSemanticContext {
  readonly authoritative: {
    readonly canvasName: string;
    readonly revision: string;
    readonly workRevision: string;
    readonly nodes: ReadonlyArray<SemanticNode>;
    readonly edges: ReadonlyArray<SemanticEdge>;
    readonly counts: {
      readonly nodes: number;
      readonly edges: number;
      readonly working: number;
      readonly blocked: number;
      readonly completed: number;
    };
    readonly omittedNodes: number;
    readonly omittedEdges: number;
  };
  /** Attention is captured renderer input. It grants no authority. */
  readonly attention: {
    readonly source: "renderer";
    readonly canvasName: string;
    readonly selectedNodeIds: ReadonlyArray<string>;
    readonly unresolvedSelectionCount: number;
    readonly viewport?: LiveAttention["viewport"];
    readonly draft?: { readonly nodeId: string; readonly text: string; readonly committed: false };
  };
}

/** Never cut a UTF-8 code point in half. The ellipsis is included in the limit. */
const clipBytes = (text: string, limit: number): string => {
  if (Buffer.byteLength(text, "utf8") <= limit) return text;
  let result = "";
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > limit - 3) break;
    result += character;
    bytes += size;
  }
  return `${result}…`;
};

/**
 * Provider credentials, launch arguments, environments, paths, URLs, terminal
 * output and rich Work history are never projected. Recognizable credentials
 * accidentally pasted into a human label or draft are also withheld.
 */
const semanticText = (text: string, maxBytes: number): string => clipBytes(text
  .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[credential withheld]")
  .replace(/\b(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[credential withheld]")
  .replace(/\b(?:Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "Bearer [credential withheld]")
  .replace(/\b(?:api[_ -]?key|access[_ -]?token|password|secret)\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|\S+)/gi, "[credential withheld]")
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
  .replace(/\u00b7/g, ","), maxBytes);

const labelOf = (node: CanvasNode): string => {
  const kind = node.ether?.entity?.kind;
  const label = kind === "agent" || kind === "terminal"
    ? node.ether?.terminal?.label ?? node.ether?.entity?.name ?? node.id
    : node.ether?.tasks?.name ?? node.ether?.requests?.name ?? node.ether?.entity?.name ??
      (node.type === "group" ? node.label : node.type === "text" ? node.text.split("\n")[0] : undefined) ?? node.id;
  return semanticText(label, 200);
};

const tasksOf = (node: CanvasNode): ReadonlyArray<Task> => [
  ...(node.ether?.tasks?.items ?? []),
  ...(node.ether?.requests?.items ?? []),
];

const taskPriority = (task: Task): number =>
  task.state === "input-required" || task.state === "auth-required" ? 0 : task.state === "working" ? 1 : 2;

const projectNode = (node: CanvasNode): SemanticNode => {
  const tasks = tasksOf(node);
  const shownTasks = [...tasks].sort((left, right) => taskPriority(left) - taskPriority(right) || left.id.localeCompare(right.id))
    .slice(0, LIVE_CONTEXT_LIMITS.tasksPerNode);
  const artifacts = node.ether?.artifacts?.items ?? [];
  return {
    id: node.id,
    kind: semanticText(node.ether?.entity?.kind ?? node.type, 80),
    label: labelOf(node),
    geometry: { x: node.x, y: node.y, width: node.width, height: node.height },
    ...(node.ether?.host === undefined ? {} : { host: node.ether.host }),
    overseer: node.ether?.overseer === true,
    flags: [...(node.ether?.flags ?? [])],
    tasks: shownTasks.map((task) => ({
      id: task.id, brief: semanticText(taskBrief(task), 240), state: task.state,
      ...(task.claimedBy === undefined ? {} : { claimedBy: task.claimedBy }),
    })),
    omittedTasks: tasks.length - shownTasks.length,
    artifactIds: artifacts.slice(0, 12).map((artifact) => artifact.artifactId),
    artifactCount: artifacts.length,
  };
};

const freezeContext = <Value>(value: Value): Value => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeContext(child);
    Object.freeze(value);
  }
  return value;
};

/** Main-owned canvas/work truth stays distinct from renderer attention/drafts. */
export const buildLiveContext = (read: CanvasReadResult, attention: LiveAttention): LiveSemanticContext => {
  const nodeIds = new Set(read.doc.nodes.map((node) => node.id));
  const selection = attention.canvasName === read.name
    ? [...new Set(attention.selectedNodeIds)].filter((id) => nodeIds.has(id)).slice(0, 100)
    : [];
  const selected = new Set(selection);
  const adjacent = new Set(read.doc.edges.flatMap((edge) =>
    selected.has(edge.fromNode) ? [edge.toNode] : selected.has(edge.toNode) ? [edge.fromNode] : []));
  const nodePriority = (node: CanvasNode): number => selected.has(node.id) ? 0 : adjacent.has(node.id) ? 1 :
    tasksOf(node).some((task) => taskPriority(task) === 0) ? 2 : 3;
  const ordered = [...read.doc.nodes].sort((left, right) => nodePriority(left) - nodePriority(right) || left.id.localeCompare(right.id));
  const allTasks = read.doc.nodes.flatMap(tasksOf);
  const nodes: Array<SemanticNode> = [];
  const edges: Array<SemanticEdge> = [];
  const context = {
    authoritative: {
      canvasName: read.name, revision: read.revision, workRevision: read.workRevision,
      nodes, edges,
      counts: {
        nodes: read.doc.nodes.length, edges: read.doc.edges.length,
        working: allTasks.filter((task) => task.state === "working").length,
        blocked: allTasks.filter((task) => task.state === "input-required" || task.state === "auth-required").length,
        completed: allTasks.filter((task) => task.state === "completed").length,
      },
      omittedNodes: read.doc.nodes.length, omittedEdges: read.doc.edges.length,
    },
    attention: {
      source: "renderer" as const,
      canvasName: attention.canvasName,
      selectedNodeIds: selection,
      unresolvedSelectionCount: attention.selectedNodeIds.length - selection.length,
      ...(attention.viewport === undefined ? {} : { viewport: { ...attention.viewport } }),
      ...(attention.draft === undefined ? {} : {
        draft: { nodeId: attention.draft.nodeId, text: semanticText(attention.draft.text, 4_000), committed: false as const },
      }),
    },
  };
  // Reserve room for omission counters while building, and never shorten an
  // identity into a different target. Oversized projections are omitted whole.
  const fits = () => Buffer.byteLength(JSON.stringify(context), "utf8") <= LIVE_CONTEXT_LIMITS.bytes - 128;
  if (!fits()) throw new RangeError("Live attention exceeds the semantic context limit");
  for (const node of ordered) {
    if (nodes.length >= LIVE_CONTEXT_LIMITS.nodes) break;
    nodes.push(projectNode(node));
    if (!fits()) nodes.pop();
  }
  const included = new Set(nodes.map((node) => node.id));
  for (const edge of [...read.doc.edges].sort((left, right) => left.id.localeCompare(right.id))) {
    if (edges.length >= LIVE_CONTEXT_LIMITS.edges) break;
    if (!included.has(edge.fromNode) || !included.has(edge.toNode)) continue;
    edges.push({ id: edge.id, fromNode: edge.fromNode, toNode: edge.toNode, verb: edge.ether?.verb ?? null });
    if (!fits()) edges.pop();
  }
  context.authoritative.omittedNodes -= nodes.length;
  context.authoritative.omittedEdges -= edges.length;
  return freezeContext(context);
};

/** A conservative UTF-8 byte bound is also a 500-token bound for Live appends. */
export const quietLiveContext = (context: LiveSemanticContext): string => {
  const state = context.authoritative;
  const selected = new Set(context.attention.selectedNodeIds);
  const labels = state.nodes.filter((node) => selected.has(node.id)).map((node) => node.label);
  const lines = [
    `Canvas ${semanticText(state.canvasName, 80)}: ${state.counts.nodes} nodes, ${state.counts.working} working tasks, ${state.counts.blocked} blocked, ${state.counts.completed} completed.`,
    `Selected: ${labels.length > 0 ? labels.join(", ") : "none resolved"}.`,
    ...(context.attention.draft === undefined ? [] : ["The operator has an unsaved draft; it is not committed state."]),
    ...(state.omittedNodes > 0 || state.omittedEdges > 0 ? ["Detailed context is partial; retrieve exact targets before acting."] : []),
  ];
  return clipBytes(lines.join("\n"), LIVE_CONTEXT_LIMITS.quietBytes);
};

export interface LiveActivity {
  readonly kind: "task-blocked" | "task-completed" | "task-failed" | "artifact-published";
  readonly canvasName: string;
  readonly nodeId: string;
  readonly itemId: string;
  readonly workRevision: string;
}

/** Derived only from two observed Work projections, never from model prose. */
export const meaningfulLiveChanges = (previous: LiveSemanticContext, current: LiveSemanticContext): ReadonlyArray<LiveActivity> => {
  const before = previous.authoritative;
  const after = current.authoritative;
  if (before.canvasName !== after.canvasName || before.workRevision === after.workRevision) return [];
  const priorNodes = new Map(before.nodes.map((node) => [node.id, node]));
  const events: Array<LiveActivity> = [];
  for (const node of after.nodes) {
    const prior = priorNodes.get(node.id);
    // A newly visible node is not evidence that all its historical work just happened.
    if (!prior) continue;
    const priorTasks = new Map(prior.tasks.map((task) => [task.id, task.state]));
    for (const task of node.tasks) {
      if (!priorTasks.has(task.id) || priorTasks.get(task.id) === task.state) continue;
      const kind = task.state === "input-required" || task.state === "auth-required" ? "task-blocked" :
        task.state === "completed" ? "task-completed" : task.state === "failed" ? "task-failed" : undefined;
      if (kind) events.push({ kind, canvasName: after.canvasName, nodeId: node.id, itemId: task.id, workRevision: after.workRevision });
    }
    // A truncated artifact list cannot prove a newly observed id was just published.
    if (prior.artifactCount <= prior.artifactIds.length && node.artifactCount > prior.artifactCount) {
      const priorArtifacts = new Set(prior.artifactIds);
      for (const id of node.artifactIds) {
        if (!priorArtifacts.has(id)) events.push({
          kind: "artifact-published", canvasName: after.canvasName, nodeId: node.id, itemId: id, workRevision: after.workRevision,
        });
      }
    }
  }
  return coalesceLiveActivity(events);
};

/** Last observed state for an item wins, so a result replaces its old blocker. */
export const coalesceLiveActivity = (events: ReadonlyArray<LiveActivity>, limit = 8): ReadonlyArray<LiveActivity> => {
  const latest = new Map<string, LiveActivity>();
  for (const event of events) {
    const key = JSON.stringify([event.canvasName, event.nodeId, event.kind === "artifact-published" ? "artifact" : "task", event.itemId]);
    latest.set(key, { ...event });
  }
  return Object.freeze([...latest.values()]
    .sort((left, right) =>
      Number(right.kind === "task-blocked") - Number(left.kind === "task-blocked") ||
      left.canvasName.localeCompare(right.canvasName) || left.nodeId.localeCompare(right.nodeId) || left.itemId.localeCompare(right.itemId))
    .slice(0, Math.max(0, Math.min(32, Math.floor(limit))))
    .map((event) => Object.freeze(event)));
};
