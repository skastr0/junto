import type { FileMatch } from "@shared/files";
import { NameIndex, NameIndexBuilder, type MatchSet } from "./name-index";

/**
 * Where a root's name index is built, held and searched, in numbered slots,
 * for the root index (`root-index.ts`, in the index worker thread in the app).
 *
 * An index sits in a numbered slot. A rebuild fills a new slot while the old
 * one keeps answering, then the service drops the old one.
 */

/** A batch of changes for one index, already classified by main (lstat, ignore rules, links). */
export type IndexDelta = {
  /** Files that exist now. */
  readonly adds: ReadonlyArray<string>;
  /** Paths that went away: a file in the index, else a folder to sweep. */
  readonly gone: ReadonlyArray<string>;
  /** Paths that exist but must not be listed (a link that points out of the root). */
  readonly drop: ReadonlyArray<string>;
};

export type IndexState = { readonly size: number; readonly drift: number };

/** `overflow`: more folders went than a sweep is worth; the service rebuilds instead. */
export type DeltaOutcome = IndexState & { readonly overflow: boolean };

export type IndexSearch = { readonly matches: ReadonlyArray<FileMatch>; readonly total: number };

export interface IndexEngine {
  begin(slot: number): void;
  names(slot: number, names: ReadonlyArray<string>): void;
  finish(slot: number): Promise<IndexState>;
  apply(slot: number, delta: IndexDelta): Promise<DeltaOutcome>;
  /** Narrows from the session's previous query on the same slot when it can. */
  search(slot: number, session: string, query: string): Promise<IndexSearch>;
  forget(slot: number, session: string): void;
  drop(slot: number): void;
}

/** Folders gone in one batch past which a rebuild is cheaper than a sweep. */
export const SWEEP_MAX = 64;

type Slot = { builder?: NameIndexBuilder; index?: NameIndex; readonly sets: Map<string, MatchSet> };

/** The engine's work, wherever it runs. */
export const makeIndexHandler = () => {
  const slots = new Map<number, Slot>();
  const indexIn = (slot: number): { readonly index: NameIndex; readonly sets: Map<string, MatchSet> } => {
    const held = slots.get(slot);
    if (held?.index === undefined) throw new Error(`no index in slot ${String(slot)}`);
    return { index: held.index, sets: held.sets };
  };
  return {
    begin: (slot: number): void => {
      slots.set(slot, { builder: new NameIndexBuilder(), sets: new Map() });
    },
    names: (slot: number, names: ReadonlyArray<string>): void => {
      slots.get(slot)?.builder?.add(names);
    },
    finish: async (slot: number): Promise<IndexState> => {
      const held = slots.get(slot);
      if (held?.builder === undefined) throw new Error(`no build in slot ${String(slot)}`);
      const index = await held.builder.finish();
      held.builder = undefined;
      held.index = index;
      return { size: index.size, drift: index.drift };
    },
    apply: async (slot: number, delta: IndexDelta): Promise<DeltaOutcome> => {
      const { index } = indexIn(slot);
      for (const path of delta.drop) if (index.has(path)) index.remove(path);
      const folders: string[] = [];
      for (const path of delta.gone) {
        if (index.has(path)) index.remove(path);
        else folders.push(path);
      }
      if (folders.length > SWEEP_MAX) return { size: index.size, drift: index.drift, overflow: true };
      index.removeUnder(folders);
      for (const path of delta.adds) index.add(path);
      return { size: index.size, drift: index.drift, overflow: false };
    },
    search: async (slot: number, session: string, query: string): Promise<IndexSearch> => {
      const { index, sets } = indexIn(slot);
      if (query.trim() === "") return { matches: [], total: index.size };
      const { matches, set } = index.search(query, sets.get(session));
      sets.set(session, set);
      return { matches, total: index.size };
    },
    forget: (slot: number, session: string): void => {
      slots.get(slot)?.sets.delete(session);
    },
    drop: (slot: number): void => {
      slots.delete(slot);
    },
  };
};

/** The handler in this thread: the root index holds its engine where it runs. */
export const inProcessEngine = (): IndexEngine => makeIndexHandler();
