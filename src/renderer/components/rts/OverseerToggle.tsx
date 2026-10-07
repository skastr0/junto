import { useState } from "react";
import { Shield } from "lucide-react";
import { useRtsNodes } from "../../lib/rts-selection";
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
export function OverseerToggleKey({ nodeId }: { readonly nodeId: string }) {
  const canvasName = use$(state$.canvasName);
  const node = useRtsNodes(canvasName, [nodeId])[0];
  const granted = node ? isOverseerGranted(node) : false;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (!node || !canToggleOverseer(node)) return null;

  const toggle = () => {
    if (busy || !canvasName) return;
    setBusy(true);
    setError("");
    void setOverseerSeat({
      canvasName,
      nodeId,
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
