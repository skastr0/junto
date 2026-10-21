import { useEffect, useMemo } from "react";
import { use$ } from "@legendapp/state/react";
import type { NodeOf } from "@shared/model";
import { formatNodeRef } from "@shared/node-ref";
import { RegionUrgency } from "@shared/wire/urgency";
import { Globe } from "lucide-react";
import { refreshBrowserSession, subscribeBrowserSessionEvents, browser$ } from "../../lib/browser-state";
import { dock$ } from "../../lib/dock-state";
import { pageDriving$, refreshPageDriving, subscribePageDriving } from "../../lib/page-driving";
import { hostOf } from "../../lib/presentation";
import { state$ } from "../../lib/state";
import { useNodeUrgency } from "../../lib/use-node-urgency";
import { SpineCard } from "../nodes/SpineCard";

/**
 * Page, in the Spines language (docs/node-card-language.md): a leaf chip, the
 * host as its name and the full address as its hover title, then "browser
 * page, <profile>". Working while a seat drives it; Failed, with the error as
 * the line, when the page or the operator's action on it failed. Nothing
 * while it loads or while the operator holds it. Open by double-click or RTS;
 * no action buttons.
 */
export function PageCard({ node }: { readonly node: NodeOf<"page"> }) {
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
  const opError = use$(dock$.opErrorByRef[pageRef ?? ""]);
  const working = use$(pageDriving$.workingByRef[pageRef ?? ""]) ?? false;
  // Operator action failures outrank a session's own last error: the
  // operator can act on the first, the second is context.
  const err = opError?.message ?? (session?.state === "failed" ? session.lastError : undefined);
  // A failed page leans its region frame to it at overview (Failed counts as blocked).
  useNodeUrgency(node.id, err !== undefined ? RegionUrgency.group.blocked : undefined);

  useEffect(() => {
    subscribeBrowserSessionEvents();
    subscribePageDriving();
  }, []);

  useEffect(() => {
    if (!pageRef) return;
    void refreshBrowserSession(pageRef).then(() => refreshPageDriving(pageRef));
  }, [pageRef]);

  if (!pageRef) {
    return <div className="text-xs text-faint">page unbound</div>;
  }

  const host = hostOf(url);

  return (
    <div className="h-full w-full" title={url || host}>
      <SpineCard
        glyph={<Globe size={15} />}
        hue="indigo"
        name={host}
        {...(err !== undefined ? { status: "failed" as const } : working ? { status: "working" as const } : {})}
        body={{ kind: "leaf", line: err ?? `browser page, ${node.profile}` }}
      />
    </div>
  );
}
