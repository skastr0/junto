import { useEffect, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { useReactFlow, useStoreApi, ViewportPortal } from "@xyflow/react";
import { canvasTier$ } from "../lib/canvas-tier";
import type { FlowEdge, FlowNode } from "../lib/convert";
import { AGENT_NODE_SIZE } from "../lib/node-geometry";
import { nodeTitle } from "../lib/presentation";
import {
  buildClusterIndex,
  clustersOf,
  linksHeldAt,
  type ClusterIndex,
  type ClusterSeat,
  type SeatCluster,
} from "../lib/seat-clusters";
import { AgentPortrait } from "./AgentPortrait";

/**
 * Seat clusters at the overview tier (seat-clusters.ts). Every agent stays on
 * the board however far the camera pulls back; where seats sit closer than a
 * floor-size ring, they gather into one badge the size of a seat: a portrait
 * on a stack of rings, and a count. Hover lists them (click one to select it); click the badge and the
 * camera comes in until they part. A seat that needs the operator, and a
 * selected seat, is never gathered.
 *
 * Membership is recomputed when the board, a seat's ring or the selection
 * changes, and on zoom only when the number of links held changes: most
 * zoom frames do no work. Gathered seats are hidden by one generated style
 * rule, so a remounted node stays hidden without a render.
 *
 * Must be mounted inside <ReactFlow>.
 */

const STYLE_ID = "junto-seat-clusters";
/** Rings that mean the seat needs the operator: needs input, waiting on you, blocked. */
const NEEDS_YOU: ReadonlySet<string> = new Set(["call", "wait", "halt"]);

type Seen = {
  readonly clusters: ReadonlyArray<SeatCluster>;
  readonly rings: ReadonlyMap<string, string>;
};

const EMPTY: Seen = { clusters: [], rings: new Map() };

const writeHidden = (ids: ReadonlyArray<string>): void => {
  if (typeof document === "undefined") return;
  let el = document.getElementById(STYLE_ID);
  if (ids.length === 0) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  const selectors = ids.map((id) => `html[data-canvas-tier="overview"] .react-flow__node[data-id="${CSS.escape(id)}"]`);
  el.textContent = `${selectors.join(",\n")} { visibility: hidden !important; }`;
};

type Store = ReturnType<typeof useStoreApi<FlowNode, FlowEdge>>;

/** Every agent seat's ring centre and region, its ring, and which seats stay apart. */
const readSeats = (
  store: Store,
): { seats: ClusterSeat[]; rings: Map<string, string>; apart: Set<string> } => {
  const { nodeLookup, domNode } = store.getState();
  const rings = new Map<string, string>();
  domNode?.querySelectorAll<HTMLElement>(".react-flow__node.junto-flow-agent").forEach((el) => {
    const id = el.getAttribute("data-id");
    const ring = el.querySelector('.junto-mark[data-mark-size="seat"]')?.getAttribute("data-mark-ring");
    if (id && ring) rings.set(id, ring);
  });
  const seats: ClusterSeat[] = [];
  const apart = new Set<string>();
  for (const node of nodeLookup.values()) {
    const region = node.data.seatRegion;
    if (region === undefined) continue;
    const at = node.internals.positionAbsolute;
    const width = node.measured.width ?? AGENT_NODE_SIZE.width;
    const height = node.measured.height ?? AGENT_NODE_SIZE.height;
    seats.push({ id: node.id, x: at.x + width / 2, y: at.y + height / 2, region });
    if (node.selected || NEEDS_YOU.has(rings.get(node.id) ?? "")) apart.add(node.id);
  }
  return { seats, rings, apart };
};

function ClusterBadge({ cluster, rings }: { readonly cluster: SeatCluster; readonly rings: ReadonlyMap<string, string> }) {
  const store = useStoreApi<FlowNode, FlowEdge>();
  const rf = useReactFlow<FlowNode, FlowEdge>();
  const count = cluster.members.length;
  const nameOf = (id: string): string => {
    const node = store.getState().nodeLookup.get(id)?.data.node;
    return node ? nodeTitle(node) : id;
  };
  const busiest = cluster.members.some((id) => rings.get(id) === "work")
    ? "work"
    : cluster.members.some((id) => rings.get(id) === "done")
      ? "done"
      : "rest";
  return (
    <div
      className="junto-seat-cluster nopan"
      data-testid="seat-cluster"
      data-cluster-count={count}
      data-cluster-state={busiest}
      style={{ transform: `translate(${String(cluster.x)}px, ${String(cluster.y)}px)` }}
    >
      <div className="junto-seat-cluster__body">
        <button
          type="button"
          className="junto-seat-cluster__stack"
          aria-label={`${String(count)} seats, show them apart`}
          title={`${String(count)} seats, show them apart`}
          onClick={(event) => {
            event.stopPropagation();
            const zoom = Math.min(1, Math.max(store.getState().transform[2], cluster.partsAt * 1.08));
            void rf.setCenter(cluster.x, cluster.y, { zoom, duration: 260 });
          }}
        >
          <span className="junto-seat-cluster__face">
            <AgentPortrait identity={cluster.members[0]!} size={34} frame="round" outline={false} />
          </span>
          <span className="junto-seat-cluster__count">{count}</span>
        </button>
        <div className="junto-seat-cluster__list" role="list" aria-label="Seats here">
          {cluster.members.map((id) => (
            <button
              key={id}
              type="button"
              role="listitem"
              className="junto-seat-cluster__member"
              data-testid="seat-cluster-member"
              data-seat-id={id}
              data-ring={rings.get(id) ?? "rest"}
              onClick={(event) => {
                event.stopPropagation();
                store.getState().addSelectedNodes([id]);
              }}
            >
              <AgentPortrait identity={id} size={20} frame="round" outline={false} />
              <span className="junto-seat-cluster__name">{nameOf(id)}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function SeatClusterLayer() {
  const store = useStoreApi<FlowNode, FlowEdge>();
  const tier = use$(canvasTier$);
  const [seen, setSeen] = useState<Seen>(EMPTY);

  useEffect(() => {
    if (tier !== "overview") {
      writeHidden([]);
      setSeen(EMPTY);
      return;
    }
    let index: ClusterIndex = { seats: new Map(), links: [] };
    let rings: ReadonlyMap<string, string> = new Map();
    let held = -1;
    let frame = 0;
    const regroup = (force: boolean): void => {
      const next = linksHeldAt(index, store.getState().transform[2]);
      if (!force && next === held) return;
      held = next;
      const clusters = clustersOf(index, held);
      writeHidden(clusters.flatMap((cluster) => cluster.members));
      setSeen({ clusters, rings });
    };
    const rebuild = (): void => {
      const read = readSeats(store);
      index = buildClusterIndex(read.seats, read.apart);
      rings = read.rings;
      regroup(true);
    };
    const schedule = (): void => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        rebuild();
      });
    };
    rebuild();
    let nodes = store.getState().nodes;
    let zoom = store.getState().transform[2];
    const unsubscribe = store.subscribe((state) => {
      if (state.nodes !== nodes) {
        nodes = state.nodes;
        schedule();
      }
      if (state.transform[2] !== zoom) {
        zoom = state.transform[2];
        regroup(false);
      }
    });
    // A seat that comes to need the operator leaves its cluster at once.
    const observer = new MutationObserver(schedule);
    const root = store.getState().domNode;
    if (root) observer.observe(root, { subtree: true, attributes: true, attributeFilter: ["data-mark-ring"] });
    return () => {
      unsubscribe();
      observer.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
      writeHidden([]);
    };
  }, [store, tier]);

  if (seen.clusters.length === 0) return null;
  return (
    <ViewportPortal>
      {seen.clusters.map((cluster) => (
        <ClusterBadge key={cluster.key} cluster={cluster} rings={seen.rings} />
      ))}
    </ViewportPortal>
  );
}
