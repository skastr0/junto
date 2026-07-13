import type { SnapshotState } from "@shared/entities";

export interface PulseItem {
  id: string;
  source: string;
  text: string;
  at: number;
}

/**
 * Compares two snapshot states and emits meaningful deltas.
 * - For entities in both prev and next (matched by source+key), compare numeric stats
 * - Track source ok:false → ok:true (came back online) or true → false (went stale)
 * - Ignore first-ever snapshots (no prev bundle for that source)
 * - Each item has {id, source, text, at: Date.now()}
 */
export function comparePulse(prev: SnapshotState | null, next: SnapshotState): PulseItem[] {
  const items: PulseItem[] = [];

  if (!prev) {
    // First-ever snapshot: suppress pulse items, but allow status flips
    // Actually, if prev is null, there's no previous state to flip from,
    // so just return empty.
    return items;
  }

  const prevBundlesBySource = new Map(prev.bundles.map((b) => [b.source, b]));
  const nextBundlesBySource = new Map(next.bundles.map((b) => [b.source, b]));

  // Check each source for ok status flip
  for (const [source, nextBundle] of nextBundlesBySource.entries()) {
    const prevBundle = prevBundlesBySource.get(source);
    if (!prevBundle) continue;

    // Check ok:false → ok:true (came back online)
    if (!prevBundle.ok && nextBundle.ok) {
      items.push({
        id: `${source}-online-${Date.now()}`,
        source,
        text: `${source} back online`,
        at: Date.now(),
      });
    }

    // Check ok:true → ok:false (went stale)
    if (prevBundle.ok && !nextBundle.ok) {
      items.push({
        id: `${source}-offline-${Date.now()}`,
        source,
        text: `${source} went stale`,
        at: Date.now(),
      });
    }
  }

  // For entities: compare stats
  for (const [source, nextBundle] of nextBundlesBySource.entries()) {
    if (!nextBundle.ok) continue; // Skip broken bundles

    const prevBundle = prevBundlesBySource.get(source);
    if (!prevBundle) continue; // Skip if no prior bundle for this source (first snapshot for this source)

    const nextEntitiesByKey = new Map(nextBundle.entities.map((e) => [e.key, e]));
    const prevEntitiesByKey = new Map(prevBundle.entities.map((e) => [e.key, e]));

    // For entities present in both
    for (const [key, nextEntity] of nextEntitiesByKey.entries()) {
      const prevEntity = prevEntitiesByKey.get(key);
      if (!prevEntity) continue;

      // Compare numeric stats
      for (const [statKey, nextValue] of Object.entries(nextEntity.stats)) {
        const prevValue = prevEntity.stats[statKey];
        if (prevValue === undefined) continue;

        const prevNum = typeof prevValue === "number" ? prevValue : parseFloat(String(prevValue));
        const nextNum = typeof nextValue === "number" ? nextValue : parseFloat(String(nextValue));

        if (!Number.isFinite(prevNum) || !Number.isFinite(nextNum)) continue;
        if (prevNum === nextNum) continue;

        const delta = nextNum - prevNum;
        const deltaStr = delta > 0 ? `+${delta}` : `${delta}`;
        const title = nextEntity.title || key;

        items.push({
          id: `${source}-${key}-${statKey}-${Date.now()}`,
          source,
          text: `${title} · ${statKey} ${deltaStr}`,
          at: Date.now(),
        });
      }
    }
  }

  return items;
}
