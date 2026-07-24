import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import {
  Cpu,
  Globe,
  Orbit,
  Radar,
  Rocket,
  Satellite,
  Server,
  Star,
  type LucideIcon,
} from "lucide-react";
import type { RemoteHost } from "@shared/remote-hosts";
import type { FleetProbeState } from "../../lib/fleet-state";
import { hostColor } from "../../lib/fleet-layout";
import { withAlpha } from "../../lib/theme";

/** Lucide components for the FLEET_GLYPHS vocabulary (fleet-layout.ts). */
export const FLEET_GLYPH_ICONS: Record<string, LucideIcon> = {
  satellite: Satellite,
  rocket: Rocket,
  globe: Globe,
  star: Star,
  orbit: Orbit,
  radar: Radar,
  cpu: Cpu,
  server: Server,
};

export const fleetGlyphIcon = (glyph?: string): LucideIcon =>
  (glyph ? FLEET_GLYPH_ICONS[glyph] : undefined) ?? Satellite;

// --- Command Center ----------------------------------------------------------

export type CommandCenterNodeData = { readonly hostId: string };
export type CommandCenterFlowNode = Node<CommandCenterNodeData, "commandCenter">;

export function CommandCenterNode({ data, selected }: NodeProps<CommandCenterFlowNode>) {
  return (
    <div className={`fleet-cc${selected ? " fleet-cc--selected" : ""}`}>
      <Handle type="source" position={Position.Right} className="fleet-handle" />
      {/* Orbit guide rings — diameters match orbitLayout radii (260/520/780). */}
      <div className="fleet-cc__rings" aria-hidden>
        <div className="fleet-cc__ring" style={{ width: 520, height: 520 }} />
        <div className="fleet-cc__ring" style={{ width: 1040, height: 1040 }} />
        <div className="fleet-cc__ring" style={{ width: 1560, height: 1560 }} />
      </div>
      <div className="fleet-cc__core" aria-hidden />
      <div className="fleet-cc__label font-display">Command Center</div>
      <div className="fleet-cc__meta">{data.hostId ? `${data.hostId} · command-center` : "command-center"}</div>
    </div>
  );
}

// --- Remote station ----------------------------------------------------------

export type StationNodeData = {
  readonly host: RemoteHost;
  readonly probe?: FleetProbeState;
};
export type StationFlowNode = Node<StationNodeData, "station">;

const probePipClass = (probe?: FleetProbeState): string => {
  switch (probe?.status) {
    case "probing":
      return "fleet-station__pip fleet-station__pip--probing";
    case "reachable":
      return "fleet-station__pip fleet-station__pip--reachable";
    case "unreachable":
      return "fleet-station__pip fleet-station__pip--unreachable";
    default:
      return "fleet-station__pip fleet-station__pip--unknown";
  }
};

const probePipTitle = (probe?: FleetProbeState): string => {
  switch (probe?.status) {
    case "probing":
      return "probing link";
    case "reachable":
      return probe.latencyMs !== undefined ? `reachable · ${probe.latencyMs} ms` : "reachable";
    case "unreachable":
      return probe.detail ? `unreachable — ${probe.detail}` : "unreachable";
    default:
      return "link untested";
  }
};

export function StationNode({ data, selected }: NodeProps<StationFlowNode>) {
  const { host, probe } = data;
  const color = hostColor(host);
  const Icon = fleetGlyphIcon(host.appearance?.glyph);
  return (
    <div className={`fleet-station${selected ? " fleet-station--selected" : ""}`}>
      <Handle type="target" position={Position.Left} className="fleet-handle" />
      <div
        className="fleet-station__orb"
        style={{
          background: `radial-gradient(circle at 32% 28%, ${withAlpha(color, 0.9)}, ${withAlpha(color, 0.28)} 62%, ${withAlpha(color, 0.08)})`,
          boxShadow: `0 0 ${selected ? 26 : 16}px ${withAlpha(color, selected ? 0.65 : 0.4)}, inset 0 0 10px ${withAlpha(color, 0.35)}`,
          borderColor: withAlpha(color, selected ? 0.85 : 0.5),
        }}
      >
        <Icon size={20} strokeWidth={1.6} style={{ color: withAlpha(color, 0.95) }} />
        <span className={probePipClass(probe)} title={probePipTitle(probe)} />
      </div>
      <div className="fleet-station__label">{host.label}</div>
    </div>
  );
}

export const fleetNodeTypes = {
  commandCenter: CommandCenterNode,
  station: StationNode,
};
