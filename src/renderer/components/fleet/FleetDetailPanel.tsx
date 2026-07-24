import {
  Fragment,
  useState,
  type CSSProperties,
} from "react";
import { Command, WandSparkles, X } from "lucide-react";
import type { DiscoveredPeer } from "@shared/ipc";
import type { RemoteHost } from "@shared/remote-hosts";
import { setFleetAppearance } from "../../lib/fleet-appearance";
import { probeHost, refreshFleet, type FleetProbeState } from "../../lib/fleet-state";
import { FLEET_COLORS, hostColor } from "../../lib/fleet-layout";
import {
  FLEET_MACHINE_ASSETS,
  FLEET_MACHINE_AVATARS,
} from "../../lib/fleet-machine-assets";
import {
  FLEET_MACHINE_CATALOG,
  fleetMachineColor,
  fleetMachineLabel,
  resolveFleetMachineModel,
  resolvePeerMachineModel,
} from "../../lib/fleet-machine-model";
import { activateOnPointerUp } from "../../lib/pointer-activation";
import { HUE, withAlpha } from "../../lib/theme";
import { getVellumApi } from "../../lib/vellum-api";
import { Button, Chip, IconButton, type ChipTone } from "../ui";
import { DitheredFleetObject } from "./DitheredFleetObject";

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

function reachabilityLine(probe?: FleetProbeState): {
  readonly text: string;
  readonly detail?: string;
  readonly color: string;
} {
  switch (probe?.status) {
    case "probing":
      return { text: "probing link…", color: HUE.cyan };
    case "reachable":
      return {
        text: probe.latencyMs !== undefined ? `reachable · ${probe.latencyMs} ms` : "reachable",
        detail: probe.detail,
        color: "#5FB98E",
      };
    case "unreachable":
      return {
        text: "unreachable",
        detail: probe.detail,
        color: HUE.crimson,
      };
    default:
      return { text: "link untested", color: "#8a8378" };
  }
}

function CommandCenterDetail({ hostId }: { readonly hostId: string }) {
  return (
    <div className="fleet-detail__body">
      <section className="fleet-detail__section">
        <div className="fleet-detail__section-label">Authority</div>
        <div className="fleet-detail__kv">
          <span>role</span>
          <span>command-center</span>
          <span>host id</span>
          <span>{hostId || "local"}</span>
        </div>
        <p className="fleet-detail__note">
          The human-authored core of the fleet. It distributes complete intent to enrolled
          stations; it does not create station-to-station reach.
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
  const resolvedModel = resolveFleetMachineModel(host);
  const color = hostColor(host, fleetMachineColor(resolvedModel));
  const automatic = !FLEET_MACHINE_CATALOG.some(
    ({ id }) => id === host.appearance?.glyph,
  );

  const saveAppearance = (appearance: { color?: string; glyph?: string }) => {
    setActionLine("");
    setFleetAppearance(host, appearance, setActionLine);
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
        <div className="fleet-detail__section-label">Identity</div>
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
        <div className="fleet-detail__section-label">Connectivity</div>
        <div className="fleet-detail__status">
          <span
            className={probePipClassName(probe)}
            style={{ "--fleet-status-color": reach.color } as CSSProperties}
          />
          <span className="fleet-detail__reach" style={{ color: reach.color }}>
            {reach.text}
          </span>
        </div>
        {reach.detail ? (
          <details className="fleet-detail__diagnostic">
            <summary>Probe detail</summary>
            <p>{reach.detail}</p>
          </details>
        ) : null}
        <Button
          size="xs"
          disabled={probing}
          {...activateOnPointerUp(() => void probeHost(host.id))}
        >
          {probing ? "probing…" : "Test link"}
        </Button>
      </section>

      <section className="fleet-detail__section">
        <div className="fleet-detail__section-label">Machine signature</div>
        <div className="fleet-detail__swatches" role="group" aria-label="Station color">
          {FLEET_COLORS.map((swatch) => {
            const active = color === swatch;
            return (
              <button
                key={swatch}
                type="button"
                className={`fleet-swatch${active ? " fleet-swatch--active" : ""}`}
                style={{ background: swatch }}
                aria-label={`Set station color ${swatch}`}
                aria-pressed={active}
                {...activateOnPointerUp(() =>
                  saveAppearance({
                    color: swatch,
                    glyph: host.appearance?.glyph,
                  })
                )}
              />
            );
          })}
        </div>
        <div className="fleet-detail__model-heading">
          <span>{automatic ? "Automatic silhouette" : "Custom silhouette"}</span>
          <strong>{fleetMachineLabel(resolvedModel)}</strong>
        </div>
        <div className="fleet-detail__models" role="group" aria-label="Station silhouette">
          <button
            type="button"
            className={`fleet-model-choice fleet-model-choice--auto${
              automatic ? " fleet-model-choice--active" : ""
            }`}
            style={automatic ? { color, borderColor: withAlpha(color, 0.6) } : undefined}
            aria-label="Automatically choose station silhouette"
            aria-pressed={automatic}
            title="Automatic"
            {...activateOnPointerUp(() =>
              saveAppearance({ color: host.appearance?.color })
            )}
          >
            <WandSparkles size={14} strokeWidth={1.6} />
            <span>Automatic</span>
          </button>
          {FLEET_MACHINE_CATALOG.map(({ id, label, color: modelColor }) => {
            const active = !automatic && host.appearance?.glyph === id;
            return (
              <button
                key={id}
                type="button"
                className={`fleet-model-choice${
                  active ? " fleet-model-choice--active" : ""
                }`}
                style={
                  {
                    "--fleet-model-color": modelColor,
                    ...(active
                      ? { color, borderColor: withAlpha(color, 0.6) }
                      : {}),
                  } as CSSProperties
                }
                aria-label={`Use ${label} silhouette`}
                aria-pressed={active}
                title={label}
                {...activateOnPointerUp(() =>
                  saveAppearance({
                    color: host.appearance?.color,
                    glyph: id,
                  })
                )}
              >
                <span
                  className="fleet-model-choice__preview"
                  aria-hidden="true"
                >
                  <img src={FLEET_MACHINE_AVATARS[id]} alt="" />
                </span>
                <span className="fleet-model-choice__label">{label}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="fleet-detail__section">
        <div className="fleet-detail__section-label">Operations</div>
        <div className="fleet-detail__actions">
          <Button
            size="xs"
            disabled={actionBusy !== ""}
            {...activateOnPointerUp(() => void runAction("configure"))}
          >
            {actionBusy === "configure" ? "configuring…" : "Configure station"}
          </Button>
          <Button
            variant="primary"
            size="xs"
            disabled={actionBusy !== ""}
            {...activateOnPointerUp(() => void runAction("deploy"))}
          >
            {actionBusy === "deploy" ? "deploying…" : "Deploy Vellum Remote"}
          </Button>
          {confirmRemove ? (
            <Button
              size="xs"
              variant="danger"
              disabled={actionBusy !== ""}
              {...activateOnPointerUp(() => void runAction("remove"))}
            >
              {actionBusy === "remove" ? "removing…" : `Confirm remove ${host.id}`}
            </Button>
          ) : (
            <Button
              size="xs"
              variant="danger"
              disabled={actionBusy !== ""}
              {...activateOnPointerUp(() => setConfirmRemove(true))}
            >
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
  return (
    <div className="fleet-detail__body">
      <section className="fleet-detail__section">
        <div className="fleet-detail__section-label">Observed identity</div>
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
          Seen on the Tailscale mesh, but outside the execution graph. Claiming only enrolls the
          host; configuration and installation remain separate operator actions.
        </p>
      </section>

      <section className="fleet-detail__section">
        <div className="fleet-detail__section-label">Enrollment</div>
        <div className="fleet-detail__actions">
          <Button
            variant="primary"
            size="xs"
            {...activateOnPointerUp(() => onClaim(peer))}
          >
            Claim as station
          </Button>
        </div>
      </section>
    </div>
  );
}

const probePipClassName = (probe?: FleetProbeState): string =>
  `fleet-detail__status-dot fleet-detail__status-dot--${probe?.status ?? "unknown"}`;

/** Right-hand detail column for the selected star-map node. */
export function FleetDetailPanel({
  selection,
  probe,
  ccHostId,
  onClose,
  onClaimPeer,
  ditherPixelSize,
}: {
  readonly selection: FleetSelection;
  readonly probe?: FleetProbeState;
  readonly ccHostId: string;
  readonly onClose: () => void;
  readonly onClaimPeer: (peer: DiscoveredPeer) => void;
  readonly ditherPixelSize: number;
}) {
  const reach = selection.kind === "station" ? reachabilityLine(probe) : undefined;
  const stationModel =
    selection.kind === "station"
      ? resolveFleetMachineModel(selection.host)
      : undefined;
  const peerModel =
    selection.kind === "ghost"
      ? resolvePeerMachineModel(selection.peer)
      : undefined;
  const HeaderIcon =
    selection.kind === "cc"
      ? Command
      : undefined;
  const title =
    selection.kind === "cc"
      ? "Command Center"
      : selection.kind === "station"
        ? selection.host.label
        : selection.peer.name;
  const kind =
    selection.kind === "cc"
      ? "Authorial core"
      : selection.kind === "station"
        ? "Enrolled station"
        : "Discovered peer";
  const color =
    selection.kind === "cc"
      ? HUE.amber
      : selection.kind === "station"
        ? hostColor(
            selection.host,
            stationModel ? fleetMachineColor(stationModel) : undefined,
          )
        : HUE.steel;

  return (
    <aside className="fleet-detail" aria-label="Fleet node detail">
      <div className="fleet-detail__head">
        <div
          className={`fleet-detail__identity-mark${
            stationModel || peerModel ? " fleet-detail__identity-mark--model" : ""
          }`}
          style={{
            color,
            borderColor: withAlpha(color, 0.42),
            background: withAlpha(color, 0.07),
          }}
        >
          {selection.kind === "station" && stationModel ? (
            <DitheredFleetObject
              color={color}
              ditherPixelSize={ditherPixelSize}
              focused
              label={fleetMachineLabel(stationModel)}
              motionSeed={`detail:${selection.host.id}`}
              src={FLEET_MACHINE_ASSETS[stationModel]}
            />
          ) : selection.kind === "ghost" && peerModel ? (
            <DitheredFleetObject
              amberMix={0}
              color={color}
              ditherPixelSize={ditherPixelSize}
              focused
              label={fleetMachineLabel(peerModel)}
              motionSeed={`detail:peer:${selection.peer.name}`}
              src={FLEET_MACHINE_ASSETS[peerModel]}
            />
          ) : HeaderIcon ? (
            <HeaderIcon size={18} strokeWidth={1.55} />
          ) : null}
        </div>
        <div className="fleet-detail__identity">
          <span>{kind}</span>
          <strong>{title}</strong>
          <small style={reach ? { color: reach.color } : undefined}>
            {selection.kind === "station"
              ? reach?.text
              : selection.kind === "ghost"
                ? `${selection.peer.os ?? "unknown device"} · ${selection.peer.online ? "online" : "offline"}`
                : ccHostId || "local"}
          </small>
        </div>
        <IconButton
          aria-label="Close fleet detail"
          title="close detail"
          {...activateOnPointerUp(onClose)}
        >
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
