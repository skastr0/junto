import { use$ } from "@legendapp/state/react";
import type { EtherBinding, EtherEntity } from "@shared/canvas";
import { findEntity } from "@shared/entities";
import type { Entity, EntitySource, SnapshotState } from "@shared/entities";
import { SOURCE_HUE, withAlpha } from "../lib/theme";
import { state$, toggleSourceFilter } from "../lib/state";

// Preferred headline stat per source; falls back to the first stats entries.
const PREFERRED: Record<string, ReadonlyArray<string>> = {
  tower: ["glyphs", "active", "open"],
  quasar: ["sessions", "tool_calls"],
  booth: ["drafts", "pending"],
  hermes: ["agents", "sessions", "status"],
};

const pickStats = (entity: Entity, source: string): Array<[string, string | number]> => {
  const entries = Object.entries(entity.stats);
  const pref = PREFERRED[source] ?? [];
  const ranked = [...entries].sort((a, b) => {
    const ai = pref.indexOf(a[0]);
    const bi = pref.indexOf(b[0]);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
  const numeric = ranked.filter(([, value]) => typeof value === "number");
  return (numeric.length > 0 ? numeric : ranked).slice(0, 2);
};

const formatValue = (label: string, value: string | number): string | number => {
  if (typeof value === "number") return value;
  if (label.includes("last")) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    }
  }
  return value.length > 14 ? `${value.slice(0, 13)}…` : value;
};

const bundleOk = (state: SnapshotState, source: string): boolean =>
  state.bundles.find((b) => b.source === source)?.ok ?? false;

function StaleDot({ source, active, interactive, onFilter }: { readonly source: EntitySource; readonly active: boolean; readonly interactive: boolean; readonly onFilter: (source: EntitySource) => void }) {
  const className = "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] uppercase tracking-[0.14em]";
  const style = { color: SOURCE_HUE[source], background: withAlpha(SOURCE_HUE[source] ?? "#8a8378", 0.08), border: `1px solid ${withAlpha(SOURCE_HUE[source] ?? "#8a8378", active ? 0.45 : 0.16)}` };
  if (!interactive) return <span className={className} style={style} title={`${source} — stale` }><span className="size-1.5 rounded-full bg-current opacity-60" />{source}</span>;
  return (
    <button
      type="button"
      className={`nodrag nopan ${className} transition hover:brightness-125`}
      aria-label={`Filter ${source} signals`}
      aria-pressed={active}
      style={{ color: SOURCE_HUE[source], background: withAlpha(SOURCE_HUE[source] ?? "#8a8378", 0.08), border: `1px solid ${withAlpha(SOURCE_HUE[source] ?? "#8a8378", active ? 0.45 : 0.16)}` }}
      title={`${source} — stale · filter source`}
      onClick={(event) => { event.stopPropagation(); onFilter(source); }}
    >
      <span className="size-1.5 rounded-full bg-current opacity-60" />
      {source}
    </button>
  );
}

function StatBadge({
  source,
  label,
  value,
  active,
  interactive,
  onFilter,
}: {
  readonly source: EntitySource;
  readonly label: string;
  readonly value: string | number;
  readonly active: boolean;
  readonly interactive: boolean;
  readonly onFilter: (source: EntitySource) => void;
}) {
  const hue = SOURCE_HUE[source] ?? "#8a8378";
  const className = "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-medium tracking-wide";
  const style = { color: hue, background: withAlpha(hue, active ? 0.17 : 0.1), border: `1px solid ${withAlpha(hue, active ? 0.55 : 0.22)}` };
  if (!interactive) return <span className={className} style={style} title={`${source} · ${label}`}><span className="tabular-nums">{value}</span><span className="opacity-60 uppercase tracking-[0.12em]">{label}</span></span>;
  return (
    <button
      type="button"
      className={`nodrag nopan ${className} transition hover:brightness-125`}
      aria-label={`Filter ${source} signals`}
      aria-pressed={active}
      style={{ color: hue, background: withAlpha(hue, active ? 0.17 : 0.1), border: `1px solid ${withAlpha(hue, active ? 0.55 : 0.22)}` }}
      title={`${source} · ${label} · filter source`}
      onClick={(event) => { event.stopPropagation(); onFilter(source); }}
    >
      <span className="tabular-nums">{value}</span>
      <span className="opacity-60 uppercase tracking-[0.12em]">{label}</span>
    </button>
  );
}

export function EntityBadges({
  entity,
  bindings,
  interactive = true,
}: {
  readonly entity: EtherEntity;
  readonly bindings: ReadonlyArray<EtherBinding> | undefined;
  readonly interactive?: boolean;
}) {
  const snapshots = use$(state$.snapshots);
  const sourceFilter = use$(state$.sourceFilter);
  const onFilter = (source: EntitySource) => toggleSourceFilter(source);

  return (
    <div className="mb-1.5 flex flex-wrap items-center gap-1">
      <span
        className="rounded-sm px-1.5 py-0.5 text-[9px] uppercase tracking-[0.16em]"
        style={{ color: "#EDE6DA", background: "rgba(237,230,218,0.07)", border: "1px solid rgba(237,230,218,0.14)" }}
      >
        {entity.kind}
      </span>
      {(bindings ?? []).map((binding, i) => {
        const source = binding.source;
        const entityRow = findEntity(snapshots, source, binding.ref.key);
        const ok = bundleOk(snapshots, source);
        if (!ok || !entityRow) return <StaleDot key={`${source}-${i}`} source={source} active={sourceFilter === source} interactive={interactive} onFilter={onFilter} />;
        const stats = pickStats(entityRow, source);
        if (stats.length === 0) return <StaleDot key={`${source}-${i}`} source={source} active={sourceFilter === source} interactive={interactive} onFilter={onFilter} />;
        return stats.map(([label, value]) => (
          <StatBadge key={`${source}-${label}`} source={source} label={label} value={formatValue(label, value)} active={sourceFilter === source} interactive={interactive} onFilter={onFilter} />
        ));
      })}
    </div>
  );
}
