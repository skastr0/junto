import { use$ } from "@legendapp/state/react";
import {
  Fragment,
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
} from "react";
import { Command, WandSparkles, X } from "lucide-react";
import type {
  DiscoveredPeer,
  HostsDeployRemoteResult,
} from "@shared/ipc";
import type { HostsDeployCapabilities } from "@shared/deploy-capabilities";
import {
  LINUX_HOST_UNAVAILABLE_IN_RELEASE_LABEL,
  LINUX_REMOTE_DEPLOY_DISABLED_DETAIL,
} from "@shared/release-capabilities";
import type { RemoteHost } from "@shared/remote-hosts";
import {
  deriveRemoteUpdateStatus,
  remoteUpdateStatusLabel,
  resolveRemoteAvailableForStatus,
  REMOTE_UPDATE_IDLE_PRODUCT_COPY,
  shouldAutoWalkRemoteUpdate,
} from "@shared/remote-update-status";
import { useHostDeployJob } from "../../lib/deploy-job-state";
import { deployRecoveryGuidance } from "../../lib/deploy-recovery";
import { setFleetAppearance } from "../../lib/fleet-appearance";
import { probeHost, refreshFleet, type FleetProbeState } from "../../lib/fleet-state";
import { FLEET_COLORS, hostColor } from "../../lib/fleet-layout";
import { FLEET_MACHINE_AVATARS } from "../../lib/fleet-machine-assets";
import {
  FLEET_MACHINE_CATALOG,
  fleetMachineColor,
  fleetMachineLabel,
  resolveFleetMachineModel,
  resolvePeerMachineModel,
} from "../../lib/fleet-machine-model";
import { activateOnPointerUp } from "../../lib/pointer-activation";
import { state$ } from "../../lib/state";
import { HUE, withAlpha } from "../../lib/theme";
import { updateState$ } from "../../lib/update-state";
import { getVellumApi } from "../../lib/vellum-api";
import { LinuxHostCapabilities } from "../LinuxHostCapabilities";
import { Button, Chip, IconButton, type ChipTone } from "../ui";
import { FleetDeployJobPanel } from "./FleetDeployJobPanel";

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
      if (probe.protocol?.compatibility === "update-required") {
        return {
          text: "reachable · update required",
          detail: probe.detail,
          color: HUE.amber,
        };
      }
      if (probe.protocol?.compatibility === "deprecated") {
        return {
          text: `reachable · protocol ${probe.protocol.negotiatedProtocol} deprecated`,
          detail: probe.detail,
          color: HUE.amber,
        };
      }
      return {
        text: probe.latencyMs !== undefined
          ? `reachable · ${probe.latencyMs} ms`
          : "reachable",
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
          Work is authored here and handed to the machines enrolled in the
          fleet.
        </p>
      </section>
    </div>
  );
}

function StationDetail({ host, probe }: { readonly host: RemoteHost; readonly probe?: FleetProbeState }) {
  const remoteManagedInstalls = use$(state$.settings.fleet.remoteManagedInstalls);
  const stationRole = use$(state$.settings.station.role);
  const ccVersion = use$(updateState$.status.currentVersion);
  const availableUpdate = use$(updateState$.status.available);
  const [actionBusy, setActionBusy] = useState<
    "" | "configure" | "deploy" | "remove"
  >("");
  const [actionLine, setActionLine] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [caps, setCaps] = useState<HostsDeployCapabilities | null>(null);
  const deployJob = useHostDeployJob(host.id);
  const reach = reachabilityLine(probe);
  const probing = probe?.status === "probing";
  // Prefer main-owned job for busy state so panel remount mid-deploy still shows deploying.
  const deployInFlight =
    actionBusy === "deploy" || deployJob?.status === "running";
  const resolvedModel = resolveFleetMachineModel(host);
  const color = hostColor(host, fleetMachineColor(resolvedModel));
  const automatic = !FLEET_MACHINE_CATALOG.some(
    ({ id }) => id === host.appearance?.glyph,
  );
  // CC-first: while feed is ahead of running CC, Available column waits and
  // auto-walk is suppressed — but status still compares Remote vs CC so a
  // lagging Remote is not mislabeled "Up to date".
  const {
    feedAhead,
    feedVersion,
    availableForStatus,
    availableRemoteReleaseVersion,
  } = resolveRemoteAvailableForStatus({
    ...(availableUpdate?.version !== undefined
      ? { feedVersion: availableUpdate.version }
      : {}),
    commandCenterVersion: ccVersion,
  });
  const installedRemoteVersion = probe?.protocol?.peer?.appVersion;
  const remoteUpdate = deriveRemoteUpdateStatus({
    ...(installedRemoteVersion !== undefined
      ? { installedVersion: installedRemoteVersion }
      : {}),
    availableVersion: availableForStatus,
  });
  const autoWalkWouldRun = shouldAutoWalkRemoteUpdate({
    availableRemoteReleaseVersion,
    commandCenterVersion: ccVersion,
    remoteManagedInstalls,
  });

  const loadCaps = useCallback(async () => {
    const api = getVellumApi();
    if (!api?.hostsDeployCapabilities) {
      setCaps(null);
      return;
    }
    try {
      const result = await api.hostsDeployCapabilities();
      setCaps(result.ok ? result : null);
    } catch {
      setCaps(null);
    }
  }, []);

  useEffect(() => {
    void loadCaps();
  }, [loadCaps, host.id, remoteManagedInstalls, stationRole]);

  // Fail-closed when capabilities unknown: gated actions stay disabled.
  // Linux hosts stay enrolled/read-only when managed Linux deploy is off.
  // Box-enrolled host ids are always Linux; probe facts confirm other hosts.
  const knownLinuxHost =
    host.id.startsWith("box-") ||
    (probe?.linuxCapabilities !== undefined &&
      probe.linuxCapabilities.facts.platform === "linux");
  const linuxManagedOff = caps?.release.linuxRemoteDeploy === false;
  const linuxReleaseBlocked = knownLinuxHost && linuxManagedOff;
  const deployEnabled =
    caps?.effective.deployRemote === true && !linuxReleaseBlocked;
  const deployDetail = linuxReleaseBlocked
    ? LINUX_REMOTE_DEPLOY_DISABLED_DETAIL
    : caps?.detail.deployRemote;

  const saveAppearance = (appearance: { color?: string; glyph?: string }) => {
    setActionLine("");
    setFleetAppearance(host, appearance, setActionLine);
  };

  const presentDeployResult = (result: HostsDeployRemoteResult) => {
    // Recovery + summary in actionLine. Always attach stages on failure so a
    // missing job-bridge (stale preload) still shows what main ran.
    const recovery = deployRecoveryGuidance(result.recoveryAction);
    const stages = result.stages?.length
      ? `\n${result.stages.map((stage) => `· ${stage}`).join("\n")}`
      : "";
    if (!result.ok) {
      setActionLine(
        [
          result.detail || result.message || "deploy failed",
          recovery,
          stages,
        ]
          .filter(Boolean)
          .join("\n"),
      );
      return;
    }
    setActionLine(
      [result.detail || "Remote deployed and ready", recovery]
        .filter(Boolean)
        .join("\n"),
    );
  };

  const runAction = async (kind: "configure" | "deploy" | "remove") => {
    const api = getVellumApi();
    if (!api) return;
    if (kind === "deploy" && !deployEnabled) return;
    if (kind === "deploy" && deployJob?.status === "running") return;
    setActionBusy(kind);
    const jobBridge =
      typeof api.hostsDeployJobGet === "function" &&
      typeof api.onHostsDeployJobChanged === "function";
    setActionLine(
      kind === "deploy"
        ? jobBridge
          ? "Deploy accepted — live progress is at the top of this panel (main process; survives closing Fleet)."
          : "Deploy accepted — restart Command Center fully to enable the live progress panel (preload/main not hot-reloaded)."
        : "",
    );
    try {
      if (kind === "configure") {
        const result = await api.hostsConfigureRemote(host.id);
        setActionLine(result.detail || (result.ok ? "configured as a Remote" : (result.message ?? "configure failed")));
      } else if (kind === "deploy") {
        const result = await api.hostsDeployRemote({ id: host.id });
        presentDeployResult(result);
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
      {/* Deploy + progress share one surface — never bury the action under Identity. */}
      <section className="fleet-detail__section fleet-detail__section--deploy">
        <div className="fleet-detail__section-label">Remote deploy</div>
        {deployJob ? <FleetDeployJobPanel job={deployJob} /> : null}
        <div className="fleet-detail__actions">
          <Button
            variant="primary"
            size="xs"
            disabled={actionBusy !== "" || !deployEnabled || deployInFlight}
            title={
              deployInFlight
                ? "Deploy already running in Command Center"
                : deployDetail
            }
            {...activateOnPointerUp(() => void runAction("deploy"))}
          >
            {deployInFlight ? "deploying…" : "Deploy Vellum Command Remote"}
          </Button>
          {!deployEnabled && deployDetail ? (
            <p className="fleet-detail__note">{deployDetail}</p>
          ) : null}
        </div>
        {actionLine ? (
          <p
            className="fleet-detail__note"
            role="status"
            style={{ whiteSpace: "pre-wrap" }}
          >
            {actionLine}
          </p>
        ) : !deployJob ? (
          <p className="fleet-detail__note">
            Package install, sealed adopt, and readiness run in the main
            process. Progress and step log appear here while Deploy runs.
          </p>
        ) : null}
      </section>

      <section className="fleet-detail__section">
        <div className="fleet-detail__section-label">Identity</div>
        <div className="fleet-detail__kv">
          <span>endpoint</span>
          <span>{host.sshEndpoint ?? "—"}</span>
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
        {probe?.protocol ? (
          <div className="fleet-detail__kv">
            <span>protocol</span>
            <span>
              {probe.protocol.compatibility === "update-required"
                ? "update required"
                : `${probe.protocol.negotiatedProtocol} · ${probe.protocol.compatibility}`}
            </span>
            <span>local app / schema</span>
            <span>
              {probe.protocol.local.appVersion} /{" "}
              {probe.protocol.local.stateSchemaVersion}
            </span>
            <span>local support</span>
            <span>
              {probe.protocol.local.support.compatibleFrom}–
              {probe.protocol.local.support.preferred} · warn below{" "}
              {probe.protocol.local.support.warnBelow}
            </span>
            <span>Remote app / schema</span>
            <span>
              {probe.protocol.peer
                ? `${probe.protocol.peer.appVersion} / ${probe.protocol.peer.stateSchemaVersion}`
                : "diagnostics unavailable"}
            </span>
            <span>Remote support</span>
            <span>
              {probe.protocol.peer
                ? `${probe.protocol.peer.support.compatibleFrom}–${probe.protocol.peer.support.preferred} · warn below ${probe.protocol.peer.support.warnBelow}`
                : "unknown"}
            </span>
          </div>
        ) : null}
        <Button
          size="xs"
          disabled={probing}
          {...activateOnPointerUp(() => void probeHost(host.id))}
        >
          {probing ? "probing…" : "Test link"}
        </Button>
      </section>

      {probe?.linuxCapabilities ? (
        <section className="fleet-detail__section">
          <div className="fleet-detail__section-label">
            Linux host
            {linuxReleaseBlocked
              ? ` · ${LINUX_HOST_UNAVAILABLE_IN_RELEASE_LABEL}`
              : ""}
          </div>
          {linuxReleaseBlocked ? (
            <p className="fleet-detail__note">
              {LINUX_REMOTE_DEPLOY_DISABLED_DETAIL}
            </p>
          ) : null}
          <LinuxHostCapabilities observation={probe.linuxCapabilities} />
        </section>
      ) : null}

      <section className="fleet-detail__section">
        <div className="fleet-detail__section-label">Software update</div>
        <div className="fleet-detail__kv">
          <span>Installed version</span>
          <span>{remoteUpdate.installedVersion ?? "unknown"}</span>
          <span>Available version</span>
          <span>
            {feedAhead && feedVersion !== undefined
              ? `waiting for CC ${feedVersion}`
              : (remoteUpdate.availableVersion ?? "—")}
          </span>
          <span>Update status</span>
          <span>
            {remoteUpdate.installedVersion === undefined
              ? "unknown"
              : remoteUpdateStatusLabel(remoteUpdate.updateStatus)}
          </span>
        </div>
        {remoteUpdate.updateStatus === "update-available" ? (
          <p className="fleet-detail__note">
            {deployEnabled
              ? autoWalkWouldRun
                ? "Eligible for automatic managed update when idle (one Remote at a time)."
                : remoteManagedInstalls
                  ? "Update available. Command Center must match this release before Remotes auto-update."
                  : "Update available. Enable “Allow remote managed installs” for fleet auto-update, or Deploy when ready."
              : deployDetail ??
                "Managed Remote package deployment is disabled in this release."}
          </p>
        ) : null}
        {remoteUpdate.updateStatus === "waiting-for-idle" ? (
          <p className="fleet-detail__note">{REMOTE_UPDATE_IDLE_PRODUCT_COPY}</p>
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
          <span>{automatic ? "Automatic silhouette" : "Custom silhouette"}</span>
          <strong>{fleetMachineLabel(resolvedModel)}</strong>
        </div>
        <div className="fleet-detail__models" role="group" aria-label="Machine silhouette">
          <button
            type="button"
            className={`fleet-model-choice fleet-model-choice--auto${
              automatic ? " fleet-model-choice--active" : ""
            }`}
            style={automatic ? { color, borderColor: withAlpha(color, 0.6) } : undefined}
            aria-label="Automatically choose machine silhouette"
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
            disabled={actionBusy !== "" || deployInFlight}
            {...activateOnPointerUp(() => void runAction("configure"))}
          >
            {actionBusy === "configure" ? "configuring…" : "Configure Remote"}
          </Button>
          {confirmRemove ? (
            <Button
              size="xs"
              variant="danger"
              disabled={actionBusy !== "" || deployInFlight}
              {...activateOnPointerUp(() => void runAction("remove"))}
            >
              {actionBusy === "remove" ? "removing…" : `Confirm remove ${host.id}`}
            </Button>
          ) : (
            <Button
              size="xs"
              variant="danger"
              disabled={actionBusy !== "" || deployInFlight}
              {...activateOnPointerUp(() => setConfirmRemove(true))}
            >
              Remove host
            </Button>
          )}
        </div>
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
          Visible on your network but not yet enrolled. Enrolling only adds it
          to the fleet — configure and deploy it afterward.
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
  const markModel = stationModel ?? peerModel;
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
          className={`fleet-detail__identity-mark${
            markModel || selection.kind === "cc" ? " fleet-detail__identity-mark--model" : ""
          }`}
          style={{
            color,
            borderColor: withAlpha(color, 0.42),
            background: withAlpha(color, 0.07),
          }}
        >
          {markModel ? (
            <img
              className="fleet-detail__identity-avatar"
              src={FLEET_MACHINE_AVATARS[markModel]}
              alt=""
              draggable={false}
            />
          ) : selection.kind === "cc" ? (
            <img
              className="fleet-detail__identity-avatar"
              src={FLEET_MACHINE_AVATARS["command-core"]}
              alt=""
              draggable={false}
            />
          ) : (
            <Command size={18} strokeWidth={1.55} />
          )}
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
