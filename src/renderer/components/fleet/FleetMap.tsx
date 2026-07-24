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
  discoveryLayout,
  ditherPixelSize,
  FLEET_DITHER_LEVELS,
  orbitLayout,
  type FleetDitherLevel,
  type FleetEdgeStatus,
} from "../../lib/fleet-layout";
import { activateOnPointerUp } from "../../lib/pointer-activation";
import {
  fleetNodeTypes,
  type CommandCenterFlowNode,
  type DiscoveryBandFlowNode,
  type GhostStationFlowNode,
  type StationFlowNode,
} from "./FleetNodes";

export const COMMAND_CENTER_ID = "command-center";

type FleetFlowNode =
  | CommandCenterFlowNode
  | DiscoveryBandFlowNode
  | StationFlowNode
  | GhostStationFlowNode;

export const ghostNodeId = (peer: DiscoveredPeer): string => `ghost:${peer.name}`;

type FleetLinkData = {
  readonly status: FleetEdgeStatus;
  readonly latencyMs?: number;
  readonly emphasized?: boolean;
  readonly routeIndex: number;
};
type FleetLinkEdgeType = Edge<FleetLinkData, "fleetLink">;

interface NodeGeometry {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const nodeGeometry = (
  node: NonNullable<ReturnType<typeof useInternalNode>>,
): NodeGeometry => {
  const width = node.measured?.width ?? 1;
  const height = node.measured?.height ?? 1;
  return {
    x: node.internals.positionAbsolute.x + width / 2,
    y: node.internals.positionAbsolute.y + height / 2,
    width,
    height,
  };
};

const boundaryPoint = (
  from: NodeGeometry,
  toward: NodeGeometry,
): { x: number; y: number } => {
  const dx = toward.x - from.x;
  const dy = toward.y - from.y;
  const halfWidth = Math.max(from.width / 2 - 12, 1);
  const halfHeight = Math.max(from.height / 2 - 18, 1);
  const scale = 1 / Math.max(Math.abs(dx) / halfWidth, Math.abs(dy) / halfHeight, 0.001);
  return { x: from.x + dx * scale, y: from.y + dy * scale };
};

/** Perimeter-to-perimeter route. A shallow deterministic curve separates
 * neighboring spokes without making reachability look directional. */
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
  const sourceGeometry = nodeGeometry(sourceNode);
  const targetGeometry = nodeGeometry(targetNode);
  const s = boundaryPoint(sourceGeometry, targetGeometry);
  const t = boundaryPoint(targetGeometry, sourceGeometry);
  const dx = t.x - s.x;
  const dy = t.y - s.y;
  const distance = Math.max(Math.hypot(dx, dy), 1);
  const ux = dx / distance;
  const uy = dy / distance;
  const nx = -uy;
  const ny = ux;
  const bendDirection = (data?.routeIndex ?? 0) % 2 === 0 ? 1 : -1;
  const bend = Math.min(18, distance * 0.055) * bendDirection;
  const controlDistance = distance * 0.34;
  const path = [
    `M ${s.x} ${s.y}`,
    `C ${s.x + ux * controlDistance + nx * bend} ${s.y + uy * controlDistance + ny * bend}`,
    `${t.x - ux * controlDistance + nx * bend} ${t.y - uy * controlDistance + ny * bend}`,
    `${t.x} ${t.y}`,
  ].join(" ");
  const emphasized = data?.emphasized ?? false;
  return (
    <>
      <BaseEdge
        id={`${id}-underlay`}
        path={path}
        style={{
          stroke: "var(--color-ground)",
          strokeWidth: phase.width + (emphasized ? 6 : 4.5),
          opacity: 0.96,
        }}
        className="fleet-link__underlay"
      />
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke: phase.hue,
          strokeWidth: phase.width + (emphasized ? 0.8 : 0),
          strokeDasharray: phase.dash ?? undefined,
          opacity: emphasized ? 1 : status === "unknown" ? 0.48 : 0.82,
        }}
        className={`fleet-link${phase.animated ? " fleet-link--probing" : ""}`}
      />
      <circle
        cx={t.x}
        cy={t.y}
        r={emphasized ? 4.2 : 3.2}
        fill={phase.hue}
        stroke="var(--color-ground)"
        strokeWidth={2}
        className="fleet-link__terminal"
      />
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
  ditherLevel,
  onDitherLevelChange,
}: {
  readonly hosts: ReadonlyArray<RemoteHost>;
  readonly peers: ReadonlyArray<DiscoveredPeer>;
  readonly probes: Record<string, FleetProbeState>;
  readonly ccHostId: string;
  readonly selectedId: string | null;
  readonly onSelect: (id: string | null) => void;
  readonly ditherLevel: FleetDitherLevel;
  readonly onDitherLevelChange: (level: FleetDitherLevel) => void;
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
    const resolvedDitherPixelSize = ditherPixelSize(ditherLevel);
    const stationRight = stationIds.reduce(
      (max, id) => Math.max(max, positions[id]?.x ?? 0),
      0,
    );
    const discoveryStartX = stationRight + 390;
    const ghostIds = peers.map(ghostNodeId);
    const ghostPositions = discoveryLayout(ghostIds, discoveryStartX);
    const ghostColumns = Math.max(1, Math.ceil(peers.length / 4));
    const ghostYs = Object.values(ghostPositions).map((position) => position.y);
    const ghostMinY = ghostYs.length > 0 ? Math.min(...ghostYs) : 0;
    const ghostMaxY = ghostYs.length > 0 ? Math.max(...ghostYs) : 0;
    const cc: CommandCenterFlowNode = {
      id: COMMAND_CENTER_ID,
      type: "commandCenter",
      position: { x: 0, y: 0 },
      data: {
        hostId: ccHostId,
        ditherPixelSize: resolvedDitherPixelSize,
        onSelect: () => onSelect(COMMAND_CENTER_ID),
      },
      ariaLabel: `Command Center${ccHostId ? `, host ${ccHostId}` : ""}`,
      selected: selectedId === COMMAND_CENTER_ID,
      draggable: false,
      connectable: false,
    };
    const orbits: Array<StationFlowNode> = stations.map((host) => ({
      id: host.id,
      type: "station",
      position: positions[host.id] ?? { x: 0, y: 0 },
      data: {
        host,
        probe: probes[host.id],
        ditherPixelSize: resolvedDitherPixelSize,
        onSelect: () => onSelect(host.id),
      },
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
      data: {
        peer,
        ditherPixelSize: resolvedDitherPixelSize,
        onSelect: () => onSelect(ghostNodeId(peer)),
      },
      ariaLabel: `${peer.name}, ${peer.os ?? "unknown device"}, discovered but not enrolled`,
      selected: selectedId === ghostNodeId(peer),
      draggable: false,
      connectable: false,
    }));
    const discoveryBand: DiscoveryBandFlowNode | undefined =
      peers.length > 0
        ? {
            id: "mesh-discovery-band",
            type: "discoveryBand",
            position: { x: discoveryStartX - 36, y: ghostMinY - 72 },
            data: { count: peers.length },
            style: {
              width: (ghostColumns - 1) * 230 + 262,
              height: ghostMaxY - ghostMinY + 286,
              zIndex: -1,
            },
            selectable: false,
            focusable: false,
            draggable: false,
            connectable: false,
          }
        : undefined;
    return [cc, ...(discoveryBand ? [discoveryBand] : []), ...orbits, ...ghosts];
  }, [stations, peers, probes, ccHostId, selectedId, ditherLevel, onSelect]);

  const edges = useMemo<ReadonlyArray<FleetLinkEdgeType>>(() => {
    const links: Array<FleetLinkEdgeType> = stations.map((host, routeIndex) => {
      const probe = probes[host.id];
      const status: FleetEdgeStatus = probe?.status ?? "unknown";
      return {
        id: `fleet-${host.id}`,
        source: COMMAND_CENTER_ID,
        target: host.id,
        type: "fleetLink",
        data: {
          status,
          routeIndex,
          emphasized: selectedId === host.id || selectedId === COMMAND_CENTER_ID,
          ...(probe?.status === "reachable" && probe.latencyMs !== undefined
            ? { latencyMs: probe.latencyMs }
            : {}),
        },
        selectable: false,
        focusable: false,
      } satisfies FleetLinkEdgeType;
    });
    return links;
  }, [stations, probes, selectedId]);

  return (
    <div
      className="fleet-map__flow"
      onPointerUp={(event) => {
        if (
          event.button === 0 &&
          event.target instanceof Element &&
          event.target.classList.contains("react-flow__pane")
        ) {
          onSelect(null);
        }
      }}
    >
    <ReactFlow
      key={topologyKey}
      nodes={nodes as Array<FleetFlowNode>}
      edges={edges as Array<Edge>}
      nodeTypes={fleetNodeTypes}
      edgeTypes={fleetEdgeTypes}
      onNodeClick={(event, node) => {
        if (event.detail === 0 && node.type !== "discoveryBand") onSelect(node.id);
      }}
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
      <div
        className="fleet-map__dither"
        role="group"
        aria-label="Dither detail"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <span>dither</span>
        {FLEET_DITHER_LEVELS.map((level) => (
          <button
            key={level.id}
            type="button"
            className={level.id === ditherLevel ? "is-active" : undefined}
            aria-pressed={level.id === ditherLevel}
            {...activateOnPointerUp(() => onDitherLevelChange(level.id))}
          >
            {level.label}
          </button>
        ))}
      </div>
      <div className="fleet-map__legend" aria-label="Fleet route states">
        <span><i className="fleet-pip--reachable" />reachable</span>
        <span><i className="fleet-pip--probing" />checking</span>
        <span><i className="fleet-pip--unreachable" />unreachable</span>
        <span><i className="fleet-pip--unknown" />untested</span>
      </div>
      <div className="fleet-map__hint">drag to pan · scroll to zoom · select a machine to inspect</div>
    </ReactFlow>
    </div>
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
