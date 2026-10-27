import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { FILES_COUNT_CAP, parseFilePath, type FilePath, type FilesCount } from "@shared/files";
import { inProcessEngine, type IndexSearch } from "./index-engine";
import { COMPACT_AFTER } from "./name-index";
import { linkInside, type NameSink, type NameSources } from "./sources";
import { watchRoot, type Timers, type WatchBatch, type WatchFactory } from "./watcher";

/**
 * Everything the Files service keeps per root, apart from the filesystem
 * calls: one watcher, one name index, the deltas between them, and counts
 * of roots no window holds. In the app it runs in the index worker thread
 * (`index-worker.ts`), so the walk, git's output, the watcher's events and
 * every search stay off main's loop; tests run it in process.
 *
 * A root is held while any session holds it; the last release drops the
 * watcher and the index. Only the first build is waited for: after that a
 * stale index answers while its rebuild runs, and a fresh one answers
 * before its queued deltas land.
 */

export type RootEvent =
  | { readonly kind: "paths"; readonly paths: ReadonlyArray<FilePath> }
  | { readonly kind: "reset" }
  /** The root's watch failed (it went away, most often): the holder is gone. */
  | { readonly kind: "lost" };

export interface RootIndex {
  /** Hold `root` for a session: its watcher starts now, its index on the first search. */
  hold(root: string, session: string): Promise<{ readonly repo: boolean }>;
  /** The root's file count when this was the last session on a fresh index, for the card. */
  release(root: string, session: string): Promise<FilesCount | undefined>;
  /** On a root the session holds; rejects otherwise, holding nothing. */
  search(root: string, session: string, query: string): Promise<IndexSearch>;
  /** From the index when held, else one git ls-files or capped walk. */
  count(root: string): Promise<FilesCount>;
}

export type RootIndexDeps = {
  readonly names: NameSources;
  readonly emit: (root: string, event: RootEvent) => void;
  readonly watch?: WatchFactory;
  readonly timers?: Timers;
};

type Holder = {
  readonly root: string;
  readonly sessions: Set<string>;
  readonly watcher: { readonly close: () => void };
  readonly abort: AbortController;
  repo?: boolean;
  /** The engine slot of the index that answers, once one is built. */
  slot?: number;
  size: number;
  drift: number;
  building?: Promise<void>;
  /** Paths seen while a build ran, applied once it lands. */
  heldDuringBuild?: string[];
  stale: boolean;
  /** Deltas apply one batch at a time. */
  deltas: Promise<void>;
  /** Paths waiting in `deltas`. */
  queued: number;
  /** Bursts seen: a build that saw one arrive mid-scan leaves the index stale. */
  bursts: number;
};

export const makeRootIndex = (deps: RootIndexDeps): RootIndex & { readonly settle: () => Promise<void> } => {
  const { names, emit } = deps;
  const engine = inProcessEngine();
  const holders = new Map<string, Holder>();
  let slots = 0;

  const dropHolder = (holder: Holder): void => {
    if (holder.slot !== undefined) engine.drop(holder.slot);
    holder.abort.abort();
    holder.watcher.close();
    holders.delete(holder.root);
  };

  /** Build into a fresh slot; the old one answers until this one lands. */
  const buildIndex = (holder: Holder): Promise<void> => {
    const build = async (): Promise<void> => {
      holder.heldDuringBuild = [];
      const bursts = holder.bursts;
      const signal = holder.abort.signal;
      holder.repo ??= await names.isGitRoot(holder.root, signal);
      const fresh = (): number => {
        slots += 1;
        engine.begin(slots);
        return slots;
      };
      let slot = fresh();
      const sinkInto = (into: number): NameSink => (batch) => engine.names(into, batch);
      let state;
      try {
        if (holder.repo) {
          try {
            await names.gitNames(holder.root, sinkInto(slot), signal);
          } catch (cause) {
            console.error("[files] git ls-files failed, walking instead", cause);
            engine.drop(slot);
            slot = fresh();
            await names.walkNames(holder.root, sinkInto(slot), signal);
          }
        } else {
          await names.walkNames(holder.root, sinkInto(slot), signal);
        }
        state = await engine.finish(slot);
      } catch (cause) {
        engine.drop(slot);
        throw cause;
      }
      if (signal.aborted) {
        engine.drop(slot);
        return;
      }
      const previous = holder.slot;
      holder.slot = slot;
      holder.size = state.size;
      holder.drift = state.drift;
      if (previous !== undefined) engine.drop(previous);
      // A burst keeps no paths: one that came mid-scan may be missing, so build again.
      holder.stale = holder.bursts !== bursts;
      const held = holder.heldDuringBuild;
      holder.heldDuringBuild = undefined;
      // On the chain, so no batch that came after the build interleaves with these.
      if (held.length > 0 && !holder.stale) {
        holder.queued += held.length;
        holder.deltas = holder.deltas
          .then(() => applyDeltas(holder, slot, held))
          .catch((cause: unknown) => {
            console.error("[files] index delta failed; rebuilding", cause);
            holder.stale = true;
          })
          .finally(() => {
            holder.queued -= held.length;
          });
      }
    };
    const building = build().finally(() => {
      if (holder.building === building) holder.building = undefined;
    });
    holder.building = building;
    return building;
  };

  /**
   * Ready to search: only the first build is awaited. After that the index
   * answers as it is: a stale one while its rebuild runs, a fresh one before
   * its queued deltas land (a check-ignore on a big repo can take seconds).
   */
  const ready = async (holder: Holder): Promise<void> => {
    if (holder.slot === undefined) {
      await (holder.building ?? buildIndex(holder));
      return;
    }
    if (holder.stale && holder.building === undefined) {
      buildIndex(holder).catch((cause: unknown) => console.error("[files] index rebuild failed", cause));
    }
  };

  /**
   * Fold one batch of changed paths into a built index. Ignored paths drop
   * first, deletes included (check-ignore matches by pattern, so a gone
   * `dist/` file needs no lookup). A folder that appeared is walked; the
   * engine sweeps folders that went. A stale index takes no deltas.
   */
  const applyDeltas = async (holder: Holder, slot: number, paths: ReadonlyArray<string>): Promise<void> => {
    const signal = holder.abort.signal;
    // A delta for an index a rebuild replaced: the new scan already has it.
    const current = (): boolean => !holder.stale && !signal.aborted && holder.slot === slot;
    if (!current()) return;
    const ignoredNow = holder.repo === true ? await names.gitIgnored(holder.root, paths, signal) : new Set<string>();
    const adds: string[] = [];
    const gone: string[] = [];
    const drop: string[] = [];
    const walked: string[] = [];
    for (const path of paths) {
      if (!current()) return;
      const info = await lstat(join(holder.root, path)).catch(() => undefined);
      if (ignoredNow.has(path)) {
        // Never added, never swept; gone, it leaves the index if it was there.
        if (info === undefined) drop.push(path);
      } else if (info === undefined) {
        gone.push(path);
      } else if (info.isDirectory()) {
        await names.walkNames(join(holder.root, path), (batch) => {
          for (const name of batch) walked.push(`${path}/${name}`);
        }, signal, undefined, holder.root);
      } else if (info.isSymbolicLink() && !(await linkInside(holder.root, join(holder.root, path)))) {
        // Points out of the root (or nowhere): no row that could only fail.
        drop.push(path);
      } else {
        adds.push(path);
      }
    }
    const ignoredWalked = holder.repo === true ? await names.gitIgnored(holder.root, walked, signal) : new Set<string>();
    if (!current()) return;
    for (const path of walked) if (!ignoredWalked.has(path)) adds.push(path);
    const outcome = await engine.apply(slot, { adds, gone, drop });
    if (holder.slot !== slot) return;
    holder.size = outcome.size;
    holder.drift = outcome.drift;
    if (outcome.overflow || outcome.drift > COMPACT_AFTER) holder.stale = true;
  };

  const onBatch = (holder: Holder, batch: WatchBatch): void => {
    if (batch.kind === "lost") {
      dropHolder(holder);
      emit(holder.root, { kind: "lost" });
      return;
    }
    if (batch.kind === "burst") {
      holder.bursts += 1;
      holder.stale = true;
      emit(holder.root, { kind: "reset" });
      return;
    }
    const paths = batch.paths.flatMap((raw) => {
      const path = parseFilePath(raw);
      return path === undefined ? [] : [path];
    });
    if (paths.length === 0) return;
    emit(holder.root, { kind: "paths", paths });
    if (holder.heldDuringBuild !== undefined) {
      holder.heldDuringBuild.push(...paths);
      return;
    }
    const slot = holder.slot;
    if (slot === undefined || holder.stale) return;
    // More queued than a rebuild costs: go stale now and drop the queue.
    if (holder.drift + holder.queued + paths.length > COMPACT_AFTER) {
      holder.stale = true;
      return;
    }
    holder.queued += paths.length;
    holder.deltas = holder.deltas
      .then(() => applyDeltas(holder, slot, paths))
      .catch((cause: unknown) => {
        console.error("[files] index delta failed; rebuilding on next search", cause);
        holder.stale = true;
      })
      .finally(() => {
        holder.queued -= paths.length;
      });
  };

  /** Cards on the same unheld root share one count in flight. */
  const counting = new Map<string, Promise<FilesCount>>();

  /** Count names without keeping them: one git ls-files, or a walk that stops at the cap. */
  const countOnce = async (root: string): Promise<FilesCount> => {
    const signal = new AbortController().signal;
    let files = 0;
    const sink: NameSink = (batch) => {
      files += batch.length;
    };
    if (await names.isGitRoot(root, signal)) {
      try {
        await names.gitNames(root, sink, signal);
        return { files, capped: false };
      } catch (cause) {
        console.error("[files] git ls-files failed, walking instead", cause);
        files = 0;
      }
    }
    await names.walkNames(root, sink, signal, FILES_COUNT_CAP);
    return { files, capped: files >= FILES_COUNT_CAP };
  };

  const holderFor = (root: string, session: string): Holder => {
    let holder = holders.get(root);
    if (holder === undefined) {
      let created: Holder | undefined;
      const watcher = watchRoot(root, (batch) => {
        if (created !== undefined) onBatch(created, batch);
      }, deps.watch, deps.timers);
      created = {
        root,
        sessions: new Set(),
        watcher,
        abort: new AbortController(),
        stale: false,
        deltas: Promise.resolve(),
        queued: 0,
        bursts: 0,
        size: 0,
        drift: 0,
      };
      holder = created;
      holders.set(root, holder);
    }
    holder.sessions.add(session);
    return holder;
  };

  return {
    hold: async (root, session) => {
      const holder = holderFor(root, session);
      holder.repo ??= await names.isGitRoot(root, holder.abort.signal).catch(() => false);
      return { repo: holder.repo };
    },

    release: async (root, session) => {
      const holder = holders.get(root);
      if (holder === undefined || !holder.sessions.delete(session)) return undefined;
      if (holder.slot !== undefined) engine.forget(holder.slot, session);
      if (holder.sessions.size > 0) return undefined;
      // The last count a card sees until the root is opened again.
      const last = holder.slot !== undefined && !holder.stale ? { files: holder.size, capped: false } : undefined;
      dropHolder(holder);
      return last;
    },

    search: async (root, session, query) => {
      const holder = holders.get(root);
      if (holder === undefined || !holder.sessions.has(session)) throw new Error("files root not held");
      await ready(holder);
      const slot = holder.slot;
      if (slot === undefined) throw new Error("files index missing");
      return engine.search(slot, session, query);
    },

    count: async (root) => {
      const holder = holders.get(root);
      if (holder !== undefined) {
        await ready(holder);
        return { files: holder.size, capped: false };
      }
      const running = counting.get(root);
      if (running !== undefined) return running;
      const once = countOnce(root).finally(() => counting.delete(root));
      counting.set(root, once);
      return once;
    },

    /** Every rebuild and queued delta done: for tests and measurements. */
    settle: async () => {
      for (;;) {
        const busy = [...holders.values()].flatMap((holder) => [holder.building, holder.deltas]);
        await Promise.all(busy.map((work) => work?.catch(() => undefined)));
        if ([...holders.values()].every((holder) => holder.building === undefined)) return;
      }
    },
  };
};
