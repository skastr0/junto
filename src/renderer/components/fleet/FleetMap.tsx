import { useMemo } from "react";
import {
  BaseEdge,
  ReactFlow,
  ReactFlowProvider,
  useInternalNode,
  type Edge,
  type EdgeProps,
  type EdgeTypes,
  type InternalNode,
} from "@xyflow/react";
import type { RemoteHost } from "@shared/remote-hosts";
import type { FleetProbeState } from "../../lib/fleet-state";
import { edgePhase, orbitLayout, type FleetEdgeStatus } from "../../lib/fleet-layout";
import {
  fleetNodeTypes,
  type CommandCenterFlowNode,
  type StationFlowNode,
} from "./FleetNodes";

export const COMMAND_CENTER_ID = "command-center";

type FleetFlowNode = CommandCenterFlowNode | StationFlowNode;

type FleetLinkData = {
  readonly status: FleetEdgeStatus;
  readonly latencyMs?: number;
};
type FleetLinkEdgeType = Edge<FleetLinkData, "fleetLink">;

/** Medallion radii (FleetNodes: CC 84px, station 64px) — the medallion is the
 * first, horizontally-centered child of the node, so its center is
 * (node.x + width/2, node.y + radius). Handle measurement is not trustworthy
 * here (CSS transforms are invisible to it), so compute from node internals. */
const MEDALLION_RADIUS: Record<string, number> = {
  commandCenter: 42,
  station: 32,
};

const medallionCenter = (node: InternalNode): { x: number; y: number } => {
  const radius = MEDALLION_RADIUS[node.type ?? "station"] ?? 32;
  const width = node.measured?.width ?? 0;
  return {
    x: node.internals.positionAbsolute.x + width / 2,
    y: node.internals.positionAbsolute.y + radius,
  };
};

/** Straight medallion-to-medallion link line. Status drives hue, dash, and
 * the probing animation — never invented state. */
function FleetLinkEdge({
  id,
  source,
  target,
  data,
}: EdgeProps<FleetLinkEdgeType>) {
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  const status = data?.status ?? "unknown";
  const phase = edgePhase(status);
  if (!sourceNode || !targetNode) return null;
  const s = medallionCenter(sourceNode);
  const t = medallionCenter(targetNode);
  const path = `M ${s.x} ${s.y} L ${t.x} ${t.y}`;
  const midX = (s.x + t.x) / 2;
  const midY = (s.y + t.y) / 2;
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke: phase.hue,
          strokeWidth: phase.width,
          strokeDasharray: phase.dash ?? undefined,
          opacity: status === "unknown" ? 0.45 : 0.8,
        }}
        className={phase.animated ? "fleet-link--probing" : undefined}
      />
      {status === "reachable" && data?.latencyMs !== undefined ? (
        <text x={midX} y={midY - 7} textAnchor="middle" className="fleet-link__label">
          {`${data.latencyMs} ms`}
        </text>
      ) : null}
    </>
  );
}

const fleetEdgeTypes: EdgeTypes = { fleetLink: FleetLinkEdge };

function FleetMapInner({
  hosts,
  probes,
  ccHostId,
  selectedId,
  onSelect,
}: {
  readonly hosts: ReadonlyArray<RemoteHost>;
  readonly probes: Record<string, FleetProbeState>;
  readonly ccHostId: string;
  readonly selectedId: string | null;
  readonly onSelect: (id: string | null) => void;
}) {
  const stations = useMemo(() => hosts.filter((host) => host.kind === "remote"), [hosts]);

  const nodes = useMemo<ReadonlyArray<FleetFlowNode>>(() => {
    const positions = orbitLayout(stations.map((host) => host.id));
    const cc: CommandCenterFlowNode = {
      id: COMMAND_CENTER_ID,
      type: "commandCenter",
      position: { x: 0, y: 0 },
      data: { hostId: ccHostId },
      selected: selectedId === COMMAND_CENTER_ID,
      draggable: false,
      connectable: false,
    };
    const orbits: Array<StationFlowNode> = stations.map((host) => ({
      id: host.id,
      type: "station",
      position: positions[host.id] ?? { x: 0, y: 0 },
      data: { host, probe: probes[host.id] },
      selected: selectedId === host.id,
      draggable: false,
      connectable: false,
    }));
    return [cc, ...orbits];
  }, [stations, probes, ccHostId, selectedId]);

  const edges = useMemo<ReadonlyArray<FleetLinkEdgeType>>(() => {
    return stations.map((host) => {
      const probe = probes[host.id];
      const status: FleetEdgeStatus = probe?.status ?? "unknown";
      return {
        id: `fleet-${host.id}`,
        source: COMMAND_CENTER_ID,
        target: host.id,
        type: "fleetLink",
        data: {
          status,
          ...(probe?.status === "reachable" && probe.latencyMs !== undefined
            ? { latencyMs: probe.latencyMs }
            : {}),
        },
        selectable: false,
        focusable: false,
      } satisfies FleetLinkEdgeType;
    });
  }, [stations, probes]);

  return (
    <ReactFlow
      nodes={nodes as Array<FleetFlowNode>}
      edges={edges as Array<Edge>}
      nodeTypes={fleetNodeTypes}
      edgeTypes={fleetEdgeTypes}
      onNodeClick={(_, node) => onSelect(node.id)}
      onPaneClick={() => onSelect(null)}
      fitView
      fitViewOptions={{ padding: 0.28, maxZoom: 1.1 }}
      minZoom={0.3}
      maxZoom={1.6}
      panOnDrag
      zoomOnScroll
      nodesDraggable={false}
      nodesConnectable={false}
      edgesFocusable={false}
      proOptions={{ hideAttribution: true }}
    />
  );
}

/** The star map: Command Center core + orbiting station nodes over the starfield. */
export function FleetMap(props: Parameters<typeof FleetMapInner>[0]) {
  return (
    <ReactFlowProvider>
      <FleetMapInner {...props} />
    </ReactFlowProvider>
  );
}
