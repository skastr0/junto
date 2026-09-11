import { useMemo } from "react";
import { use$ } from "@legendapp/state/react";
import { Globe, Pin, SquareX } from "lucide-react";
import type { CanvasNode } from "@shared/canvas";
import { formatNodeRef } from "@shared/node-ref";
import { browser$ } from "../../lib/browser-state";
import { openDockBrowser, stopDockBrowser } from "../../lib/dock-state";
import { hostOf } from "../../lib/presentation";
import { state$ } from "../../lib/state";
import { useTwoClickArm } from "../../lib/two-click-arm";
import { HUE } from "../../lib/theme";
import { IconButton } from "../ui";

/**
 * Selection-toolbar page actions. Open is one-click (double-click on the card
 * does the same). Stop is two-click arm. Never on the card body.
 */
export function PageToolbarActions({ node }: { readonly node: CanvasNode }) {
  const browser = node.ether?.browser;
  const url = node.type === "link" ? node.url : "";
  const canvasName = use$(state$.canvasName);
  const pageRef = useMemo(() => {
    try {
      return formatNodeRef({ canvasName, nodeId: node.id });
    } catch {
      return undefined;
    }
  }, [canvasName, node.id]);
  const session = use$(browser$.sessionByRef[pageRef ?? ""]);
  const { armed, arm } = useTwoClickArm(() => {
    if (pageRef) void stopDockBrowser(pageRef);
  });

  if (!browser || !pageRef) return null;

  const open = (zone: "focus" | "pinned" = "focus") => {
    void openDockBrowser(
      pageRef,
      {
        nodeId: node.id,
        browser,
        url,
        title: session?.title ?? hostOf(url),
      },
      zone,
    );
  };

  return (
    <>
      <IconButton
        className="nodrag nopan"
        aria-label="Open page"
        title="Open page"
        data-testid="node-toolbar-page-open"
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          open("focus");
        }}
      >
        <Globe size={14} />
      </IconButton>
      <IconButton
        className="nodrag nopan"
        aria-label="Open page pinned"
        title="Open page pinned"
        data-testid="node-toolbar-page-pin"
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          open("pinned");
        }}
      >
        <Pin size={14} />
      </IconButton>
      <IconButton
        className="nodrag nopan"
        aria-label={armed ? "Confirm stop page" : "Stop page"}
        title={armed ? "Confirm stop page" : "Stop page"}
        data-testid="node-toolbar-page-stop"
        style={armed ? { color: HUE.crimson } : undefined}
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          arm();
        }}
      >
        <SquareX size={14} />
      </IconButton>
    </>
  );
}
