import { DIM } from "../lib/theme";

// Shared quiet loading/error vocabulary for every browse fetch — the tab
// lists in InspectorBrowse and the row-detail fetches in BrowseDetailModal
// both render through these two lines, never a throw. Its own file so
// neither of those two modules has to import the other just for this.
export function LoadingLine({ label }: { readonly label: string }) {
  return <div className="vellum-dot--pulse py-2 text-[10px]" style={{ color: DIM }}>{label}</div>;
}

export function EmptyLine({ label }: { readonly label: string }) {
  return <div className="py-2 text-[10px]" style={{ color: DIM }}>{label}</div>;
}
