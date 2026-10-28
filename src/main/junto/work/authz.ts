import {
  regionMembers,
  regionStack,
  seatIdentity,
  seatLabel,
  seatRegions,
  titleOf,
  type Canvas,
  type Node,
  type SeatIdentity,
  type SeatRegion,
} from "@shared/model";
import {
  ALL_PORTS,
  admitPure,
  asNodeId,
  isTargetWorkOp,
  isTaskReachOp,
  opsForSink,
  portForWorkOp,
  resolveSpec,
  roleOf,
  type FactoryRole,
  type NodeSpecValue,
  type Port,
  type ScopeDenial,
  type OldTaskStoreOp,
  type TargetWorkOpName,
} from "@shared/physics";
import { canvasToCapabilityView } from "@shared/physics/view";
import type { TargetCandidate, WorkErrorBody, WorkOpName } from "@shared/work-control";
import { resolveTarget, type ResolvedTarget } from "@shared/target-resolution";
import { resourcesInReach, seatReachesTaskNode, seatsInReach } from "@shared/region-reach";
import { mentionableNodesFrom } from "@shared/mention-reach";
import { linkMentionTokens, matchTypedMention, type ResolvedName } from "@shared/typed-mentions";
import { OPERATOR_SEAT_ID } from "@shared/work-reference";
import type { ActorRef } from "@shared/work-protocol";
import { Result, Match } from "effect";
import {
  productNodeKindEnabled,
} from "@shared/features";

// Edges are the capability system. Kernel-enforced per call via canvas physics
// (admitPure + ports). Region co-members: who they are and where (id, kind,
// title, name, regions) only.
// Everything else: invisible — ops fail as ScopeError naming the missing edge.

export type AuthzVisibility = "connected" | "region" | "none";

/**
 * The kind a node is for work. A peer is an agent seat that lives on another
 * machine: the same kind, and the law leaves it one thing to be asked, mail.
 */
export const nodeKind = (node: Node | undefined): string | undefined =>
  node?.kind === "peer" ? "agent" : node?.kind;

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
/**
 * A product's op refused whole in a build that turns the product off. A
 * tasks-off build can open a canvas a tasks-on machine wrote; no node there
 * makes its ops runnable.
 */
export const productDisabledError = (callerId: string, kind: "task" | "artifacts", op: WorkOpName): WorkErrorBody => ({
  type: "ScopeError",
  message: `${op} is disabled in this Junto build: node kind ${kind} is off`,
  details: {
    caller: callerId,
    expected: [],
    received: kind,
    hint: "this product surface is turned off in this build",
    next_step: "stop work on this node; the feature is disabled in this build and no edge can grant it",
    retryable: false,
    missing: "feature enabled in this build",
    reason: op,
  },
});

const featureDisabledError = (
  callerId: string,
  targetId: string,
  kind: string,
  op: WorkOpName | OldTaskStoreOp,
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
  op: WorkOpName | OldTaskStoreOp,
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
  if ((isTaskReachOp(op) || (requiresConnection(op) && isTargetWorkOp(op))) && !kindAllowsOp(nodeKind(target), op)) {
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
export const requiresConnection = (op: WorkOpName | OldTaskStoreOp | "overseer"): boolean => {
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
    // A seat reads only its own since, the projection onboard carries.
    case "since":
    // Offboard writes only the caller's own session notes.
    case "offboard":
    case "preamble":
    case "msg.sent":
    // Agent signals are universal and seat-local: the process-bound caller
    // raises, clears, and reads only its own. No edge, no port.
    case "signal.raise":
    case "signal.clear":
    case "signal.list":
    // A seat reads only its own writes, by opId. No edge, no port.
    case "op.show":
    case "op.list":
    // A seat reads only its own region environment report. No edge, no port.
    case "env.report":
    // A seat reads this machine's log within its own scope. No edge, no port.
    case "logs.read":
    // A seat reads the references in its own scope. No edge, no port.
    case "references.list":
    case "references.read":
    // A seat stages only its own files; a stage id answers to its seat alone.
    case "content.stage":
      return false;
    // Automations are reached through regions, not edges (plan 01).
    case "automation.list":
    case "automation.show":
    case "automation.history":
    // Artifacts too: an Artifacts node in reach admits (plan 05).
    case "artifact.list":
    case "artifact.show":
    case "artifact.history":
    case "artifact.create":
    case "artifact.edit":
    case "artifact.label":
    case "artifact.comment":
    case "artifact.archive":
    case "artifact.restore":
    // Tasks too: a task node in reach admits, and the ruler checks reach again (plan 04).
    case "task.list":
    case "task.show":
    case "task.create":
    case "task.edit":
    case "task.assign":
    case "task.unassign":
    case "task.start":
    case "task.pause":
    case "task.resume":
    case "task.finish":
    case "task.cancel":
    case "task.archive":
    case "task.depend":
    case "task.undepend":
    case "task.reviewer-add":
    case "task.reviewer-remove":
    case "task.stamp-policy":
    case "task.stamp":
    case "task.comment":
    // The task ops that keep their 0.9 handlers, and the old store's writes,
    // admit by reach too (admitTaskReach).
    case "task.claim":
    case "task.update":
    case "task.wait":
    case "task.rules":
    case "task.check":
    case "rulings":
      return false;
    case "msg.list":
    case "msg.send":
    case "msg.prompt":
    case "seat.wait":
    case "seat.read":
    case "msg.read":
    case "msg.reply":
    case "msg.react":
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
const opsForSpec = (spec: NodeSpecValue): ReadonlyArray<WorkOpName> =>
  Match.value(spec).pipe(
    Match.tagsExhaustive({
      Actor: () => MSG_OPS,
      Sink: (s): ReadonlyArray<WorkOpName> => opsForSink(s.kind),
      Geography: () => NO_OPS,
    }),
  );

export const opsForKind = (kind: string | undefined): ReadonlyArray<WorkOpName> => {
  if (!kind) return [];
  return opsForSpec(resolveSpec({ isGroup: false, kind }));
};

export const kindAllowsOp = (kind: string | undefined, op: WorkOpName | OldTaskStoreOp): boolean =>
  // The reach-admitted task ops go wherever tasks are.
  isTaskReachOp(op) ? kind === "task" && productNodeKindEnabled(kind) : opsForKind(kind).includes(op);

export const scopeError = (
  callerId: string,
  targetId: string,
  reason: "not_connected" | "invisible" | "wrong_kind",
  extra?: { readonly kind?: string; readonly op?: WorkOpName | OldTaskStoreOp },
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
  extra?: { readonly kind?: string; readonly op?: WorkOpName | OldTaskStoreOp },
): WorkErrorBody => {
  switch (denial.reason) {
    case "invisible":
      return scopeError(denial.caller, denial.target, "invisible");
    case "not_connected":
      return scopeError(denial.caller, denial.target, "not_connected");
    case "no_port":
    case "role_law":
      return scopeError(denial.caller, denial.target, "wrong_kind", {
        kind: extra?.kind,
        op: extra?.op,
      });
    case "other_machine":
      return {
        type: "ScopeError",
        message: denial.message,
        details: {
          target: denial.target,
          caller: denial.caller,
          reason: "other_machine",
          hint: "a seat on another machine can be mailed and nothing else",
          next_step: "send it mail with junto msg send",
          retryable: false,
        },
      };
    case "out_of_reach":
      return {
        type: "ScopeError",
        message: denial.message,
        details: {
          target: denial.target,
          caller: denial.caller,
          reason: "out_of_reach",
          hint: "a seat reaches the resources in its own region, the regions inside it and the regions around it; no edge changes that",
          next_step: "pick a resource in reach, or ask the operator to move this seat or the resource on the canvas",
          retryable: false,
        },
      };
    case "unknown_node":
      return scopeError(denial.caller, denial.target, "invisible");
  }
};

/**
 * The machine the canvas's own kinds are on, for the law. A caller is a seat
 * on this machine: where this machine edits the canvas that is the editing
 * machine, and a copy of a canvas holds none of those kinds.
 */
const callerMachine = (doc: Canvas, callerId: string): string => {
  const caller = findNode(doc, callerId);
  return caller?.kind === "agent" ? caller.host : "";
};

/**
 * A reach-admitted task op (TASK_REACH_OPS): the target is a task node in the
 * caller's reach (any on its canvas for a live overseer seat), or the operator's. No edge and no port; plan 04.
 */
const admitTaskReach = (
  doc: Canvas,
  callerId: string,
  target: Node,
  op: WorkOpName | OldTaskStoreOp,
): Result.Result<{ readonly node: Node }, WorkErrorBody> => {
  const kind = nodeKind(target);
  if (kind === "task" && !productNodeKindEnabled(kind)) {
    return Result.fail(featureDisabledError(callerId, target.id, kind, op));
  }
  if (kind !== "task") return Result.fail(scopeError(callerId, target.id, "wrong_kind", { kind, op }));
  // A live overseer seat reaches every task node on its canvas, as the task verbs do.
  if (callerId === OPERATOR_SEAT_ID || seatReachesTaskNode(doc, asNodeId(callerId), asNodeId(target.id))) {
    return Result.succeed({ node: target });
  }
  return Result.fail({
    type: "ScopeError",
    message: `task node "${target.id}" is out of reach of "${callerId}"`,
    details: {
      target: target.id,
      caller: callerId,
      reason: "out_of_reach",
      hint: "a seat reaches the resources in its own region, the regions inside it and the regions around it; no edge changes that",
      next_step: "pick a resource in reach, or ask the operator to move this seat or the resource on the canvas",
      retryable: false,
    },
  });
};

/**
 * Admit a target-scoped work op via canvas physics (edge + role law + port).
 * Missing target still uses visibility-aware UnknownTarget / invisible.
 */
export const admitWorkTarget = (
  doc: Canvas,
  callerId: string,
  targetId: string,
  op: WorkOpName | OldTaskStoreOp,
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

  if (isTaskReachOp(op)) return admitTaskReach(doc, callerId, target, op);

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

  const view = canvasToCapabilityView(doc, { editingMachine: callerMachine(doc, callerId) });
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
  const view = canvasToCapabilityView(doc, { editingMachine: callerMachine(doc, callerId) });
  const caller = asNodeId(callerId);
  const target = asNodeId(targetId);
  return ALL_PORTS.filter((port) =>
    Result.isSuccess(admitPure(view, caller, target, port)),
  );
};

export type ConnectedCapability = VisibleNode & {
  /** What the node is called and every region around it, outermost first. */
  readonly name: string;
  readonly regions: ReadonlyArray<SeatRegion>;
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
    // Seats only (agent and peer rows): a resource node is reached by region,
    // never by its wire.
    if (!node || (node.kind !== "agent" && node.kind !== "peer")) continue;
    const grants = heldGrantsOnEdge(doc, callerId, other);
    const { name, regions } = seatIdentity(doc, node);
    out.push({
      ...summarizeNode(node),
      name,
      regions,
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

export type CoMember = VisibleNode & {
  readonly name: string;
  readonly regions: ReadonlyArray<SeatRegion>;
  /** The innermost region the caller and this member are both inside. */
  readonly shared_region: SeatRegion;
};

export const regionVisibility = (
  doc: Canvas,
  callerId: string,
): ReadonlyArray<CoMember> => {
  const callerRegions = seatRegions(doc, callerId);
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
    .map((node) => {
      const { name, regions } = seatIdentity(doc, node);
      const theirs = new Set(regions.map((region) => region.id));
      const shared = [...callerRegions].reverse().find((region) => theirs.has(region.id))!;
      return { ...summarizeNode(node), name, regions, shared_region: shared };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
};

/** Where resolution looks for what a target could mean: what the caller reaches for this op. */
export type TargetCandidates = (doc: Canvas, callerId: string, op: WorkOpName) => ReadonlyArray<TargetCandidate>;

const candidateOf = (node: Node): TargetCandidate => ({ kind: node.kind, nodeId: node.id, name: titleOf(node) });

/** Mail: every seat wired to the caller that this op admits. */
export const wiredTargetCandidates: TargetCandidates = (doc, callerId, op) =>
  wiredNodes(doc, callerId)
    .filter((node) => Result.isSuccess(admitWorkTarget(doc, callerId, node.id, op)))
    .map(candidateOf);

/**
 * The node, or item, a target names as a seat typed it: a node id, a
 * `junto://` ref, `#42`, or the name of something it reaches with this op. A
 * name two candidates share is refused listing each; a target nothing matches
 * is refused naming every candidate. An id or a ref to an existing node is
 * passed on for the op's own admission to judge.
 */
export const resolveWorkTarget = (
  doc: Canvas,
  callerId: string,
  typed: string,
  op: WorkOpName,
  candidatesOf: TargetCandidates = wiredTargetCandidates,
): Result.Result<ResolvedTarget, WorkErrorBody> => {
  const wanted = typed.trim();
  const resolved = resolveTarget({
    typed: wanted,
    candidates: candidatesOf(doc, callerId, op),
    kindOf: (nodeId) => findNode(doc, nodeId)?.kind,
  });
  if (resolved.ok) return Result.succeed(resolved.target);
  if (resolved.reason === "malformed") {
    return Result.fail({
      type: "InputError",
      message: resolved.message,
      details: { path: "target", retryable: false, next_step: "send the ref exactly as Junto printed it" },
    });
  }
  return Result.fail(targetRefusal(doc, wanted, resolved.reason, resolved.typed.kind === "number", resolved.candidates));
};

/**
 * A target nothing matched (`none`, every candidate listed) or that several
 * match (`ambiguous`, only those listed), in the one refusal shape.
 */
const targetRefusal = (
  doc: Canvas,
  wanted: string,
  reason: "none" | "ambiguous",
  byNumber: boolean,
  candidates: ReadonlyArray<TargetCandidate>,
): WorkErrorBody => {
  const line = (candidate: TargetCandidate): string => {
    const node = findNode(doc, candidate.nodeId);
    const label = node !== undefined && candidate.itemId === undefined ? seatLabel(seatIdentity(doc, node)) : candidate.name;
    const number = candidate.number === undefined ? "" : `#${candidate.number} `;
    return `${number}${label} [${candidate.itemId ?? candidate.nodeId}]`;
  };
  if (reason === "ambiguous") {
    return {
      type: "InputError",
      message: `"${wanted}" names ${candidates.length} things you can reach: ${candidates.map(line).join("; ")}`,
      details: {
        target: wanted,
        retryable: false,
        candidates,
        next_step: "send again with the node id of the one you mean",
      },
    };
  }
  const what = byNumber ? `no task you can reach is ${wanted}` : `nothing you can reach is called "${wanted}"`;
  return {
    type: "UnknownTarget",
    message: candidates.length === 0
      ? `${what}, and this seat reaches nothing for this command`
      : `${what}; you can reach ${candidates.map(line).join("; ")}`,
    details: {
      target: wanted,
      retryable: false,
      candidates,
      next_step: candidates.length === 0
        ? "ask the operator to wire this seat to the one it should reach"
        : "send again with one of these names or ids",
    },
  };
};

/** Who a mention in a seat's mail can name: the seats wired to it (03 section 3). */
export const mailMentionCandidates = (doc: Canvas, callerId: string): ReadonlyArray<TargetCandidate> =>
  wiredNodes(doc, callerId).filter((node) => node.kind === "agent").map(candidateOf);

/** Who a mention in a resource's comments can name: the seats in reach of the resource (03 section 3). */
export const resourceMentionCandidates = (doc: Canvas, nodeId: string): ReadonlyArray<TargetCandidate> =>
  seatsInReach(doc, asNodeId(nodeId))
    .map((reached) => findNode(doc, reached.id))
    .filter((node): node is Node => node?.kind === "agent")
    .map(candidateOf);

/** Where a text is written (03 section 3): a seat's mail, or the comments on a resource or a page. */
export type MentionPlace = { readonly kind: "mail" } | { readonly kind: "comments"; readonly nodeId: string };

/**
 * The task boards, Artifacts nodes and pages a mention may name (03 section
 * 3): from the writer in mail, from the resource commented on in comments,
 * by the composer's own rule (`mentionableNodesFrom`).
 */
export const mentionNodesAt = (doc: Canvas, writerId: string, place: MentionPlace): ReadonlyArray<Node> =>
  mentionableNodesFrom(doc, asNodeId(place.kind === "mail" ? writerId : place.nodeId))
    .map((node) => findNode(doc, node.id))
    .filter((node): node is Node => node !== undefined);

/** What a mention in a text may name: seats and pages by name, tasks and artifacts as items on their nodes. */
export type MentionCandidates = {
  readonly seats: ReadonlyArray<TargetCandidate>;
  readonly pages: ReadonlyArray<TargetCandidate>;
  /** Tasks and artifacts, each with its `itemId`, a task with its number. */
  readonly items: ReadonlyArray<TargetCandidate>;
};

/** A page node's mention candidates, beside the seats a place offers. */
export const pageMentionCandidates = (nodes: ReadonlyArray<Node>): ReadonlyArray<TargetCandidate> =>
  nodes.filter((node) => node.kind === "page").map(candidateOf);

const fold = (text: string): string => text.trim().toLowerCase();

/** Edit distance between two names, by Levenshtein's rule. */
const distance = (a: string, b: string): number => {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= b.length; j += 1) {
      next.push(Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)));
    }
    row = next;
  }
  return row[b.length]!;
};

/** A token a text kept as typed, and the names nearest it that it could have meant. */
export type UnlinkedMention = { readonly token: string; readonly nearest: ReadonlyArray<string> };

/** A text with its mentions linked, and each token that linked to nothing. */
export type LinkedText = { readonly text: string; readonly unlinked: ReadonlyArray<UnlinkedMention> };

const NEAREST = 3;

/**
 * Up to three of `names` within a typo of `typed`, nearest first. A number
 * is a typo one digit away, and one digit alone has none: every other
 * one-digit task is as near.
 */
export const nearestOf = (typed: string, names: ReadonlyArray<string>, numbers = false): ReadonlyArray<string> => {
  const wanted = fold(typed);
  if (numbers && wanted.length < 2) return [];
  const within = numbers ? 1 : Math.max(2, Math.floor(wanted.length / 2));
  return [...new Set(names)]
    .map((name) => ({ name, far: distance(wanted, fold(name)) }))
    .filter(({ far }) => far <= within)
    .sort((a, b) => a.far - b.far || a.name.localeCompare(b.name))
    .slice(0, NEAREST)
    .map(({ name }) => name);
};

/**
 * The text with every token rewritten to its mention link (03, "Writing from
 * the CLI"): `@name` a seat or a page, `#42` a task by its number, `#name` a
 * task or an artifact by its title, each among `candidates`. A token nothing
 * matches stays plain text and is listed in `unlinked` with the names nearest
 * it, so prose and quoted commands never fail a send; a self-mention stays
 * plain text unlisted. A name several match is refused InputError with those
 * candidates, naming the token.
 */
export const linkMentions = (
  doc: Canvas,
  canvasName: string,
  callerId: string,
  text: string,
  candidates: MentionCandidates,
): Result.Result<LinkedText, WorkErrorBody> => {
  const unlinked: UnlinkedMention[] = [];
  const writer = findNode(doc, callerId);
  const isSelf = (name: string): boolean =>
    fold(name) === "me" || name === callerId || (writer !== undefined && fold(titleOf(writer)) === fold(name));
  const linked = linkMentionTokens(text, canvasName, (token) => {
    const typed = matchTypedMention(token, {
      at: (at) => `@${at.name}`,
      number: (number) => `#${number.number}`,
      hash: (hash) => `#${hash.name}`,
    });
    const refused = (error: WorkErrorBody): WorkErrorBody => ({
      ...error,
      message: `${typed}: ${error.message}`,
      details: { ...error.details, path: "text", target: typed, retryable: false },
    });
    const kept = (nearest: ReadonlyArray<string>): Result.Result<undefined, never> => {
      unlinked.push({ token: typed, nearest });
      return Result.succeed(undefined);
    };
    const tasks = candidates.items.filter((candidate) => candidate.kind === "task");
    const item = (found: TargetCandidate | undefined): Result.Result<ResolvedName | undefined, WorkErrorBody> => {
      if (found?.itemId === undefined) {
        return kept(token.kind === "number"
          ? nearestOf(String(token.number), tasks.flatMap((task) => (task.number === undefined ? [] : [String(task.number)])), true).map((number) => `#${number}`)
          : nearestOf(token.kind === "hash" ? token.name : typed, candidates.items.map((candidate) => candidate.name)).map((name) => `#${name}`));
      }
      const number = found.number === undefined ? "" : `${found.number} `;
      return Result.succeed(found.kind === "task"
        ? { ref: { kind: "task", nodeId: found.nodeId, taskId: found.itemId }, label: `#${number}${found.name}` }
        : { ref: { kind: "artifact", nodeId: found.nodeId, artifactId: found.itemId }, label: `#${found.name}` });
    };
    return matchTypedMention<Result.Result<ResolvedName | undefined, WorkErrorBody>>(token, {
      at: ({ name }) => {
        if (isSelf(name)) return Result.succeed(undefined);
        const named = [...candidates.seats, ...candidates.pages];
        const nearest = () => nearestOf(name, named.map((candidate) => candidate.name)).map((near) => `@${near}`);
        const resolved = resolveWorkTarget(doc, callerId, name, "msg.send", () => named);
        if (Result.isFailure(resolved)) {
          return resolved.failure.type === "UnknownTarget" ? kept(nearest()) : Result.fail(refused(resolved.failure));
        }
        // An id resolves to any node it names; a mention names only a seat or a page it may.
        const found = named.find((candidate) => candidate.nodeId === resolved.success.nodeId);
        if (found === undefined) return kept(nearest());
        return Result.succeed({
          ref: found.kind === "agent" ? { kind: "seat", nodeId: found.nodeId } : { kind: "page", nodeId: found.nodeId },
          label: `@${found.name}`,
        });
      },
      number: ({ number }) => item(tasks.find((candidate) => candidate.number === number)),
      hash: ({ name }) => {
        const matches = candidates.items.filter((candidate) => fold(candidate.name) === fold(name));
        return matches.length > 1
          ? Result.fail(refused(targetRefusal(doc, typed, "ambiguous", false, matches)))
          : item(matches[0]);
      },
    });
  });
  return Result.map(linked, (linkedText) => ({ text: linkedText, unlinked }));
};

/** Every node a wire joins to the caller, either way, once each. */
const wiredNodes = (doc: Canvas, callerId: string): ReadonlyArray<Node> => {
  const ids = new Set<string>();
  for (const wire of doc.wires.values()) {
    if (wire.from === callerId) ids.add(wire.to);
    else if (wire.to === callerId) ids.add(wire.from);
  }
  return [...ids].map((id) => findNode(doc, id)).filter((node): node is Node => node !== undefined);
};
