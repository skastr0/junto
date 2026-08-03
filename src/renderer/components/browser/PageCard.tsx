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
import { ActivityMarkFromSpec } from "../ActivityMark";

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

  const errored = Boolean(stopError || session?.lastError);
  const frameClassName = [
    "special-page",
    `is-${state}`,
    attaching ? "is-attaching" : "",
    session?.attached ? "is-attached" : "",
    warm && !session?.attached ? "is-warm-detached" : "",
    errored ? "is-error" : "",
  ].filter(Boolean).join(" ");

  return (
    <div className={frameClassName} role="group" aria-label={`${displayTitle}, ${activity.label}`}>
      {warm ? <div className="special-page__runtime-shadow" aria-hidden="true" /> : null}
      <div className="special-page__frame">
        <div className="special-page__inner">
          <div className="special-page__tabline">
            <span className="special-page__profile">{browser.profile}</span>
            <ActivityMarkFromSpec spec={activity} size="inline" className="special-page__activity" />
          </div>
          <button
            type="button"
            className="special-page__title nodrag nopan"
            style={{ color: INK }}
            title="Attach browser surface"
            onClick={(event) => {
              event.stopPropagation();
              open();
            }}
          >
            <Globe size={14} aria-hidden="true" />
            <span>{displayTitle}</span>
          </button>
          <div className="special-page__url" title={url}>{subtitle}</div>
          <div className="special-page__actions nodrag nopan">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                open();
              }}
            >
              open
            </button>
            {session?.attached ? (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  detach();
                }}
              >
                detach
              </button>
            ) : null}
            {warm ? (
              <button
                type="button"
                className="special-page__stop"
                title="Destroy this page runtime; profile cookies remain"
                onClick={(event) => {
                  event.stopPropagation();
                  stop();
                }}
              >
                stop
              </button>
            ) : null}
          </div>
          {errored ? (
            <span
              className="special-page__error"
              style={{ color: HUE.crimson }}
              title={stopError ?? session?.lastError}
              role={stopError ? "alert" : undefined}
            >
              {stopError ?? session?.lastError}
            </span>
          ) : null}
          <span className="special-page__dock" aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}
