import { use$ } from "@legendapp/state/react";
import { useCallback, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { DiscoveredPeer } from "@shared/ipc";
import { state$ } from "../lib/state";
import { setStationTopology } from "../lib/settings-state";
import { DIM, FAINT, HUE, INK, RAISE, STROKE, withAlpha } from "../lib/theme";
import { Button } from "./ui/Button";
import { Eyebrow } from "./ui/Eyebrow";

type ScanState =
  | { readonly status: "idle" }
  | { readonly status: "scanning" }
  | {
      readonly status: "done";
      readonly peers: ReadonlyArray<DiscoveredPeer>;
      readonly message?: string;
    };

/**
 * First-run / unset role gate.
 *
 * Sole local topology commit: establish Command Center.
 * Remote identity is never self-selected — a Command Center claims this
 * installation over the Station API. Mesh discovery is opt-in only so we
 * never fire SSH probes or Tailscale CLI from first paint.
 */
export function StationRoleGate() {
  const settings = use$(state$.settings);
  const role = settings?.station?.role ?? "";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [scan, setScan] = useState<ScanState>({ status: "idle" });

  const establishCommandCenter = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const ok = await setStationTopology({
        role: "command-center",
        hostId: settings?.station?.hostId || "local",
        supervisedPreferred: false,
      });
      if (!ok) {
        setError(state$.settingsError.peek() || "could not save station role");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [busy, settings?.station?.hostId]);

  const scanMesh = useCallback(async () => {
    if (scan.status === "scanning") return;
    setScan({ status: "scanning" });
    try {
      // Tailscale status only — no SSH reachability probes. Empty mesh is success.
      if (!window.vellum?.hostsDiscoverPeers) {
        setScan({
          status: "done",
          peers: [],
          message: "Mesh discovery API unavailable on this build",
        });
        return;
      }
      const result = await window.vellum.hostsDiscoverPeers();
      if (!result.ok) {
        setScan({
          status: "done",
          peers: [],
          message: result.message ?? "Could not read Tailscale mesh",
        });
        return;
      }
      setScan({
        status: "done",
        peers: result.peers ?? [],
        ...(result.message ? { message: result.message } : {}),
      });
    } catch (err) {
      setScan({
        status: "done",
        peers: [],
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [scan.status]);

  if (settings === undefined) return null;
  if (role === "command-center" || role === "remote") return null;

  const peers = scan.status === "done" ? scan.peers : [];
  const onlinePeers = peers.filter((peer) => peer.online);
  const listedPeers = onlinePeers.length > 0 ? onlinePeers : peers;
  const scanError = scan.status === "done" ? scan.message : undefined;

  return createPortal(
    <div
      className="station-role-gate"
      role="dialog"
      aria-modal="true"
      aria-label="Establish this installation"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10050,
        display: "grid",
        placeItems: "center",
        background: "rgba(0, 0, 0, 0.72)",
        backdropFilter: "blur(2px)",
      }}
    >
      <div
        style={{
          width: "min(540px, 92vw)",
          borderRadius: 12,
          border: `1px solid ${STROKE}`,
          background: RAISE,
          padding: "28px 28px 22px",
          boxShadow: "0 24px 80px rgba(0,0,0,0.55)",
        }}
      >
        <Eyebrow tone="amber" className="text-[11px] mb-2">
          VELLUM COMMAND · STATION
        </Eyebrow>
        <h1
          style={{
            color: INK,
            fontSize: 20,
            margin: "0 0 8px",
            fontWeight: 600,
          }}
        >
          Establish this installation
        </h1>
        <p
          style={{
            color: DIM,
            fontSize: 13,
            lineHeight: 1.5,
            margin: "0 0 20px",
          }}
        >
          Role is explicit and never inferred. This machine can become the
          Command Center (you author the canvas and claim fleet machines), or
          stay unset until an existing Command Center claims it as a Remote over
          the Station API.
        </p>

        <div style={{ display: "grid", gap: 14 }}>
          <button
            type="button"
            disabled={busy || scan.status === "scanning"}
            onClick={() => void establishCommandCenter()}
            aria-label="Command Center"
            style={primaryCardStyle}
          >
            <strong style={{ color: INK }}>Set up as Command Center</strong>
            <span style={{ color: DIM, fontSize: 12, lineHeight: 1.45 }}>
              Human authors the canvas here. Manages the fleet, enrolls Remotes,
              and runs local agents and browser. Default for a single machine or
              the factory head.
            </span>
          </button>

          <div style={secondaryPanelStyle}>
            <div style={{ display: "grid", gap: 4 }}>
              <strong style={{ color: INK, fontSize: 13 }}>
                Or wait to be claimed as a Remote
              </strong>
              <span style={{ color: DIM, fontSize: 12, lineHeight: 1.45 }}>
                You cannot enroll this machine yourself. Leave it unset; a
                Command Center enrolls it from fleet controls. No network scan
                runs until you ask — so SSH prompts never fire on first open.
              </span>
            </div>

            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 8,
                alignItems: "center",
              }}
            >
              <Button
                variant="chrome"
                size="md"
                disabled={busy || scan.status === "scanning"}
                onClick={() => void scanMesh()}
                aria-label="Look for machines on Tailscale"
              >
                {scan.status === "scanning"
                  ? "Looking…"
                  : scan.status === "done"
                    ? "Scan again"
                    : "Look for machines on Tailscale"}
              </Button>
              <span style={{ color: FAINT, fontSize: 11, lineHeight: 1.4 }}>
                Tailscale mesh only — no SSH
              </span>
            </div>

            {scan.status === "idle" ? (
              <p style={{ color: FAINT, fontSize: 12, margin: 0, lineHeight: 1.45 }}>
                Optional. Scan only if you expect another Vellum machine on your
                tailnet to claim this host.
              </p>
            ) : null}

            {scan.status === "scanning" ? (
              <p style={{ color: DIM, fontSize: 12, margin: 0, lineHeight: 1.45 }}>
                Reading Tailscale status…
              </p>
            ) : null}

            {scan.status === "done" && listedPeers.length === 0 ? (
              <p
                style={{
                  color: DIM,
                  fontSize: 12,
                  margin: 0,
                  lineHeight: 1.45,
                }}
              >
                {scanError
                  ? scanError
                  : "No other machines found on the Tailscale mesh. Proceed to set this up as Command Center, or leave the app open if a Command Center will claim it later."}
              </p>
            ) : null}

            {scan.status === "done" && listedPeers.length > 0 ? (
              <div style={foundCardStyle} role="status">
                <Eyebrow tone="cyan" size="xs">
                  MESH MACHINES VISIBLE
                </Eyebrow>
                <strong style={{ color: INK, fontSize: 13 }}>
                  Claim this host from Command Center on:
                </strong>
                <ul
                  style={{
                    margin: "4px 0 0",
                    padding: "0 0 0 1.1em",
                    color: INK,
                    fontSize: 12,
                    lineHeight: 1.5,
                  }}
                >
                  {listedPeers.map((peer) => (
                    <li key={peer.name}>
                      <span style={{ color: INK }}>{peer.name}</span>
                      {!peer.online ? (
                        <span style={{ color: FAINT }}> · offline</span>
                      ) : null}
                      {peer.os ? (
                        <span style={{ color: FAINT }}> · {peer.os}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
                <span style={{ color: DIM, fontSize: 12, lineHeight: 1.45 }}>
                  Mesh presence is not proof those machines run Command Center.
                  Open Vellum there, establish Command Center if needed, then
                  enroll this installation from fleet controls. This machine
                  stays unset until the Station API claim lands — it never
                  self-assigns Remote.
                </span>
              </div>
            ) : null}
          </div>
        </div>

        {error ? (
          <p
            role="alert"
            style={{ color: HUE.crimson, fontSize: 12, margin: "14px 0 0" }}
          >
            {error}
          </p>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

const primaryCardStyle: CSSProperties = {
  display: "grid",
  gap: 6,
  textAlign: "left",
  padding: 14,
  borderRadius: 10,
  border: `1px solid ${withAlpha(HUE.amber, 0.35)}`,
  background: withAlpha(HUE.amber, 0.12),
  cursor: "pointer",
};

const secondaryPanelStyle: CSSProperties = {
  borderRadius: 10,
  border: `1px solid ${DIM}33`,
  padding: 14,
  display: "grid",
  gap: 12,
};

const foundCardStyle: CSSProperties = {
  display: "grid",
  gap: 6,
  padding: 12,
  borderRadius: 8,
  border: `1px solid ${withAlpha(HUE.cyan, 0.4)}`,
  background: withAlpha(HUE.cyan, 0.08),
};
