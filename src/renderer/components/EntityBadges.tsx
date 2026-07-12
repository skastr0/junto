import { use$ } from "@legendapp/state/react";
import type { EtherBinding, EtherEntity } from "@shared/canvas";
import { findEntity } from "@shared/entities";
import type { Entity, SnapshotState } from "@shared/entities";
import { SOURCE_HUE, withAlpha } from "../lib/theme";
import { state$ } from "../lib/state";

// Preferred headline stat per source; falls back to the first stats entries.
const PREFERRED: Record<string, ReadonlyArray<string>> = {
  tower: ["glyphs", "active", "open"],
  quasar: ["sessions", "tool_calls"],
  booth: ["drafts", "pending"],
};

const pickStats = (entity: Entity, source: string): Array<[string, string | number]> => {
  const entries = Object.entries(entity.stats);
  const pref = PREFERRED[source] ?? [];
  const ranked = [...entries].sort((a, b) => {
    const ai = pref.indexOf(a[0]);
    const bi = pref.indexOf(b[0]);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
  return ranked.slice(0, 2);
};

const bundleOk = (state: SnapshotState, source: string): boolean =>
  state.bundles.find((b) => b.source === source)?.ok ?? false;

function StaleDot({ source }: { readonly source: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] uppercase tracking-[0.14em]"
      style={{ color: SOURCE_HUE[source], background: withAlpha(SOURCE_HUE[source] ?? "#8a8378", 0.08) }}
      title={`${source} — stale`}
    >
      <span className="size-1.5 rounded-full bg-current opacity-60" />
      {source}
    </span>
  );
}

function StatBadge({
  source,
  label,
  value,
}: {
  readonly source: string;
  readonly label: string;
  readonly value: string | number;
}) {
  const hue = SOURCE_HUE[source] ?? "#8a8378";
  return (
    <span
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-medium tracking-wide"
      style={{ color: hue, background: withAlpha(hue, 0.1), border: `1px solid ${withAlpha(hue, 0.22)}` }}
      title={`${source} · ${label}`}
    >
      <span className="tabular-nums">{value}</span>
      <span className="opacity-60 uppercase tracking-[0.12em]">{label}</span>
    </span>
  );
}

export function EntityBadges({
  entity,
  bindings,
}: {
  readonly entity: EtherEntity;
  readonly bindings: ReadonlyArray<EtherBinding> | undefined;
}) {
  const snapshots = use$(state$.snapshots);

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
        if (!ok || !entityRow) return <StaleDot key={`${source}-${i}`} source={source} />;
        const stats = pickStats(entityRow, source);
        if (stats.length === 0) return <StaleDot key={`${source}-${i}`} source={source} />;
        return stats.map(([label, value]) => (
          <StatBadge key={`${source}-${label}`} source={source} label={label} value={value} />
        ));
      })}
    </div>
  );
}
