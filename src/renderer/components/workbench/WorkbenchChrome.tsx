import { use$ } from "@legendapp/state/react";
import {
  dock$,
  focusWorkbenchSurface,
  pinWorkbenchSurface,
  setWorkbenchLayout,
  unpinWorkbenchSurface,
} from "../../lib/dock-state";
import {
  surfaceById,
  type LayoutMode,
  type WorkZone,
} from "../../lib/surface-registry";
import { surfaceLabel } from "./surface-label";

const LAYOUTS: ReadonlyArray<{ mode: LayoutMode; glyph: string; title: string }> = [
  { mode: "solo", glyph: "□", title: "Solo" },
  { mode: "split-v", glyph: "┃", title: "Split vertical" },
  { mode: "split-h", glyph: "━", title: "Split horizontal" },
];

/**
 * Zone chrome: layout toggle + tab strip for surplus MRU surfaces + pin-all.
 * Tabs are non-pane surfaces (visiblePanes.tabs); clicking promotes to front.
 */
export function WorkbenchChrome({
  zone,
  paneIds,
  tabs,
  activeId,
}: {
  readonly zone: WorkZone;
  readonly paneIds: ReadonlyArray<string | undefined>;
  readonly tabs: ReadonlyArray<string>;
  readonly activeId: string | undefined;
}) {
  const registry = use$(dock$.registry);
  const layout = zone === "focus" ? registry.focusLayout : registry.pinnedLayout;
  const zoneSurfaces = registry.surfaces.filter((s) => s.zone === zone);

  const cycleLayout = () => {
    const i = LAYOUTS.findIndex((l) => l.mode === layout);
    const next = LAYOUTS[(i + 1) % LAYOUTS.length]!.mode;
    setWorkbenchLayout(zone, next);
  };

  const pinAll = () => {
    for (const s of zoneSurfaces) {
      if (s.zone === "focus") pinWorkbenchSurface(s.id);
    }
  };

  const unpinAll = () => {
    for (const s of zoneSurfaces) {
      if (s.zone === "pinned") unpinWorkbenchSurface(s.id);
    }
  };

  const tabSurfaces = tabs
    .map((id) => surfaceById(registry, id))
    .filter((s): s is NonNullable<typeof s> => Boolean(s));

  // Also list pane surfaces as inactive-looking tabs when in split (so user can swap).
  const allTabIds = [
    ...paneIds.filter((id): id is string => Boolean(id)),
    ...tabs,
  ];
  const uniqueTabIds = [...new Set(allTabIds)];

  return (
    <div className="workbench-chrome" data-zone={zone}>
      <div className="workbench-chrome__tabs" role="tablist" aria-label={`${zone} surfaces`}>
        {uniqueTabIds.map((id) => {
          const surface = surfaceById(registry, id);
          if (!surface) return null;
          const isActive = id === activeId || paneIds.includes(id);
          const isFront = id === activeId;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={isFront}
              className={[
                "workbench-tab",
                isActive ? "workbench-tab--visible" : "",
                isFront ? "workbench-tab--active" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              title={surfaceLabel(surface, registry)}
              onClick={() => focusWorkbenchSurface(id)}
            >
              <span className="workbench-tab__kind">{surface.kind}</span>
              <span className="workbench-tab__label truncate">
                {surfaceLabel(surface, registry)}
              </span>
            </button>
          );
        })}
        {tabSurfaces.length === 0 && uniqueTabIds.length <= 1 ? (
          <span className="workbench-chrome__empty">
            {zone === "focus" ? "focus" : "pinned"}
          </span>
        ) : null}
      </div>

      <div className="workbench-chrome__actions">
        <button
          type="button"
          className="workbench-layout-toggle"
          title={`Layout: ${layout} (click to cycle)`}
          aria-label={`Layout ${layout}`}
          onClick={cycleLayout}
        >
          {LAYOUTS.map((l) => (
            <span
              key={l.mode}
              className={[
                "workbench-layout-toggle__opt",
                l.mode === layout ? "workbench-layout-toggle__opt--on" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              title={l.title}
            >
              {l.glyph}
            </span>
          ))}
        </button>

        {zone === "focus" && zoneSurfaces.length > 0 ? (
          <button
            type="button"
            className="workbench-chrome__btn"
            title="Pin all focus surfaces to side dock"
            onClick={pinAll}
          >
            Pin all
          </button>
        ) : null}
        {zone === "pinned" && zoneSurfaces.length > 0 ? (
          <button
            type="button"
            className="workbench-chrome__btn"
            title="Move all pinned surfaces back to focus"
            onClick={unpinAll}
          >
            Unpin all
          </button>
        ) : null}
      </div>
    </div>
  );
}
