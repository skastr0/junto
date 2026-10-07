/**
 * RTS command-card control: re-seat a managed agent onto another harness.
 * Reuses AgentHarnessPick (palette rules) + confirmation for process kill.
 *
 * The pick surface is a ui Popover above the key: it portals to the body, so
 * it clears the canvas the RTS shell sits under.
 */
import { useCallback, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { CanvasNode, TextNode } from "@shared/canvas";
import { resolveTerminalBinding } from "@shared/terminal";
import type { HarnessId } from "@shared/managed-terminal-templates";
import {
  harnessDisplayName,
  performManagedAgentReseat,
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

const currentHarnessOf = (node: CanvasNode): HarnessId | undefined => {
  const binding = resolveTerminalBinding(node);
  if (binding?.kind !== "native" || !binding.harness) return undefined;
  return binding.harness as HarnessId;
};

// Module-level so the popover's placement effect sees one stable array.
const POP_SIDES = ["above", "below"] as const;

export function AgentReseatControl({ node }: { readonly node: CanvasNode }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [pending, setPending] = useState<AgentConfigurationChoices | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const current = currentHarnessOf(node);
  const close = useCallback(() => setAnchor(null), []);

  const runReseat = useCallback(
    async (choices: AgentConfigurationChoices) => {
      if (node.type !== "text") return;
      setBusy(true);
      setError(undefined);
      const result = await performManagedAgentReseat(node as TextNode, choices);
      setBusy(false);
      setPending(null);
      if (!result.ok) setError(result.message);
    },
    [node],
  );

  const onConfigure = useCallback(
    (choices: AgentConfigurationChoices) => {
      if (choices.harness === current && !choices.model && !choices.effort && !choices.profile) {
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

  if (node.ether?.entity?.kind !== "agent") return null;
  if (resolveTerminalBinding(node)?.kind !== "native") return null;

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
          toLabel={harnessDisplayName(pending.harness)}
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
