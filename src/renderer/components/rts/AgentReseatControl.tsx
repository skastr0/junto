/**
 * RTS command-card control: re-seat a managed agent onto another harness.
 * Reuses AgentHarnessPick (palette rules) + confirmation for process kill.
 *
 * The pick surface is a ui Popover above the key: it portals to the body, so
 * it clears the canvas the RTS shell sits under.
 */
import { useCallback, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useRtsNodes } from "../../lib/rts-selection";
import { state$ } from "../../lib/state";
import { use$ } from "@legendapp/state/react";
import {
  harnessDisplayName,
  reseatSeat,
  readSkipReseatConfirm,
  writeSkipReseatConfirm,
} from "../../lib/agent-reseat";
import {
  AgentHarnessPick,
  type AgentConfigurationChoices,
} from "../node-palette/AgentHarnessPick";
import { Popover } from "../ui";
import { KindKey } from "./RtsControls";
import { ReseatConfirmDialog } from "./ReseatConfirmDialog";

// Module-level so the popover's placement effect sees one stable array.
const POP_SIDES = ["above", "below"] as const;

export function AgentReseatControl({ nodeId }: { readonly nodeId: string }) {
  const canvasName = use$(state$.canvasName);
  const node = useRtsNodes(canvasName, [nodeId])[0];
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [pending, setPending] = useState<AgentConfigurationChoices | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const current = node?.kind === "agent" ? node.harness : undefined;
  const close = useCallback(() => setAnchor(null), []);

  const runReseat = useCallback(
    async (choices: AgentConfigurationChoices) => {
      setBusy(true);
      setError(undefined);
      const result = await reseatSeat(canvasName, nodeId, choices);
      setBusy(false);
      setPending(null);
      if (!result.ok) setError(result.message);
    },
    [canvasName, nodeId],
  );

  const onConfigure = useCallback(
    (choices: AgentConfigurationChoices) => {
      if (choices.harness === current && !choices.model && !choices.effort && !choices.profile && !choices.mode) {
        // Same bare harness with no deeper pick — no-op.
        close();
        return;
      }
      // The pick is made: the popover gives way to the confirm or the re-seat.
      close();
      if (readSkipReseatConfirm()) {
        void runReseat(choices);
        return;
      }
      setPending(choices);
    },
    [close, current, runReseat],
  );

  if (node?.kind !== "agent") return null;

  return (
    <div className="relative inline-flex">
      <KindKey
        label="Re-seat agent"
        title="Swap harness (stops current process, starts new seat)"
        active={anchor !== null}
        disabled={busy}
        // An open popup silences the key's tooltip, which would cover the list.
        data={{ "aria-haspopup": "dialog", "aria-expanded": String(anchor !== null) }}
        onClick={(event) => {
          setError(undefined);
          setAnchor(anchor ? null : event.currentTarget);
        }}
      >
        <RefreshCw size={12} className={busy ? "animate-spin" : undefined} />
      </KindKey>
      {anchor ? (
        <Popover
          anchor={anchor}
          onClose={close}
          label="Re-seat agent"
          sides={POP_SIDES}
          width={280}
          className="agent-reseat-pop"
        >
          <div className="agent-reseat-pop__title">Re-seat harness</div>
          <AgentHarnessPick
            currentHarness={current}
            cwd={node.launch?.cwd}
            onConfigure={onConfigure}
            listLabel="Available harnesses"
          />
        </Popover>
      ) : null}
      {error ? (
        <p className="m-0 text-[11px] text-crimson-fg" role="alert">
          {error}
        </p>
      ) : null}
      {pending ? (
        <ReseatConfirmDialog
          fromLabel={current ? harnessDisplayName(current) : "current seat"}
          toLabel={pending.mode
            ? `${harnessDisplayName(pending.harness)} (${pending.mode})`
            : harnessDisplayName(pending.harness)}
          onCancel={() => setPending(null)}
          onConfirm={(dontShowAgain) => {
            if (dontShowAgain) writeSkipReseatConfirm(true);
            void runReseat(pending);
          }}
        />
      ) : null}
    </div>
  );
}
