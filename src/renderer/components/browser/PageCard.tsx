import { useEffect } from "react";
import { use$ } from "@legendapp/state/react";
import type { CanvasNode } from "@shared/canvas";
import {
  closeBrowserSurface,
  openBrowserSurface,
  refreshBrowserSession,
  subscribeBrowserSessionEvents,
  browser$,
} from "../../lib/browser-state";
import { hostOf } from "../../lib/presentation";
import { DIM, HUE, INK, withAlpha } from "../../lib/theme";

const STATUS_COLOR: Record<string, string> = {
  idle: HUE.steel,
  loading: HUE.amber,
  ready: "#5bb98c",
  failed: HUE.crimson,
  detached: HUE.steel,
  destroyed: DIM,
};

/**
 * Browser page work-surface card — rendered by LinkNode.tsx for kind "page" +
 * ether.browser nodes. Mirrors HerdrCard.tsx's shape (profile chip instead of
 * host/pane, live title instead of agent preview): session state is entirely
 * runtime (browser$), the document only ever carries the profile binding.
 */
export function PageCard({ node }: { readonly node: CanvasNode }) {
  const browser = node.ether?.browser;
  const url = node.type === "link" ? node.url : "";
  const session = use$(browser$.sessionByNodeId[node.id]);
  const surface = use$(browser$.surface);
  const attaching = surface?.nodeId === node.id && !session?.attached;

  useEffect(() => {
    subscribeBrowserSessionEvents();
  }, []);

  useEffect(() => {
    if (!browser) return;
    void refreshBrowserSession(node.id);
  }, [node.id, browser]);

  if (!browser) {
    return <div className="text-xs text-slate-500">page unbound</div>;
  }

  const state = session?.state ?? "idle";
  const warm = state === "loading" || state === "ready" || state === "failed" || state === "detached";
  const title = session?.title;
  const host = hostOf(url);
  const statusColor = STATUS_COLOR[state] ?? HUE.steel;

  const open = () => {
    void openBrowserSurface(node.id, browser, url, title ?? host);
  };
  const detach = () => {
    // Explicit nodeId — always targets THIS session, regardless of which
    // node's surface the portal currently shows (or whether it's open at all).
    closeBrowserSurface(node.id);
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
          <span
            className="size-[5px] shrink-0 rounded-full"
            style={{ background: statusColor, boxShadow: `0 0 6px ${withAlpha(statusColor, 0.6)}` }}
            title={state}
          />
        </div>
        <button
          type="button"
          className="nodrag nopan mt-1 w-full truncate text-left text-[14px] font-semibold leading-snug"
          style={{ color: INK, fontFamily: "ui-monospace, SFMono-Regular, monospace" }}
          title="Attach browser surface"
          onClick={(e) => {
            e.stopPropagation();
            open();
          }}
        >
          {warm && title ? title : host}
        </button>
        <div className="mt-0.5 truncate text-[10px]" style={{ color: DIM }} title={url}>
          {url}
        </div>
      </div>
      <div className="nodrag nopan flex flex-wrap items-center gap-1 pt-0.5">
        <button
          type="button"
          className="rounded border border-white/10 px-1.5 py-0.5 text-[9px] text-slate-300 hover:bg-white/10"
          onClick={(e) => {
            e.stopPropagation();
            open();
          }}
        >
          {attaching ? "attaching…" : "open"}
        </button>
        {session?.attached ? (
          <button
            type="button"
            className="rounded border border-white/10 px-1.5 py-0.5 text-[9px] text-slate-300 hover:bg-white/10"
            onClick={(e) => {
              e.stopPropagation();
              detach();
            }}
          >
            detach
          </button>
        ) : null}
        {session?.lastError ? (
          <span className="truncate text-[9px]" style={{ color: HUE.crimson }} title={session.lastError}>
            {session.lastError}
          </span>
        ) : null}
      </div>
    </div>
  );
}
