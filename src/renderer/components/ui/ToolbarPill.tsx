import type { ReactNode } from "react";

/**
 * Toolbar pill — the floating icon-button strip stamped above a selected
 * node/region (edit - expand - flag - delete). One chrome, every entity.
 */
export function ToolbarPill({ children }: { readonly children: ReactNode }) {
  return (
    <div className="nodrag nopan flex items-center gap-1 rounded-md border border-white/10 bg-inset px-1 py-1 shadow-lg shadow-black/40">
      {children}
    </div>
  );
}
