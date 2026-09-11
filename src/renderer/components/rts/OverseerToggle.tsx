import { useState } from "react";
import { Shield } from "lucide-react";
import type { CanvasNode } from "@shared/canvas";
import { use$ } from "@legendapp/state/react";
import { HUE } from "../../lib/theme";
import { state$ } from "../../lib/state";
import {
  canToggleOverseer,
  isOverseerGranted,
  setOverseerSeat,
} from "../../lib/overseer-set";
import { KindKey } from "./RtsControls";

const ICON = 12;

/**
 * Human-only grant/revoke on a managed agent seat. Pause/play is orthogonal.
 * Lives on the RTS kind strip — never on the card body.
 */
export function OverseerToggleKey({ node }: { readonly node: CanvasNode }) {
  const canvasName = use$(state$.canvasName);
  const granted = isOverseerGranted(node);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (!canToggleOverseer(node)) return null;

  const toggle = () => {
    if (busy || !canvasName) return;
    setBusy(true);
    setError("");
    void setOverseerSeat({
      canvasName,
      nodeId: node.id,
      overseer: !granted,
    })
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => setBusy(false));
  };

  return (
    <KindKey
      label={granted ? "Revoke overseer" : "Grant overseer"}
      title={
        error
          ? error
          : granted
            ? "Revoke overseer — human grant only"
            : "Grant overseer — human grant only"
      }
      active={granted}
      disabled={busy}
      style={{ color: granted ? HUE.indigo : error ? HUE.crimson : undefined }}
      testId="rts-overseer"
      data={{ "data-overseer": granted ? "true" : "false" }}
      onClick={toggle}
    >
      <Shield size={ICON} />
    </KindKey>
  );
}
