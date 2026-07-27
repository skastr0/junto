import { use$ } from "@legendapp/state/react";
import { useCallback, useState } from "react";
import { createPortal } from "react-dom";
import { state$ } from "../lib/state";
import { setStationTopology } from "../lib/settings-state";
import { DIM, HUE, INK, RAISE, STROKE, withAlpha } from "../lib/theme";
import { Eyebrow } from "./ui/Eyebrow";
// state$.settingsError used when patch fails

/**
 * First-run / unset role gate. A Command Center can be established locally.
 * Remote identity is installed only by a paired Command Center.
 */
export function StationRoleGate() {
  const settings = use$(state$.settings);
  const role = settings?.station?.role ?? "";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const establishCommandCenter = useCallback(
    async () => {
      if (busy) return;
      setBusy(true);
      setError(undefined);
      try {
        const ok = await setStationTopology({
          role: "command-center",
          hostId: settings?.station?.hostId || "local",
          commandCenterRef: "",
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
    },
    [busy, settings?.station?.hostId],
  );

  // Settings not loaded yet.
  if (settings === undefined) return null;

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
          Establish this installation
        </h1>
        <p style={{ color: DIM, fontSize: 13, lineHeight: 1.5, margin: "0 0 20px" }}>
          Role is explicit and never inferred. Start a Command Center here, or
          enroll this installation from an existing Command Center as a Remote.
        </p>

        <div style={{ display: "grid", gap: 12 }}>
          <button
            type="button"
            disabled={busy}
            onClick={() => void establishCommandCenter()}
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
                Enroll this installation from the fleet controls of an existing
                Command Center. Pairing installs its complete identity and
                configuration through the Station API.
              </span>
            </div>
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
