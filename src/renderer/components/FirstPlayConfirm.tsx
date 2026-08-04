import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Play } from "lucide-react";
import { DIM, GROUND, HUE, INK, INK_2, STROKE, withAlpha } from "../lib/theme";

// First-play confirmation — the explicit operator gate the pause law requires
// (@shared/pause: the factory is BORN PAUSED; the first play is a human
// decision, never a default). Shown once per canvas (everPlayed latch);
// subsequent play/pause toggles are direct. Inline-styled overlay by design —
// this dialog owns no shared stylesheet surface.

/** What play actually does — honest consequences, no softeners. */
const CONSEQUENCES: ReadonlyArray<string> = [
  "Cron and relay nodes start firing, and may spend real agent turns.",
  "Agents can act through the vellum CLI.",
  "Queued messages deliver to their targets.",
  "Queued tasks are handed to free connected agents.",
];

const LABEL: React.CSSProperties = {
  fontSize: 9,
  letterSpacing: ".16em",
  textTransform: "uppercase",
  color: DIM,
};

export function FirstPlayConfirm({
  canvasName,
  onConfirm,
  onCancel,
}: {
  readonly canvasName: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  // Portal to body: the top-bar ancestors carry transforms/filters that would
  // otherwise turn position:fixed into a header-local overlay.
  return createPortal(
    <div
      role="presentation"
      onMouseDown={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 90,
        display: "grid",
        placeItems: "center",
        background: "rgba(6,5,4,0.72)",
        backdropFilter: "blur(2px)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="first-play-title"
        data-testid="first-play-confirm"
        onMouseDown={(event) => event.stopPropagation()}
        style={{
          width: 420,
          maxWidth: "calc(100vw - 48px)",
          borderRadius: 10,
          border: `1px solid ${withAlpha(HUE.amber, 0.35)}`,
          background: GROUND,
          boxShadow: `0 18px 60px rgba(0,0,0,.55), 0 0 0 4px ${withAlpha(HUE.amber, 0.06)}`,
          padding: "18px 20px 16px",
          color: INK_2,
        }}
      >
        <div style={{ ...LABEL, color: HUE.amber, marginBottom: 8 }}>first play</div>
        <h2
          id="first-play-title"
          style={{ margin: "0 0 10px", fontSize: 14, fontWeight: 600, color: INK }}
        >
          Start “{canvasName}”?
        </h2>
        <p style={{ margin: "0 0 10px", fontSize: 11, lineHeight: 1.55 }}>
          This canvas has never run. Once playing, it acts on its own:
        </p>
        <ul style={{ margin: "0 0 12px", padding: 0, listStyle: "none", display: "grid", gap: 6 }}>
          {CONSEQUENCES.map((line) => (
            <li
              key={line}
              style={{ display: "flex", gap: 8, fontSize: 11, lineHeight: 1.5 }}
            >
              <span aria-hidden style={{ color: HUE.amber }}>—</span>
              <span>{line}</span>
            </li>
          ))}
        </ul>
        <p style={{ margin: "0 0 14px", fontSize: 10, color: DIM }}>
          Pausing is always instant and needs no confirmation.
        </p>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            type="button"
            autoFocus
            onClick={onCancel}
            style={{
              ...LABEL,
              color: INK_2,
              border: `1px solid ${STROKE}`,
              background: "rgba(255,255,255,0.02)",
              borderRadius: 7,
              padding: "7px 12px",
              cursor: "pointer",
            }}
          >
            cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            style={{
              ...LABEL,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              color: GROUND,
              border: `1px solid ${withAlpha(HUE.amber, 0.7)}`,
              background: HUE.amber,
              borderRadius: 7,
              padding: "7px 12px",
              cursor: "pointer",
              fontWeight: 600,
            }}
          >
            <Play size={11} />
            play
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
