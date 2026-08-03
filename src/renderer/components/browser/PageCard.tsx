import { useEffect, useMemo } from "react";
import { use$ } from "@legendapp/state/react";
import type { CanvasNode } from "@shared/canvas";
import { formatNodeRef } from "@shared/node-ref";
import { Globe } from "lucide-react";
import { browserActivity } from "../../lib/activity";
import {
  refreshBrowserSession,
  subscribeBrowserSessionEvents,
  browser$,
} from "../../lib/browser-state";
import { dock$ } from "../../lib/dock-state";
import { hostOf } from "../../lib/presentation";
import { state$ } from "../../lib/state";
import { HUE, INK } from "../../lib/theme";
import { ExecutionCardHeader } from "../nodes/ExecutionCardHeader";

/**
 * Page card — identity + session ActivityMark only.
 * Open via double-click / RTS. No action buttons. No agent-seat “automating”
 * proxy (that lied when the seat was busy for other reasons).
 */
export function PageCard({ node }: { readonly node: CanvasNode }) {
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
  const stopError = use$(dock$.stopErrorByRef[pageRef ?? ""]);
  const docked = use$(() => {
    if (!pageRef) return false;
    return dock$.registry.surfaces.get().some((s) => s.kind === "browser" && s.id === pageRef);
  });
  const attaching = docked && !session?.attached;

  useEffect(() => {
    subscribeBrowserSessionEvents();
  }, []);

  useEffect(() => {
    if (!browser || !pageRef) return;
    void refreshBrowserSession(pageRef);
  }, [browser, pageRef]);

  if (!browser || !pageRef) {
    return <div className="text-xs text-faint">page unbound</div>;
  }

  const state = session?.state ?? "idle";
  const warm =
    state === "loading" ||
    state === "ready" ||
    state === "failed" ||
    state === "detached";
  const pageTitle = session?.title;
  const host = hostOf(url);
  const activity = browserActivity({ state, attaching });
  const displayTitle = warm && pageTitle ? pageTitle : host;
  const err = stopError ?? (state === "failed" ? session?.lastError : undefined);

  return (
    <div className="flex h-full w-full flex-col justify-between overflow-hidden">
      <ExecutionCardHeader
        decal={
          <div className="grid size-7 shrink-0 place-items-center rounded-md border border-amber/25 bg-amber/[0.07] text-amber">
            <Globe size={15} />
          </div>
        }
        title={
          <div
            className="truncate font-mono text-[14px] font-semibold leading-snug"
            style={{ color: INK }}
            title={url || displayTitle}
          >
            {displayTitle}
          </div>
        }
        subtitle={
          err ? (
            <span className="truncate" style={{ color: HUE.crimson }} title={err}>
              {err}
            </span>
          ) : undefined
        }
        activity={activity}
      />
    </div>
  );
}
