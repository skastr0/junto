import { Match, Schema } from "effect";
import type { ActorRefResolver } from "./attention";
import type { CanvasDoc, CanvasNode, GroupNode } from "./canvas";
import type { SnapshotState } from "./entities";
import {
  deriveExecutionGraph,
  isBlockableNode,
  type LiveTrustViews,
  type WorkBlockedSeat,
} from "./execution-graph";
import { groupMembers, isGroup } from "./graph";
import { resolveSpec } from "./physics";
import type { WorkSurfaceActivity } from "./terminal";

// Region severity rollups: the operational tier of the bottom-bar information
// ladder (minimap strategic / region bar operational / selection tactical).
// One rollup per group node — the region is the control group; every member's
// severity bubbles up to the chip.
//
// Pure, side-effect-free, derived from (document + compiled actor refs +
// optional live inputs). Never persisted. INVARIANT (mirror of the edge law):
// unknown or missing live data invents NOTHING — absent snapshots/activity
// only narrow what can be derived; they never fabricate blocks, attention,
// or work.

// The severity ladder, worst first. A member lands in the WORST tier it
// matches; its reasons collect every match, in ladder order.
// `ready` is finished work nobody has read yet (seat idle + needsLook, herdr
// "done"). It sits below working on purpose: it asks for a glance, never for
// input, so notify pills and attention alerts must keep ignoring it.
export const MemberSeverity = Schema.Literals([
  "blocked",
  "attention",
  "working",
  "ready",
  "parked",
  "idle",
]);
export type MemberSeverity = typeof MemberSeverity.Type;

// Live per-agent runtime signal, keyed by ether.entity.name (the hermes
// "<host>:<profile>" key). The app-side ACP chat plane fills this in; the
// headless digest omits it entirely (determinism over liveness).
export const AgentActivity = Schema.Struct({
  sessionLive: Schema.optionalKey(Schema.Boolean),
  permissionPending: Schema.optionalKey(Schema.Boolean),
});
export type AgentActivity = typeof AgentActivity.Type;

export const MemberStatus = Schema.Struct({
  nodeId: Schema.String,
  label: Schema.String,
  // ether.entity.kind, or "node" for unbound (ether-free) members.
  kind: Schema.String,
  severity: MemberSeverity,
  // Short machine strings, worst-tier first: flag:blocker, edge:<detail>,
  // seed:<detail>, activity:blocked, flag:attention, permission:pending,
  // activity:attention, activity:working, flag:parked.
  // (`seed:` is the execution-graph's manual-blocker origin — NOT the digest
  // `seeds` section, which lists unbound entity nodes.)
  reasons: Schema.Array(Schema.String),
});
export type MemberStatus = typeof MemberStatus.Type;

export const RegionRollup = Schema.Struct({
  regionId: Schema.String,
  // Group label trimmed; "unnamed region" when blank/absent.
  label: Schema.String,
  // Worst member severity; "idle" for an empty region.
  severity: MemberSeverity,
  // A member counts only in its own (worst-match) bucket; parked and idle
  // members count toward total only.
  counts: Schema.Struct({
    total: Schema.Number,
    blocked: Schema.Number,
    attention: Schema.Number,
    working: Schema.Number,
    ready: Schema.Number,
  }),
  // Sorted: severity rank (blocked -> idle), then kind rank (agent, task/
  // requests, rest), then document order.
  members: Schema.Array(MemberStatus),
});
export type RegionRollup = typeof RegionRollup.Type;

export interface RegionRollupInput extends LiveTrustViews {
  readonly doc: CanvasDoc;
  /** Canvas scope and compiled actor identity are mandatory graph inputs. */
  readonly canvasName: string;
  readonly resolveActorRef: ActorRefResolver;
  readonly workBlockedSeats?: ReadonlyMap<string, WorkBlockedSeat>;
  // Reserved seam: binding staleness deliberately does NOT feed the ladder
  // yet — a down adapter would cry wolf on every bound node. Accepted so the
  // digest and the app service share one input shape.
  readonly snapshots?: SnapshotState;
  readonly agentActivity?: ReadonlyMap<string, AgentActivity>;
  // Backend-neutral harness activity by canvas node id. Session liveness alone
  // never means work: only an explicit harness state contributes severity.
  readonly terminalStatusByNodeId?: ReadonlyMap<string, WorkSurfaceActivity>;
}

const SEVERITY_RANK: Readonly<Record<MemberSeverity, number>> = {
  blocked: 0,
  attention: 1,
  working: 2,
  ready: 3,
  parked: 4,
  idle: 5,
};

// Rollcall ordering: message-bearing actor seats first, then the two work
// stores an operator reads next, then everything else. Exhaustive over NodeSpec
// — a new kind has to be ranked here rather than silently landing in "rest".
// A raw terminal ranks with the rest: it carries no messages to read.
const kindRank = (kind: string): number =>
  Match.value(resolveSpec({ isGroup: false, kind })).pipe(
    Match.tagsExhaustive({
      Actor: () => 0,
      Sink: (spec) => (spec.kind === "task" || spec.kind === "requests" ? 1 : 2),
      Scheduler: () => 2,
      Geography: () => 2,
    }),
  );

const workSurfaceContribution = (
  activity: WorkSurfaceActivity | undefined,
): {
  readonly blocked: boolean;
  readonly attention: boolean;
  readonly working: boolean;
  readonly ready: boolean;
  readonly reason?: string;
} => {
  const state = activity?.harness;
  // Finished-but-unread rides alongside the harness state: the surface reports
  // `idle` and marks `ready`, so nothing downstream reads it as needs-input.
  const ready = activity?.ready === true;
  if (state === undefined || state === "unknown" || state === "idle") {
    return ready
      ? { blocked: false, attention: false, working: false, ready, reason: "activity:ready" }
      : { blocked: false, attention: false, working: false, ready: false };
  }
  if (state === "blocked") return { blocked: true, attention: false, working: false, ready: false, reason: "activity:blocked" };
  if (state === "attention") return { blocked: false, attention: true, working: false, ready: false, reason: "activity:attention" };
  return { blocked: false, attention: false, working: true, ready: false, reason: "activity:working" };
};

// Rank for mapped execution-graph reasons: edge before seed (no relay cascade).
const GRAPH_REASON_RANK = { work: 0, edge: 1, seed: 2 } as const;

// mirrors digest.titleOf — duplicated on purpose: shared modules stay
// decoupled, and the label convention must not drift with the projection.
const titleOf = (node: CanvasNode): string => {
  switch (node.type) {
    case "text":
      return (node.text.split("\n")[0] ?? "").trim();
    case "file": {
      const base = node.file.split(/[\\/]/).pop();
      return base && base.length > 0 ? base : node.file;
    }
    case "link":
      return node.url;
    case "group":
      return node.label ?? node.id;
  }
};

const regionLabel = (group: GroupNode): string => (group.label ?? "").trim() || "unnamed region";

const deriveMember = (
  node: CanvasNode,
  graph: ReturnType<typeof deriveExecutionGraph>,
  agentActivity: ReadonlyMap<string, AgentActivity> | undefined,
  terminalStatusByNodeId: ReadonlyMap<string, WorkSurfaceActivity> | undefined,
): MemberStatus => {
  const entity = node.ether?.entity;
  // The authored entity kind, or none. Presence of a binding key (ether.herdr)
  // is not a kind — a node is what it was authored as, never what a live
  // attachment implies.
  const kind = entity?.kind ?? "node";
  const flags = node.ether?.flags ?? [];
  const activity =
    entity?.kind === "agent" && entity.name !== undefined
      ? agentActivity?.get(entity.name)
      : undefined;
  const surface = workSurfaceContribution(terminalStatusByNodeId?.get(node.id));

  const reasons: string[] = [];

  // blocked: seat flag (actors only), execution-graph closure, or harness blocked.
  // Schedulers/pages with a stray flag:blocker are not stoppage seats.
  const flagBlockerSeat = flags.includes("blocker") && isBlockableNode(node);
  if (flagBlockerSeat) reasons.push("flag:blocker");
  const graphReasons = [...(graph.reasonsByNodeId.get(node.id) ?? [])].sort(
    (a, b) => GRAPH_REASON_RANK[a.kind] - GRAPH_REASON_RANK[b.kind],
  );
  for (const reason of graphReasons) {
    if (reason.kind === "work") reasons.push(`work:${reason.detail}`);
    else if (reason.kind === "edge") reasons.push(`edge:${reason.detail}`);
    else reasons.push(`seed:${reason.detail}`);
  }
  if (surface.reason === "activity:blocked") reasons.push(surface.reason);
  const blocked =
    flagBlockerSeat || graph.blocked.has(node.id) || surface.blocked;

  // attention: manual flag, ACP permission pending, or explicit harness signal.
  if (flags.includes("attention")) reasons.push("flag:attention");
  if (activity?.permissionPending === true) reasons.push("permission:pending");
  if (surface.reason === "activity:attention") reasons.push(surface.reason);
  const attention =
    flags.includes("attention") || activity?.permissionPending === true || surface.attention;

  // working: explicit harness activity only.
  if (surface.reason === "activity:working") reasons.push(surface.reason);
  const working = surface.working;

  // ready: the seat finished a turn and nobody has looked yet.
  if (surface.reason === "activity:ready") reasons.push(surface.reason);

  // parked: manual flag only.
  if (flags.includes("parked")) reasons.push("flag:parked");

  const severity: MemberSeverity = blocked
    ? "blocked"
    : attention
      ? "attention"
      : working
        ? "working"
        : surface.ready
          ? "ready"
          : flags.includes("parked")
            ? "parked"
            : "idle";

  return { nodeId: node.id, label: titleOf(node), kind, severity, reasons };
};

// A region's members, sorted for the rollcall: severity rank (blocked ->
// idle), then kind rank (agent, project, rest), then document order.
const regionMembers = (
  memberIds: ReadonlyArray<string>,
  nodeById: ReadonlyMap<string, CanvasNode>,
  indexById: ReadonlyMap<string, number>,
  graph: ReturnType<typeof deriveExecutionGraph>,
  agentActivity: ReadonlyMap<string, AgentActivity> | undefined,
  terminalStatusByNodeId: ReadonlyMap<string, WorkSurfaceActivity> | undefined,
): MemberStatus[] =>
  memberIds
    .map((id) => {
      const member = nodeById.get(id);
      return member === undefined
        ? undefined
        : {
            status: deriveMember(member, graph, agentActivity, terminalStatusByNodeId),
            index: indexById.get(id) ?? 0,
          };
    })
    .filter((entry): entry is { status: MemberStatus; index: number } => entry !== undefined)
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.status.severity] - SEVERITY_RANK[b.status.severity] ||
        kindRank(a.status.kind) - kindRank(b.status.kind) ||
        a.index - b.index,
    )
    .map((entry) => entry.status);

const countBySeverity = (members: ReadonlyArray<MemberStatus>): RegionRollup["counts"] => {
  const counts = { total: members.length, blocked: 0, attention: 0, working: 0, ready: 0 };
  for (const member of members) {
    if (member.severity === "blocked") counts.blocked += 1;
    else if (member.severity === "attention") counts.attention += 1;
    else if (member.severity === "working") counts.working += 1;
    else if (member.severity === "ready") counts.ready += 1;
  }
  return counts;
};

// One rollup per group node, in document order. Only members per
// groupMembers(doc) participate — members are non-group nodes, and nodes
// outside every region are ignored. Nesting-correct as-is: a node inside an
// inner region is a member of every container, so severity aggregates up the
// whole region stack without walking region-in-region structure.
export const deriveRegionRollups = (input: RegionRollupInput): ReadonlyArray<RegionRollup> => {
  const {
    doc,
    canvasName,
    resolveActorRef,
    workBlockedSeats,
    stamps,
    approvals,
    agentActivity,
    terminalStatusByNodeId,
  } = input;
  const graph = deriveExecutionGraph(doc, {
    canvasName,
    resolveActorRef,
    ...(workBlockedSeats ? { workBlockedSeats } : {}),
    ...(stamps ? { stamps } : {}),
    ...(approvals ? { approvals } : {}),
  });
  const membersByRegion = groupMembers(doc);
  const indexById = new Map(doc.nodes.map((node, index) => [node.id, index] as const));
  const nodeById = new Map(doc.nodes.map((node) => [node.id, node] as const));

  const rollups: RegionRollup[] = [];
  for (const node of doc.nodes) {
    if (!isGroup(node)) continue;
    const members = regionMembers(
      membersByRegion.get(node.id) ?? [],
      nodeById,
      indexById,
      graph,
      agentActivity,
      terminalStatusByNodeId,
    );
    rollups.push({
      regionId: node.id,
      label: regionLabel(node),
      severity: members[0]?.severity ?? "idle",
      counts: countBySeverity(members),
      members,
    });
  }
  return rollups;
};
