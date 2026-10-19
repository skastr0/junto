import { Match, Schema } from "effect";
import { compareView, MemberSeverity as MemberSeverityView, type ViewGroup } from "./wire/urgency";
import type { ActorRefResolver } from "./attention";
import type { Canvas, Node } from "./model";
import { titleOf } from "./model/title";
import { inPaintOrder, regionMembers as membersOf, regionName } from "./model/canvas";
import type { SnapshotState } from "./entities";
import {
  deriveExecutionGraph,
  type LiveTrustViews,
  type WorkBlockedSeat,
} from "./execution-graph";
import { resolveSpec } from "./physics";
import type { WorkSurfaceActivity } from "./terminal";
import type { WorkItemsOf } from "./execution-graph";

// Region severity rollups: the operational tier of the bottom-bar information
// ladder (minimap strategic / region bar operational / selection tactical).
// One rollup per region node — the region is the control group; every member's
// severity bubbles up to the chip.
//
// Pure, side-effect-free, derived from (canvas rows + compiled actor refs +
// optional live inputs). Never persisted. INVARIANT (mirror of the edge law):
// unknown or missing live data invents NOTHING — absent snapshots/activity
// only narrow what can be derived; they never fabricate blocks, attention,
// or work.

// The severity tiers are the MemberSeverity view of the one urgency ladder
// (wire/urgency.ts), worst first: blocked (a declared block or a stop),
// attention (a proven dialog), escalated, ready (review or done), working,
// idle. A member lands in the WORST tier it matches; its reasons collect every
// match, in ladder order. `ready` asks for a glance, never for input, so
// notify pills and attention alerts must keep ignoring it.
export const MemberSeverity = MemberSeverityView;
export type MemberSeverity = ViewGroup<typeof MemberSeverityView>;

/** Most urgent tier first: a negative result means `a` is the worse tier. Every surface that compares tiers reads this. */
export const compareSeverity = compareView(MemberSeverityView);

/** The worse of two tiers. */
export const worseSeverity = (a: MemberSeverity, b: MemberSeverity): MemberSeverity =>
  compareSeverity(a, b) <= 0 ? a : b;

/**
 * A seat's tier read off its needs through `ROLLUP_FROM_NEED`
 * (need-surfaces.ts), and the need cause that set it. The caller projects,
 * so this module stays free of the need tables.
 */
export type SeatNeedTier = {
  readonly severity: MemberSeverity;
  readonly cause: string;
};

// Live per-agent runtime signal, keyed by agentKey (the hermes
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
  // the native node kind.
  kind: Schema.String,
  severity: MemberSeverityView.Group,
  // Short machine strings, worst-tier first: permission:pending,
  // need:<cause>, work:<detail>, edge:<detail>, and the harness fallback's
  // activity:attention, activity:blocked, activity:ready, activity:working.
  reasons: Schema.Array(Schema.String),
});
export type MemberStatus = typeof MemberStatus.Type;

export const RegionRollup = Schema.Struct({
  regionId: Schema.String,
  // The region's display name (regionDisplayName): never empty.
  label: Schema.String,
  // Worst member severity; "idle" for an empty region.
  severity: MemberSeverityView.Group,
  // A member counts only in its own (worst-match) bucket; parked and idle
  // members count toward total only.
  counts: Schema.Struct({
    total: Schema.Number,
    blocked: Schema.Number,
    attention: Schema.Number,
    escalated: Schema.Number,
    working: Schema.Number,
    ready: Schema.Number,
  }),
  // Sorted: severity rank (attention -> idle), then kind rank (agent, task/
  // requests, rest), then paint order.
  members: Schema.Array(MemberStatus),
});
export type RegionRollup = typeof RegionRollup.Type;

export interface RegionRollupInput extends LiveTrustViews {
  readonly canvas: Canvas;
  readonly itemsOf: WorkItemsOf;
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
  // The fallback for a seat with no tier below.
  readonly terminalStatusByNodeId?: ReadonlyMap<string, WorkSurfaceActivity>;
  // A seat's tier from its needs, by canvas node id. When present it
  // replaces the harness fallback: declared signals, stops and unread turns
  // reach the rollup on the one ladder.
  readonly seatTierByNodeId?: ReadonlyMap<string, SeatNeedTier>;
}

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

// The harness fallback: a seat with no need tier reads its harness state.
// Finished-but-unread rides alongside it: the surface reports `idle` and
// marks `ready`, so nothing downstream reads it as needs-input.
const surfaceTier = (activity: WorkSurfaceActivity | undefined): SeatNeedTier | undefined => {
  const state = activity?.harness;
  if (state === undefined || state === "unknown" || state === "idle") {
    return activity?.ready === true ? { severity: MemberSeverity.group.ready, cause: "activity:ready" } : undefined;
  }
  if (state === "blocked") return { severity: MemberSeverity.group.blocked, cause: "activity:blocked" };
  if (state === "attention") return { severity: MemberSeverity.group.attention, cause: "activity:attention" };
  return { severity: MemberSeverity.group.working, cause: "activity:working" };
};

// Rank for mapped execution-graph reasons: edge before seed (no relay cascade).
const GRAPH_REASON_RANK = { work: 0, edge: 1 } as const;

// mirrors digest.titleOf — duplicated on purpose: shared modules stay
// decoupled, and the label convention must not drift with the projection.
const deriveMember = (
  node: Node,
  graph: ReturnType<typeof deriveExecutionGraph>,
  agentActivity: ReadonlyMap<string, AgentActivity> | undefined,
  terminalStatusByNodeId: ReadonlyMap<string, WorkSurfaceActivity> | undefined,
  seatTierByNodeId: ReadonlyMap<string, SeatNeedTier> | undefined,
): MemberStatus => {
  const kind = node.kind;
  const activity = node.kind === "agent" ? agentActivity?.get(node.agentKey) : undefined;
  const fromNeeds = seatTierByNodeId?.get(node.id);
  const seat = fromNeeds
    ? { ...fromNeeds, cause: `need:${fromNeeds.cause}` }
    : surfaceTier(terminalStatusByNodeId?.get(node.id));

  const matches: Array<readonly [MemberSeverity, string]> = [];
  // ACP permission pending: the chat plane's own attention.
  if (activity?.permissionPending === true) matches.push([MemberSeverity.group.attention, "permission:pending"]);
  // Idle is where a member lands with no match; it carries no reason.
  if (seat && seat.severity !== MemberSeverity.group.idle) matches.push([seat.severity, seat.cause]);
  // Execution-graph closure: edge before seed (no relay cascade).
  const graphReasons = [...(graph.reasonsByNodeId.get(node.id) ?? [])].sort(
    (a, b) => GRAPH_REASON_RANK[a.kind] - GRAPH_REASON_RANK[b.kind],
  );
  for (const reason of graphReasons) matches.push([MemberSeverity.group.blocked, `${reason.kind}:${reason.detail}`]);
  // A graph block with no reason still blocks; it just adds no reason string.
  if (graph.blocked.has(node.id) && graphReasons.length === 0) matches.push([MemberSeverity.group.blocked, ""]);

  // Stable: equal tiers keep the order they were found in.
  matches.sort((a, b) => compareSeverity(a[0], b[0]));
  const severity: MemberSeverity = matches[0]?.[0] ?? MemberSeverity.group.idle;
  const reasons = matches.flatMap(([, reason]) => (reason === "" ? [] : [reason]));
  return { nodeId: node.id, label: titleOf(node), kind, severity, reasons };
};

// A region's members, sorted for the rollcall: severity rank (attention ->
// idle), then kind rank (agent, project, rest), then paint order.
const regionMembers = (
  memberIds: ReadonlyArray<string>,
  nodeById: ReadonlyMap<string, Node>,
  indexById: ReadonlyMap<string, number>,
  graph: ReturnType<typeof deriveExecutionGraph>,
  agentActivity: ReadonlyMap<string, AgentActivity> | undefined,
  terminalStatusByNodeId: ReadonlyMap<string, WorkSurfaceActivity> | undefined,
  seatTierByNodeId: ReadonlyMap<string, SeatNeedTier> | undefined,
): MemberStatus[] =>
  memberIds
    .map((id) => {
      const member = nodeById.get(id);
      return member === undefined
        ? undefined
        : {
            status: deriveMember(member, graph, agentActivity, terminalStatusByNodeId, seatTierByNodeId),
            index: indexById.get(id) ?? 0,
          };
    })
    .filter((entry): entry is { status: MemberStatus; index: number } => entry !== undefined)
    .sort(
      (a, b) =>
        compareSeverity(a.status.severity, b.status.severity) ||
        kindRank(a.status.kind) - kindRank(b.status.kind) ||
        a.index - b.index,
    )
    .map((entry) => entry.status);

const countBySeverity = (members: ReadonlyArray<MemberStatus>): RegionRollup["counts"] => {
  const counts = { total: members.length, blocked: 0, attention: 0, escalated: 0, working: 0, ready: 0 };
  for (const member of members) {
    if (member.severity === "blocked") counts.blocked += 1;
    else if (member.severity === "attention") counts.attention += 1;
    else if (member.severity === "escalated") counts.escalated += 1;
    else if (member.severity === "working") counts.working += 1;
    else if (member.severity === "ready") counts.ready += 1;
  }
  return counts;
};

// One rollup per region node, in paint order. Only members per
// groupMembers(doc) participate — members are non-region nodes, and nodes
// outside every region are ignored. Nesting-correct as-is: a node inside an
// inner region is a member of every container, so severity aggregates up the
// whole region stack without walking region-in-region structure.
export const deriveRegionRollups = (input: RegionRollupInput): ReadonlyArray<RegionRollup> => {
  const {
    canvas,
    itemsOf,
    canvasName,
    resolveActorRef,
    workBlockedSeats,
    stamps,
    approvals,
    agentActivity,
    terminalStatusByNodeId,
    seatTierByNodeId,
  } = input;
  const graph = deriveExecutionGraph(canvas, {
    canvasName,
    resolveActorRef,
    itemsOf,
    ...(workBlockedSeats ? { workBlockedSeats } : {}),
    ...(stamps ? { stamps } : {}),
    ...(approvals ? { approvals } : {}),
  });
  const ordered = inPaintOrder(canvas);
  const indexById = new Map(ordered.map((node, index) => [node.id, index] as const));
  const nodeById = canvas.nodes;

  const rollups: RegionRollup[] = [];
  for (const node of ordered) {
    if (node.kind !== "region") continue;
    const members = regionMembers(
      membersOf(canvas, node).map((member) => member.id),
      nodeById,
      indexById,
      graph,
      agentActivity,
      terminalStatusByNodeId,
      seatTierByNodeId,
    );
    rollups.push({
      regionId: node.id,
      label: regionName(node),
      severity: members[0]?.severity ?? "idle",
      counts: countBySeverity(members),
      members,
    });
  }
  return rollups;
};
