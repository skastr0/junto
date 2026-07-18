import { useEffect, useRef, useState, type ReactNode } from "react";
import { use$ } from "@legendapp/state/react";
import { PanelTopClose, RotateCw, SquareX } from "lucide-react";
import type { CanvasNode } from "@shared/canvas";
import { connectionStateOf, herdr$ } from "../../lib/herdr-state";
import { killHerdrPane, killHerdrTab, recreateHerdrPane } from "../../lib/herdr-actions";
import { HUE } from "../../lib/theme";

const ARM_MS = 3000;

type HerdrAction = "kill-pane" | "kill-tab" | "recreate";

// Destructive herdr actions live in the floating selection toolbar, never on
// the card body. Every action is a two-click arm: first click arms (crimson,
// ~3s window), second click executes. No modal.
export function HerdrToolbarActions({ node }: { readonly node: CanvasNode }) {
  const herdr = node.ether?.herdr;
  const conn = use$(herdr$.connectionByNodeId[node.id]);
  const [armed, setArmed] = useState<HerdrAction | null>(null);
  const armTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (armTimer.current !== null) window.clearTimeout(armTimer.current);
    };
  }, []);

  if (!herdr) return null;

  const connState = conn?.state ?? connectionStateOf(node.id);

  const disarm = () => {
    if (armTimer.current !== null) {
      window.clearTimeout(armTimer.current);
      armTimer.current = null;
    }
    setArmed(null);
  };

  const fire = (action: HerdrAction) => {
    if (armed !== action) {
      if (armTimer.current !== null) window.clearTimeout(armTimer.current);
      setArmed(action);
      armTimer.current = window.setTimeout(() => {
        armTimer.current = null;
        setArmed(null);
      }, ARM_MS);
      return;
    }
    disarm();
    if (action === "kill-pane") void killHerdrPane(node.id, herdr);
    else if (action === "kill-tab") void killHerdrTab(node.id, herdr);
    else void recreateHerdrPane(node.id, herdr);
  };

  const actionButton = (action: HerdrAction, label: string, icon: ReactNode) => {
    const isArmed = armed === action;
    return (
      <button
        aria-label={isArmed ? `confirm ${label}` : label}
        className={`nodrag nopan grid size-7 place-items-center rounded text-[11px] transition hover:bg-white/10 ${
          isArmed ? "" : "text-slate-300 hover:text-[#EDE6DA]"
        }`}
        style={isArmed ? { color: HUE.crimson } : undefined}
        title={isArmed ? `confirm ${label}` : label}
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          fire(action);
        }}
      >
        {icon}
      </button>
    );
  };

  return (
    <>
      {actionButton("kill-pane", "kill pane", <SquareX size={14} />)}
      {herdr.tabId ? actionButton("kill-tab", "kill tab", <PanelTopClose size={14} />) : null}
      {connState === "lost" || connState === "failed"
        ? actionButton("recreate", "recreate pane", <RotateCw size={14} />)
        : null}
    </>
  );
}
