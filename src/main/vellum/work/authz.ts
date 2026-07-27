import type { CanvasDoc, CanvasNode } from "@shared/canvas";
import { groupMembers, isGroup } from "@shared/graph";
import {
  ALL_PORTS,
  admitPure,
  asNodeId,
  canvasDocToCapabilityView,
  isTargetWorkOp,
  opsForSink,
  portForWorkOp,
  resolveSpec,
  roleOf,
  type FactoryRole,
  type NodeSpecValue,
  type Port,
  type ScopeDenial,
  type TargetWorkOpName,
} from "@shared/physics";
import type { WorkErrorBody, WorkOpName } from "@shared/work-control";
import { Either, Match } from "effect";

// Edges are the capability system. Kernel-enforced per call via factory physics
// (admitPure + ports). Region co-members: {id, kind, title} visibility only.
// Everything else: invisible — ops fail as ScopeError naming the missing edge.

export type AuthzVisibility = "connected" | "region" | "none";

export const nodeKind = (node: CanvasNode | undefined): string | undefined =>
  node?.ether?.entity?.kind;

export const nodeTitle = (node: CanvasNode): string => {
  if (node.type === "text") {
    const first = node.text?.split("\n")[0]?.trim();
    if (first) return first;
  }
  if (node.type === "group" && node.label?.trim()) return node.label.trim();
  if (node.type === "link" && node.url) return node.url;
  if (node.type === "file" && node.file) return node.file;
  return node.ether?.entity?.name ?? node.id;
};

export const findNode = (doc: CanvasDoc, nodeId: string): CanvasNode | undefined =>
  doc.nodes.find((n) => n.id === nodeId);

/** Undirected: any edge between a and b counts as connected. */
export const areConnected = (doc: CanvasDoc, a: string, b: string): boolean => {
  if (a === b) return true;
  return doc.edges.some(
    (e) =>
      (e.fromNode === a && e.toNode === b) || (e.fromNode === b && e.toNode === a),
  );
};

/** Node ids that share a group with `nodeId` (excluding self). */
export const regionCoMemberIds = (
  doc: CanvasDoc,
  nodeId: string,
): ReadonlyArray<string> => {
  const members = groupMembers(doc);
  const out = new Set<string>();
  for (const [, ids] of members) {
    if (!ids.includes(nodeId)) continue;
    for (const id of ids) {
      if (id !== nodeId) out.add(id);
    }
  }
  return [...out];
};

/** The first group containing nodeId, if any. */
export const containingRegion = (
  doc: CanvasDoc,
  nodeId: string,
): { readonly id: string; readonly label: string; readonly instruction?: string } | undefined => {
  const members = groupMembers(doc);
  for (const [groupId, ids] of members) {
    if (!ids.includes(nodeId)) continue;
    const group = doc.nodes.find((n) => n.id === groupId);
    if (!group || !isGroup(group)) continue;
    const instruction = group.ether?.region?.instruction;
    return {
      id: group.id,
      label: group.label?.trim() || group.id,
      ...(instruction !== undefined && instruction.trim().length > 0
        ? { instruction: instruction.trim() }
        : {}),
    };
  }
  return undefined;
};

export const visibilityOf = (
  doc: CanvasDoc,
  callerId: string,
  targetId: string,
): AuthzVisibility => {
  if (callerId === targetId) return "connected";
  if (areConnected(doc, callerId, targetId)) return "connected";
  if (regionCoMemberIds(doc, callerId).includes(targetId)) return "region";
  return "none";
};

/** Ops that require a connected edge to the target (mutations + full reads). */
export const requiresConnection = (op: WorkOpName): boolean => {
  switch (op) {
    case "ping":
    case "doctor":
    case "capabilities":
    case "onboard":
      return false;
    case "tasks.list":
    case "tasks.claim":
    case "tasks.update":
    case "msg.list":
    case "msg.send":
    case "request.create":
    case "request.escalate":
    case "artifact.publish":
      return true;
  }
};

const NO_OPS: ReadonlyArray<WorkOpName> = [];
const MSG_OPS: ReadonlyArray<WorkOpName> = ["msg.list", "msg.send"];

/**
 * Work-plane ops offered by a node, matched exhaustively on its NodeSpec.
 * Role decides participation; the sink rows are read from the total
 * `OPS_BY_SINK` record in the physics work vocabulary, so a new sink kind is a
 * compile error at the declaration rather than a silent empty op list here.
 */
const opsForSpec = (spec: NodeSpecValue): ReadonlyArray<WorkOpName> =>
  Match.value(spec).pipe(
    Match.tagsExhaustive({
      Actor: (s) => (s.kind === "terminal" ? NO_OPS : MSG_OPS),
      Sink: (s): ReadonlyArray<WorkOpName> => opsForSink(s.kind),
      Scheduler: () => NO_OPS,
      Geography: () => NO_OPS,
    }),
  );

export const opsForKind = (kind: string | undefined): ReadonlyArray<WorkOpName> => {
  if (!kind) return [];
  return opsForSpec(resolveSpec({ isGroup: false, kind }));
};

export const kindAllowsOp = (kind: string | undefined, op: WorkOpName): boolean =>
  opsForKind(kind).includes(op);

export const scopeError = (
  callerId: string,
  targetId: string,
  reason: "not_connected" | "invisible" | "wrong_kind",
  extra?: { readonly kind?: string; readonly op?: WorkOpName },
): WorkErrorBody => {
  if (reason === "wrong_kind") {
    return {
      type: "ScopeError",
      message: `node "${targetId}" kind ${extra?.kind ?? "none"} does not support ${extra?.op ?? "this op"}`,
      details: {
        target: targetId,
        caller: callerId,
        expected: extra?.op ? opsForKind(extra.kind) : undefined,
        received: extra?.kind,
        hint: "connect the caller to a node of the required kind",
        next_step: "draw an edge in Vellum between the nodes",
        retryable: false,
        missing: "compatible target kind",
      },
    };
  }
  if (reason === "invisible") {
    return {
      type: "ScopeError",
      message: `target "${targetId}" is not visible from "${callerId}" — no edge and not region co-members`,
      details: {
        target: targetId,
        caller: callerId,
        hint: "connect the nodes",
        next_step: "draw an edge in Vellum between the nodes, or place them in the same region",
        retryable: false,
        missing: "edge",
      },
    };
  }
  return {
    type: "ScopeError",
    message: `missing edge between "${callerId}" and "${targetId}" — connect the nodes`,
    details: {
      target: targetId,
      caller: callerId,
      hint: "connect the nodes",
      next_step: "draw an edge in Vellum between the nodes",
      retryable: false,
      missing: "edge",
    },
  };
};

/**
 * Map physics ScopeDenial → wire-compatible WorkErrorBody ScopeError.
 * Messages/details match the pre-physics surface for not_connected / invisible /
 * wrong_kind so CLIs and tests stay stable.
 */
export const scopeDenialToWorkError = (
  denial: ScopeDenial,
  extra?: { readonly kind?: string; readonly op?: WorkOpName },
): WorkErrorBody => {
  switch (denial.reason) {
    case "invisible":
      return scopeError(denial.caller, denial.target, "invisible");
    case "not_connected":
      return scopeError(denial.caller, denial.target, "not_connected");
    case "no_port":
    case "role_law":
    case "facility":
    case "route":
    case "tier":
    case "placement_unknown":
      return scopeError(denial.caller, denial.target, "wrong_kind", {
        kind: extra?.kind,
        op: extra?.op,
      });
    case "unknown_node":
      return scopeError(denial.caller, denial.target, "invisible");
  }
};

/**
 * Admit a target-scoped work op via factory physics (edge + role law + port).
 * Missing target still uses visibility-aware UnknownTarget / invisible.
 */
export const admitWorkTarget = (
  doc: CanvasDoc,
  callerId: string,
  targetId: string,
  op: WorkOpName,
): Either.Either<{ readonly node: CanvasNode }, WorkErrorBody> => {
  const target = findNode(doc, targetId);
  if (!target) {
    const vis = visibilityOf(doc, callerId, targetId);
    if (vis === "none") {
      return Either.left(scopeError(callerId, targetId, "invisible"));
    }
    return Either.left({
      type: "UnknownTarget",
      message: `target "${targetId}" not found`,
      details: { target: targetId, retryable: false },
    });
  }

  if (!requiresConnection(op) || !isTargetWorkOp(op)) {
    return Either.right({ node: target });
  }

  const view = canvasDocToCapabilityView(doc);
  const result = admitPure(
    view,
    asNodeId(callerId),
    asNodeId(targetId),
    portForWorkOp(op as TargetWorkOpName),
  );
  if (Either.isLeft(result)) {
    return Either.left(
      scopeDenialToWorkError(result.left, {
        kind: nodeKind(target),
        op,
      }),
    );
  }
  return Either.right({ node: target });
};

export type VisibleNode = {
  readonly id: string;
  readonly kind: string | undefined;
  readonly title: string;
};

export const summarizeNode = (node: CanvasNode): VisibleNode => ({
  id: node.id,
  kind: nodeKind(node),
  title: nodeTitle(node),
});

export const factoryRoleOfNode = (node: CanvasNode): FactoryRole =>
  roleOf(resolveSpec({ kind: nodeKind(node), isGroup: isGroup(node) }));

/** Ports the caller holds on the undirected edge to target (physics admit). */
export const heldGrantsOnEdge = (
  doc: CanvasDoc,
  callerId: string,
  targetId: string,
): ReadonlyArray<Port> => {
  const view = canvasDocToCapabilityView(doc);
  const caller = asNodeId(callerId);
  const target = asNodeId(targetId);
  return ALL_PORTS.filter((port) =>
    Either.isRight(admitPure(view, caller, target, port)),
  );
};

export type ConnectedCapability = VisibleNode & {
  readonly summary: string;
  readonly ops: ReadonlyArray<WorkOpName>;
  /** Derived factory role of the target (additive). */
  readonly role: FactoryRole;
  /** Ports held via the undirected edge (additive). */
  readonly grants: ReadonlyArray<Port>;
};

export const connectedCapabilities = (
  doc: CanvasDoc,
  callerId: string,
): ReadonlyArray<ConnectedCapability> => {
  const seen = new Set<string>();
  const out: ConnectedCapability[] = [];
  for (const edge of doc.edges) {
    const other =
      edge.fromNode === callerId
        ? edge.toNode
        : edge.toNode === callerId
          ? edge.fromNode
          : undefined;
    if (!other || seen.has(other)) continue;
    seen.add(other);
    const node = findNode(doc, other);
    if (!node) continue;
    const kind = nodeKind(node);
    const ops = opsForKind(kind);
    const grants = heldGrantsOnEdge(doc, callerId, other);
    out.push({
      ...summarizeNode(node),
      summary: ops.length > 0 ? ops.join(", ") : "connected (no work ops)",
      ops,
      role: factoryRoleOfNode(node),
      grants,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
};

export const regionVisibility = (
  doc: CanvasDoc,
  callerId: string,
): ReadonlyArray<VisibleNode> => {
  const connected = new Set(
    doc.edges.flatMap((e) => {
      if (e.fromNode === callerId) return [e.toNode];
      if (e.toNode === callerId) return [e.fromNode];
      return [];
    }),
  );
  return regionCoMemberIds(doc, callerId)
    .filter((id) => !connected.has(id))
    .map((id) => findNode(doc, id))
    .filter((n): n is CanvasNode => n !== undefined)
    .map(summarizeNode)
    .sort((a, b) => a.id.localeCompare(b.id));
};
