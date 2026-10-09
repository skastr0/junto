import { Fragment, useState, type CSSProperties } from "react";
import { WandSparkles, X } from "lucide-react";
import type { DiscoveredPeer } from "@shared/ipc";
import {
  HERMES_INTEGRATION_ENABLED,
  productHostCapabilities,
} from "@shared/features";
import type { RemoteHost } from "@shared/remote-hosts";
import { setFleetAppearance } from "../../lib/fleet-appearance";
import { probeHost, refreshFleet, type FleetProbeState } from "../../lib/fleet-state";
import { FLEET_COLORS, hostColor } from "../../lib/fleet-layout";
import {
  FLEET_MACHINE_CATALOG,
  fleetMachineColor,
  fleetMachineLabel,
  resolveFleetMachineModel,
  resolvePeerMachineModel,
} from "../../lib/fleet-machine-model";
import { activateOnPointerUp } from "../../lib/pointer-activation";
import { DIM, GREEN, HUE, withAlpha } from "../../lib/theme";
import { getJuntoApi } from "../../lib/junto-api";
import { Button, Chip, IconButton, type ChipTone } from "../ui";
import { fleetMachineIcon } from "./FleetNodes";

export type FleetSelection =
  | { readonly kind: "cc" }
  | { readonly kind: "station"; readonly host: RemoteHost }
  | { readonly kind: "ghost"; readonly peer: DiscoveredPeer };

const CAPABILITY_TONE: Record<string, ChipTone> = {
  terminal: "cyan",
  browser: "violet",
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
        text: probe.latencyMs !== undefined
          ? `On the network — ${probe.latencyMs} ms`
          : "On the network",
        detail: probe.detail,
        color: GREEN,
      };
    case "unreachable":
      return {
        text: "Can't reach this machine",
        detail: probe.detail,
        color: HUE.crimson,
      };
    default:
      return { text: "link untested", color: DIM };
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
          <span>{hostId || "this machine"}</span>
        </div>
        <p className="fleet-detail__note">
          Work is authored here and handed to the machines enrolled in the
          fleet.
        </p>
      </section>
    </div>
  );
}

function StationDetail({ host, probe }: { readonly host: RemoteHost; readonly probe?: FleetProbeState }) {
  const [removing, setRemoving] = useState(false);
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

  const removeHost = async () => {
    const remove = getJuntoApi()?.hostsRemove;
    if (!remove) {
      setActionLine("Host remove API unavailable");
      return;
    }
    setRemoving(true);
    try {
      const result = await remove(host.id);
      if (result.ok) {
        await refreshFleet();
      } else {
        setActionLine(result.message ?? "remove failed");
      }
    } catch (error) {
      setActionLine(error instanceof Error ? error.message : String(error));
    } finally {
      setRemoving(false);
      setConfirmRemove(false);
    }
  };

  return (
    <div className="fleet-detail__body">
      <section className="fleet-detail__section">
        <div className="fleet-detail__section-label">Identity</div>
        <div className="fleet-detail__kv">
          <span>endpoint</span>
          <span>{host.sshEndpoint ?? "—"}</span>
          {HERMES_INTEGRATION_ENABLED && host.hermesId ? (
            <>
              <span>hermes id</span>
              <span>{host.hermesId}</span>
            </>
          ) : null}
        </div>
        <div className="fleet-detail__chips">
          {productHostCapabilities(host.capabilities).map((capability) => (
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
          <Button
            size="sm"
            disabled={probing}
            {...activateOnPointerUp(() => void probeHost(host.id))}
          >
            {probing ? "probing…" : "Test Station link"}
          </Button>
        </div>
        {reach.detail ? (
          <details className="fleet-detail__diagnostic">
            <summary>Probe detail</summary>
            <p>{reach.detail}</p>
          </details>
        ) : null}
      </section>
      <section className="fleet-detail__section">
        <div className="fleet-detail__section-label">Machine signature</div>
        <div className="fleet-detail__swatches" role="group" aria-label="Machine color">
          {FLEET_COLORS.map((swatch) => {
            const active = color === swatch;
            return (
              <button
                key={swatch}
                type="button"
                className={`fleet-swatch${active ? " fleet-swatch--active" : ""}`}
                style={{ background: swatch }}
                aria-label={`Set machine color ${swatch}`}
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
          <span>{automatic ? "Automatic icon" : "Custom icon"}</span>
          <strong>{fleetMachineLabel(resolvedModel)}</strong>
        </div>
        <div className="fleet-detail__models" role="group" aria-label="Machine icon">
          <button
            type="button"
            className={`fleet-model-choice fleet-model-choice--auto${
              automatic ? " fleet-model-choice--active" : ""
            }`}
            style={automatic ? { color, borderColor: withAlpha(color, 0.6) } : undefined}
            aria-label="Automatically choose machine icon"
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
            const MachineIcon = fleetMachineIcon(id);
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
                aria-label={`Use ${label} icon`}
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
                  <MachineIcon size={24} strokeWidth={1.6} />
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
          {confirmRemove ? (
            <Button
              size="xs"
              variant="danger"
              disabled={removing}
              {...activateOnPointerUp(() => void removeHost())}
            >
              {removing ? "removing…" : `Confirm remove ${host.id}`}
            </Button>
          ) : (
            <Button
              size="xs"
              variant="danger"
              disabled={removing}
              {...activateOnPointerUp(() => setConfirmRemove(true))}
            >
              Remove host
            </Button>
          )}
        </div>
        {actionLine ? (
          <p
            className="fleet-detail__note"
            role="status"
            style={{ whiteSpace: "pre-wrap" }}
          >
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
        <div className="fleet-detail__section-label">Identity</div>
        <div className="fleet-detail__kv">
          <span>os</span>
          <span>{peer.os ?? "unknown"}</span>
          <span>status</span>
          <span>{peer.online ? "online" : "offline"}</span>
          {peer.addresses.map((address, index) => (
            <Fragment key={address}>
              <span>{index === 0 ? (peer.addresses.length > 1 ? "addresses" : "address") : ""}</span>
              <span>{address}</span>
            </Fragment>
          ))}
        </div>
        <p className="fleet-detail__note">
          Visible on your network but not yet enrolled. Enrolling adds it to
          the fleet.
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
            Enroll this machine
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
}: {
  readonly selection: FleetSelection;
  readonly probe?: FleetProbeState;
  readonly ccHostId: string;
  readonly onClose: () => void;
  readonly onClaimPeer: (peer: DiscoveredPeer) => void;
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
  const IdentityIcon = fleetMachineIcon(stationModel ?? peerModel ?? "command-core");
  const title =
    selection.kind === "cc"
      ? "Command Center"
      : selection.kind === "station"
        ? selection.host.label
        : selection.peer.name;
  const kind =
    selection.kind === "cc"
      ? "This machine"
      : selection.kind === "station"
        ? "Enrolled machine"
        : "Discovered machine";
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
          className="fleet-detail__identity-mark"
          style={{
            color,
            borderColor: withAlpha(color, 0.42),
            background: withAlpha(color, 0.07),
          }}
        >
          <IdentityIcon size={18} strokeWidth={1.55} aria-hidden="true" />
        </div>
        <div className="fleet-detail__identity">
          <span>{kind}</span>
          <strong>{title}</strong>
          <small style={reach ? { color: reach.color } : undefined}>
            {selection.kind === "station"
              ? reach?.text
              : selection.kind === "ghost"
                ? `${selection.peer.os ?? "unknown device"} - ${selection.peer.online ? "online" : "offline"}`
                : ccHostId || "this machine"}
          </small>
        </div>
        <IconButton
          aria-label="Close fleet detail"
          title="Close"
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
