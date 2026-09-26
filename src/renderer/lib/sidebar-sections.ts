import { observable } from "@legendapp/state";

/**
 * Collapsed state of sidebar sections for this session. A section key names
 * a kind of section ("seat-sidebar:mail"), not one seat, so collapsing mail
 * once collapses it on every agent. Held in memory only: renderer storage is
 * not a preference store, and a fresh window opens every section at its
 * default.
 */

export type SectionOpenMap = Readonly<Record<string, boolean>>;

export const sidebarSections$ = observable({
  open: {} as Record<string, boolean>,
  /**
   * One-shot reveal request: the sidebar for `nodeId` expands `section` and
   * scrolls it into view, then clears the request.
   */
  reveal: null as { readonly nodeId: string; readonly section: string } | null,
});

export const sectionOpen = (
  key: string,
  fallback: boolean,
  map: SectionOpenMap = sidebarSections$.open.peek(),
): boolean => map[key] ?? fallback;

export const setSectionOpen = (key: string, open: boolean): void => {
  sidebarSections$.open[key].set(open);
};

export const requestSectionReveal = (nodeId: string, section: string): void => {
  sidebarSections$.reveal.set({ nodeId, section });
};

export const clearSectionReveal = (): void => {
  sidebarSections$.reveal.set(null);
};
