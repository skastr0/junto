import { Fragment, useState } from "react";
import { X } from "lucide-react";
import type { DiscoveredPeer } from "@shared/ipc";
import type { RemoteHost } from "@shared/remote-hosts";
import { probeHost, refreshFleet, type FleetProbeState } from "../../lib/fleet-state";
import { FLEET_COLORS, FLEET_GLYPHS, hostColor } from "../../lib/fleet-layout";
import { HUE, withAlpha } from "../../lib/theme";
import { getVellumApi } from "../../lib/vellum-api";
import { Button, Chip, Eyebrow, IconButton, type ChipTone } from "../ui";
import { fleetGlyphIcon, peerOsIcon } from "./FleetNodes";

export type FleetSelection =
  | { readonly kind: "cc" }
  | { readonly kind: "station"; readonly host: RemoteHost }
  | { readonly kind: "ghost"; readonly peer: DiscoveredPeer };

const CAPABILITY_TONE: Record<string, ChipTone> = {
  terminal: "cyan",
  browser: "violet",
  herdr: "amber",
  hermes: "green",
};

function reachabilityLine(probe?: FleetProbeState): { readonly text: string; readonly color: string } {
  switch (probe?.status) {
    case "probing":
      return { text: "probing link…", color: HUE.cyan };
    case "reachable":
      return {
        text: probe.latencyMs !== undefined ? `reachable · ${probe.latencyMs} ms` : "reachable",
        color: "#5FB98E",
      };
    case "unreachable":
      return { text: `unreachable${probe.detail ? ` — ${probe.detail}` : ""}`, color: HUE.crimson };
    default:
      return { text: "link untested", color: "#8a8378" };
  }
}

function CommandCenterDetail({ hostId }: { readonly hostId: string }) {
  return (
    <div className="fleet-detail__body">
      <section className="fleet-detail__section">
        <Eyebrow tone="steel">station</Eyebrow>
        <div className="fleet-detail__title">Command Center</div>
        <div className="fleet-detail__kv">
          <span>role</span>
          <span>command-center</span>
          <span>host id</span>
          <span>{hostId || "local"}</span>
        </div>
        <p className="fleet-detail__note">
          The human-authored core of the fleet. Remote stations are enrolled from the star map or
          the discovery rail — the core itself has no operator actions here.
        </p>
      </section>
    </div>
  );
}

function StationDetail({ host, probe }: { readonly host: RemoteHost; readonly probe?: FleetProbeState }) {
  const [actionBusy, setActionBusy] = useState<"" | "configure" | "deploy" | "remove">("");
  const [actionLine, setActionLine] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const reach = reachabilityLine(probe);
  const probing = probe?.status === "probing";
  const color = hostColor(host);

  const saveAppearance = async (appearance: { color?: string; glyph?: string }) => {
    const api = getVellumApi();
    if (!api?.hostsUpsert) return;
    try {
      await api.hostsUpsert({ ...host, appearance });
      await refreshFleet();
    } catch (error) {
      setActionLine(error instanceof Error ? error.message : String(error));
    }
  };

  const runAction = async (kind: "configure" | "deploy" | "remove") => {
    const api = getVellumApi();
    if (!api) return;
    setActionBusy(kind);
    setActionLine(kind === "deploy" ? "deploying Vellum Remote — this can take a while…" : "");
    try {
      if (kind === "configure") {
        const result = await api.hostsConfigureRemote(host.id);
        setActionLine(result.detail || (result.ok ? "configured as Remote station" : (result.message ?? "configure failed")));
      } else if (kind === "deploy") {
        const result = await api.hostsDeployRemote({ id: host.id });
        if (result.authorizationRequest) {
          setActionLine("Fresh administrator authorization required — finish the deploy from Settings → Hosts.");
        } else {
          setActionLine(result.detail || (result.ok ? "Remote deployed and ready" : (result.message ?? "deploy failed")));
        }
      } else {
        const result = await api.hostsRemove(host.id);
        if (result.ok) {
          await refreshFleet();
        } else {
          setActionLine(result.message ?? "remove failed");
        }
      }
    } catch (error) {
      setActionLine(error instanceof Error ? error.message : String(error));
    } finally {
      setActionBusy("");
      setConfirmRemove(false);
    }
  };

  return (
    <div className="fleet-detail__body">
      <section className="fleet-detail__section">
        <Eyebrow tone="steel">station</Eyebrow>
        <div className="fleet-detail__title">{host.label}</div>
        <div className="fleet-detail__kv">
          <span>endpoint</span>
          <span>{host.endpoint ?? "—"}</span>
          <span>kind</span>
          <span>{host.kind}</span>
          {host.hermesId ? (
            <>
              <span>hermes id</span>
              <span>{host.hermesId}</span>
            </>
          ) : null}
        </div>
        <div className="fleet-detail__chips">
          {host.capabilities.map((capability) => (
            <Chip key={capability} tone={CAPABILITY_TONE[capability] ?? "steel"}>
              {capability}
            </Chip>
          ))}
        </div>
      </section>

      <section className="fleet-detail__section">
        <Eyebrow tone="steel">link</Eyebrow>
        <div className="fleet-detail__reach" style={{ color: reach.color }}>
          {reach.text}
        </div>
        <Button size="xs" disabled={probing} onClick={() => void probeHost(host.id)}>
          {probing ? "probing…" : "Test link"}
        </Button>
      </section>

      <section className="fleet-detail__section">
        <Eyebrow tone="steel">appearance</Eyebrow>
        <div className="fleet-detail__swatches" role="group" aria-label="Station color">
          {FLEET_COLORS.map((swatch) => (
            <button
              key={swatch}
              type="button"
              className={`fleet-swatch${host.appearance?.color === swatch ? " fleet-swatch--active" : ""}`}
              style={{ background: swatch, boxShadow: `0 0 8px ${withAlpha(swatch, 0.5)}` }}
              aria-label={`Set station color ${swatch}`}
              aria-pressed={host.appearance?.color === swatch}
              onClick={() => void saveAppearance({ color: swatch, glyph: host.appearance?.glyph })}
            />
          ))}
        </div>
        <div className="fleet-detail__glyphs" role="group" aria-label="Station glyph">
          {FLEET_GLYPHS.map((glyph) => {
            const Icon = fleetGlyphIcon(glyph);
            const active = (host.appearance?.glyph ?? "satellite") === glyph;
            return (
              <button
                key={glyph}
                type="button"
                className={`fleet-glyph${active ? " fleet-glyph--active" : ""}`}
                style={active ? { color, borderColor: withAlpha(color, 0.6) } : undefined}
                aria-label={`Set station glyph ${glyph}`}
                aria-pressed={active}
                title={glyph}
                onClick={() => void saveAppearance({ color: host.appearance?.color, glyph })}
              >
                <Icon size={14} strokeWidth={1.6} />
              </button>
            );
          })}
        </div>
      </section>

      <section className="fleet-detail__section">
        <Eyebrow tone="steel">operator actions</Eyebrow>
        <div className="fleet-detail__actions">
          <Button size="xs" disabled={actionBusy !== ""} onClick={() => void runAction("configure")}>
            {actionBusy === "configure" ? "configuring…" : "Configure as station"}
          </Button>
          <Button size="xs" disabled={actionBusy !== ""} onClick={() => void runAction("deploy")}>
            {actionBusy === "deploy" ? "deploying…" : "Install CLI / deploy"}
          </Button>
          {confirmRemove ? (
            <Button
              size="xs"
              variant="danger"
              disabled={actionBusy !== ""}
              onClick={() => void runAction("remove")}
            >
              {actionBusy === "remove" ? "removing…" : `Confirm remove ${host.id}`}
            </Button>
          ) : (
            <Button size="xs" variant="danger" disabled={actionBusy !== ""} onClick={() => setConfirmRemove(true)}>
              Remove host
            </Button>
          )}
        </div>
        {actionLine ? (
          <p className="fleet-detail__note" role="status">
            {actionLine}
          </p>
        ) : null}
      </section>
    </div>
  );
}

function GhostDetail({
  peer,
  onClaim,
}: {
  readonly peer: DiscoveredPeer;
  readonly onClaim: (peer: DiscoveredPeer) => void;
}) {
  const OsIcon = peerOsIcon(peer.os);
  return (
    <div className="fleet-detail__body">
      <section className="fleet-detail__section">
        <Eyebrow tone="steel">unclaimed peer</Eyebrow>
        <div className="fleet-detail__title fleet-detail__title--icon">
          <OsIcon size={15} strokeWidth={1.6} />
          {peer.name}
        </div>
        <div className="fleet-detail__kv">
          <span>os</span>
          <span>{peer.os ?? "unknown"}</span>
          <span>status</span>
          <span>{peer.online ? "online on the tailnet" : "offline"}</span>
          {peer.addresses.map((address, index) => (
            <Fragment key={address}>
              <span>{index === 0 ? (peer.addresses.length > 1 ? "addresses" : "address") : ""}</span>
              <span>{address}</span>
            </Fragment>
          ))}
        </div>
        <p className="fleet-detail__note">
          Detected on the Tailscale mesh but not enrolled. Claiming enrolls it as a fleet host —
          configure and install stay separate operator actions.
        </p>
      </section>

      <section className="fleet-detail__section">
        <Eyebrow tone="steel">operator actions</Eyebrow>
        <div className="fleet-detail__actions">
          <Button size="xs" onClick={() => onClaim(peer)}>
            Claim as station
          </Button>
        </div>
      </section>
    </div>
  );
}

/** Right-hand detail column for the selected star-map node. */
export function FleetDetailPanel({
  selection,
  probe,
  ccHostId,
  onClose,
  onClaimPeer,
}: {
  readonly selection: FleetSelection;
  readonly probe?: FleetProbeState;
  readonly ccHostId: string;
  readonly onClose: () => void;
  readonly onClaimPeer: (peer: DiscoveredPeer) => void;
}) {
  return (
    <aside className="fleet-detail" aria-label="Fleet node detail">
      <div className="fleet-detail__head">
        <Eyebrow tone="steel">detail</Eyebrow>
        <IconButton aria-label="Close fleet detail" title="close detail" onClick={onClose}>
          <X size={13} />
        </IconButton>
      </div>
      {selection.kind === "cc" ? (
        <CommandCenterDetail hostId={ccHostId} />
      ) : selection.kind === "station" ? (
        <StationDetail key={selection.host.id} host={selection.host} probe={probe} />
      ) : (
        <GhostDetail key={selection.peer.name} peer={selection.peer} onClaim={onClaimPeer} />
      )}
    </aside>
  );
}
