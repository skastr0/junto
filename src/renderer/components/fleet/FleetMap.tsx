import { useMemo } from "react";
import {
  BaseEdge,
  ReactFlow,
  ReactFlowProvider,
  useInternalNode,
  type Edge,
  type EdgeProps,
  type EdgeTypes,
} from "@xyflow/react";
import type { DiscoveredPeer } from "@shared/ipc";
import type { RemoteHost } from "@shared/remote-hosts";
import type { FleetProbeState } from "../../lib/fleet-state";
import {
  edgePhase,
  ORBIT_BASE_RADIUS,
  orbitLayout,
  type FleetEdgeStatus,
} from "../../lib/fleet-layout";
import {
  fleetNodeTypes,
  type CommandCenterFlowNode,
  type GhostStationFlowNode,
  type StationFlowNode,
} from "./FleetNodes";

export const COMMAND_CENTER_ID = "command-center";

type FleetFlowNode = CommandCenterFlowNode | StationFlowNode | GhostStationFlowNode;

export const ghostNodeId = (peer: DiscoveredPeer): string => `ghost:${peer.name}`;

type FleetLinkData = {
  readonly status: FleetEdgeStatus;
  readonly latencyMs?: number;
  /** Unclaimed-peer link — rendered as a whisper, never labeled. */
  readonly ghost?: boolean;
};
type FleetLinkEdgeType = Edge<FleetLinkData, "fleetLink">;

const nodeCenter = (
  node: NonNullable<ReturnType<typeof useInternalNode>>,
): { x: number; y: number } => {
  const width = node.measured?.width ?? 0;
  const height = node.measured?.height ?? 0;
  return {
    x: node.internals.positionAbsolute.x + width / 2,
    y: node.internals.positionAbsolute.y + height / 2,
  };
};

/** Straight machine-to-machine route. The dark underlay separates topology
 * from the field without inventing strength or direction. */
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
  const s = nodeCenter(sourceNode);
  const t = nodeCenter(targetNode);
  const path = `M ${s.x} ${s.y} L ${t.x} ${t.y}`;
  const midX = (s.x + t.x) / 2;
  const midY = (s.y + t.y) / 2;
  return (
    <>
      <BaseEdge
        id={`${id}-underlay`}
        path={path}
        style={{
          stroke: "var(--color-ground)",
          strokeWidth: phase.width + 4,
          opacity: 0.92,
        }}
        className="fleet-link__underlay"
      />
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke: phase.hue,
          strokeWidth: phase.width,
          strokeDasharray: phase.dash ?? undefined,
          opacity: data?.ghost ? 0.28 : status === "unknown" ? 0.5 : 0.88,
        }}
        className={`fleet-link${phase.animated ? " fleet-link--probing" : ""}`}
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
  peers,
  probes,
  ccHostId,
  selectedId,
  onSelect,
}: {
  readonly hosts: ReadonlyArray<RemoteHost>;
  readonly peers: ReadonlyArray<DiscoveredPeer>;
  readonly probes: Record<string, FleetProbeState>;
  readonly ccHostId: string;
  readonly selectedId: string | null;
  readonly onSelect: (id: string | null) => void;
}) {
  const stations = useMemo(() => hosts.filter((host) => host.kind === "remote"), [hosts]);
  const topologyKey = useMemo(
    () =>
      [
        ...stations.map((host) => `station:${host.id}`),
        ...peers.map((peer) => `peer:${peer.name}`),
      ]
        .sort()
        .join("|"),
    [stations, peers],
  );

  const nodes = useMemo<ReadonlyArray<FleetFlowNode>>(() => {
    const stationIds = stations.map((host) => host.id);
    const positions = orbitLayout(stationIds);
    // Unclaimed peers orbit one ring beyond the outermost station orbit.
    const outerOrbit = stationIds.reduce((max, id) => {
      const p = positions[id];
      return p ? Math.max(max, Math.round(Math.hypot(p.x, p.y) / ORBIT_BASE_RADIUS)) : max;
    }, 0);
    const ghostPositions = orbitLayout(peers.map(ghostNodeId), outerOrbit);
    const cc: CommandCenterFlowNode = {
      id: COMMAND_CENTER_ID,
      type: "commandCenter",
      position: { x: 0, y: 0 },
      data: { hostId: ccHostId },
      ariaLabel: `Command Center${ccHostId ? `, host ${ccHostId}` : ""}`,
      selected: selectedId === COMMAND_CENTER_ID,
      draggable: false,
      connectable: false,
    };
    const orbits: Array<StationFlowNode> = stations.map((host) => ({
      id: host.id,
      type: "station",
      position: positions[host.id] ?? { x: 0, y: 0 },
      data: { host, probe: probes[host.id] },
      ariaLabel: `${host.label}, enrolled station, ${
        probes[host.id]?.status ?? "link untested"
      }`,
      selected: selectedId === host.id,
      draggable: false,
      connectable: false,
    }));
    const ghosts: Array<GhostStationFlowNode> = peers.map((peer) => ({
      id: ghostNodeId(peer),
      type: "ghost",
      position: ghostPositions[ghostNodeId(peer)] ?? { x: 0, y: 0 },
      data: { peer },
      ariaLabel: `${peer.name}, ${peer.os ?? "unknown device"}, discovered but not enrolled`,
      selected: selectedId === ghostNodeId(peer),
      draggable: false,
      connectable: false,
    }));
    return [cc, ...orbits, ...ghosts];
  }, [stations, peers, probes, ccHostId, selectedId]);

  const edges = useMemo<ReadonlyArray<FleetLinkEdgeType>>(() => {
    const links: Array<FleetLinkEdgeType> = stations.map((host) => {
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
    // Detected-but-unclaimed peers get a whisper of a link: seen, not enrolled.
    for (const peer of peers) {
      links.push({
        id: `fleet-${ghostNodeId(peer)}`,
        source: COMMAND_CENTER_ID,
        target: ghostNodeId(peer),
        type: "fleetLink",
        data: { status: "unknown", ghost: true },
        selectable: false,
        focusable: false,
      } satisfies FleetLinkEdgeType);
    }
    return links;
  }, [stations, peers, probes]);

  return (
    <ReactFlow
      key={topologyKey}
      nodes={nodes as Array<FleetFlowNode>}
      edges={edges as Array<Edge>}
      nodeTypes={fleetNodeTypes}
      edgeTypes={fleetEdgeTypes}
      onNodeClick={(_, node) => onSelect(node.id)}
      onPaneClick={() => onSelect(null)}
      fitView
      fitViewOptions={{ padding: 0.25, maxZoom: 1.2 }}
      minZoom={0.3}
      maxZoom={1.6}
      panOnDrag
      zoomOnScroll
      nodesDraggable={false}
      nodesConnectable={false}
      edgesFocusable={false}
      nodesFocusable
      proOptions={{ hideAttribution: true }}
    >
      <div className="fleet-map__context" role="status">
        <span>Command Center routes</span>
        <span>
          {stations.length} enrolled · {peers.length} visible on mesh
        </span>
      </div>
      <div className="fleet-map__legend" aria-label="Fleet route states">
        <span><i className="fleet-pip--reachable" />reachable</span>
        <span><i className="fleet-pip--probing" />checking</span>
        <span><i className="fleet-pip--unreachable" />unreachable</span>
        <span><i className="fleet-pip--unknown" />untested</span>
      </div>
      <div className="fleet-map__hint">drag to pan · scroll to zoom · select a machine to inspect</div>
    </ReactFlow>
  );
}

/** Fleet topology: Command Center core, enrolled stations, and visible peers. */
export function FleetMap(props: Parameters<typeof FleetMapInner>[0]) {
  return (
    <ReactFlowProvider>
      <FleetMapInner {...props} />
    </ReactFlowProvider>
  );
}
