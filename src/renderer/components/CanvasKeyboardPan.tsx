import { useEffect } from "react";
import { useReactFlow } from "@xyflow/react";
import {
  canvasOwnsKeyboard,
  panKeyFor,
  panModifiersAllow,
  panVectorFor,
  panViewportDelta,
} from "../lib/canvas-keyboard-pan";

/**
 * WASD / arrow-key camera panning.
 *
 * Mounted inside the ReactFlow tree so it drives the live viewport. The gate
 * lives in canvas-keyboard-pan.ts: keys are only claimed while the canvas
 * owns the keyboard, so a focus modal, menu, terminal, or any focused field
 * keeps every letter to itself.
 */
export function CanvasKeyboardPan() {
  const rf = useReactFlow();

  useEffect(() => {
    const held = new Map<string, number>();
    let boost = false;
    let frame = 0;
    let lastFrameAt = 0;

    const stop = () => {
      held.clear();
      boost = false;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      lastFrameAt = 0;
    };

    const tick = (now: number) => {
      frame = 0;
      if (held.size === 0) return;
      // A surface can open while keys are down (menu, modal). Drop the keys
      // rather than flying the camera under it.
      if (!canvasOwnsKeyboard(document)) {
        stop();
        return;
      }
      const frameMs = lastFrameAt === 0 ? 16 : now - lastFrameAt;
      lastFrameAt = now;
      const oldest = Math.min(...held.values());
      const delta = panViewportDelta({
        vector: panVectorFor(held.keys()),
        frameMs,
        heldMs: now - oldest,
        boost,
      });
      if (delta.x !== 0 || delta.y !== 0) {
        const viewport = rf.getViewport();
        rf.setViewport({
          x: viewport.x + delta.x,
          y: viewport.y + delta.y,
          zoom: viewport.zoom,
        });
      }
      frame = requestAnimationFrame(tick);
    };

    const start = () => {
      if (frame) return;
      lastFrameAt = 0;
      frame = requestAnimationFrame(tick);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Shift") {
        boost = true;
        return;
      }
      const key = panKeyFor(event.key);
      if (!key || !panModifiersAllow(event)) return;
      if (!canvasOwnsKeyboard(document)) return;
      // Arrows scroll the shell otherwise; letters would be harmless but the
      // claim should be visible either way.
      event.preventDefault();
      if (event.repeat || held.has(key)) return;
      boost = event.shiftKey;
      held.set(key, performance.now());
      start();
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Shift") {
        boost = false;
        return;
      }
      const key = panKeyFor(event.key);
      if (!key) return;
      held.delete(key);
      if (held.size === 0) stop();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", stop);
    document.addEventListener("visibilitychange", stop);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", stop);
      document.removeEventListener("visibilitychange", stop);
      stop();
    };
  }, [rf]);

  return null;
}
