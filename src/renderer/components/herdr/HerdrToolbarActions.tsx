import { useEffect, useRef, useState, type ReactNode } from "react";
import { use$ } from "@legendapp/state/react";
import { PanelTopClose, RotateCw, SquareX } from "lucide-react";
import type { CanvasNode } from "@shared/canvas";
import { HERDR_SURFACE_HIDDEN } from "@shared/legacy-surfaces";
import { connectionStateOf, herdr$, openHerdrTerminal } from "../../lib/herdr-state";
import { killHerdrPane, killHerdrTab, recreateHerdrPane } from "../../lib/herdr-actions";
import { HUE } from "../../lib/theme";
import { OpenHerdrMark } from "./OpenHerdrMark";

const ARM_MS = 3000;

type HerdrAction = "kill-pane" | "kill-tab" | "recreate";

// Selection-toolbar herdr actions. Open is one-click (double-click on the card
// already does the same). Destructive actions stay two-click arm: first arms
// (crimson, ~3s), second executes. Never on the card body.
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

  // Herdr is hard-hidden as a product surface; keep component for dormant boards.
  if (HERDR_SURFACE_HIDDEN || !herdr) return null;

  const connState = conn?.state ?? connectionStateOf(node.id);
  const title = (node.type === "text" ? node.text : "").split("\n")[0] || "herdr";

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
          isArmed ? "" : "text-ink-2 hover:text-ink"
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
      <button
        aria-label="Open work surface"
        className="nodrag nopan grid size-7 place-items-center rounded text-[11px] transition hover:bg-white/10"
        style={{ color: HUE.cyan }}
        title="open work surface"
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          openHerdrTerminal(node.id, herdr, title);
        }}
      >
        <OpenHerdrMark size={14} />
      </button>
      {actionButton("kill-pane", "kill pane", <SquareX size={14} />)}
      {herdr.tabId ? actionButton("kill-tab", "kill tab", <PanelTopClose size={14} />) : null}
      {connState === "lost" || connState === "failed"
        ? actionButton("recreate", "recreate pane", <RotateCw size={14} />)
        : null}
    </>
  );
}
