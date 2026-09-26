import { useEffect, useRef, useState } from "react";
import { CircleStop, Pin, SquareTerminal } from "lucide-react";
import type { CanvasNode } from "@shared/canvas";
import { resolveTerminalBinding } from "@shared/terminal";
import { killTerminal, openTerminal } from "../../lib/terminal-actions";
import {
  isAgentTerminalSeat,
  killActionCopy,
  KILL_ARM_MS,
} from "../../lib/terminal-kill-ux";
import { Button, IconButton } from "../ui";

/**
 * Selection-toolbar actions for native terminal nodes.
 * Open is one-click; open-pinned lands in the side dock; stop ends the seat's
 * process in two clicks, and the armed second click reads as words ("Stop
 * process?") so the confirm is legible without a tooltip. Never on the card body.
 *
 * Icons share the toolbar steel chrome (IconButton default) — no per-action
 * accent colors. Crimson is reserved for the armed stop confirm only.
 */
export function TerminalToolbarActions({ node }: { readonly node: CanvasNode }) {
  const [armed, setArmed] = useState(false);
  const armTimer = useRef<number | null>(null);
  const binding = resolveTerminalBinding(node);
  const agentSeat =
    binding?.kind === "native" ? isAgentTerminalSeat(binding) : false;
  const stopCopy = killActionCopy({
    phase: armed ? "armed" : "idle",
    agentSeat,
  });

  useEffect(() => {
    return () => {
      if (armTimer.current !== null) window.clearTimeout(armTimer.current);
    };
  }, []);

  const disarm = () => {
    if (armTimer.current !== null) {
      window.clearTimeout(armTimer.current);
      armTimer.current = null;
    }
    setArmed(false);
  };

  const fireStop = () => {
    if (!armed) {
      if (armTimer.current !== null) window.clearTimeout(armTimer.current);
      setArmed(true);
      armTimer.current = window.setTimeout(() => {
        armTimer.current = null;
        setArmed(false);
      }, KILL_ARM_MS);
      return;
    }
    disarm();
    void killTerminal(node);
  };

  return (
    <>
      <IconButton
        className="nodrag nopan"
        aria-label="Open terminal"
        title="Open terminal"
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void openTerminal(node);
        }}
      >
        <SquareTerminal size={14} />
      </IconButton>
      <IconButton
        className="nodrag nopan"
        aria-label="Open terminal pinned"
        title="Open terminal pinned"
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void openTerminal(node, "pinned");
        }}
      >
        <Pin size={14} />
      </IconButton>
      {armed ? (
        <Button
          className="nodrag nopan"
          size="xs"
          variant="danger"
          aria-label={stopCopy.ariaLabel}
          title={stopCopy.title}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            fireStop();
          }}
        >
          <CircleStop size={11} aria-hidden />
          {stopCopy.label}
        </Button>
      ) : (
        <IconButton
          className="nodrag nopan"
          aria-label={stopCopy.ariaLabel}
          title={stopCopy.title}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            fireStop();
          }}
        >
          <CircleStop size={14} />
        </IconButton>
      )}
    </>
  );
}
