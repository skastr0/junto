import type { EtherBinding, EtherView } from "@shared/canvas";
// Relative, not "@shared/entities": this is the one *value* (non-type-only)
// cross-package import in this file, and vitest here has no alias resolver
// configured for runtime imports (only tsc resolves "@shared/*" via
// tsconfig paths) — a relative path is what actually lets this module load
// under `bun run test`. Type-only imports stay on the alias below since
// those are erased before any resolver sees them.
import { findEntity } from "../../shared/entities";
import type { Entity, EntitySource, SnapshotState } from "@shared/entities";

// The compact live readout an entity card wears: a handful of plain-English
// stat segments ("82 active · 213 done · 500+ sessions") plus one connector
// dot per binding (lit = fresh, dim = stale/source down). One node, one line —
// never a wall of chips.

export interface ConnectorDot {
  readonly source: EntitySource;
  readonly ok: boolean;
}

export interface EntityReadout {
  readonly segments: ReadonlyArray<string>;
  readonly dots: ReadonlyArray<ConnectorDot>;
}

const num = (entity: Entity, key: string): string | undefined => {
  const value = entity.stats[key];
  if (typeof value === "number") return String(value);
  if (typeof value === "string" && value.length > 0 && value.length <= 6) return value;
  return undefined;
};

const shortDate = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" }).toLowerCase();
};

// Without an orbit slice this is the global "N active"; with one, the card
// is a project slice — the active count narrows to that orbit's own
// orbit_<name> stat ("0" when the orbit exists but has no active glyphs,
// never omitted, since silence there would read as "no data" not "empty").
const towerSegments = (entity: Entity, orbit?: string): string[] => {
  const out: string[] = [];
  if (orbit) {
    const scoped = num(entity, `orbit_${orbit}`);
    out.push(`${scoped ?? "0"} active in ${orbit}`);
  } else {
    const active = num(entity, "glyphs_active");
    if (active) out.push(`${active} active`);
  }
  const done = num(entity, "glyphs_done");
  const signals = num(entity, "signals");
  if (done && done !== "0") out.push(`${done} done`);
  if (signals) out.push(`${signals} signals`);
  return out;
};

const quasarSegments = (entity: Entity): string[] => {
  const out: string[] = [];
  const sessions = num(entity, "sessions");
  if (sessions) out.push(`${sessions} sessions`);
  const last = shortDate(entity.stats.last_session);
  if (last) out.push(last);
  return out;
};

// --- implicit booth resolution ------------------------------------------------
// Booth joins the canvas through TOWER identity, not through hand-wired
// bindings: booth projects carry their tower linkage (key equality, or the
// tower_project stat the adapter forwards from booth's towerProjectKey), so a
// node bound to tower project X is booth-connected the moment a booth project
// for X exists. An explicit booth binding still wins when present.

// The booth project key joined to a tower project key, if any.
export const boothKeyForTower = (
  towerKey: string | undefined,
  snapshots: SnapshotState,
): string | undefined => {
  if (!towerKey) return undefined;
  const bundle = snapshots.bundles.find((candidate) => candidate.source === "booth");
  if (!bundle?.ok) return undefined;
  const match = bundle.entities.find(
    (entity) => entity.key === towerKey || entity.stats.tower_project === towerKey,
  );
  return match?.key;
};

// The node's bindings plus the implicit booth binding (when a booth project
// joins the node's tower project and no explicit booth binding exists).
// Everything binding-driven — readout segments, connector dots, decals,
// browse tabs — consumes THIS, so implicit booth behaves exactly like a
// stored binding without ever touching the document.
export const effectiveBindings = (
  bindings: ReadonlyArray<EtherBinding> | undefined,
  snapshots: SnapshotState,
): ReadonlyArray<EtherBinding> => {
  const stored = bindings ?? [];
  if (stored.some((binding) => binding.source === "booth")) return stored;
  const towerKey = stored.find((binding) => binding.source === "tower")?.ref.key;
  const boothKey = boothKeyForTower(towerKey, snapshots);
  if (boothKey === undefined) return stored;
  return [...stored, { source: "booth", ref: { type: "project", key: boothKey } }];
};

// "3 drafts · 2 to review" — pending_review is the attention state (a human
// verdict is owed), so it surfaces whenever non-zero; needs_revision is the
// producer's queue, shown only when nothing is pending on the human.
const boothSegments = (entity: Entity): string[] => {
  const out: string[] = [];
  const drafts = num(entity, "drafts");
  if (drafts && drafts !== "0") out.push(`${drafts} drafts`);
  const pending = num(entity, "pending_review");
  if (pending && pending !== "0") out.push(`${pending} to review`);
  else {
    const revising = num(entity, "needs_revision");
    if (revising && revising !== "0") out.push(`${revising} revising`);
  }
  return out;
};

// Total drafts owed a human verdict across a node's booth connections
// (explicit or implicit) — the canvas decal's input. 0 means quiet; the badge
// only exists above zero.
export const boothPendingReview = (
  bindings: ReadonlyArray<EtherBinding> | undefined,
  snapshots: SnapshotState,
): number => {
  let total = 0;
  for (const binding of effectiveBindings(bindings, snapshots)) {
    if (binding.source !== "booth") continue;
    const entity = findEntity(snapshots, "booth", binding.ref.key);
    const pending = entity?.stats.pending_review;
    if (typeof pending === "number") total += pending;
  }
  return total;
};

const hermesSegments = (entity: Entity): string[] => {
  const out: string[] = [];
  const status = entity.stats.status;
  if (typeof status === "string" && status) out.push(status);
  const model = entity.stats.model;
  const version = entity.stats.version;
  if (typeof model === "string" && model) out.push(model);
  if (typeof version === "string" && version) out.push(`v${version.replace(/^v/, "")}`);
  return out;
};

const genericSegments = (entity: Entity): string[] =>
  Object.entries(entity.stats)
    .filter(([, value]) => typeof value === "number" && value !== 0)
    .slice(0, 2)
    .map(([key, value]) => `${value} ${key.replace(/_/g, " ")}`);

const SEGMENTS: Record<string, (entity: Entity) => string[]> = {
  tower: towerSegments,
  quasar: quasarSegments,
  booth: boothSegments,
  hermes: hermesSegments,
};

const MAX_SEGMENTS = 4;
const FILTER_QUERY_MAX_LEN = 18;

const truncateQuery = (query: string): string =>
  query.length > FILTER_QUERY_MAX_LEN ? `${query.slice(0, FILTER_QUERY_MAX_LEN)}…` : query;

// `view` is the node's ether.view slice (project nodes only). It never
// changes which bindings/dots render — purely presentational narrowing of
// the tower segment plus one appended "active filter" cue.
export const entityReadout = (
  bindings: ReadonlyArray<EtherBinding> | undefined,
  snapshots: SnapshotState,
  view?: EtherView,
): EntityReadout => {
  const segments: string[] = [];
  const dots: ConnectorDot[] = [];
  for (const binding of effectiveBindings(bindings, snapshots)) {
    const bundle = snapshots.bundles.find((candidate) => candidate.source === binding.source);
    const entity = findEntity(snapshots, binding.source, binding.ref.key);
    const ok = (bundle?.ok ?? false) && entity !== undefined;
    dots.push({ source: binding.source, ok });
    if (!entity) continue;
    const built = binding.source === "tower" ? towerSegments(entity, view?.orbit) : (SEGMENTS[binding.source] ?? genericSegments)(entity);
    segments.push(...(built.length > 0 ? built : genericSegments(entity)));
  }
  const filterSegment = view?.glyphQuery ? `⌕ ${truncateQuery(view.glyphQuery)}` : undefined;
  const capped = segments.slice(0, filterSegment ? MAX_SEGMENTS - 1 : MAX_SEGMENTS);
  return { segments: filterSegment ? [...capped, filterSegment] : capped, dots };
};
