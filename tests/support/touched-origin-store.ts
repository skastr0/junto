import type {
  BrowserTouchedOrigin,
  BrowserTouchedOriginStore,
} from "../../src/main/junto/browser/touched-origins";

/** The write-ahead record in memory, for tests whose seats evaluate. */
export const memoryTouchedOriginStore = (): BrowserTouchedOriginStore & {
  readonly rows: () => ReadonlyArray<BrowserTouchedOrigin>;
} => {
  const rows = new Map<string, BrowserTouchedOrigin>();
  const key = ({ profile, origin }: BrowserTouchedOrigin): string => `${profile}\0${origin}`;
  return {
    record: async (entry) => {
      rows.set(key(entry), entry);
    },
    list: async () => [...rows.values()],
    remove: async (entries) => {
      for (const entry of entries) rows.delete(key(entry));
    },
    removeProfile: async (profile) => {
      for (const [id, entry] of rows) if (entry.profile === profile) rows.delete(id);
    },
    rows: () => [...rows.values()],
  };
};
