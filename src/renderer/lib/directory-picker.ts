import type {
  HostDirectoryEntry,
  HostDirectorySnapshot,
} from "@shared/host-directory";

/**
 * Typing model for the host directory picker.
 *
 * The input is the primary surface: what you type is both the path and the
 * filter over the listing, and the listing is a way to keep typing rather than
 * a separate mode. Everything here is pure over one directory page so the
 * behaviour is testable without a rendered tree.
 *
 * Hosts Junto spawns on are macOS/Linux, so paths are posix.
 */

/** Join a host path segment without collapsing the filesystem root. */
export const joinHostPath = (dir: string, name: string): string =>
  dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;

/** Drop a trailing separator, except from the filesystem root itself. */
export const trimTrailingSlash = (path: string): string =>
  path.length > 1 && path.endsWith("/") ? path.replace(/\/+$/, "") : path;

export type DirectoryDraft = {
  /** Directory whose page the draft is pointing at; empty when it names none. */
  readonly dir: string;
  /** Trailing segment still being typed — the filter, never part of the path. */
  readonly query: string;
};

/**
 * Split typed text into "the folder to list" and "the word to match".
 * A trailing separator means the folder is settled and nothing is filtered.
 */
export const parseDirectoryDraft = (draft: string): DirectoryDraft => {
  const text = draft.trim();
  if (text === "" || text === "~") return { dir: text, query: "" };
  const cut = text.lastIndexOf("/");
  if (cut < 0) return { dir: "", query: text };
  const head = text.slice(0, cut);
  return { dir: head === "" ? "/" : head, query: text.slice(cut + 1) };
};

/**
 * Folders on this page that the typed word matches.
 *
 * Prefix hits lead, then substring hits — the order typeahead assumes. Hidden
 * folders stay out of the way until the word actually reaches for one, which
 * is what keeps a home directory from opening on a wall of dotfolders.
 */
export const matchDirectoryEntries = (
  entries: readonly HostDirectoryEntry[],
  query: string,
): ReadonlyArray<HostDirectoryEntry> => {
  const needle = query.trim().toLowerCase();
  const folders = entries.filter(
    (entry) =>
      entry.kind === "directory" &&
      (needle.startsWith(".") || !entry.name.startsWith(".")),
  );
  if (needle === "") return folders;
  const prefix: HostDirectoryEntry[] = [];
  const contains: HostDirectoryEntry[] = [];
  for (const entry of folders) {
    const name = entry.name.toLowerCase();
    if (name.startsWith(needle)) prefix.push(entry);
    else if (name.includes(needle)) contains.push(entry);
  }
  return [...prefix, ...contains];
};

/**
 * The folder inline typeahead should suggest for a typed word: the one folder
 * the word can only mean. Ambiguity suggests nothing rather than guessing —
 * a suggestion that has to be deleted costs more than one that never appeared,
 * and the listing is already filtered down to the candidates either way.
 */
export const bestDirectoryCompletion = (
  entries: readonly HostDirectoryEntry[],
  query: string,
): HostDirectoryEntry | undefined => {
  const needle = query.trim().toLowerCase();
  if (needle === "") return undefined;
  const prefixed = matchDirectoryEntries(entries, needle).filter((entry) =>
    entry.name.toLowerCase().startsWith(needle)
  );
  const only = prefixed.length === 1 ? prefixed[0] : undefined;
  if (!only || only.name.toLowerCase() === needle) return undefined;
  return only;
};

/**
 * The absolute folder the typed text names, or undefined when it names none
 * yet. Only a folder this page can vouch for is selectable, so a half-typed
 * word never becomes a launch directory.
 */
export const directoryFromDraft = (
  draft: string,
  snapshot: HostDirectorySnapshot | undefined,
): string | undefined => {
  if (!snapshot) return undefined;
  const text = trimTrailingSlash(draft.trim());
  if (text === "") return undefined;
  if (text === snapshot.root) return snapshot.root;
  const entry = snapshot.entries.find(
    (candidate) => candidate.kind === "directory" && candidate.path === text,
  );
  return entry?.path;
};

/** A listing and the path that was asked for to get it ("~" answers as the home). */
export type DirectoryPage = {
  readonly requested: string;
  readonly snapshot: HostDirectorySnapshot;
};

/**
 * Read typed text against the page that answered it, so "~/Pro" on the page
 * "~" resolved to means "/Users/developer/Pro". The input keeps what the user
 * typed; only the reading of it is canonical.
 */
export const expandDraft = (
  draft: string,
  page: DirectoryPage | undefined,
): string => {
  const text = draft.trim();
  if (!page) return text;
  const from = trimTrailingSlash(page.requested.trim());
  const root = page.snapshot.root;
  if (from === "" || from === "/" || from === root) return text;
  if (text === from) return root;
  if (text.startsWith(`${from}/`)) {
    return joinHostPath(root, text.slice(from.length + 1));
  }
  return text;
};

/**
 * What accepting the typeahead makes the draft: the typed text up to its last
 * separator, the folder's real name, and a closing separator, so accepting is
 * an explicit step into that folder. The highlighted row wins when the word
 * still reaches it; otherwise only a folder the word can only mean. Undefined
 * when the draft does not point at this page, or names no parent at all.
 */
export const directoryCompletion = (
  draft: string,
  page: DirectoryPage | undefined,
  active?: HostDirectoryEntry,
): string | undefined => {
  if (!page) return undefined;
  const cut = draft.lastIndexOf("/");
  if (cut < 0) return undefined;
  const head = draft.slice(0, cut + 1);
  if (trimTrailingSlash(expandDraft(head, page)) !== page.snapshot.root) {
    return undefined;
  }
  const word = draft.slice(cut + 1);
  const reaches =
    active?.kind === "directory" &&
    active.name.toLowerCase().startsWith(word.toLowerCase());
  const pick = reaches ? active : bestDirectoryCompletion(page.snapshot.entries, word);
  return pick ? `${head}${pick.name}/` : undefined;
};
