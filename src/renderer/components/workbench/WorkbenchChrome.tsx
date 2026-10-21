import { use$ } from "@legendapp/state/react";
import {
  activateWorkbenchSurface,
  dock$,
  setWorkbenchLayout,
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
 * Zone chrome: layout toggle + tab strip for surplus MRU surfaces.
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
  const layout = use$(() =>
    zone === "focus"
      ? dock$.registry.focusLayout.get()
      : dock$.registry.pinnedLayout.get(),
  );
  // Re-render when this zone's surfaces change: tab labels read the registry.
  use$(() =>
    JSON.stringify(
      dock$.registry.surfaces
        .get()
        .filter((surface) => surface.zone === zone)
        .map((surface) => [surface.id, surface.kind]),
    ),
  );
  const registry = dock$.registry.peek();

  const cycleLayout = () => {
    const current =
      zone === "focus"
        ? dock$.registry.focusLayout.peek()
        : dock$.registry.pinnedLayout.peek();
    const i = LAYOUTS.findIndex((l) => l.mode === current);
    const next = LAYOUTS[(i + 1) % LAYOUTS.length]!.mode;
    setWorkbenchLayout(zone, next);
  };

  // Pane + surplus tabs in one strip (click promotes / routes keyboard).
  const allTabIds = [
    ...paneIds.filter((id): id is string => Boolean(id)),
    ...tabs,
  ];
  const uniqueTabIds = [...new Set(allTabIds)];

  return (
    <div className="workbench-chrome" data-zone={zone}>
      <div className="workbench-chrome__tabs" role="tablist" aria-label={`${zone} surfaces`}>
        {uniqueTabIds.length === 0 ? (
          <span className="workbench-chrome__empty">
            {zone === "focus" ? "focus" : "pinned"}
          </span>
        ) : (
          uniqueTabIds.map((id) => {
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
                onClick={() => activateWorkbenchSurface(id)}
              >
                <span className="workbench-tab__kind">{surface.kind}</span>
                <span className="workbench-tab__label truncate">
                  {surfaceLabel(surface, registry)}
                </span>
              </button>
            );
          })
        )}
      </div>

      <div className="workbench-chrome__actions">
        <button
          type="button"
          className="workbench-layout-toggle"
          title={`Layout: ${layout}`}
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

      </div>
    </div>
  );
}
