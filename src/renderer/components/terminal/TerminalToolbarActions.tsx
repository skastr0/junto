import { useEffect, useRef, useState } from "react";
import { PINNING_ENABLED } from "@shared/features";
import { CircleStop, Compass, Pin, SquareTerminal } from "lucide-react";
import type { CanvasNode } from "@shared/canvas";
import { resolveTerminalBinding } from "@shared/terminal";
import { sendOnboardNudge, useSeatOnboarding } from "../../lib/seat-onboarding";
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
 * A seat whose agent has not onboarded also gets the nudge: one click types
 * the one-sentence pointer to `junto onboard`, and a refusal reads as words.
 *
 * Icons share the toolbar steel chrome (IconButton default) — no per-action
 * accent colors. Crimson is reserved for the armed stop confirm only.
 */
export function TerminalToolbarActions({ node }: { readonly node: CanvasNode }) {
  const [armed, setArmed] = useState(false);
  const onboarding = useSeatOnboarding(node);
  const [nudgeProblem, setNudgeProblem] = useState<string | undefined>();
  const [nudging, setNudging] = useState(false);
  const nudge = async () => {
    setNudging(true);
    setNudgeProblem(undefined);
    const result = await sendOnboardNudge(node.id);
    setNudging(false);
    if (!result.ok) setNudgeProblem(result.message);
  };
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
      {PINNING_ENABLED ? (
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
      ) : null}
      {agentSeat && onboarding === "not-onboarded" ? (
        nudgeProblem ? (
          <Button
            className="nodrag nopan"
            size="xs"
            aria-label={`Onboarding nudge not sent. ${nudgeProblem}`}
            title={`${nudgeProblem} Click to try again.`}
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void nudge();
            }}
          >
            <Compass size={11} aria-hidden />
            Not sent
          </Button>
        ) : (
          <IconButton
            className="nodrag nopan"
            aria-label="Send onboarding nudge"
            title="Not onboarded. Send the onboarding nudge"
            disabled={nudging}
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void nudge();
            }}
          >
            <Compass size={14} />
          </IconButton>
        )
      ) : null}
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
