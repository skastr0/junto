import { useEffect, useRef, useState, type ReactNode } from "react";
import { use$ } from "@legendapp/state/react";
import { PanelTopClose, RotateCw, SquareX } from "lucide-react";
import type { CanvasNode } from "@shared/canvas";
import { connectionStateOf, herdr$, openHerdrTerminal } from "../../lib/herdr-state";
import { killHerdrPane, killHerdrTab, recreateHerdrPane } from "../../lib/herdr-actions";
import { HUE } from "../../lib/theme";
import { IconButton } from "../ui";
import { OpenHerdrMark } from "./OpenHerdrMark";

const ARM_MS = 3000;

type HerdrAction = "kill-pane" | "kill-tab" | "recreate";

// Selection-toolbar herdr actions. Open is one-click (double-click on the card
// already does the same). Destructive actions stay two-click arm: first arms
// (crimson, ~3s), second executes. Never on the card body.
//
// Icons share the toolbar steel chrome (IconButton default) — no per-action
// accent colors. Crimson is reserved for armed confirm only.
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
      <IconButton
        className="nodrag nopan"
        aria-label={isArmed ? `confirm ${label}` : label}
        title={isArmed ? `confirm ${label}` : label}
        style={isArmed ? { color: HUE.crimson } : undefined}
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          fire(action);
        }}
      >
        {icon}
      </IconButton>
    );
  };

  return (
    <>
      <IconButton
        className="nodrag nopan"
        aria-label="Open work surface"
        title="open work surface"
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          openHerdrTerminal(node.id, herdr, title);
        }}
      >
        <OpenHerdrMark size={14} />
      </IconButton>
      {actionButton("kill-pane", "kill pane", <SquareX size={14} />)}
      {herdr.tabId ? actionButton("kill-tab", "kill tab", <PanelTopClose size={14} />) : null}
      {connState === "lost" || connState === "failed"
        ? actionButton("recreate", "recreate pane", <RotateCw size={14} />)
        : null}
    </>
  );
}
