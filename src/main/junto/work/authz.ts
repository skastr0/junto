import { regionMembers, regionStack, titleOf, type Canvas, type Node } from "@shared/model";
import {
  ALL_PORTS,
  admitPure,
  asNodeId,
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
import { canvasToCapabilityView } from "@shared/physics/view";
import type { WorkErrorBody, WorkOpName } from "@shared/work-control";
import { OPERATOR_SEAT_ID } from "@shared/work-reference";
import type { ActorRef } from "@shared/work-protocol";
import { Result, Match } from "effect";
import {
  productNodeKindEnabled,
  RELAY_ENABLED,
  TASKS_ENABLED,
} from "@shared/features";

// Edges are the capability system. Kernel-enforced per call via canvas physics
// (admitPure + ports). Region co-members: {id, kind, title} visibility only.
// Everything else: invisible — ops fail as ScopeError naming the missing edge.

export type AuthzVisibility = "connected" | "region" | "none";

export const nodeKind = (node: Node | undefined): string | undefined => node?.kind;

export const nodeTitle = titleOf;

export const findNode = (canvas: Canvas, nodeId: string): Node | undefined =>
  canvas.nodes.get(asNodeId(nodeId));

/** Undirected: any wire between a and b counts as connected. */
export const areConnected = (canvas: Canvas, a: string, b: string): boolean => {
  if (a === b) return true;
  for (const wire of canvas.wires.values()) {
    if ((wire.from === a && wire.to === b) || (wire.from === b && wire.to === a)) return true;
  }
  return false;
};

/**
 * Node ids that share a group with `nodeId` (excluding self). Nesting-correct
 * as-is: a node inside an inner region is a member of every container, so
 * co-members already span the whole region stack.
 */
export const regionCoMemberIds = (
  doc: Canvas,
  nodeId: string,
): ReadonlyArray<string> => {
  const out = new Set<string>();
  // Regions are geography, not peers. A region itself has no co-member view.
  if (findNode(doc, nodeId)?.kind === "region") return [];
  for (const region of regionStack(doc, asNodeId(nodeId))) {
    for (const member of regionMembers(doc, region)) {
      if (member.id !== nodeId) out.add(member.id);
    }
  }
  return [...out];
};

export type RegionBriefing = {
  readonly id: string;
  readonly label: string;
  readonly instruction?: string;
};

/**
 * Every region containing nodeId, outer → inner (regionStack order), each
 * with its own briefing instruction. Briefing consumers concatenate
 * instructions outer → inner so nested seats inherit every layer's law.
 */
export const regionStackFor = (
  doc: Canvas,
  nodeId: string,
): ReadonlyArray<RegionBriefing> =>
  regionStack(doc, asNodeId(nodeId)).map((group) => {
    const instruction = group.instruction?.trim();
    return {
      id: group.id,
      label: group.label?.trim() || group.id,
      ...(instruction !== undefined && instruction.length > 0
        ? { instruction }
        : {}),
    };
  });

/**
 * One-region briefing view over the stack. Identity is the INNERMOST
 * containing region (innermost wins where a single region is semantically
 * needed — onboard's region field, spawn injection); the instruction
 * concatenates every layer's briefing outer → inner so nested seats still
 * inherit ambient law from all containers.
 */
export const containingRegion = (
  doc: Canvas,
  nodeId: string,
): RegionBriefing | undefined => {
  const stack = regionStackFor(doc, nodeId);
  const innermost = stack[stack.length - 1];
  if (!innermost) return undefined;
  const instructions = stack
    .map((region) => region.instruction)
    .filter((instruction): instruction is string => instruction !== undefined);
  return {
    id: innermost.id,
    label: innermost.label,
    ...(instructions.length > 0 ? { instruction: instructions.join("\n\n") } : {}),
  };
};

export const visibilityOf = (
  doc: Canvas,
  callerId: string,
  targetId: string,
): AuthzVisibility => {
  if (callerId === targetId) return "connected";
  if (areConnected(doc, callerId, targetId)) return "connected";
  if (regionCoMemberIds(doc, callerId).includes(targetId)) return "region";
  return "none";
};

/**
 * Main-derived overseer authority. Never user-supplied as a principal, never
 * `OPERATOR_SEAT_ID`. The live overseer flag is re-checked at use.
 */
export type OverseerWorkAdmin = {
  readonly kind: "overseer";
  readonly actor: ActorRef;
};

export const overseerWorkAdmin = (actor: ActorRef): OverseerWorkAdmin => ({
  kind: "overseer",
  actor,
});

const overseerAuthError = (
  callerId: string,
  message: string,
  missing: string,
): WorkErrorBody => ({
  type: "AuthError",
  message,
  details: {
    caller: callerId,
    retryable: false,
    missing,
    next_step: "ask the operator to grant overseer on this agent seat",
  },
});

/** True when the node is a managed agent seat with a live human overseer grant. */
export const isLiveOverseerNode = (node: Node | undefined): boolean =>
  node !== undefined &&
  nodeKind(node) === "agent" &&
  node.kind === "agent" && node.overseer === true;

/**
 * Admit a claimed overseer admin against the live canvas. Callers cannot
 * forge `kind: "overseer"` without a matching compiled ActorRef and flag.
 */
export const admitLiveOverseer = (
  doc: Canvas,
  actorRefs: ReadonlyArray<ActorRef>,
  caller: { readonly canvasName: string; readonly nodeId: string },
  claimed: OverseerWorkAdmin,
): Result.Result<ActorRef, WorkErrorBody> => {
  if (claimed.kind !== "overseer") {
    return Result.fail(
      overseerAuthError(caller.nodeId, "overseer admin kind is invalid", "overseer grant"),
    );
  }
  const actor = claimed.actor;
  if (
    actor.seatId === OPERATOR_SEAT_ID ||
    actor.nodeId === "operator"
  ) {
    return Result.fail(
      overseerAuthError(
        caller.nodeId,
        "overseer provenance cannot use the operator seat",
        "overseer grant",
      ),
    );
  }
  if (actor.canvasName !== caller.canvasName || actor.nodeId !== caller.nodeId) {
    return Result.fail(
      overseerAuthError(
        caller.nodeId,
        "overseer admin actor does not match the admitted caller",
        "overseer grant",
      ),
    );
  }
  const exact = actorRefs.filter(
    (candidate) =>
      candidate.seatId === actor.seatId &&
      candidate.canvasName === actor.canvasName &&
      candidate.nodeId === actor.nodeId,
  );
  if (exact.length !== 1) {
    return Result.fail(
      overseerAuthError(
        caller.nodeId,
        `actor ${JSON.stringify(actor.nodeId)} does not identify exactly one compiled actor seat`,
        "overseer grant",
      ),
    );
  }
  const node = findNode(doc, caller.nodeId);
  if (!isLiveOverseerNode(node)) {
    return Result.fail(
      overseerAuthError(
        caller.nodeId,
        `node "${caller.nodeId}" is not a live overseer`,
        "overseer grant",
      ),
    );
  }
  return Result.succeed(exact[0]!);
};

/**
 * A feature-gated product sink stays decodable but offers no work surface in
 * a build whose gate is off. Name the gate rather than an edge so an agent
 * stops instead of asking the operator for a wire that can never grant.
 */
const featureDisabledError = (
  callerId: string,
  targetId: string,
  kind: string,
  op: WorkOpName,
): WorkErrorBody => ({
  type: "ScopeError",
  message: `node "${targetId}" kind ${kind} is disabled in this Junto build`,
  details: {
    target: targetId,
    caller: callerId,
    expected: [],
    received: kind,
    hint: "this product surface is turned off in this build",
    next_step:
      "stop work on this node; the feature is disabled in this build and no edge can grant it",
    retryable: false,
    missing: "feature enabled in this build",
    reason: op,
  },
});

/** True when a live connected target is a product kind this build disabled. */
export const targetFeatureDisabled = (
  doc: Canvas,
  callerId: string,
  targetId: string,
): boolean => {
  const kind = nodeKind(findNode(doc, targetId));
  return (
    kind !== undefined &&
    !productNodeKindEnabled(kind) &&
    areConnected(doc, callerId, targetId)
  );
};

/**
 * Target admission for a live overseer: node existence + kind, no edge.
 * Ordinary agents still go through {@link admitWorkTarget}.
 */
export const admitOverseerWorkTarget = (
  doc: Canvas,
  targetId: string,
  op: WorkOpName,
): Result.Result<{ readonly node: Node }, WorkErrorBody> => {
  const target = findNode(doc, targetId);
  if (!target) {
    return Result.fail({
      type: "UnknownTarget",
      message: `target "${targetId}" not found`,
      details: { target: targetId, retryable: false },
    });
  }
  const overseerTargetKind = nodeKind(target);
  if (
    overseerTargetKind !== undefined &&
    !productNodeKindEnabled(overseerTargetKind)
  ) {
    return Result.fail(
      featureDisabledError("overseer", targetId, overseerTargetKind, op),
    );
  }
  if (requiresConnection(op) && isTargetWorkOp(op) && !kindAllowsOp(nodeKind(target), op)) {
    return Result.fail(
      scopeError("overseer", targetId, "wrong_kind", {
        kind: nodeKind(target),
        op,
      }),
    );
  }
  return Result.succeed({ node: target });
};

/** Ops that require a connected edge to the target (mutations + full reads). */
export const requiresConnection = (op: WorkOpName | "overseer"): boolean => {
  switch (op) {
    case "overseer.live":
    case "overseer":
      // Administrative envelope, not a grant. Parent dispatches before the
      // ordinary work-op switch; this case keeps the exhaustive switch honest.
      return false;
    case "ping":
    case "doctor":
    case "capabilities":
    case "onboard":
    // Offboard writes only the caller's own session notes.
    case "offboard":
    case "preamble":
    case "msg.sent":
    // Agent signals are universal and seat-local: the process-bound caller
    // raises, clears, and reads only its own. No edge, no port.
    case "signal.raise":
    case "signal.clear":
    case "signal.list":
    // A seat reads only its own region environment report. No edge, no port.
    case "env.report":
    // A seat reads the references in its own scope. No edge, no port.
    case "references.list":
    case "references.read":
    // A seat stages only its own files; a stage id answers to its seat alone.
    case "content.stage":
      return false;
    case "tasks.list":
    case "tasks.wait":
    case "tasks.create":
    case "tasks.claim":
    case "tasks.update":
    case "tasks.show":
    case "tasks.rules":
    case "tasks.check":
    case "rulings":
    case "content.path":
    case "content.stat":
    case "content.materialize":
    case "msg.list":
    case "msg.send":
    case "msg.prompt":
    case "seat.wait":
    case "seat.read":
    case "verdict.post":
    case "msg.read":
    case "msg.reply":
    case "msg.react":
    case "artifact.publish":
    case "board.list":
    case "board.tags":
    case "board.create_topic":
    case "board.post":
    case "board.mark_read":
    case "pad.read":
    case "pad.patch":
    case "sheet.read":
    case "relay.trigger":
      return true;
  }
};

const NO_OPS: ReadonlyArray<WorkOpName> = [];
const MSG_OPS: ReadonlyArray<WorkOpName> = [
  "msg.list",
  "msg.send",
  "msg.prompt",
  "seat.wait",
  "seat.read",
  // Verdicts target a task board; without the tasks surface the op leaves
  // the actor vocabulary with the port that carried it.
  ...(TASKS_ENABLED ? (["verdict.post"] as const) : []),
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
 * Admit a target-scoped work op via canvas physics (edge + role law + port).
 * Missing target still uses visibility-aware UnknownTarget / invisible.
 */
export const admitWorkTarget = (
  doc: Canvas,
  callerId: string,
  targetId: string,
  op: WorkOpName,
): Result.Result<{ readonly node: Node }, WorkErrorBody> => {
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

  const targetKind = nodeKind(target);
  if (
    targetKind !== undefined &&
    targetFeatureDisabled(doc, callerId, targetId)
  ) {
    return Result.fail(
      featureDisabledError(callerId, targetId, targetKind, op),
    );
  }

  const view = canvasToCapabilityView(doc);
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

export const summarizeNode = (node: Node): VisibleNode => ({
  id: node.id,
  kind: nodeKind(node),
  title: nodeTitle(node),
});

export const factoryRoleOfNode = (node: Node): FactoryRole =>
  roleOf(resolveSpec({ kind: nodeKind(node), isGroup: node.kind === "region" }));

/** Ports the caller holds on the undirected edge to target (physics admit). */
export const heldGrantsOnEdge = (
  doc: Canvas,
  callerId: string,
  targetId: string,
): ReadonlyArray<Port> => {
  const view = canvasToCapabilityView(doc);
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
  doc: Canvas,
  callerId: string,
): ReadonlyArray<ConnectedCapability> => {
  const seen = new Set<string>();
  const out: ConnectedCapability[] = [];
  for (const edge of doc.wires.values()) {
    const other =
      edge.from === callerId
        ? edge.to
        : edge.to === callerId
          ? edge.from
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
  doc: Canvas,
  callerId: string,
): ReadonlyArray<VisibleNode> => {
  const connected = new Set<string>(
    [...doc.wires.values()].flatMap((e) => {
      if (e.from === callerId) return [e.to];
      if (e.to === callerId) return [e.from];
      return [];
    }),
  );
  return regionCoMemberIds(doc, callerId)
    .filter((id) => !connected.has(id))
    .map((id) => findNode(doc, id))
    .filter((n): n is Node => n !== undefined)
    .map(summarizeNode)
    .sort((a, b) => a.id.localeCompare(b.id));
};
