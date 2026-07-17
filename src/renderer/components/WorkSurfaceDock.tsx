import { useEffect, useRef, useState } from "react";
import { use$ } from "@legendapp/state/react";
import type { VellumBrowserApi } from "@shared/ipc";
import { browser$ } from "../lib/browser-state";
import { closeDockBrowser, dock$, syncDockHerdrSlot } from "../lib/dock-state";
import { herdr$ } from "../lib/herdr-state";
import { getVellumApi } from "../lib/vellum-api";
import { HerdrTerminalPanel } from "./herdr/HerdrTerminalModal";

type BrowserApi = ReturnType<typeof getVellumApi> & Partial<VellumBrowserApi>;

/**
 * One browser slot: plain DOM placeholder only — the WebContentsView is NEVER
 * parented here (or under any xyflow node). The placeholder's measured rect is
 * pushed over browserSetBounds so the main process positions the native view
 * above the window content at exactly this spot. ResizeObserver + rAF-throttled
 * pushes keep it glued through dock splits and window resizes.
 */
function BrowserDockSlot({ pageRef }: { readonly pageRef: string }) {
  const payload = use$(dock$.browserByRef[pageRef]);
  const session = use$(browser$.sessionByRef[pageRef]);
  const sessionId = session?.sessionId;
  const bodyRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("attaching…");

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
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
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      setStatus("attached");
      // Capture the exact handle for this effect lifetime. If a session is
      // recreated, cleanup cancels queued work and the new handle remounts the
      // measurement effect; any already-in-flight stale call is rejected main-side.
      void api.browserSetBounds!(sessionId, {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
    };

    // rAF-throttled: at most one bounds push per frame, coalescing the resize
    // storms a dock split produces.
    const scheduleBounds = () => {
      if (rafId != null) return;
      rafId = requestAnimationFrame(pushBounds);
    };

    // First measure waits a frame so flex layout has real size.
    scheduleBounds();

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
      if (rafId != null) cancelAnimationFrame(rafId);
    };
  }, [pageRef, sessionId]);

  if (!payload) return null;

  return (
    <section className="dock-slot" aria-label="Browser page surface">
      <header className="browser-modal-header dock-slot__header">
        <div className="browser-modal-header__meta min-w-0">
          <div className="browser-modal-eyebrow">page · {payload.browser.profile} · close detaches (session keeps running)</div>
          <div className="browser-modal-title truncate">{session?.title ?? payload.title}</div>
          <div className="browser-modal-status truncate">
            {session?.url ?? payload.url}
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
              closeDockBrowser(pageRef);
            }}
          >
            Close
          </button>
        </div>
      </header>
      <div ref={bodyRef} className="browser-modal-body dock-slot__body" />
    </section>
  );
}

/**
 * Stage-level work-surface dock: hosts browser placeholders and (when a
 * browser is open alongside) the herdr terminal, side by side, splitting the
 * stage's width as a flex sibling of the canvas. Slot admission/eviction is
 * the pure surface-registry; maxVisibleSurfaces comes from the
 * BrowserProfileService config over IPC (default 2).
 */
export function WorkSurfaceDock() {
  const registry = use$(dock$.registry);
  const terminal = use$(herdr$.terminal);
  const hasBrowser = registry.surfaces.some((s) => s.kind === "browser");

  // Herdr docks only while a browser surface is open; alone it stays in the
  // full-window modal. Sync runs on either input changing.
  useEffect(() => {
    syncDockHerdrSlot();
  }, [Boolean(terminal), hasBrowser]);

  if (registry.surfaces.length === 0) return null;

  return (
    <aside className="work-surface-dock" aria-label="Work surface dock">
      {registry.surfaces.map((s) =>
        s.kind === "browser" ? (
          <BrowserDockSlot key={s.id} pageRef={s.id} />
        ) : (
          <section key={s.id} className="dock-slot dock-slot--herdr" aria-label="Herdr terminal surface">
            <HerdrTerminalPanel variant="dock" />
          </section>
        ),
      )}
    </aside>
  );
}
