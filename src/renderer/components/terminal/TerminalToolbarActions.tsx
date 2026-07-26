import { useEffect, useRef, useState } from "react";
import { Pin, SquareTerminal, SquareX } from "lucide-react";
import type { CanvasNode } from "@shared/canvas";
import { killTerminal, openTerminal } from "../../lib/terminal-actions";
import { HUE } from "../../lib/theme";

const ARM_MS = 3000;

/**
 * Selection-toolbar actions for native terminal nodes.
 * Open is one-click; open-pinned lands in the side dock; kill is two-click arm
 * (same pattern as HerdrToolbarActions). Never on the card body.
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
      <button
        type="button"
        aria-label="Open terminal"
        className="nodrag nopan grid size-7 place-items-center rounded text-[11px] transition hover:bg-white/10"
        style={{ color: HUE.cyan }}
        title="open terminal"
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void openTerminal(node);
        }}
      >
        <SquareTerminal size={14} />
      </button>
      <button
        type="button"
        aria-label="Open terminal pinned"
        className="nodrag nopan grid size-7 place-items-center rounded text-[11px] transition hover:bg-white/10"
        style={{ color: HUE.cyan }}
        title="open terminal pinned"
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void openTerminal(node, "pinned");
        }}
      >
        <Pin size={14} />
      </button>
      <button
        type="button"
        aria-label={armed ? "confirm kill session" : "kill session"}
        className={`nodrag nopan grid size-7 place-items-center rounded text-[11px] transition hover:bg-white/10 ${
          armed ? "" : "text-ink-2 hover:text-ink"
        }`}
        style={armed ? { color: HUE.crimson } : undefined}
        title={armed ? "confirm kill session" : "kill session"}
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          fireKill();
        }}
      >
        <SquareX size={14} />
      </button>
    </>
  );
}
