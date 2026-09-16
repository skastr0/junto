import { useEffect, useRef, useState } from "react";
import { use$ } from "@legendapp/state/react";
import type { BrowserOpResult, BrowserSessionInfo, JuntoBrowserApi } from "@shared/ipc";
import { browser$, clearBrowserSessionIfUnchanged } from "../../lib/browser-state";
import {
  BROWSER_ZERO_BOUNDS,
  closeDockBrowser,
  dock$,
  pinWorkbenchSurface,
  stopDockBrowser,
  unpinWorkbenchSurface,
} from "../../lib/dock-state";
import type { WorkZone } from "../../lib/surface-registry";
import { getJuntoApi } from "../../lib/junto-api";
import { activateSurfaceOnMouseDown } from "../../lib/pointer-activation";
import { useTwoClickArm } from "../../lib/two-click-arm";
import { Button, OverlayHeader } from "../ui";

type BrowserApi = ReturnType<typeof getJuntoApi> & Partial<JuntoBrowserApi>;

/**
 * Browser workbench body: plain DOM placeholder — WebContentsView is never
 * parented here. Measured rect is pushed over browserSetBounds so main paints
 * the native view above the window at this spot.
 *
 * When `visible` is false (tabbed away), bounds are zeroed so the native view
 * does not ghost over chrome. The slot stays mounted for keep-alive. Bounds
 * results are honored: a gone handle ends the session story (no infinite
 * attach wave, no pumping a dead view), a failed placement is visible.
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
  const opError = use$(dock$.opErrorByRef[pageRef]);
  const sessionId = session?.sessionId;
  const sessionState = session?.state;
  const bodyRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("attaching…");
  const [boundsError, setBoundsError] = useState<string | undefined>(undefined);
  // Set when the observed handle proved gone (bounds not_found): the surface
  // stays open with guidance until the operator stops or closes it.
  const [ended, setEnded] = useState(false);

  const stopArm = useTwoClickArm(() => {
    void stopDockBrowser(pageRef);
  });

  // Park the native view when this slot unmounts or its session handle
  // changes — but never for an already-closed surface, whose close already
  // detached (or parked) the session over IPC.
  useEffect(() => {
    const parkedSessionId = sessionId;
    return () => {
      if (!parkedSessionId) return;
      const stillDocked = dock$.registry.peek().surfaces.some((s) => s.id === pageRef);
      if (!stillDocked) return;
      void (getJuntoApi() as BrowserApi | undefined)?.browserSetBounds?.(
        parkedSessionId,
        { ...BROWSER_ZERO_BOUNDS },
      ).catch(() => undefined);
    };
  }, [pageRef, sessionId]);

  // A replacement handle is a fresh story.
  useEffect(() => {
    setEnded(false);
    setBoundsError(undefined);
  }, [sessionId]);

  const destroyed = sessionState === "destroyed";

  useEffect(() => {
    if (ended || destroyed) {
      // The session is gone: stop pumping bounds at a handle that no longer
      // exists and say so instead of waving “attaching” forever.
      setStatus("session ended");
      setBoundsError(undefined);
      return;
    }
    if (!sessionId) {
      setStatus("waiting for session…");
      return;
    }
    const api = getJuntoApi() as BrowserApi | undefined;
    if (!api?.browserSetBounds) {
      setStatus("browser surface API unavailable");
      return;
    }

    let cancelled = false;
    let rafId: number | null = null;
    let latestPush = 0;

    const settleBounds = (
      push: number,
      okStatus: string,
      result: BrowserOpResult<BrowserSessionInfo> | undefined,
      threw: boolean,
    ): void => {
      // Only the newest placement push may report; earlier completions are
      // stale layout work.
      if (cancelled || push !== latestPush) return;
      if (!threw && result?.ok) {
        setBoundsError(undefined);
        setStatus(okStatus);
        return;
      }
      if (!threw && result?.code === "not_found") {
        // The handle is gone: drop the stale cache entry and end the
        // surface's session story.
        clearBrowserSessionIfUnchanged(pageRef, sessionId);
        setEnded(true);
        setStatus("session ended");
        setBoundsError(undefined);
        return;
      }
      setStatus("attach failed");
      setBoundsError(
        threw || !result
          ? "The page view could not be placed; retrying on the next layout change."
          : result.message ?? "The page view could not be placed.",
      );
    };

    const pushBounds = () => {
      rafId = null;
      if (cancelled) return;
      const push = ++latestPush;
      if (!visible) {
        setStatus("parked");
        void api
          .browserSetBounds!(sessionId, { ...BROWSER_ZERO_BOUNDS })
          .then((result) => settleBounds(push, "parked", result, false))
          .catch(() => settleBounds(push, "parked", undefined, true));
        return;
      }
      const el = bodyRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      setStatus("attaching…");
      void api
        .browserSetBounds!(sessionId, {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        })
        .then((result) => settleBounds(push, "attached", result, false))
        .catch(() => settleBounds(push, "attached", undefined, true));
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
    };
  }, [pageRef, sessionId, visible, ended, destroyed]);

  if (!payload) return null;

  const pinned = zone === "pinned";
  const endedStory = ended || destroyed;
  // Failed opens are not "waiting": the refusal (alert lane) is the truth.
  const opFailedOpen = opError?.op === "open";
  const stateLabel = sessionState
    ? destroyed
      ? "session ended"
      : sessionState
    : endedStory
      ? "session ended"
      : opFailedOpen
        ? "open failed"
        : status;
  // Operator action failures, placement failures, and the session's own last
  // error share one deduped alert lane, independent of the status line.
  const failedSessionError = sessionState === "failed" ? session?.lastError : undefined;
  const alerts: string[] = [];
  for (const candidate of [opError?.message, boundsError, failedSessionError]) {
    if (candidate && !alerts.includes(candidate)) alerts.push(candidate);
  }

  return (
    <section
      className="dock-slot workbench-surface nokey"
      // Focusable keyboard root: opening the surface parks keyboard focus here
      // (data-autofocus is the primary-focus convention), and xyflow ignores
      // every keydown from inside a `.nokey` element — canvas chords must not
      // act through the page pane. The native webpage itself stays page-owned
      // (WebContentsView keys never reach this document).
      tabIndex={0}
      data-autofocus
      aria-label="Browser page surface"
      aria-hidden={!visible}
      onMouseDown={activateSurfaceOnMouseDown(onActivate)}
    >
      {visible ? (
        <>
          <OverlayHeader
            eyebrow={`page - ${payload.browser.profile}`}
            title={session?.title ?? payload.title}
            status={
              <>
                {session?.url ?? payload.url}
                {" - "}
                {stateLabel}
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
                  variant={stopArm.armed ? "danger" : "chrome"}
                  className={stopArm.armed ? "ring-1 ring-crimson/60" : undefined}
                  title={stopArm.armed ? "Click again to stop the page session" : "Stop the page session"}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    stopArm.arm();
                  }}
                >
                  {stopArm.armed ? "Confirm" : "Stop Page"}
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
          {endedStory ? (
            <div
              className="shrink-0 border-b border-stroke px-3.5 py-1.5 text-[11px] leading-snug text-dim"
              role="status"
            >
              The page session ended. Stop Page or Close will clear this surface.
            </div>
          ) : alerts.length > 0 ? (
            <div className="shrink-0 border-b border-stroke px-3.5 py-1.5" role="alert">
              {alerts.map((message) => (
                <div key={message} className="text-[11px] leading-snug text-crimson">
                  {message}
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
      <div ref={bodyRef} className="relative min-h-0 w-full flex-1 overflow-hidden" />
    </section>
  );
}
