import { use$ } from "@legendapp/state/react";
import { useCallback, useState } from "react";
import { createPortal } from "react-dom";
import type { StationRole } from "@shared/station";
import { state$ } from "../lib/state";
import { setStationTopology } from "../lib/settings-state";
import { DIM, HUE, INK, INSET, RAISE, STROKE, withAlpha } from "../lib/theme";
import { Eyebrow } from "./ui/Eyebrow";
// state$.settingsError used when patch fails

/**
 * First-run / unset role gate, or integrity-failed recovery lock.
 * Role is never inferred — the human must pick Command Center or Remote before
 * using the station as a fleet participant. Integrity failure is not first-run:
 * the CC picker is refused until a transfer/recovery ceremony.
 */
export function StationRoleGate() {
  const settings = use$(state$.settings);
  const role = settings?.station?.role ?? "";
  const integrity = settings?.station?.topologyIntegrity ?? "ok";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [remoteRef, setRemoteRef] = useState("");

  const pick = useCallback(
    async (next: StationRole) => {
      if (busy) return;
      setBusy(true);
      setError(undefined);
      try {
        const ok = await setStationTopology({
          role: next,
          hostId: settings?.station?.hostId || "local",
          commandCenterRef: next === "remote" ? remoteRef.trim() : "",
          supervisedPreferred: next === "remote",
        });
        if (!ok) {
          setError(state$.settingsError.peek() || "could not save station role");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [busy, remoteRef, settings?.station?.hostId],
  );

  // Settings not loaded yet.
  if (settings === undefined) return null;

  // Integrity breach: recovery-locked — not the first-run CC picker.
  if (integrity === "failed") {
    return createPortal(
      <div
        className="station-role-gate station-role-gate--integrity-failed"
        role="dialog"
        aria-modal="true"
        aria-label="Topology integrity failed"
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
            width: "min(520px, 92vw)",
            borderRadius: 12,
            border: `1px solid ${withAlpha(HUE.crimson, 0.45)}`,
            background: RAISE,
            padding: "28px 28px 22px",
            boxShadow: "0 24px 80px rgba(0,0,0,0.55)",
          }}
        >
          <Eyebrow tone="amber" className="text-[11px] mb-2">
            VELLUM COMMAND · RECOVERY LOCKED
          </Eyebrow>
          <h1 style={{ color: INK, fontSize: 20, margin: "0 0 8px", fontWeight: 600 }}>
            Topology integrity failed
          </h1>
          <p style={{ color: DIM, fontSize: 13, lineHeight: 1.5, margin: "0 0 12px" }}>
            The station topology seal could not be verified (MAC mismatch, missing key/seal
            pair, or corrupt seal). This is not first-run onboarding — Command Center and
            Remote promotion are refused until an explicit transfer or recovery ceremony.
          </p>
          <p style={{ color: DIM, fontSize: 12, lineHeight: 1.5, margin: 0 }}>
            Do not edit <span style={{ color: INK, fontFamily: "var(--font-mono, monospace)" }}>
              settings.json
            </span>{" "}
            to invent a role. Restore from a known-good station or run the Command Center
            transfer ceremony when available.
          </p>
        </div>
      </div>,
      document.body,
    );
  }

  // Role already chosen — gate closed.
  if (role === "command-center" || role === "remote") return null;

  return createPortal(
    <div
      className="station-role-gate"
      role="dialog"
      aria-modal="true"
      aria-label="Choose station role"
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
          width: "min(520px, 92vw)",
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
        <h1 style={{ color: INK, fontSize: 20, margin: "0 0 8px", fontWeight: 600 }}>
          How does this machine participate?
        </h1>
        <p style={{ color: DIM, fontSize: 13, lineHeight: 1.5, margin: "0 0 20px" }}>
          You choose. The product never guesses from hardware or whether a window is open.
          Canvas authoring stays human-only on the Command Center.
        </p>

        <div style={{ display: "grid", gap: 12 }}>
          <button
            type="button"
            disabled={busy}
            onClick={() => void pick("command-center")}
            style={cardButtonStyle}
          >
            <strong style={{ color: INK }}>Command Center</strong>
            <span style={{ color: DIM, fontSize: 12, lineHeight: 1.45 }}>
              Human authors the canvas here. Manages the fleet with existing host connections.
              Local agents and local browser. Default for a single machine.
            </span>
          </button>

          <div
            style={{
              borderRadius: 10,
              border: `1px solid ${DIM}33`,
              padding: 14,
              display: "grid",
              gap: 10,
            }}
          >
            <div style={{ display: "grid", gap: 4 }}>
              <strong style={{ color: INK }}>Remote</strong>
              <span style={{ color: DIM, fontSize: 12, lineHeight: 1.45 }}>
                Capability host for this machine. Pulls canvases. Runs host-scoped watchers and
                agents. Does not rewrite the authorial canvas.
              </span>
            </div>
            <label style={{ display: "grid", gap: 4, fontSize: 12, color: DIM }}>
              Command Center reachability (host id or SSH target)
              <input
                value={remoteRef}
                onChange={(event) => setRemoteRef(event.target.value)}
                placeholder="e.g. local or mac-mini"
                disabled={busy}
                style={{
                  background: INSET,
                  border: `1px solid ${DIM}44`,
                  borderRadius: 6,
                  color: INK,
                  padding: "8px 10px",
                  fontSize: 13,
                }}
              />
            </label>
            <button
              type="button"
              disabled={busy || remoteRef.trim().length === 0}
              onClick={() => void pick("remote")}
              style={{
                ...cardButtonStyle,
                opacity: remoteRef.trim().length === 0 ? 0.45 : 1,
              }}
            >
              <strong style={{ color: INK }}>Continue as Remote</strong>
            </button>
          </div>
        </div>

        {error ? (
          <p role="alert" style={{ color: HUE.crimson, fontSize: 12, margin: "14px 0 0" }}>
            {error}
          </p>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

const cardButtonStyle: React.CSSProperties = {
  display: "grid",
  gap: 6,
  textAlign: "left",
  padding: 14,
  borderRadius: 10,
  border: `1px solid ${withAlpha(HUE.amber, 0.35)}`,
  background: withAlpha(HUE.amber, 0.12),
  cursor: "pointer",
};
