import { useMemo } from "react";
import { use$ } from "@legendapp/state/react";
import { Globe, SquareX } from "lucide-react";
import type { NodeOf } from "@shared/model";
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
export function PageToolbarActions({ node }: { readonly node: NodeOf<"page"> }) {
  const browser = useMemo(() => ({ profile: node.profile, host: node.host, onDelete: node.onRemove }), [node.profile, node.host, node.onRemove]);
  const url = node.url;
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

  const open = () => {
    void openDockBrowser(pageRef, {
      nodeId: node.id,
      browser,
      url,
      title: session?.title ?? hostOf(url),
    });
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
          open();
        }}
      >
        <Globe size={14} />
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
