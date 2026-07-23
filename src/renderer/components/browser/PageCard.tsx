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
import { DIM, HUE, INK, withAlpha } from "../../lib/theme";
import { ActivityMarkFromSpec } from "../ActivityMark";

/**
 * Browser page work-surface card — rendered by LinkNode.tsx for kind "page" +
 * ether.browser nodes. Session state is runtime (browser$); the document only
 * carries the profile binding. ActivityMark: wave while loading/attaching.
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
  const title = session?.title;
  const host = hostOf(url);
  const activity = browserActivity({ state, attaching });

  const open = () => {
    void openDockBrowser(pageRef, {
      nodeId: node.id,
      browser,
      url,
      title: title ?? host,
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
      <div>
        <div className="flex items-center justify-between gap-2">
          <span
            className="rounded-full border px-1.5 py-px text-[8px] font-semibold uppercase tracking-wide"
            style={{ color: HUE.cyan, borderColor: withAlpha(HUE.cyan, 0.4) }}
            title={`profile · ${browser.profile}`}
          >
            {browser.profile}
          </span>
          <ActivityMarkFromSpec
            spec={
              session?.lastError && state === "failed"
                ? { ...activity, label: session.lastError }
                : activity
            }
          />
        </div>
        <button
          type="button"
          className="nodrag nopan mt-1 flex w-full items-center gap-1.5 text-left"
          title="Attach browser surface"
          onClick={(e) => {
            e.stopPropagation();
            open();
          }}
        >
          <Globe size={13} className="shrink-0" style={{ color: HUE.steel }} />
          <span
            className="truncate font-mono text-[14px] font-semibold leading-snug"
            style={{ color: INK }}
          >
            {warm && title ? title : host}
          </span>
        </button>
        <div className="mt-0.5 truncate text-[10px]" style={{ color: DIM }} title={url}>
          {url}
        </div>
      </div>
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
