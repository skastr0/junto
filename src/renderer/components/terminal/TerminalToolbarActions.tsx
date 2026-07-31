import { useEffect, useRef, useState } from "react";
import { Pin, SquareTerminal, SquareX } from "lucide-react";
import type { CanvasNode } from "@shared/canvas";
import { killTerminal, openTerminal } from "../../lib/terminal-actions";
import { HUE } from "../../lib/theme";
import { IconButton } from "../ui";

const ARM_MS = 3000;

/**
 * Selection-toolbar actions for native terminal nodes.
 * Open is one-click; open-pinned lands in the side dock; kill is two-click arm
 * (same pattern as HerdrToolbarActions). Never on the card body.
 *
 * Icons share the toolbar steel chrome (IconButton default) — no per-action
 * accent colors. Crimson is reserved for the armed kill confirm only.
 */
export function TerminalToolbarActions({ node }: { readonly node: CanvasNode }) {
  const [armed, setArmed] = useState(false);
  const armTimer = useRef<number | null>(null);

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

  const fireKill = () => {
    if (!armed) {
      if (armTimer.current !== null) window.clearTimeout(armTimer.current);
      setArmed(true);
      armTimer.current = window.setTimeout(() => {
        armTimer.current = null;
        setArmed(false);
      }, ARM_MS);
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
        title="open terminal"
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
        title="open terminal pinned"
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void openTerminal(node, "pinned");
        }}
      >
        <Pin size={14} />
      </IconButton>
      <IconButton
        className="nodrag nopan"
        aria-label={armed ? "confirm kill session" : "kill session"}
        title={armed ? "confirm kill session" : "kill session"}
        style={armed ? { color: HUE.crimson } : undefined}
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          fireKill();
        }}
      >
        <SquareX size={14} />
      </IconButton>
    </>
  );
}
