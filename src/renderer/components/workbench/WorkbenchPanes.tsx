import type { ReactNode } from "react";
import { use$ } from "@legendapp/state/react";
import {
  activateWorkbenchSurface,
  dock$,
  pinWorkbenchSurface,
  unpinWorkbenchSurface,
} from "../../lib/dock-state";
import {
  surfaceById,
  visiblePanes,
  type WorkSurface,
  type WorkZone,
} from "../../lib/surface-registry";
import { HerdrTerminalPanel } from "../herdr/HerdrTerminalModal";
import { BrowserSurfaceSlot } from "./BrowserSurfaceSlot";
import { parseHerdrNodeId } from "./surface-label";
import { parseTerminalSurfaceId } from "../../lib/dock-state";
import { terminal$ } from "../../lib/terminal-state";
import { TerminalSurface } from "../terminal/TerminalSurface";
import { Button } from "../ui";
import { ChatSurface } from "../chat/ChatSurface";
import { TaskEnqueueSurface } from "../work/TaskEnqueueSurface";
import { activateSurfaceOnMouseDown } from "../../lib/pointer-activation";

function HerdrSurfaceSlot({
  surface,
  zone,
  visible,
  onActivate,
}: {
  readonly surface: WorkSurface;
  readonly zone: WorkZone;
  readonly visible: boolean;
  readonly onActivate?: () => void;
}) {
  const nodeId = parseHerdrNodeId(surface.id);
  const pinned = zone === "pinned";

  if (!nodeId) {
    return (
      <section className="dock-slot workbench-surface">
        <div className="workbench-surface__placeholder">herdr · unbound</div>
      </section>
    );
  }

  return (
    <section
      className="dock-slot dock-slot--herdr workbench-surface"
      aria-label="Herdr terminal surface"
      aria-hidden={!visible}
      onMouseDown={activateSurfaceOnMouseDown(onActivate)}
    >
      {visible ? (
        <div className="workbench-surface__herdr-actions" data-herdr-chrome>
          <Button
            size="xs"
            variant="chrome"
            title={pinned ? "Move to focus shell" : "Pin to side dock"}
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (pinned) unpinWorkbenchSurface(surface.id);
              else pinWorkbenchSurface(surface.id);
            }}
          >
            {pinned ? "Unpin" : "Pin"}
          </Button>
        </div>
      ) : null}
      {/* Keep mounted when tabbed away so the control stream survives. */}
      <HerdrTerminalPanel variant="dock" nodeId={nodeId} />
    </section>
  );
}

function resolveSurfaceBody(
  surface: WorkSurface,
  zone: WorkZone,
  visible: boolean,
  onActivate: () => void,
): ReactNode {
  if (surface.kind === "browser") {
    return (
      <BrowserSurfaceSlot
        pageRef={surface.id}
        zone={zone}
        visible={visible}
        onActivate={onActivate}
      />
    );
  }
  if (surface.kind === "herdr") {
    return (
      <HerdrSurfaceSlot
        surface={surface}
        zone={zone}
        visible={visible}
        onActivate={onActivate}
      />
    );
  }
  if (surface.kind === "terminal") {
    const nodeId = parseTerminalSurfaceId(surface.id);
    const node = nodeId ? terminal$.openByNodeId[nodeId].peek() : undefined;
    return (
      <section
        className="dock-slot workbench-surface"
        onMouseDown={activateSurfaceOnMouseDown(onActivate)}
      >
        {node ? (
          <TerminalSurface node={node} />
        ) : (
          <div className="workbench-surface__placeholder">terminal · unbound</div>
        )}
      </section>
    );
  }
  if (surface.kind === "chat") {
    return (
      <ChatSurface
        surface={surface}
        zone={zone}
        visible={visible}
        onActivate={onActivate}
      />
    );
  }
  if (surface.kind === "task-create") {
    return (
      <TaskEnqueueSurface
        surface={surface}
        zone={zone}
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
      <div className="workbench-surface__placeholder">{surface.kind} · {surface.id}</div>
    </section>
  );
}

/**
 * Renders every surface in the zone (keep-alive). Visible panes fill the
 * layout; surplus surfaces park offscreen so browser bounds zero and herdr
 * streams stay open.
 */
export function WorkbenchPanes({ zone }: { readonly zone: WorkZone }) {
  const registry = use$(dock$.registry);
  const panes = visiblePanes(registry, zone);
  const layout = zone === "focus" ? registry.focusLayout : registry.pinnedLayout;
  const mru = zone === "focus" ? registry.focusMru : registry.pinnedMru;

  const visibleIds = new Set(
    [panes.pane0, panes.pane1].filter((id): id is string => Boolean(id)),
  );

  if (mru.length === 0) return null;

  return (
    <div
      className={["workbench-panes", `workbench-panes--${layout}`].join(" ")}
      data-zone={zone}
    >
      {mru.map((id) => {
        const surface = surfaceById(registry, id);
        if (!surface) return null;
        const visible = visibleIds.has(id);
        const paneSlot =
          id === panes.pane0 ? "0" : id === panes.pane1 ? "1" : undefined;
        return (
          <div
            key={id}
            className={[
              "workbench-pane",
              visible ? "" : "workbench-pane--parked",
            ]
              .filter(Boolean)
              .join(" ")}
            data-pane={paneSlot}
            aria-hidden={!visible}
          >
            {resolveSurfaceBody(surface, zone, visible, () =>
              activateWorkbenchSurface(id),
            )}
          </div>
        );
      })}
    </div>
  );
}
