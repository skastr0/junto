import { Schema } from "effect";
import { WIP_GLYPH_STATES, type CanvasDoc, type CanvasNode, type GroupNode } from "./canvas";
import type { SnapshotState } from "./entities";
import { deriveExecutionGraph, type GlyphView } from "./execution-graph";
import { groupMembers, isGroup } from "./graph";

// Region severity rollups: the operational tier of the bottom-bar information
// ladder (minimap strategic / region bar operational / selection tactical).
// One rollup per group node — the region is the control group; every member's
// severity bubbles up to the chip.
//
// Pure, side-effect-free, derived from (document + optional live inputs).
// Never persisted. INVARIANT (mirror of the edge law): unknown or missing
// live data invents NOTHING — absent snapshots/glyphs/activity only narrow
// what can be derived; they never fabricate blocks, attention, or work.

// The severity ladder, worst first. A member lands in the WORST tier it
// matches; its reasons collect every match, in ladder order.
export const MemberSeverity = Schema.Literal("blocked", "attention", "working", "parked", "idle");
export type MemberSeverity = typeof MemberSeverity.Type;

// Live per-agent runtime signal, keyed by ether.entity.name (the hermes
// "<host>:<profile>" key). The app-side ACP chat plane fills this in; the
// headless digest omits it entirely (determinism over liveness).
export const AgentActivity = Schema.Struct({
  sessionLive: Schema.optionalWith(Schema.Boolean, { exact: true }),
  permissionPending: Schema.optionalWith(Schema.Boolean, { exact: true }),
});
export type AgentActivity = typeof AgentActivity.Type;

export const MemberStatus = Schema.Struct({
  nodeId: Schema.String,
  label: Schema.String,
  // ether.entity.kind, or "node" for unbound (ether-free) members.
  kind: Schema.String,
  severity: MemberSeverity,
  // Short machine strings, worst-tier first: flag:blocker, edge:<detail>,
  // relay, seed:<detail>, flag:attention, permission:pending, session:live,
  // glyph:wip:<state>, flag:parked.
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
  }),
  // Sorted: severity rank (blocked -> idle), then kind rank (agent, project,
  // everything else), then document order.
  members: Schema.Array(MemberStatus),
});
export type RegionRollup = typeof RegionRollup.Type;

export interface RegionRollupInput {
  readonly doc: CanvasDoc;
  // Reserved seam: binding staleness deliberately does NOT feed the ladder
  // yet — a down adapter would cry wolf on every bound node. Accepted so the
  // digest and the app service share one input shape.
  readonly snapshots?: SnapshotState;
  readonly glyphs?: GlyphView;
  readonly agentActivity?: ReadonlyMap<string, AgentActivity>;
}

const SEVERITY_RANK: Readonly<Record<MemberSeverity, number>> = {
  blocked: 0,
  attention: 1,
  working: 2,
  parked: 3,
  idle: 4,
};

const kindRank = (kind: string): number => (kind === "agent" ? 0 : kind === "project" ? 1 : 2);

const WIP_SET: ReadonlySet<string> = new Set(WIP_GLYPH_STATES);

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

// First WIP state on the member's own project rows, when the view knows the
// project at all. Missing key / undefined rows = data unavailable = no work
// invented. Project identity is ether.entity.name (the tower project key).
const wipStateOf = (node: CanvasNode, glyphs: GlyphView | undefined): string | undefined => {
  const entity = node.ether?.entity;
  if (entity?.kind !== "project" || entity.name === undefined || glyphs === undefined) {
    return undefined;
  }
  if (!glyphs.has(entity.name)) return undefined;
  const rows = glyphs.get(entity.name);
  if (rows === undefined) return undefined;
  return rows.find((row) => WIP_SET.has(row.state))?.state;
};

const deriveMember = (
  node: CanvasNode,
  graph: ReturnType<typeof deriveExecutionGraph>,
  glyphs: GlyphView | undefined,
  agentActivity: ReadonlyMap<string, AgentActivity> | undefined,
): MemberStatus => {
  const entity = node.ether?.entity;
  const kind = entity?.kind ?? "node";
  const flags = node.ether?.flags ?? [];
  const activity =
    entity?.kind === "agent" && entity.name !== undefined
      ? agentActivity?.get(entity.name)
      : undefined;

  const reasons: string[] = [];

  // blocked: manual flag, or membership in the execution-graph blocked
  // closure (edge generation, relay, or seed — reasons map verbatim).
  if (flags.includes("blocker")) reasons.push("flag:blocker");
  for (const reason of graph.reasonsByNodeId.get(node.id) ?? []) {
    if (reason.kind === "edge") reasons.push(`edge:${reason.detail}`);
    else if (reason.kind === "relay") reasons.push("relay");
    else reasons.push(`seed:${reason.detail}`);
  }
  const blocked = flags.includes("blocker") || graph.blocked.has(node.id);

  // attention: manual flag, or a live agent waiting on a permission answer.
  if (flags.includes("attention")) reasons.push("flag:attention");
  if (activity?.permissionPending === true) reasons.push("permission:pending");
  const attention = flags.includes("attention") || activity?.permissionPending === true;

  // working: a live ACP session on an agent, or WIP glyphs on a project.
  if (activity?.sessionLive === true) reasons.push("session:live");
  const wipState = wipStateOf(node, glyphs);
  if (wipState !== undefined) reasons.push(`glyph:wip:${wipState}`);
  const working = activity?.sessionLive === true || wipState !== undefined;

  // parked: manual flag only.
  if (flags.includes("parked")) reasons.push("flag:parked");

  const severity: MemberSeverity = blocked
    ? "blocked"
    : attention
      ? "attention"
      : working
        ? "working"
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
  glyphs: GlyphView | undefined,
  agentActivity: ReadonlyMap<string, AgentActivity> | undefined,
): MemberStatus[] =>
  memberIds
    .map((id) => {
      const member = nodeById.get(id);
      return member === undefined
        ? undefined
        : { status: deriveMember(member, graph, glyphs, agentActivity), index: indexById.get(id) ?? 0 };
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
  const counts = { total: members.length, blocked: 0, attention: 0, working: 0 };
  for (const member of members) {
    if (member.severity === "blocked") counts.blocked += 1;
    else if (member.severity === "attention") counts.attention += 1;
    else if (member.severity === "working") counts.working += 1;
  }
  return counts;
};

// One rollup per group node, in document order. Only members per
// groupMembers(doc) participate — groups never contain groups, and nodes
// outside every region are ignored.
export const deriveRegionRollups = (input: RegionRollupInput): ReadonlyArray<RegionRollup> => {
  const { doc, glyphs, agentActivity } = input;
  const graph = deriveExecutionGraph(doc, glyphs ?? new Map());
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
      glyphs,
      agentActivity,
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
