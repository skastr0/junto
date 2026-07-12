import type { EtherBinding } from "@shared/canvas";
import { findEntity } from "@shared/entities";
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

const towerSegments = (entity: Entity): string[] => {
  const out: string[] = [];
  const active = num(entity, "glyphs_active");
  const done = num(entity, "glyphs_done");
  const signals = num(entity, "signals");
  if (active) out.push(`${active} active`);
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
  hermes: hermesSegments,
};

const MAX_SEGMENTS = 4;

export const entityReadout = (
  bindings: ReadonlyArray<EtherBinding> | undefined,
  snapshots: SnapshotState,
): EntityReadout => {
  const segments: string[] = [];
  const dots: ConnectorDot[] = [];
  for (const binding of bindings ?? []) {
    const bundle = snapshots.bundles.find((candidate) => candidate.source === binding.source);
    const entity = findEntity(snapshots, binding.source, binding.ref.key);
    const ok = (bundle?.ok ?? false) && entity !== undefined;
    dots.push({ source: binding.source, ok });
    if (!entity) continue;
    const build = SEGMENTS[binding.source] ?? genericSegments;
    const built = build(entity);
    segments.push(...(built.length > 0 ? built : genericSegments(entity)));
  }
  return { segments: segments.slice(0, MAX_SEGMENTS), dots };
};
