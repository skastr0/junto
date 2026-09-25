import { observable } from "@legendapp/state";

/**
 * Collapsed state of sidebar sections, per viewer. A section key names a
 * kind of section ("seat-sidebar:mail"), not one seat, so collapsing mail
 * once collapses it on every agent. Storage is a convenience only: when it is
 * unavailable every section falls back to its default.
 */

const STORAGE_KEY = "junto.sidebar-sections.v1";

export type SectionOpenMap = Readonly<Record<string, boolean>>;

/** Decode the stored map, keeping only boolean entries. */
export const parseSectionOpen = (raw: string | null | undefined): SectionOpenMap => {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
    const out: Record<string, boolean> = {};
    for (const [key, open] of Object.entries(value)) {
      if (typeof open === "boolean") out[key] = open;
    }
    return out;
  } catch {
    return {};
  }
};

const readStored = (): SectionOpenMap => {
  try {
    return parseSectionOpen(globalThis.localStorage?.getItem(STORAGE_KEY));
  } catch {
    return {};
  }
};

const writeStored = (map: SectionOpenMap): void => {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* private window or blocked storage: state lives for this session */
  }
};

export const sidebarSections$ = observable({
  open: readStored() as Record<string, boolean>,
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
  writeStored(sidebarSections$.open.peek());
};

export const requestSectionReveal = (nodeId: string, section: string): void => {
  sidebarSections$.reveal.set({ nodeId, section });
};

export const clearSectionReveal = (): void => {
  sidebarSections$.reveal.set(null);
};
