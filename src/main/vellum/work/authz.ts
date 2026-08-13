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
import { Result, Match } from "effect";
import { RELAY_ENABLED } from "@shared/features";

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

/**
 * The first group containing nodeId, if any.
 * Includes optional `instruction` (region briefing) for work-control onboard.
 */
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
    case "preamble":
      return false;
    case "tasks.list":
    case "tasks.create":
    case "tasks.claim":
    case "tasks.update":
    case "content.path":
    case "content.stat":
    case "content.materialize":
    case "msg.list":
    case "msg.send":
    case "msg.read":
    case "msg.reply":
    case "msg.react":
    case "request.escalate":
    case "artifact.publish":
    case "board.list":
    case "board.tags":
    case "board.create_topic":
    case "board.post":
    case "board.mark_read":
    case "relay.trigger":
      return true;
  }
};

const NO_OPS: ReadonlyArray<WorkOpName> = [];
const MSG_OPS: ReadonlyArray<WorkOpName> = [
  "msg.list",
  "msg.send",
  "msg.read",
  "msg.reply",
  "msg.react",
];

/**
 * Work-plane ops offered by a node, matched exhaustively on its NodeSpec.
 * Role decides participation; the sink rows are read from the total
 * `OPS_BY_SINK` record in the physics work vocabulary, so a new sink kind is a
 * compile error at the declaration rather than a silent empty op list here.
 */
const RELAY_OPS: ReadonlyArray<WorkOpName> = RELAY_ENABLED
  ? ["relay.trigger"]
  : [];

const opsForSpec = (spec: NodeSpecValue): ReadonlyArray<WorkOpName> =>
  Match.value(spec).pipe(
    Match.tagsExhaustive({
      Actor: () => MSG_OPS,
      Sink: (s): ReadonlyArray<WorkOpName> => opsForSink(s.kind),
      Scheduler: (s): ReadonlyArray<WorkOpName> =>
        s.kind === "relay" ? RELAY_OPS : NO_OPS,
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
        hint: "pick a target whose kind supports this op",
        next_step: "call a connected node of a kind that supports this op; if none is connected, ask the operator to wire an edge to one on the canvas",
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
        hint: "no edge or shared region grants access to this target",
        next_step: "this connection does not exist; ask the operator to wire an edge between the nodes or place them in the same region on the canvas",
        retryable: false,
        missing: "edge",
      },
    };
  }
  return {
    type: "ScopeError",
    message: `missing edge between "${callerId}" and "${targetId}"`,
    details: {
      target: targetId,
      caller: callerId,
      hint: "no edge connects these nodes",
      next_step: "this connection does not exist; ask the operator to wire an edge between the nodes on the canvas",
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
    case "route":
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
): Result.Result<{ readonly node: CanvasNode }, WorkErrorBody> => {
  const target = findNode(doc, targetId);
  if (!target) {
    const vis = visibilityOf(doc, callerId, targetId);
    if (vis === "none") {
      return Result.fail(scopeError(callerId, targetId, "invisible"));
    }
    return Result.fail({
      type: "UnknownTarget",
      message: `target "${targetId}" not found`,
      details: { target: targetId, retryable: false },
    });
  }

  if (!requiresConnection(op) || !isTargetWorkOp(op)) {
    return Result.succeed({ node: target });
  }

  const view = canvasDocToCapabilityView(doc);
  const result = admitPure(
    view,
    asNodeId(callerId),
    asNodeId(targetId),
    portForWorkOp(op as TargetWorkOpName),
  );
  if (Result.isFailure(result)) {
    return Result.fail(
      scopeDenialToWorkError(result.failure, {
        kind: nodeKind(target),
        op,
      }),
    );
  }
  return Result.succeed({ node: target });
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
    Result.isSuccess(admitPure(view, caller, target, port)),
  );
};

export type ConnectedCapability = VisibleNode & {
  readonly summary: string;
  /** Derived factory role of the target. */
  readonly role: FactoryRole;
  /** Canonical ports held via the undirected edge. */
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
    const grants = heldGrantsOnEdge(doc, callerId, other);
    out.push({
      ...summarizeNode(node),
      summary:
        grants.length > 0
          ? grants.join(", ")
          : "connected (no held grants)",
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
