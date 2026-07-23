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
import { Button, OverlayHeader } from "../ui";

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
        <OverlayHeader
          eyebrow={`page · ${payload.browser.profile} · close detaches (session keeps running)`}
          title={session?.title ?? payload.title}
          status={
            <>
              {session?.url ?? payload.url}
              {" · "}
              {session?.state ?? status}
              {stopError ? (
                <span className="block text-crimson" role="alert">
                  {stopError}
                </span>
              ) : null}
            </>
          }
          actions={
            <>
              <Button
                size="xs"
                variant="chrome"
                title={pinned ? "Move to focus shell" : "Pin to side dock"}
                onPointerDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (pinned) unpinWorkbenchSurface(pageRef);
                  else pinWorkbenchSurface(pageRef);
                }}
              >
                {pinned ? "Unpin" : "Pin"}
              </Button>
              <Button
                size="xs"
                variant="chrome"
                title="Destroy this page runtime; profile cookies remain"
                onPointerDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  void stopDockBrowser(pageRef);
                }}
              >
                Stop Page
              </Button>
              <Button
                size="xs"
                variant="primary"
                onPointerDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  closeDockBrowser(pageRef);
                }}
              >
                Close
              </Button>
            </>
          }
        />
      ) : null}
      <div ref={bodyRef} className="relative min-h-0 w-full flex-1 overflow-hidden" />
    </section>
  );
}
