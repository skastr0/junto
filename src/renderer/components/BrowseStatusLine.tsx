import { loadingActivity } from "../lib/activity";
import { DIM } from "../lib/theme";
import { ActivityMarkFromSpec } from "./ActivityMark";

// Shared quiet loading/error vocabulary for every browse fetch — the tab
// lists in InspectorBrowse and the row-detail fetches in BrowseDetailModal
// both render through these two lines, never a throw. Its own file so
// neither of those two modules has to import the other just for this.
//
// Loading is wave-only (aria label); no visible "loading…" copy.
export function LoadingLine({ label }: { readonly label: string }) {
  return (
    <div className="flex items-center gap-2 py-2" role="status" aria-label={label}>
      <ActivityMarkFromSpec spec={loadingActivity(true, label)} size="inline" />
    </div>
  );
}

export function EmptyLine({ label }: { readonly label: string }) {
  return <div className="py-2 text-[10px]" style={{ color: DIM }}>{label}</div>;
}
