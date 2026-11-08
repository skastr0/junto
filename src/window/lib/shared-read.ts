import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

/**
 * Reads that many callers share. A canvas holds one Artifacts card per node,
 * each with a count on its shell, and Tasks cards that each read their node,
 * the canvas's tasks and its facts; every one used to read on its own, and
 * again on every change. On the operator's factory canvas one artifact write
 * meant 29 node reads plus Quick capture's, and one task write meant every
 * task reader on the board reading 744 tasks.
 *
 * Here a read is keyed. Every caller of a key shares one read, at most one is
 * in flight with one more queued behind it, and the last value is kept when
 * nobody is reading, so a surface that comes back draws at once. A change
 * marks its canvas's reads stale; a stale read is re-read now if someone is
 * reading it, else on the next mount. A kept value is shown but not trusted
 * (confirmed false) until a read made after the mount lands, unless no change
 * came since it was read.
 */

type Snap = {
  readonly has: boolean;
  readonly value: unknown;
  /** No change has landed since this value was read. */
  readonly fresh: boolean;
  /** Counts reads that landed, so a mount can tell a read made after it. */
  readonly generation: number;
};

type Entry = {
  readonly canvas: string;
  /** The node the read is of, when it is one node's: a notice naming other nodes leaves it fresh. */
  readonly node: string | undefined;
  snap: Snap;
  /** The newest read a caller gave for this key. */
  read: () => Promise<unknown>;
  readers: Set<() => void>;
  reading: boolean;
  again: boolean;
};

const EMPTY: Snap = { has: false, value: undefined, fresh: false, generation: 0 };

export type SharedValue<T> = {
  /** The newest value read for the key; may predate a change not yet re-read. Undefined before any read. */
  readonly value: T | undefined;
  /** The value is one this caller may act on: read since it mounted, or read with no change since. */
  readonly confirmed: boolean;
};

export type SharedReadSpec<T> = {
  readonly key: string;
  readonly canvas: string;
  /** The one node this read is of, if it is; a change naming nodes re-reads only theirs. */
  readonly node?: string;
  readonly read: () => Promise<T>;
};

export type SharedReads = {
  /** One shared value. A null spec reads nothing. */
  readonly use: <T>(spec: SharedReadSpec<T> | null) => SharedValue<T>;
  /** Several, as one snapshot that changes only when one of them does. */
  readonly useAll: <T>(specs: ReadonlyArray<SharedReadSpec<T>>) => ReadonlyArray<SharedValue<T>>;
  /** A selection of one shared value, trusted values only; the caller re-renders only when the selection changes. */
  readonly useSelected: <T, R>(spec: SharedReadSpec<T> | null, select: (value: T) => R, initial: R) => R;
};

/**
 * A family of shared reads over one source. `listen` hears the source's
 * changes and names the canvas each is for (undefined: every canvas). A new
 * source (tests, or main's switch) drops every value read from the old one.
 */
export const makeSharedReads = (
  sourceOf: () => object,
  listen: (source: object, changed: (canvas: string | undefined, nodes?: ReadonlyArray<string>) => void) => () => void,
  {
    /**
     * Whether a kept value with no change since may be trusted by a new mount.
     * False where a read can go stale without a change notice: every mount
     * then reads (sharing a read already out), as an unshared read always did.
     */
    trustKept = true,
  }: { readonly trustKept?: boolean } = {},
): SharedReads => {
  const entries = new Map<string, Entry>();
  let listening: { readonly source: object; readonly stop: () => void } | undefined;

  const notify = (entry: Entry): void => {
    for (const reader of [...entry.readers]) reader();
  };

  const start = (entry: Entry): void => {
    if (entry.reading) {
      entry.again = true;
      return;
    }
    entry.reading = true;
    const landed = (ok: boolean, value?: unknown): void => {
      entry.reading = false;
      const queued = entry.again;
      entry.again = false;
      if (ok) {
        entry.snap = { has: true, value, fresh: !queued, generation: entry.snap.generation + 1 };
        notify(entry);
      }
      if (queued && entry.readers.size > 0) start(entry);
    };
    entry.read().then(
      (value) => landed(true, value),
      () => landed(false),
    );
  };

  const ensureListening = (): void => {
    const source = sourceOf();
    if (listening?.source === source) return;
    listening?.stop();
    entries.clear();
    const stop = listen(source, (canvas, nodes) => {
      for (const entry of entries.values()) {
        if (canvas !== undefined && entry.canvas !== canvas) continue;
        // A notice that names its nodes leaves every other node's read fresh; one that names none means them all.
        if (nodes !== undefined && entry.node !== undefined && !nodes.includes(entry.node)) continue;
        if (entry.snap.fresh) entry.snap = { ...entry.snap, fresh: false };
        if (entry.readers.size > 0) start(entry);
      }
    });
    listening = { source, stop };
  };

  const entryOf = (spec: SharedReadSpec<unknown>): Entry => {
    ensureListening();
    let entry = entries.get(spec.key);
    if (entry === undefined) {
      entry = { canvas: spec.canvas, node: spec.node, snap: EMPTY, read: spec.read, readers: new Set(), reading: false, again: false };
      entries.set(spec.key, entry);
    }
    entry.read = spec.read;
    return entry;
  };

  /** What a mount may trust, per key: a read made after it mounted, or one with no change since. */
  const useTrust = () => {
    const mounted = useRef(new Map<string, number>());
    const trusted = useRef(new Set<string>());
    return (key: string, snap: Snap): boolean => {
      if (!mounted.current.has(key)) mounted.current.set(key, snap.generation);
      if (snap.has && ((trustKept && snap.fresh) || snap.generation > mounted.current.get(key)!)) trusted.current.add(key);
      return trusted.current.has(key);
    };
  };

  const useAll = <T,>(specs: ReadonlyArray<SharedReadSpec<T>>): ReadonlyArray<SharedValue<T>> => {
    const keys = specs.map((spec) => spec.key).join("\u0001");
    const list = specs.map((spec) => entryOf(spec as SharedReadSpec<unknown>));
    // The same entries while the keys are the same, so the subscription holds.
    const heldRef = useRef<{ readonly keys: string; readonly entries: ReadonlyArray<Entry> } | undefined>(undefined);
    if (heldRef.current?.keys !== keys || heldRef.current.entries.some((entry, i) => entry !== list[i])) heldRef.current = { keys, entries: list };
    const held = heldRef.current.entries;
    const subscribe = useCallback(
      (onChange: () => void) => {
        for (const entry of held) entry.readers.add(onChange);
        return () => {
          for (const entry of held) entry.readers.delete(onChange);
        };
      },
      [held],
    );
    // One snapshot for all: the same array until one of the entries' snaps changes.
    const last = useRef<{ readonly snaps: ReadonlyArray<Snap>; readonly held: ReadonlyArray<Entry> } | undefined>(undefined);
    const snapshot = (): ReadonlyArray<Snap> => {
      const prev = last.current;
      if (prev !== undefined && prev.held === held && prev.snaps.every((snap, i) => snap === held[i]!.snap)) return prev.snaps;
      const snaps = held.map((entry) => entry.snap);
      last.current = { snaps, held };
      return snaps;
    };
    const snaps = useSyncExternalStore(subscribe, snapshot);
    // A reader that arrives to a missing or stale value reads it, unless a read is already out.
    useEffect(() => {
      for (const entry of held) if (!entry.reading && (!trustKept || !entry.snap.has || !entry.snap.fresh)) start(entry);
    }, [held]);
    const trust = useTrust();
    const confirmed = snaps.map((snap, i) => trust(specs[i]!.key, snap));
    const bits = confirmed.map((one) => (one ? "1" : "0")).join("");
    return useMemo(
      () => snaps.map((snap, i) => ({ value: snap.value as T | undefined, confirmed: bits[i] === "1" })),
      [snaps, bits],
    );
  };

  const useSelected = <T, R>(spec: SharedReadSpec<T> | null, select: (value: T) => R, initial: R): R => {
    const entry = spec === null ? undefined : entryOf(spec as SharedReadSpec<unknown>);
    const subscribe = useCallback(
      (onChange: () => void) => {
        if (entry === undefined) return () => undefined;
        entry.readers.add(onChange);
        return () => {
          entry.readers.delete(onChange);
        };
      },
      [entry],
    );
    const selectRef = useRef(select);
    selectRef.current = select;
    // The selection for the newest value this mount may trust; the same R until it changes.
    const last = useRef<{ readonly snap: Snap; readonly entry: Entry | undefined; readonly picked: R }>({ snap: EMPTY, entry: undefined, picked: initial });
    const mountedAt = useRef<number | undefined>(undefined);
    const trusted = useRef(false);
    const snapshot = (): R => {
      if (entry === undefined) return initial;
      const snap = entry.snap;
      if (last.current.entry === entry && last.current.snap === snap) return last.current.picked;
      mountedAt.current ??= snap.generation;
      if (snap.has && ((trustKept && snap.fresh) || snap.generation > mountedAt.current)) trusted.current = true;
      const picked = trusted.current ? selectRef.current(snap.value as T) : initial;
      const keep = last.current.entry === entry && Object.is(picked, last.current.picked);
      last.current = { snap, entry, picked: keep ? last.current.picked : picked };
      return last.current.picked;
    };
    const picked = useSyncExternalStore(subscribe, snapshot);
    useEffect(() => {
      if (entry !== undefined && !entry.reading && (!trustKept || !entry.snap.has || !entry.snap.fresh)) start(entry);
    }, [entry]);
    return picked;
  };

  const use = <T,>(spec: SharedReadSpec<T> | null): SharedValue<T> => {
    const values = useAll<T>(spec === null ? [] : [spec]);
    return values[0] ?? { value: undefined, confirmed: false };
  };

  return { use, useAll, useSelected };
};
