import type { DiscoveredPeer } from "@shared/ipc";
import { Button, Eyebrow, StatusDot } from "../ui";

/**
 * Discovery rail — unenrolled Tailscale peers proposed as stations. Renders
 * along the bottom of the star map; empty when the tailnet has nothing new.
 */
export function FleetDiscovery({
  peers,
  loading,
  onClaim,
}: {
  readonly peers: ReadonlyArray<DiscoveredPeer>;
  readonly loading: boolean;
  readonly onClaim: (peer: DiscoveredPeer) => void;
}) {
  if (!loading && peers.length === 0) return null;
  return (
    <div className="fleet-discovery" aria-label="Discovered tailnet peers">
      <div className="fleet-discovery__head">
        <Eyebrow tone="steel">discovery · unclaimed peers</Eyebrow>
      </div>
      <div className="fleet-discovery__rows">
        {loading && peers.length === 0 ? (
          <span className="fleet-discovery__empty">scanning the tailnet…</span>
        ) : (
          peers.map((peer) => (
            <div key={peer.name} className="fleet-discovery__row">
              <StatusDot tone={peer.online ? "green" : "dim"} title={peer.online ? "online" : "offline"} />
              <span className="fleet-discovery__name">{peer.name}</span>
              <span className="fleet-discovery__addr">
                {peer.addresses[0] ?? ""}
                {peer.os ? ` · ${peer.os}` : ""}
              </span>
              <Button size="xs" onClick={() => onClaim(peer)}>
                Claim as station
              </Button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
