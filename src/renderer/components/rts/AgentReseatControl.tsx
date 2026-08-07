/**
 * RTS command-card control: re-seat a managed agent onto another harness.
 * Reuses AgentHarnessPick (palette rules) + confirmation for process kill.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
import { Button } from "../ui";
import { KindKey } from "./RtsControls";

const currentHarnessOf = (node: CanvasNode): HarnessId | undefined => {
  const binding = resolveTerminalBinding(node);
  if (binding?.kind !== "native" || !binding.harness) return undefined;
  return binding.harness as HarnessId;
};

function ReseatConfirmDialog({
  fromLabel,
  toLabel,
  onConfirm,
  onCancel,
}: {
  readonly fromLabel: string;
  readonly toLabel: string;
  readonly onConfirm: (dontShowAgain: boolean) => void;
  readonly onCancel: () => void;
}) {
  const [dontShowAgain, setDontShowAgain] = useState(false);
  return createPortal(
    <div className="agent-reseat-confirm" role="alertdialog" aria-modal="true" aria-labelledby="reseat-title">
      <button
        type="button"
        className="agent-reseat-confirm__backdrop"
        aria-label="Cancel re-seat"
        onClick={onCancel}
      />
      <div className="agent-reseat-confirm__card">
        <strong id="reseat-title">Re-seat agent process</strong>
        <p>
          Swapping from <em>{fromLabel}</em> to <em>{toLabel}</em> stops the
          current agent process and starts a new one on a fresh seat. Unsaved
          in-process work in the old harness will be lost.
        </p>
        <label className="agent-reseat-confirm__check">
          <input
            type="checkbox"
            checked={dontShowAgain}
            onChange={(event) => setDontShowAgain(event.target.checked)}
          />
          Do not show again
        </label>
        <div className="agent-reseat-confirm__actions">
          <Button size="sm" variant="chrome" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() => onConfirm(dontShowAgain)}
          >
            Stop and re-seat
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function AgentReseatControl({ node }: { readonly node: CanvasNode }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<AgentConfigurationChoices | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const rootRef = useRef<HTMLDivElement>(null);
  const current = currentHarnessOf(node);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending) {
        event.preventDefault();
        setOpen(false);
      }
    };
    const onPointer = (event: PointerEvent) => {
      if (pending) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (rootRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest(".agent-cascade")) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer, true);
    };
  }, [open, pending]);

  const runReseat = useCallback(
    async (choices: AgentConfigurationChoices) => {
      if (node.type !== "text") return;
      setBusy(true);
      setError(undefined);
      const result = await performManagedAgentReseat(node as TextNode, choices);
      setBusy(false);
      setPending(null);
      setOpen(false);
      if (!result.ok) setError(result.message);
    },
    [node],
  );

  const onConfigure = useCallback(
    (choices: AgentConfigurationChoices) => {
      if (choices.harness === current && !choices.model && !choices.effort && !choices.profile) {
        // Same bare harness with no deeper pick — no-op.
        setOpen(false);
        return;
      }
      if (readSkipReseatConfirm()) {
        void runReseat(choices);
        return;
      }
      setPending(choices);
    },
    [current, runReseat],
  );

  if (node.ether?.entity?.kind !== "agent") return null;
  if (resolveTerminalBinding(node)?.kind !== "native") return null;

  return (
    <div className="relative inline-flex" ref={rootRef}>
      <KindKey
        label="Re-seat agent"
        title="Swap harness (stops current process, starts new seat)"
        active={open}
        disabled={busy}
        onClick={() => {
          setError(undefined);
          setOpen((v) => !v);
        }}
      >
        <RefreshCw size={12} className={busy ? "animate-spin" : undefined} />
      </KindKey>
      {open ? (
        <div className="agent-reseat-pop" role="dialog" aria-label="Re-seat agent">
          <div className="agent-reseat-pop__title">Re-seat harness</div>
          <AgentHarnessPick
            currentHarness={current}
            onConfigure={onConfigure}
            listLabel="Available harnesses"
          />
          {error ? (
            <p className="m-0 text-[11px] text-crimson" role="alert">
              {error}
            </p>
          ) : null}
        </div>
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
