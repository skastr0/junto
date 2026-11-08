import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { use$ } from "@legendapp/state/react";
import type { ArtifactHead } from "@shared/resource-ipc";
import type { NodeId } from "@shared/physics/schema";
import { artifactsSource, type ArtifactsSource } from "./artifacts-source";
import { modelStore } from "./use-model";

const NONE: ReadonlyArray<ArtifactHead> = [];

/**
 * Every artifact head on a canvas, read once for everyone who asks. Quick
 * capture's list, its Move to column, the capture editor and the mention
 * pickers each used to read all of a canvas's Artifacts nodes on their own,
 * and again on every artifact change: on the operator's factory canvas that
 * is 29 nodes and 4.6 MB of bodies, four times over per Cmd+T and per save.
 * Now one read serves them all, at most one is in flight with one more
 * queued behind it, and the last read is kept between opens, so a surface
 * that comes back draws its rows on its first frame and re-reads behind them.
 */
export type CanvasArtifactHeads = {
  /** The newest heads read for this canvas's Artifacts nodes; may predate a change not yet re-read. */
  readonly heads: ReadonlyArray<ArtifactHead>;
  /**
   * The heads are ones this caller may act on: read since it mounted, or read
   * with no change since. A kept read from an earlier open is shown, never
   * trusted, until its re-read lands.
   */
  readonly confirmed: boolean;
};

type Held = {
  /** The Artifacts node ids the heads were read from, joined. */
  readonly key: string;
  readonly heads: ReadonlyArray<ArtifactHead>;
  /** No change has landed since this read. */
  readonly fresh: boolean;
  /** Counts reads that landed, so a mount can tell a read made after it. */
  readonly generation: number;
};

type Entry = {
  held: Held;
  /** The node set the readers want now, and its key. */
  nodes: ReadonlyArray<string>;
  want: string;
  readers: Set<() => void>;
  reading: boolean;
  again: boolean;
};

const entries = new Map<string, Entry>();
let listening: { readonly source: ArtifactsSource; readonly stop: () => void } | undefined;

const notify = (entry: Entry): void => {
  for (const reader of [...entry.readers]) reader();
};

const read = (canvasName: string, entry: Entry): void => {
  if (entry.reading) {
    entry.again = true;
    return;
  }
  entry.reading = true;
  const key = entry.want;
  const nodes = entry.nodes;
  const landed = (heads: ReadonlyArray<ArtifactHead> | undefined): void => {
    entry.reading = false;
    const queued = entry.again;
    entry.again = false;
    if (heads !== undefined && key === entry.want) {
      entry.held = { key, heads, fresh: !queued, generation: entry.held.generation + 1 };
      notify(entry);
    }
    if ((queued || key !== entry.want) && entry.readers.size > 0) read(canvasName, entry);
  };
  if (nodes.length === 0) {
    landed(NONE);
    return;
  }
  void Promise.all(nodes.map((nodeId) => artifactsSource().list(canvasName, nodeId as NodeId))).then(
    (lists) => landed(lists.flat()),
    () => landed(undefined),
  );
};

/**
 * One change listener for every canvas, on whichever source is current. A
 * change marks the canvas's read stale; it is re-read now when someone is
 * reading it, and on the next open when nobody is.
 */
const listen = (): void => {
  const source = artifactsSource();
  if (listening?.source === source) return;
  listening?.stop();
  // A new source (tests, or main's switch) owns none of the old reads.
  entries.clear();
  const stop = source.onChanged((changed) => {
    const entry = entries.get(changed.canvasName);
    if (entry === undefined) return;
    if (entry.held.fresh) entry.held = { ...entry.held, fresh: false };
    if (entry.readers.size > 0) read(changed.canvasName, entry);
  });
  listening = { source, stop };
};

const entryOf = (canvasName: string): Entry => {
  listen();
  let entry = entries.get(canvasName);
  if (entry === undefined) {
    entry = { held: { key: "", heads: NONE, fresh: false, generation: 0 }, nodes: [], want: "", readers: new Set(), reading: false, again: false };
    entries.set(canvasName, entry);
  }
  return entry;
};

/** The canvas's Artifacts node ids, joined: it changes only when that set does, not on every node edit. */
const useArtifactNodesKey = (canvasName: string): string =>
  use$(() => {
    modelStore.canvas$(canvasName).nodes.get();
    const ids: string[] = [];
    for (const node of modelStore.canvasOf(canvasName).nodes.values()) if (node.kind === "artifacts") ids.push(node.id);
    return ids.join(",");
  });

/** The artifact heads of every Artifacts node on the canvas, shared, kept between opens. */
export const useCanvasArtifactHeads = (canvasName: string): CanvasArtifactHeads => {
  const key = useArtifactNodesKey(canvasName);
  const entry = canvasName === "" ? undefined : entryOf(canvasName);
  if (entry !== undefined && entry.want !== key) {
    entry.want = key;
    entry.nodes = key === "" ? [] : key.split(",");
  }
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
  const held = useSyncExternalStore(subscribe, () => entry?.held);
  // Read when this reader arrives and its read is stale, or the node set moved.
  useEffect(() => {
    if (entry === undefined) return;
    if (!entry.held.fresh || entry.held.key !== key) read(canvasName, entry);
  }, [canvasName, entry, key]);
  // What this mount may trust: a read made after it, or one with no change since.
  const mountedAt = useRef<{ readonly key: string; readonly generation: number } | undefined>(undefined);
  if (mountedAt.current?.key !== key) mountedAt.current = { key, generation: held?.generation ?? 0 };
  const trusted = useRef<string | undefined>(undefined);
  if (held !== undefined && held.key === key && (held.fresh || held.generation > mountedAt.current.generation)) trusted.current = key;
  if (held === undefined || held.key !== key) return { heads: NONE, confirmed: false };
  return { heads: held.heads, confirmed: trusted.current === key };
};

/**
 * The artifacts of every Artifacts node on the canvas, once this caller may
 * act on them: empty until then, as a fresh read always was.
 */
export const useCanvasArtifacts = (canvasName: string): ReadonlyArray<ArtifactHead> => {
  const { heads, confirmed } = useCanvasArtifactHeads(canvasName);
  return confirmed ? heads : NONE;
};
