/**
 * The top bar's quick capture button, beside the needs-you button: it opens
 * the capture surface Cmd+T opens, or closes it when it is already open. Its
 * title and aria-keyshortcuts come from the key table, so a rebound key shows.
 */
import { use$ } from "@legendapp/state/react";
import { NotebookPen } from "lucide-react";
import { keyAria, keyCaps } from "../lib/key-match";
import { operatorModal$, toggleOperatorModal } from "../lib/operator-modal";
import { isMac } from "../lib/platform";

export function QuickCaptureButton() {
  const open = use$(operatorModal$.open) === "capture";
  const caps = keyCaps("capture.open");
  return (
    <button
      type="button"
      className="station-icon-button"
      data-testid="quick-capture-trigger"
      aria-label="Quick capture"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-keyshortcuts={keyAria("capture.open")}
      title={caps === undefined ? "Quick capture" : `Quick capture (${caps.join(isMac() ? "" : "+")})`}
      style={{ borderColor: "var(--color-stroke)", color: "var(--color-steel)" }}
      onClick={() => toggleOperatorModal("capture")}
    >
      <NotebookPen size={15} />
    </button>
  );
}
