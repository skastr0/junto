import { useState } from "react";
import type { FleetPeerCompatibilitySnapshot } from "@shared/fleet-compatibility-snapshot";
import { HUE, GREEN, DIM } from "../../lib/theme";

export const compatibilityStatusColor = (
  status: FleetPeerCompatibilitySnapshot["status"],
): string => {
  switch (status) {
    case "exact":
      return GREEN;
    case "warning-exact":
    case "restricted-hold":
      return HUE.amber;
    case "unsupported":
    case "no-common":
      return HUE.crimson;
    case "checking":
      return HUE.cyan;
    case "stale-evidence":
      return HUE.amber;
    case "unreachable":
    default:
      return DIM;
  }
};

export function FleetCompatibilitySection({
  snapshot,
}: {
  readonly snapshot: FleetPeerCompatibilitySnapshot;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const color = compatibilityStatusColor(snapshot.status);

  return (
    <section className="fleet-detail__section" data-testid="fleet-compatibility-section">
      <div className="fleet-detail__section-label">Compatibility and staged execution</div>

      <div className="fleet-detail__status" style={{ marginBottom: "8px" }}>
        <span
          className="fleet-detail__status-dot"
          style={{ background: color, boxShadow: `0 0 8px ${color}` }}
          aria-hidden="true"
        />
        <div className="flex flex-col gap-0.5">
          <strong className="text-[13px] text-ink" style={{ color }}>
            {snapshot.headline}
          </strong>
          <span className="text-[11px] text-dim">{snapshot.detail}</span>
        </div>
      </div>

      <div className="fleet-detail__kv">
        <span>Negotiated protocol</span>
        <span>
          {snapshot.protocol.negotiated !== undefined
            ? `v${snapshot.protocol.negotiated}${snapshot.protocol.isDeprecated ? " (deprecated)" : ""}`
            : "none / not negotiated"}
        </span>

        <span>Semantic state</span>
        <span>{snapshot.semantic.status ?? "evidence unavailable"}</span>

        <span>Projection</span>
        <span>
          {snapshot.projection.state === "missing"
            ? "evidence unavailable"
            : `gen ${snapshot.projection.generation ?? "unknown"} (${snapshot.projection.freshness})${snapshot.projection.isLastValidRetained ? " - last valid retained" : ""}`}
        </span>

        <span>Work backlog</span>
        <span>
          {snapshot.workBacklog.state === "missing"
            ? "evidence unavailable"
            : `${String(snapshot.workBacklog.pendingCount ?? "unknown")} pending${snapshot.workBacklog.heldRouteHead !== undefined ? " (route head held)" : ""}`}
        </span>
      </div>

      {snapshot.workBacklog.heldRouteHead !== undefined ? (
        <div
          className="mt-2 border border-stroke p-2 text-[11px] text-amber"
          data-testid="held-route-head-warning"
        >
          <strong>Route head held:</strong> {snapshot.workBacklog.heldRouteHead.reason} (seq{" "}
          {snapshot.workBacklog.heldRouteHead.seq})
        </div>
      ) : null}

      <details
        className="fleet-detail__diagnostic mt-2"
        open={detailsOpen}
        onToggle={(e) => setDetailsOpen((e.target as HTMLDetailsElement).open)}
      >
        <summary className="cursor-pointer text-dim hover:text-ink">
          Progressive technical metadata
        </summary>
        <div className="fleet-detail__kv mt-2 border-t border-stroke pt-2">
          <span>Local support</span>
          <span>
            v{snapshot.protocol.localSupport.compatibleFrom}–v
            {snapshot.protocol.localSupport.preferred} (warn &lt; v
            {snapshot.protocol.localSupport.warnBelow})
          </span>

          {snapshot.protocol.peerSupport !== undefined ? (
            <>
              <span>Peer support</span>
              <span>
                v{snapshot.protocol.peerSupport.compatibleFrom}–v
                {snapshot.protocol.peerSupport.preferred} (warn &lt; v
                {snapshot.protocol.peerSupport.warnBelow})
              </span>
            </>
          ) : null}

          <span>Projection hash</span>
          <span className="truncate font-mono">
            {snapshot.projection.contentSha256 ?? "evidence unavailable"}
          </span>

          {snapshot.projection.receivedAt !== undefined ? (
            <>
              <span>Projection received</span>
              <span>{snapshot.projection.receivedAt}</span>
            </>
          ) : null}

          {snapshot.evidence.state !== "missing" ? (
            <>
              <span>Evidence timestamp</span>
              <span>{snapshot.evidence.observedAt}</span>
            </>
          ) : null}

          {(snapshot.affectedNodes?.length ?? 0) > 0 ? (
            <>
              <span>Affected nodes</span>
              <span>{snapshot.affectedNodes?.join(", ")}</span>
            </>
          ) : null}

          {(snapshot.semantic.withheldSemantics?.length ?? 0) > 0 ? (
            <>
              <span>Withheld semantics</span>
              <span>
                {snapshot.semantic.withheldSemantics
                  ?.map((w) => `[${w.aspect}] ${w.detail}`)
                  .join("; ")}
              </span>
            </>
          ) : null}
        </div>
      </details>
    </section>
  );
}
