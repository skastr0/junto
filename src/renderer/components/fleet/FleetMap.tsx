import { useMemo } from "react";
import { ReactFlow, ReactFlowProvider, type Edge } from "@xyflow/react";
import type { RemoteHost } from "@shared/remote-hosts";
import type { FleetProbeState } from "../../lib/fleet-state";
import { edgePhase, orbitLayout, type FleetEdgeStatus } from "../../lib/fleet-layout";
import { FAINT } from "../../lib/theme";
import {
  fleetNodeTypes,
  type CommandCenterFlowNode,
  type StationFlowNode,
} from "./FleetNodes";

export const COMMAND_CENTER_ID = "command-center";

type FleetFlowNode = CommandCenterFlowNode | StationFlowNode;

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
  const nodes = useMemo<ReadonlyArray<FleetFlowNode>>(() => {
    const stations = hosts.filter((host) => host.kind === "remote");
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
  }, [hosts, probes, ccHostId, selectedId]);

  const edges = useMemo<ReadonlyArray<Edge>>(() => {
    return hosts
      .filter((host) => host.kind === "remote")
      .map((host) => {
        const probe = probes[host.id];
        const status: FleetEdgeStatus = probe?.status ?? "unknown";
        const phase = edgePhase(status);
        const label =
          probe?.status === "reachable" && probe.latencyMs !== undefined
            ? `${probe.latencyMs} ms`
            : undefined;
        return {
          id: `fleet-${host.id}`,
          source: COMMAND_CENTER_ID,
          target: host.id,
          type: "default",
          animated: phase.animated,
          label,
          labelShowBg: false,
          labelStyle: {
            fill: FAINT,
            fontSize: 9,
            fontFamily: "'SF Mono', SFMono-Regular, Menlo, Consolas, monospace",
            letterSpacing: "0.08em",
          },
          style: {
            stroke: phase.hue,
            strokeWidth: phase.width,
            strokeDasharray: phase.dash ?? undefined,
          },
        } satisfies Edge;
      });
  }, [hosts, probes]);

  return (
    <ReactFlow
      nodes={nodes as Array<FleetFlowNode>}
      edges={edges as Array<Edge>}
      nodeTypes={fleetNodeTypes}
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
