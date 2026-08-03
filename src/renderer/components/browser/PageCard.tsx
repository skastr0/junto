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
import { closeDockBrowser, dock$, openDockBrowser, stopDockBrowser } from "../../lib/dock-state";
import { hostOf } from "../../lib/presentation";
import { state$ } from "../../lib/state";
import { HUE, INK } from "../../lib/theme";
import { ExecutionCardHeader } from "../nodes/ExecutionCardHeader";

/**
 * Browser page work-surface card — rendered by LinkNode.tsx for kind "page" +
 * ether.browser nodes. Session state is runtime (browser$); the document only
 * carries the profile binding. ActivityMark waves while loading/attaching;
 * idle is silent (same as terminal / schedulers).
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
  // Per-ref selectors — do not subscribe to the whole session/registry maps.
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
  const warm = state === "loading" || state === "ready" || state === "failed" || state === "detached";
  const pageTitle = session?.title;
  const host = hostOf(url);
  const activity =
    session?.lastError && state === "failed"
      ? { ...browserActivity({ state, attaching }), label: session.lastError }
      : browserActivity({ state, attaching });
  const displayTitle = warm && pageTitle ? pageTitle : host;
  const subtitle = [browser.profile, url].filter(Boolean).join(" · ");

  const open = () => {
    void openDockBrowser(pageRef, {
      nodeId: node.id,
      browser,
      url,
      title: pageTitle ?? host,
    });
  };
  const detach = () => {
    closeDockBrowser(pageRef);
  };
  const stop = () => {
    void stopDockBrowser(pageRef);
  };

  return (
    <div className="flex h-full w-full flex-col justify-between overflow-hidden">
      <ExecutionCardHeader
        decal={
          <div className="grid size-7 shrink-0 place-items-center rounded-md border border-amber/25 bg-amber/[0.07] text-amber">
            <Globe size={15} />
          </div>
        }
        title={
          <button
            type="button"
            className="nodrag nopan w-full truncate text-left font-mono text-[14px] font-semibold leading-snug"
            style={{ color: INK }}
            title="Attach browser surface"
            onClick={(e) => {
              e.stopPropagation();
              open();
            }}
          >
            {displayTitle}
          </button>
        }
        subtitle={
          <span className="truncate" title={url}>
            {subtitle}
          </span>
        }
        activity={activity}
      />
      <div className="nodrag nopan flex flex-wrap items-center gap-1 pt-0.5">
        <button
          type="button"
          className="rounded border border-white/10 px-1.5 py-0.5 text-[9px] text-ink-2 hover:bg-white/10"
          onClick={(e) => {
            e.stopPropagation();
            open();
          }}
        >
          open
        </button>
        {session?.attached ? (
          <button
            type="button"
            className="rounded border border-white/10 px-1.5 py-0.5 text-[9px] text-ink-2 hover:bg-white/10"
            onClick={(e) => {
              e.stopPropagation();
              detach();
            }}
          >
            detach
          </button>
        ) : null}
        {warm ? (
          <button
            type="button"
            className="rounded border border-red-400/20 px-1.5 py-0.5 text-[9px] text-red-200 hover:bg-red-400/10"
            title="Destroy this page runtime; profile cookies remain"
            onClick={(e) => {
              e.stopPropagation();
              stop();
            }}
          >
            stop page
          </button>
        ) : null}
        {stopError || session?.lastError ? (
          <span
            className="truncate text-[9px]"
            style={{ color: HUE.crimson }}
            title={stopError ?? session?.lastError}
            role={stopError ? "alert" : undefined}
          >
            {stopError ?? session?.lastError}
          </span>
        ) : null}
      </div>
    </div>
  );
}
