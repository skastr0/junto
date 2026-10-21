import { asNodeId, regionStack, type Canvas, type Node } from "./model";
import type { WorkRead } from "./work-read";

export type WorkPolicyRead = WorkRead & {
  readonly artifactsOf: (nodeId: string) => ReadonlyArray<Artifact>;
  readonly artifactsByNode: ReadonlyMap<string, ReadonlyArray<Artifact>>;
};
import type {
  WorkMetadata,
  Task,
  Artifact,
  Message,
} from "./work-model";
import { productPortEnabled } from "./features";
import {
  ACTOR_ACTOR_INBOX_PORTS,
  NodeSpec,
  resolveSpec,
  type ActorSpec,
  type SinkKind,
} from "./physics";
import { HashSet } from "effect";

// Pure topology validation plus work-item transforms. WorkService uses their
// results to invoke specific SQLite repository verbs; these helpers never
// authorize or commit a canvas-document mutation.
// No dual shapes: only Task / Message / Artifact.

export type WorkErrorCode =
  | "canvas_not_found"
  | "node_not_found"
  | "task_not_found"
  | "illegal_kind"
  | "illegal_transition"
  | "claim_contention"
  | "invalid";

export class WorkError extends Error {
  readonly code: WorkErrorCode;
  constructor(code: WorkErrorCode, message: string) {
    super(message);
    this.name = "WorkError";
    this.code = code;
  }
}

export type WorkIds = {
  readonly id: () => string;
  readonly messageId: () => string;
};

const regionContextId = (canvas: Canvas, nodeId: string, canvasName: string): string => {
  const region = regionStack(canvas, asNodeId(nodeId))[0];
  return region?.label?.trim() || region?.id || canvasName;
};

const requireNode = (canvas: Canvas, nodeId: string): Node => {
  const node = canvas.nodes.get(asNodeId(nodeId));
  if (!node) throw new WorkError("node_not_found", `node "${nodeId}" not found`);
  return node;
};

const illegalKind = (node: Node, expected: string): WorkError =>
  new WorkError(
    "illegal_kind",
    `node "${node.id}" kind is ${node.kind ?? "none"}; expected ${expected}`,
  );

/**
 * Group-ness is deliberately not consulted: these predicates read the authored
 * kind, exactly as the string lists they replace did. A peer is an agent seat
 * of another machine: the same actor, with the same inbox to be mailed at.
 */
const specOf = (node: Node) =>
  resolveSpec({ isGroup: false, kind: node.kind === "peer" ? "agent" : node.kind });

const isActorSpec = NodeSpec.$is("Actor");
const isSinkSpec = NodeSpec.$is("Sink");

/** The node is an actor. Role first, through the one resolution site. */
const requireActor = (node: Node, expected: string): ActorSpec => {
  const spec = specOf(node);
  if (!isActorSpec(spec)) throw illegalKind(node, expected);
  return spec;
};

/**
 * The node is a sink of one of the admitted kinds. Returns the kind narrowed to
 * what was admitted, so a caller branching afterwards branches on a literal it
 * has already proved rather than on a loose string.
 */
const requireSink = <K extends SinkKind>(
  node: Node,
  kinds: ReadonlyArray<K>,
): K => {
  const spec = specOf(node);
  if (!isSinkSpec(spec)) throw illegalKind(node, kinds.join("|"));
  const kind = kinds.find((admitted): admitted is K => admitted === spec.kind);
  if (kind === undefined) throw illegalKind(node, kinds.join("|"));
  return kind;
};

/**
 * The message inbox is an actor power, and not every actor holds one — a raw
 * terminal has nothing to read a message into. Which actors hold it is read
 * from the offered ports, so this is the same single declaration
 * (`ACTOR_ACTOR_INBOX_PORTS` → `KindSpecs`) used by capability admission,
 * not a second hand-kept copy of the kind list.
 */
const requireMessageInbox = (node: Node): void => {
  const actor = requireActor(node, "an actor inbox");
  // The required inbox is the enabled vocabulary: a port gated off in this
  // build is absent from every actor's offers.
  const holdsInbox = ACTOR_ACTOR_INBOX_PORTS
    .filter((port) => productPortEnabled(port))
    .every((port) => HashSet.has(actor.offers, port));
  if (!holdsInbox) throw illegalKind(node, "an actor inbox");
};

const patchTaskInList = (
  items: ReadonlyArray<Task>,
  taskId: string,
  patch: (task: Task) => Task,
): { readonly items: Task[]; readonly task: Task } => {
  const idx = items.findIndex((t) => t.id === taskId);
  if (idx < 0) throw new WorkError("task_not_found", `task "${taskId}" not found`);
  const next = items.map((t, i) => {
    if (i !== idx) return t;
    rejectRetiredClaimMetadata(t.metadata);
    return patch(t);
  });
  return { items: next as Task[], task: next[idx]! };
};

const rejectRetiredClaimMetadata = (
  metadata: WorkMetadata | undefined,
): void => {
  if (
    metadata !== undefined &&
    Object.prototype.hasOwnProperty.call(metadata, "claimedBy")
  ) {
    throw new WorkError(
      "invalid",
      "metadata.claimedBy is retired; use Task.claimedBy",
    );
  }
};

export type WorkMessageResult = { readonly message: Message };
export type WorkArtifactResult = { readonly artifact: Artifact };

export const workMessageAppend = (
  work: WorkPolicyRead,
  doc: Canvas,
  canvasName: string,
  nodeId: string,
  taskId: string | null,
  message: Message,
): WorkMessageResult => {
  const node = requireNode(doc, nodeId);
  const contextId = message.contextId?.trim() || regionContextId(doc, nodeId, canvasName);
  const stamped: Message = {
    ...message,
    contextId,
    ...(taskId ? { taskId } : message.taskId ? { taskId: message.taskId } : {}),
  };

  if (taskId) {
    requireSink(node, ["task"] as const);
    const items = work.itemsOf(nodeId);
    patchTaskInList(items, taskId, (current) => ({
      ...current,
      history: [...current.history, { ...stamped, taskId }],
    }));
    return { message: { ...stamped, taskId } };
  }

  requireMessageInbox(node);
  return { message: stamped };
};

/** Soft-archive flag lives in metadata so decode admits history without schema migration. */
export const isArtifactArchived = (artifact: Artifact): boolean =>
  artifact.metadata?.archived === true;

const withArtifactArchivedFlag = (
  artifact: Artifact,
  archived: boolean,
): Artifact => {
  const nextMeta: Record<string, unknown> = { ...(artifact.metadata ?? {}) };
  if (archived) {
    nextMeta.archived = true;
  } else {
    delete nextMeta.archived;
  }
  if (Object.keys(nextMeta).length === 0) {
    const { metadata: _drop, ...rest } = artifact;
    return rest;
  }
  return { ...artifact, metadata: nextMeta as WorkMetadata };
};

/** Operator soft-archive / restore. Does not delete parts or content refs. */
export const workArtifactArchive = (
  work: WorkPolicyRead,
  doc: Canvas,
  nodeId: string,
  artifactId: string,
  archived: boolean,
): WorkArtifactResult => {
  const node = requireNode(doc, nodeId);
  requireSink(node, ["artifacts"]);
  const id = artifactId.trim();
  if (!id) throw new WorkError("invalid", "artifactId must be non-empty");
  const items = work.artifactsOf(nodeId);
  const index = items.findIndex((item) => item.artifactId === id);
  if (index < 0) {
    throw new WorkError("task_not_found", `artifact "${id}" not found`);
  }
  const current = items[index]!;
  const artifact = withArtifactArchivedFlag(current, archived);
  return { artifact };
};

/** Hard-remove an artifact from the sink (operator). Content objects are retained. */
export const workArtifactDelete = (
  work: WorkPolicyRead,
  doc: Canvas,
  nodeId: string,
  artifactId: string,
): { readonly artifactId: string } => {
  const node = requireNode(doc, nodeId);
  requireSink(node, ["artifacts"]);
  const id = artifactId.trim();
  if (!id) throw new WorkError("invalid", "artifactId must be non-empty");
  const items = work.artifactsOf(nodeId);
  if (!items.some((item) => item.artifactId === id)) {
    throw new WorkError("task_not_found", `artifact "${id}" not found`);
  }
  return {
    artifactId: id,
  };
};
