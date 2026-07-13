import { DIM, HUE, INK, withAlpha } from "../../lib/theme";

// A tiny, self-contained tab bar primitive for internal panel navigation —
// no CSS import required, so any panel can drop it in. 9px uppercase
// segmented row: ink active on an amber wash, dim inactive, 1px hairline
// borders. Deliberately dumb (controlled active/onSelect) so callers own
// what "tabs" means for their panel.

export interface InspectorTab {
  readonly id: string;
  readonly label: string;
  readonly badge?: number;
}

export function InspectorTabs({
  tabs,
  active,
  onSelect,
}: {
  readonly tabs: ReadonlyArray<InspectorTab>;
  readonly active: string;
  readonly onSelect: (id: string) => void;
}) {
  if (tabs.length === 0) return null;
  return (
    <div role="tablist" aria-label="Inspector sections" className="flex items-center gap-0.5" style={{ borderBottom: "1px solid rgba(237,230,218,.12)" }}>
      {tabs.map((tab) => {
        const isActive = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onSelect(tab.id)}
            className="relative flex items-center gap-1.5 px-2.5 py-1.5 text-[9px] font-medium uppercase tracking-[.1em] transition"
            style={{
              color: isActive ? INK : DIM,
              background: isActive ? withAlpha(HUE.amber, 0.1) : "transparent",
              borderBottom: `1px solid ${isActive ? withAlpha(HUE.amber, 0.5) : "transparent"}`,
              marginBottom: -1,
            }}
          >
            {tab.label}
            {tab.badge ? (
              <span
                className="inline-flex min-w-[14px] items-center justify-center rounded-full px-1 text-[8px] tabular-nums"
                style={{ background: withAlpha(HUE.amber, 0.22), color: HUE.amber }}
              >
                {tab.badge > 99 ? "99+" : tab.badge}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
