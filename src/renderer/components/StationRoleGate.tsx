import { use$ } from "@legendapp/state/react";
import { useCallback, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
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
      /** True only when a Command Center is actually identified — never mesh peers alone. */
      readonly commandCenterFound: boolean;
      readonly detail: string;
    };

/**
 * First-run / unset role gate.
 *
 * Sole local topology commit: establish Command Center.
 * Remote identity is never self-selected — a Command Center claims this
 * installation over the Station API. Mesh discovery is opt-in only so we
 * never fire SSH probes or Tailscale CLI from first paint.
 *
 * A Tailscale peer list is not a Command Center. Until a non-SSH station
 * advertisement exists, opt-in scan reports "no Command Center found".
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
        setError(state$.settingsError.peek() || "Could not save this machine's role");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [busy, settings?.station?.hostId]);

  const scanForCommandCenter = useCallback(async () => {
    if (scan.status === "scanning") return;
    setScan({ status: "scanning" });
    try {
      // Opt-in only. hostsDiscoverPeers is Tailscale status — peers are not
      // Command Centers. Do not promote them. No SSH reachability probes.
      if (!window.vellum?.hostsDiscoverPeers) {
        setScan({
          status: "done",
          commandCenterFound: false,
          detail: "No Command Center found. Scanning isn't available in this build.",
        });
        return;
      }
      const result = await window.vellum.hostsDiscoverPeers();
      if (!result.ok) {
        setScan({
          status: "done",
          commandCenterFound: false,
          detail: "No Command Center found. The scan could not complete.",
        });
        return;
      }
      // Mesh peers alone never mean "Command Center found". Self-assigning
      // Remote is forbidden; only a real Station API claim establishes Remote.
      setScan({
        status: "done",
        commandCenterFound: false,
        detail:
          "No Command Center found. Set this machine up as the Command Center, or leave it open — it can be enrolled from another machine at any time.",
      });
    } catch (err) {
      setScan({
        status: "done",
        commandCenterFound: false,
        detail:
          err instanceof Error
            ? `No Command Center found (${err.message}).`
            : "No Command Center found.",
      });
    }
  }, [scan.status]);

  if (settings === undefined) return null;
  if (role === "command-center" || role === "remote") return null;

  return createPortal(
    <div
      className="station-role-gate"
      role="dialog"
      aria-modal="true"
      aria-label="Set up this machine"
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
          VELLUM COMMAND
        </Eyebrow>
        <h1
          style={{
            color: INK,
            fontSize: 20,
            margin: "0 0 8px",
            fontWeight: 600,
          }}
        >
          Set up this machine
        </h1>
        <p
          style={{
            color: DIM,
            fontSize: 13,
            lineHeight: 1.5,
            margin: "0 0 20px",
          }}
        >
          This machine can run the Command Center, or be enrolled as a Remote
          by one you already run.
        </p>

        <div style={{ display: "grid", gap: 14 }}>
          <button
            type="button"
            disabled={busy || scan.status === "scanning"}
            onClick={() => void establishCommandCenter()}
            aria-label="Set up as Command Center"
            style={primaryCardStyle}
          >
            <strong style={{ color: INK }}>Set up as Command Center</strong>
            <span style={{ color: DIM, fontSize: 12, lineHeight: 1.45 }}>
              The canvas lives here, agents run here, and Remotes are enrolled
              from here. The right choice for your main machine — or your only
              one.
            </span>
          </button>

          <div style={secondaryPanelStyle}>
            <div style={{ display: "grid", gap: 4 }}>
              <strong style={{ color: INK, fontSize: 13 }}>
                Or wait to be enrolled as a Remote
              </strong>
              <span style={{ color: DIM, fontSize: 12, lineHeight: 1.45 }}>
                Remotes are enrolled from the Command Center — open Command
                Fleet there and pick this machine. Nothing to do on this side.
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
                onClick={() => void scanForCommandCenter()}
                aria-label="Look for a Command Center"
              >
                {scan.status === "scanning"
                  ? "Looking…"
                  : scan.status === "done"
                    ? "Scan again"
                    : "Look for a Command Center"}
              </Button>
            </div>

            {scan.status === "idle" ? (
              <p style={{ color: FAINT, fontSize: 12, margin: 0, lineHeight: 1.45 }}>
                Optional — checks whether a Command Center is reachable from
                here.
              </p>
            ) : null}

            {scan.status === "scanning" ? (
              <p style={{ color: DIM, fontSize: 12, margin: 0, lineHeight: 1.45 }}>
                Looking for a Command Center…
              </p>
            ) : null}

            {scan.status === "done" && !scan.commandCenterFound ? (
              <p
                role="status"
                style={{
                  color: DIM,
                  fontSize: 12,
                  margin: 0,
                  lineHeight: 1.45,
                }}
              >
                {scan.detail}
              </p>
            ) : null}

            {scan.status === "done" && scan.commandCenterFound ? (
              <div style={foundCardStyle} role="status">
                <Eyebrow tone="cyan" size="xs">
                  COMMAND CENTER FOUND
                </Eyebrow>
                <strong style={{ color: INK, fontSize: 13 }}>{scan.detail}</strong>
                <span style={{ color: DIM, fontSize: 12, lineHeight: 1.45 }}>
                  Open Command Fleet on that machine and enroll this one as a
                  Remote — nothing to do on this side.
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
