import type { EtherEntity, EtherView } from "@shared/canvas";
// Relative, not "@shared/connections": this is the one *value* (non-type-only)
// cross-package import in this file, and vitest here has no alias resolver
// configured for runtime imports (only tsc resolves "@shared/*" via
// tsconfig paths) — a relative path is what actually lets this module load
// under `bun run test`. Type-only imports stay on the alias below since
// those are erased before any resolver sees them.
import { resolveNodeConnections, type Connection } from "../../shared/connections";
import type { Entity, EntitySource, SnapshotState } from "@shared/entities";

// The compact live readout an entity card wears: a handful of plain-English
// stat segments ("82 active · 213 done · 500+ sessions") plus one connector
// dot per resolved connection (lit = live entity present, dim = source down
// or entity gone). Connections are DERIVED from the node's identity by
// shared/connections.ts — nothing here reads stored per-source keys, because
// none exist.

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

// Quasar connections arrive as FACETS of one project (git identity + local
// checkouts) — the readout aggregates them: total sessions, latest activity.
const quasarSegments = (facets: ReadonlyArray<Entity>): string[] => {
  const out: string[] = [];
  let sessions = 0;
  let sawSessions = false;
  let last: string | undefined;
  for (const facet of facets) {
    const count = facet.stats.sessions;
    if (typeof count === "number") {
      sessions += count;
      sawSessions = true;
    }
    const facetLast = typeof facet.stats.last_session === "string" ? facet.stats.last_session : undefined;
    if (facetLast && (!last || facetLast > last)) last = facetLast;
  }
  if (sawSessions) out.push(`${sessions} sessions`);
  const date = shortDate(last);
  if (date) out.push(date);
  return out;
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

const MAX_SEGMENTS = 4;
const FILTER_QUERY_MAX_LEN = 18;

const truncateQuery = (query: string): string =>
  query.length > FILTER_QUERY_MAX_LEN ? `${query.slice(0, FILTER_QUERY_MAX_LEN)}…` : query;

const bundleOk = (snapshots: SnapshotState, source: EntitySource): boolean =>
  snapshots.bundles.find((bundle) => bundle.source === source)?.ok === true;

// `view` is the node's ether.view slice (project nodes only). It never
// changes which connections/dots render — purely presentational narrowing of
// the tower segment plus one appended "active filter" cue.
export const entityReadout = (
  entity: EtherEntity | undefined,
  snapshots: SnapshotState,
  view?: EtherView,
): EntityReadout => {
  const connections = resolveNodeConnections(entity, snapshots);
  const segments: string[] = [];
  const dots: ConnectorDot[] = [];

  // One dot per source, quasar facets collapsed into one.
  const seenSources = new Set<EntitySource>();
  for (const connection of connections) {
    if (seenSources.has(connection.source)) continue;
    seenSources.add(connection.source);
    dots.push({
      source: connection.source,
      ok: bundleOk(snapshots, connection.source) && connection.entity !== undefined,
    });
  }

  const tower = connections.find((connection) => connection.source === "tower")?.entity;
  if (tower) {
    const built = towerSegments(tower, view?.orbit);
    segments.push(...(built.length > 0 ? built : genericSegments(tower)));
  }

  const facets = connections
    .filter((connection) => connection.source === "quasar")
    .flatMap((connection) => (connection.entity ? [connection.entity] : []));
  if (facets.length > 0) segments.push(...quasarSegments(facets));

  const booth = connections.find((connection) => connection.source === "booth")?.entity;
  if (booth) {
    const built = boothSegments(booth);
    segments.push(...(built.length > 0 ? built : genericSegments(booth)));
  }

  const hermes = connections.find((connection) => connection.source === "hermes")?.entity;
  if (hermes) {
    const built = hermesSegments(hermes);
    segments.push(...(built.length > 0 ? built : genericSegments(hermes)));
  }

  const filterSegment = view?.glyphQuery ? `⌕ ${truncateQuery(view.glyphQuery)}` : undefined;
  const capped = segments.slice(0, filterSegment ? MAX_SEGMENTS - 1 : MAX_SEGMENTS);
  return { segments: filterSegment ? [...capped, filterSegment] : capped, dots };
};

// Total drafts owed a human verdict across the node's resolved booth
// connection — the canvas decal's input. 0 means quiet; the badge only
// exists above zero.
export const boothPendingReview = (
  entity: EtherEntity | undefined,
  snapshots: SnapshotState,
): number => {
  let total = 0;
  for (const connection of resolveNodeConnections(entity, snapshots)) {
    if (connection.source !== "booth") continue;
    const pending = connection.entity?.stats.pending_review;
    if (typeof pending === "number") total += pending;
  }
  return total;
};

export type { Connection };
