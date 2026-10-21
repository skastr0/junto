import { memo, useCallback, useLayoutEffect, useRef, type ReactNode } from "react";
import { use$ } from "@legendapp/state/react";
import { animate } from "motion";
import { surfaceMotionLive$ } from "../../lib/surface-motion";
import {
  activateWorkbenchSurface,
  dock$,
} from "../../lib/dock-state";
import { panesForLayout, type WorkSurface } from "../../lib/surface-registry";
import { BrowserSurfaceSlot } from "./BrowserSurfaceSlot";
import { parseTerminalSurfaceId } from "../../lib/dock-state";
import { registerTerminalSlot } from "../../lib/terminal-state";
import { TaskEnqueueSurface } from "../work/TaskEnqueueSurface";
import { NoteSurface } from "./NoteSurface";
import { activateSurfaceOnMouseDown } from "../../lib/pointer-activation";
import { BROWSER_ENABLED, TASKS_ENABLED } from "@shared/features";

function resolveSurfaceBody(
  surface: WorkSurface,
  visible: boolean,
  onActivate: () => void,
): ReactNode {
  if (surface.kind === "browser") {
    if (!BROWSER_ENABLED) return null;
    return (
      <BrowserSurfaceSlot
        pageRef={surface.id}
        visible={visible}
        onActivate={onActivate}
      />
    );
  }
  if (surface.kind === "terminal") {
    const nodeId = parseTerminalSurfaceId(surface.id);
    return (
      <section
        ref={(element) => registerTerminalSlot(nodeId, element)}
        className="dock-slot workbench-surface"
        onMouseDown={activateSurfaceOnMouseDown(onActivate)}
      />
    );
  }
  if (surface.kind === "task-create") {
    // A tasks-off build exposes no workTaskCreate API; hide the pane body so a
    // stale dock entry cannot render a form that can only fail on submit.
    if (!TASKS_ENABLED) return null;
    return (
      <TaskEnqueueSurface
        surface={surface}
        visible={visible}
        onActivate={onActivate}
      />
    );
  }
  if (surface.kind === "note") {
    return (
      <NoteSurface
        surface={surface}
        visible={visible}
        onActivate={onActivate}
      />
    );
  }
  return (
    <section
      className="dock-slot workbench-surface"
      onMouseDown={activateSurfaceOnMouseDown(onActivate)}
    >
      <div className="workbench-surface__placeholder">{surface.kind} - {surface.id}</div>
    </section>
  );
}

interface WorkbenchPaneProps {
  readonly surface: WorkSurface;
  readonly visible: boolean;
  readonly paneSlot: "0" | "1" | undefined;
  readonly registerPane: (id: string, element: HTMLDivElement | null) => void;
}

/**
 * Keep the interactive body outside the registry subscription boundary. A
 * registry update for another surface may re-run WorkbenchPanes, but React can
 * preserve this body when its own surface, visibility, and slot are unchanged.
 */
const WorkbenchPane = memo(function WorkbenchPane({
  surface,
  visible,
  paneSlot,
  registerPane,
}: WorkbenchPaneProps) {
  const onActivate = useCallback(
    () => activateWorkbenchSurface(surface.id),
    [surface.id],
  );

  return (
    <div
      ref={(element) => registerPane(surface.id, element)}
      className={[
        "workbench-pane",
        visible ? "" : "workbench-pane--parked",
      ]
        .filter(Boolean)
        .join(" ")}
      data-pane={paneSlot}
      data-surface-id={surface.id}
      aria-hidden={!visible}
      inert={!visible}
    >
      {resolveSurfaceBody(surface, visible, onActivate)}
    </div>
  );
});

/**
 * Renders every open surface (keep-alive). Visible panes fill the
 * layout; surplus surfaces park offscreen so browser bounds zero and
 * streams stay open.
 */
export function WorkbenchPanes() {
  // Subscribe only to fields that can change the pane composition.
  // Focus-size updates never reach this component.
  const surfaces = use$(dock$.registry.surfaces);
  const layout = use$(dock$.registry.focusLayout);
  const mru = use$(dock$.registry.focusMru);
  const paneCount = panesForLayout(layout);
  const pane0 = mru[0];
  const pane1 = paneCount === 2 ? mru[1] : undefined;

  const visibleIds = new Set(
    [pane0, pane1].filter((id): id is string => Boolean(id)),
  );

  // Front-swap entry animation. Panes never unmount — keep-alive
  // holds xterm instances and PTY leases in parked panes — so the swap is a
  // brief settle on the pane that just became front, not a mount transition.
  // Styles are cleared on finish: a lingering transform blurs the xterm canvas.
  const paneRefs = useRef(new Map<string, HTMLDivElement>());
  const registerPane = useCallback(
    (id: string, element: HTMLDivElement | null): void => {
      if (element) paneRefs.current.set(id, element);
      else paneRefs.current.delete(id);
    },
    [],
  );
  const prevFrontRef = useRef<string | null>(null);
  const front = pane0 ?? null;
  // Layout effect: the entry animation must start before the browser paints
  // the new front pane, or it flashes one frame at full opacity first.
  useLayoutEffect(() => {
    const prev = prevFrontRef.current;
    prevFrontRef.current = front;
    // First paint of the view is not a swap; hidden page / reduced motion skip.
    if (!front || prev === null || prev === front) return;
    if (!surfaceMotionLive$.peek()) return;
    // A browser pane must not move after layout: the native view is placed
    // from this pane's measured rect, and a transform would make the bounds
    // pump chase the settle (visible wobble, offset landing).
    const frontKind = dock$.registry.peek().surfaces.find((s) => s.id === front)?.kind;
    if (frontKind === "browser") return;
    const el = paneRefs.current.get(front);
    if (!el) return;
    const controls = animate(
      el,
      { opacity: [0.4, 1], transform: ["translateY(6px)", "translateY(0px)"] },
      { duration: 0.14, ease: "easeOut" },
    );
    const clear = (): void => {
      el.style.removeProperty("opacity");
      el.style.removeProperty("transform");
    };
    void controls.finished.then(clear, clear);
    return () => {
      controls.stop();
      clear();
    };
  }, [front]);

  if (mru.length === 0) return null;

  return (
    <div
      className={["workbench-panes", `workbench-panes--${layout}`].join(" ")}
    >
      {mru.map((id) => {
        const surface = surfaces.find((candidate) => candidate.id === id);
        if (!surface) return null;
        const visible = visibleIds.has(id);
        const paneSlot =
          id === pane0 ? "0" : id === pane1 ? "1" : undefined;
        return (
          <WorkbenchPane
            key={id}
            surface={surface}
            visible={visible}
            paneSlot={paneSlot}
            registerPane={registerPane}
          />
        );
      })}
    </div>
  );
}
