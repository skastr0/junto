import type { ClusterBubble, ClusterItem, WorldRect } from "./types";

// Map-style proximity clustering. This is a grid-bucket clusterer — the same
// shape map libraries use at each zoom level: snap every item to a fixed cell,
// items sharing a cell become one bubble. It is O(n), fully deterministic
// (bucket keys and labels are sorted), and cheap enough to run over thousands
// of items every time the far tier is entered. The cell size is world-space,
// so at the far tier's low zoom a ~900px cell reads as a comfortably spaced
// bubble field.

export const DEFAULT_CLUSTER_CELL = 900;

const unionRect = (a: WorldRect, b: WorldRect): WorldRect => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
};

// Up to three dominant labels, ranked by item weight then alphabetically so
// the same cluster always shows the same labels in the same order.
const dominantLabels = (items: ReadonlyArray<ClusterItem>): string[] =>
  [...items]
    .sort((a, b) => b.weight - a.weight || a.label.localeCompare(b.label))
    .map((item) => item.label)
    .filter((label, index, all) => label.length > 0 && all.indexOf(label) === index)
    .slice(0, 3);

export const clusterItems = (
  items: ReadonlyArray<ClusterItem>,
  cell: number = DEFAULT_CLUSTER_CELL,
): ClusterBubble[] => {
  if (items.length === 0) return [];
  const size = cell > 0 ? cell : DEFAULT_CLUSTER_CELL;
  const buckets = new Map<string, ClusterItem[]>();
  for (const item of items) {
    const key = `${Math.floor(item.cx / size)}:${Math.floor(item.cy / size)}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, bucket]) => {
      let sumX = 0;
      let sumY = 0;
      let weight = 0;
      let regionCount = 0;
      let looseCount = 0;
      let extent = bucket[0]!.rect;
      for (const item of bucket) {
        // Centroid weighted by item weight so a big region anchors the bubble.
        sumX += item.cx * item.weight;
        sumY += item.cy * item.weight;
        weight += item.weight;
        if (item.kind === "region") regionCount += 1;
        else looseCount += 1;
        extent = unionRect(extent, item.rect);
      }
      return {
        id: `cl:${key}`,
        cx: sumX / weight,
        cy: sumY / weight,
        count: bucket.length,
        weight,
        regionCount,
        looseCount,
        labels: dominantLabels(bucket),
        // Sorted so a bubble is a canonical set — its output is identical
        // regardless of the order items arrived in.
        memberIds: bucket.map((item) => item.id).sort(),
        extent,
      } satisfies ClusterBubble;
    });
};
