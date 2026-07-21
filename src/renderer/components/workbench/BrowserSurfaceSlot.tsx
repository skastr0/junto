import { useEffect, useRef, useState } from "react";
import { use$ } from "@legendapp/state/react";
import type { VellumBrowserApi } from "@shared/ipc";
import { browser$ } from "../../lib/browser-state";
import {
  closeDockBrowser,
  dock$,
  pinWorkbenchSurface,
  stopDockBrowser,
  unpinWorkbenchSurface,
} from "../../lib/dock-state";
import type { WorkZone } from "../../lib/surface-registry";
import { getVellumApi } from "../../lib/vellum-api";

type BrowserApi = ReturnType<typeof getVellumApi> & Partial<VellumBrowserApi>;

const ZERO_BOUNDS = { x: 0, y: 0, width: 0, height: 0 } as const;

/**
 * Browser workbench body: plain DOM placeholder — WebContentsView is never
 * parented here. Measured rect is pushed over browserSetBounds so main paints
 * the native view above the window at this spot.
 *
 * When `visible` is false (tabbed away), bounds are zeroed so the native view
 * does not ghost over chrome. The slot stays mounted for keep-alive.
 */
export function BrowserSurfaceSlot({
  pageRef,
  zone,
  visible = true,
  onActivate,
}: {
  readonly pageRef: string;
  readonly zone: WorkZone;
  readonly visible?: boolean;
  readonly onActivate?: () => void;
}) {
  const payload = use$(dock$.browserByRef[pageRef]);
  const session = use$(browser$.sessionByRef[pageRef]);
  const stopError = use$(dock$.stopErrorByRef[pageRef]);
  const sessionId = session?.sessionId;
  const bodyRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("attaching…");

  useEffect(() => {
    if (!sessionId) {
      setStatus("waiting for session…");
      return;
    }
    const api = getVellumApi() as BrowserApi | undefined;
    if (!api?.browserSetBounds) {
      setStatus("browser surface API unavailable");
      return;
    }

    let cancelled = false;
    let rafId: number | null = null;

    const pushBounds = () => {
      rafId = null;
      if (cancelled) return;
      if (!visible) {
        setStatus("parked");
        void api.browserSetBounds!(sessionId, { ...ZERO_BOUNDS });
        return;
      }
      const el = bodyRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      setStatus("attached");
      void api.browserSetBounds!(sessionId, {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
    };

    const scheduleBounds = () => {
      if (rafId != null) return;
      rafId = requestAnimationFrame(pushBounds);
    };

    scheduleBounds();
    window.addEventListener("resize", scheduleBounds);
    let resizeObs: ResizeObserver | undefined;
    const el = bodyRef.current;
    if (visible && el && typeof ResizeObserver !== "undefined") {
      resizeObs = new ResizeObserver(() => scheduleBounds());
      resizeObs.observe(el);
    }

    return () => {
      cancelled = true;
      window.removeEventListener("resize", scheduleBounds);
      resizeObs?.disconnect();
      if (rafId != null) cancelAnimationFrame(rafId);
      // Hide native view when this effect ends (unmount or session change).
      void api.browserSetBounds?.(sessionId, { ...ZERO_BOUNDS }).catch(() => undefined);
    };
  }, [pageRef, sessionId, visible]);

  if (!payload) return null;

  const pinned = zone === "pinned";

  return (
    <section
      className="dock-slot workbench-surface"
      aria-label="Browser page surface"
      aria-hidden={!visible}
      onMouseDown={() => onActivate?.()}
    >
      {visible ? (
        <header className="browser-modal-header dock-slot__header">
          <div className="browser-modal-header__meta min-w-0">
            <div className="browser-modal-eyebrow">
              page · {payload.browser.profile} · close detaches (session keeps running)
            </div>
            <div className="browser-modal-title truncate">{session?.title ?? payload.title}</div>
            <div className="browser-modal-status truncate">
              {session?.url ?? payload.url}
              {" · "}
              {session?.state ?? status}
            </div>
            {stopError ? (
              <div className="browser-modal-status text-red-300" role="alert">
                {stopError}
              </div>
            ) : null}
          </div>
          <div className="browser-modal-actions">
            <button
              type="button"
              className="browser-modal-btn"
              title={pinned ? "Move to focus shell" : "Pin to side dock"}
              onPointerDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (pinned) unpinWorkbenchSurface(pageRef);
                else pinWorkbenchSurface(pageRef);
              }}
            >
              {pinned ? "Unpin" : "Pin"}
            </button>
            <button
              type="button"
              className="browser-modal-btn"
              title="Destroy this page runtime; profile cookies remain"
              onPointerDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                void stopDockBrowser(pageRef);
              }}
            >
              Stop Page
            </button>
            <button
              type="button"
              className="browser-modal-btn browser-modal-btn--primary"
              onPointerDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                closeDockBrowser(pageRef);
              }}
            >
              Close
            </button>
          </div>
        </header>
      ) : null}
      <div ref={bodyRef} className="browser-modal-body dock-slot__body" />
    </section>
  );
}
