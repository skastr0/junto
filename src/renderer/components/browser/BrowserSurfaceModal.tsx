import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { use$ } from "@legendapp/state/react";
import type { VellumBrowserApi } from "@shared/ipc";
import { browser$, closeBrowserSurface } from "../../lib/browser-state";
import { getVellumApi } from "../../lib/vellum-api";

type BrowserApi = ReturnType<typeof getVellumApi> & Partial<VellumBrowserApi>;

/**
 * Full-window browser work surface, portaled to document.body — the same
 * shape as HerdrTerminalModal.tsx (never clipped by canvas stage, never
 * parented under an xyflow node). Unlike the herdr modal there is nothing to
 * paint here: the body div only tracks a rect. The main process attaches a
 * partitioned WebContentsView over that rect (BR-004's view-adapter); real
 * dock-into-canvas layout is BR-007. Close DETACHES only — the warm session
 * and its cookies survive, mirroring closeHerdrTerminal.
 */
export function BrowserSurfaceModal() {
  const surface = use$(browser$.surface);
  const session = use$(browser$.sessionByNodeId[surface?.nodeId ?? ""]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<BrowserApi | undefined>(undefined);
  const [status, setStatus] = useState("attaching…");

  useEffect(() => {
    if (!surface) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "w")) {
        e.preventDefault();
        closeBrowserSurface();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [Boolean(surface)]);

  useEffect(() => {
    if (!surface || !bodyRef.current) return;
    const api = getVellumApi() as BrowserApi | undefined;
    apiRef.current = api;
    const el = bodyRef.current;
    if (!api?.browserSetBounds) {
      setStatus("browser surface API unavailable");
      return;
    }
    const nodeId = surface.nodeId;

    let cancelled = false;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;

    const pushBounds = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      setStatus("attached");
      void api.browserSetBounds!(nodeId, {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
    };

    const scheduleBounds = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(pushBounds, 60);
    };

    // Wait a frame so flex layout has real size before the first measure.
    requestAnimationFrame(() => {
      if (!cancelled) pushBounds();
    });

    window.addEventListener("resize", scheduleBounds);
    let resizeObs: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      resizeObs = new ResizeObserver(() => scheduleBounds());
      resizeObs.observe(el);
    }

    return () => {
      cancelled = true;
      window.removeEventListener("resize", scheduleBounds);
      resizeObs?.disconnect();
      if (resizeTimer) clearTimeout(resizeTimer);
      apiRef.current = undefined;
    };
  }, [surface?.nodeId]);

  if (!surface) return null;

  const modal = (
    <div className="browser-modal-root" role="dialog" aria-modal="true" aria-label="Browser page surface">
      <button
        type="button"
        className="browser-modal-backdrop"
        aria-label="Close browser surface"
        onClick={() => closeBrowserSurface()}
      />
      <div className="browser-modal-panel" onClick={(e) => e.stopPropagation()}>
        <header className="browser-modal-header">
          <div className="browser-modal-header__meta min-w-0">
            <div className="browser-modal-eyebrow">page · {surface.browser.profile} · Esc closes (session keeps running)</div>
            <div className="browser-modal-title truncate">{session?.title ?? surface.title}</div>
            <div className="browser-modal-status truncate">
              {surface.url}
              {" · "}
              {session?.state ?? status}
            </div>
          </div>
          <div className="browser-modal-actions">
            <button
              type="button"
              className="browser-modal-btn browser-modal-btn--primary"
              onPointerDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                closeBrowserSurface();
              }}
            >
              Close
            </button>
          </div>
        </header>
        <div ref={bodyRef} className="browser-modal-body" />
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
