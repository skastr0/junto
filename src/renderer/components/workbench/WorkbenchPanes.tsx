import type { ReactNode } from "react";
import { use$ } from "@legendapp/state/react";
import {
  dock$,
  focusWorkbenchSurface,
  pinWorkbenchSurface,
  unpinWorkbenchSurface,
} from "../../lib/dock-state";
import { focusHerdrTerminal } from "../../lib/herdr-state";
import {
  surfaceById,
  visiblePanes,
  type WorkSurface,
  type WorkZone,
} from "../../lib/surface-registry";
import { HerdrTerminalPanel } from "../herdr/HerdrTerminalModal";
import { BrowserSurfaceSlot } from "./BrowserSurfaceSlot";
import { parseHerdrNodeId } from "./surface-label";

function HerdrSurfaceSlot({
  surface,
  zone,
  onActivate,
}: {
  readonly surface: WorkSurface;
  readonly zone: WorkZone;
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
      onMouseDown={() => {
        onActivate?.();
        focusHerdrTerminal(nodeId);
      }}
    >
      <div className="workbench-surface__herdr-actions" data-herdr-chrome>
        <button
          type="button"
          className="browser-modal-btn"
          title={pinned ? "Move to focus shell" : "Pin to side dock"}
          onPointerDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (pinned) unpinWorkbenchSurface(surface.id);
            else pinWorkbenchSurface(surface.id);
          }}
        >
          {pinned ? "Unpin" : "Pin"}
        </button>
      </div>
      <HerdrTerminalPanel variant="dock" nodeId={nodeId} />
    </section>
  );
}

function resolveSurfaceBody(
  surface: WorkSurface,
  zone: WorkZone,
  onActivate: () => void,
): ReactNode {
  if (surface.kind === "browser") {
    return (
      <BrowserSurfaceSlot pageRef={surface.id} zone={zone} onActivate={onActivate} />
    );
  }
  if (surface.kind === "herdr") {
    return <HerdrSurfaceSlot surface={surface} zone={zone} onActivate={onActivate} />;
  }
  return (
    <section className="dock-slot workbench-surface" onMouseDown={onActivate}>
      <div className="workbench-surface__placeholder">chat · {surface.id}</div>
    </section>
  );
}

/**
 * Renders 1–2 visible panes for a zone from MRU + layout.
 * Click focuses (MRU front). Surplus surfaces live only in the tab strip.
 */
export function WorkbenchPanes({ zone }: { readonly zone: WorkZone }) {
  const registry = use$(dock$.registry);
  const panes = visiblePanes(registry, zone);
  const layout = zone === "focus" ? registry.focusLayout : registry.pinnedLayout;

  const pane0 = panes.pane0 ? surfaceById(registry, panes.pane0) : undefined;
  const pane1 = panes.pane1 ? surfaceById(registry, panes.pane1) : undefined;

  if (!pane0) return null;

  const activate = (id: string) => () => focusWorkbenchSurface(id);

  return (
    <div
      className={["workbench-panes", `workbench-panes--${layout}`].join(" ")}
      data-zone={zone}
    >
      <div className="workbench-pane" data-pane="0">
        {resolveSurfaceBody(pane0, zone, activate(pane0.id))}
      </div>
      {pane1 ? (
        <div className="workbench-pane" data-pane="1">
          {resolveSurfaceBody(pane1, zone, activate(pane1.id))}
        </div>
      ) : null}
    </div>
  );
}
