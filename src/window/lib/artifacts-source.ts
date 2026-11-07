/**
 * Where the Artifacts node reads and writes its artifacts and their versions
 * (plan 0.10/05). One interface, so the pane never knows which side answers
 * it. Comment threads are the subject threads source's (03).
 *
 * A write is one `ArtifactOp` on a resource command (02), addressed by
 * `target.itemId` and ruled by `artifactDomain` (src/shared/artifact-domain.ts),
 * so a refusal here reads exactly as the editing machine's: `stale` and
 * `rebase_conflict` carry the head in `details.expected`.
 *
 * The interface is main's `ArtifactResourceApi` (src/shared/resource-ipc.ts) as is.
 *
 * In the app the artifacts come from main (`window.junto.resource.artifact`,
 * ruled by the same ruler as the CLI); outside it, or with artifacts off,
 * `makeLocalArtifactsSource` holds everything in this window's memory.
 */
import { useEffect, useRef, useState } from "react";
import { Result, Schema } from "effect";
import { canonicalJson } from "@shared/work-canonical-json";
import type { ContentRef } from "@shared/content";
import { type ArtifactBody, type ArtifactOp, ruleArtifactEdit, type ArtifactVersionRecord } from "@shared/artifact";
import {
  artifactDomain,
  type ArtifactEntry,
  type ArtifactFact,
  artifactsOnNode,
  type ArtifactState,
  emptyArtifactState,
} from "@shared/artifact-domain";
import type { NodeId } from "@shared/physics/schema";
import {
  ARTIFACT_HISTORY_PAGE,
  type ArtifactApplyOutcome,
  type ArtifactHead,
  type ArtifactPendingWrite,
  type ArtifactResourceApi,
  type ResourceChanged,
  type ResourceIpcApi,
} from "@shared/resource-ipc";
import {
  emptyRuled,
  type ItemId,
  mintItemId,
  mintOpId,
  type ResourceActor,
  rule,
  type Ruled,
} from "@shared/resource-command";
import { InstallationId } from "@shared/installation-id";
import type { ArtifactLabelColour } from "@shared/artifact-labels";
import type { ArtifactMoveRecord } from "@shared/artifact-move";

export type ArtifactRuling = ArtifactApplyOutcome;

/** Where the node reads and writes artifacts: main's API, or the stand-in with the same shape. */
export type ArtifactsSource = ArtifactResourceApi;

export type { ArtifactPendingWrite };

/** Rule one op under a fresh op id. `artifactId` is the artifact; on `create` the caller mints it. */
export const applyArtifactOp = (
  canvasName: string,
  nodeId: NodeId,
  artifactId: ItemId,
  op: ArtifactOp,
): Promise<ArtifactRuling> => artifactsSource().apply(canvasName, nodeId, artifactId, mintOpId(), op);

/**
 * The stand-in's body ref: a 256-bit FNV-1a digest of the canonical body,
 * not a cryptographic one. Main's domain uses sha256 over the same bytes.
 */
export const localBodyRef = (body: ArtifactBody): ContentRef => {
  const bytes = new TextEncoder().encode(canonicalJson(body));
  let hex = "";
  for (let lane = 0; lane < 8; lane += 1) {
    let hash = (0x811c9dc5 ^ lane) >>> 0;
    for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
    hex += hash.toString(16).padStart(8, "0");
  }
  return {
    sha256: hex as ContentRef["sha256"],
    byteLength: bytes.byteLength as ContentRef["byteLength"],
    mediaType: "application/json" as ContentRef["mediaType"],
  };
};

/** An in-memory source, as the stand-in and for tests. Every write is `actor`'s. */
export const makeLocalArtifactsSource = (
  actor: ResourceActor = { kind: "operator" },
  now: () => number = Date.now,
  /**
   * The command key's writer. The window never names a machine: in the app
   * main's source rules under main's installation; the stand-in rules under
   * an opaque id of its own, minted per source.
   */
  writer: InstallationId = Schema.decodeUnknownSync(InstallationId)(mintItemId()),
): ArtifactsSource => {
  const domain = artifactDomain({ now, bodyRef: localBodyRef });
  const ruled = new Map<string, Ruled<ArtifactState, ArtifactFact>>();
  const versions = new Map<ItemId, ReadonlyArray<ArtifactVersionRecord>>();
  /** Every move by artifact, oldest first, as main's `artifact_moves` holds them. */
  const moves = new Map<ItemId, ReadonlyArray<ArtifactMoveRecord>>();
  /** Label colours by canvas and node, as main's `artifact_label_colours` holds them. */
  const colours = new Map<string, Record<string, ArtifactLabelColour>>();
  const coloursKey = (canvasName: string, nodeId: NodeId): string => `${canvasName}\n${nodeId}`;
  const listeners = new Set<(changed: ResourceChanged) => void>();
  const changed = (canvasName: string): void => {
    for (const listener of listeners) listener({ canvasName });
  };
  const ruledOf = (canvasName: string) => ruled.get(canvasName) ?? emptyRuled<ArtifactState, ArtifactFact>(emptyArtifactState());

  const record = (fact: ArtifactFact, state: ArtifactState): void => {
    const push = (artifactId: ItemId, entry: ArtifactVersionRecord): void => {
      versions.set(artifactId, [entry, ...(versions.get(artifactId) ?? [])]);
    };
    // The stand-in keeps every version's body by hand; main serves them by bodyRef.
    if (fact.fact === "artifact.created") {
      const body = state.get(fact.artifact.artifactId)?.body;
      if (body == null) return;
      push(fact.artifact.artifactId, {
        artifactId: fact.artifact.artifactId,
        version: fact.artifact.version,
        author: fact.artifact.createdBy,
        at: fact.artifact.updatedAt,
        body,
      });
    } else if (fact.fact === "artifact.moved") {
      moves.set(fact.artifactId, [...(moves.get(fact.artifactId) ?? []), { from: fact.from, to: fact.to, by: fact.by, at: fact.at }]);
    } else if (fact.fact === "artifact.edited") {
      const body = state.get(fact.artifactId)?.body;
      if (body == null) return;
      push(fact.artifactId, { artifactId: fact.artifactId, version: fact.version, author: fact.author, at: fact.at, body });
    }
  };

  /**
   * A body too big to ride in its fact folds as not loaded; main loads it by
   * ref. The stand-in has no content store, so it puts back the body the op
   * itself made.
   */
  const hydrate = (
    state: ArtifactState,
    itemId: ItemId,
    before: ArtifactEntry | undefined,
    op: ArtifactOp,
  ): ArtifactState => {
    const entry = state.get(itemId);
    if (entry === undefined || entry.body !== null) return state;
    let body: ArtifactBody | null = null;
    if (op.op === "create") body = op.body;
    else if (op.op === "edit" && op.edit.kind === "replace") body = op.edit.body;
    else if (op.op === "edit" && before?.body != null) {
      const since = before.edits.slice(Math.max(0, op.edit.baseVersion + 1 - before.editsFrom));
      const next = ruleArtifactEdit({ version: before.artifact.version, body: before.body }, op.edit, since);
      body = Result.isSuccess(next) ? next.success.body : null;
    }
    return body === null ? state : new Map(state).set(itemId, { ...entry, body });
  };

  return {
    // The stand-in rules every write at once: nothing waits.
    pending: async () => [],
    list: async (canvasName, nodeId) =>
      artifactsOnNode(ruledOf(canvasName).state, nodeId).map(({ artifact, body, bodyRef }) => ({ artifact, body, bodyRef })),
    history: async (_canvasName, artifactId) => (versions.get(artifactId) ?? []).slice(0, ARTIFACT_HISTORY_PAGE),
    moves: async (_canvasName, artifactId) => moves.get(artifactId) ?? [],
    body: async (_canvasName, artifactId, version) =>
      versions.get(artifactId)?.find((record) => record.version === version)?.body ?? null,
    apply: async (canvasName, nodeId, itemId, opId, op) => {
      const before = ruledOf(canvasName).state.get(itemId);
      const result = rule(
        domain,
        ruledOf(canvasName),
        writer,
        {
          opId,
          canvasName,
          actor,
          target: { kind: "artifact", nodeId, itemId },
          basis: null,
          after: [],
          op,
        },
        { inReach: () => true },
      );
      const state = hydrate(result.ruled.state, itemId, before, op);
      ruled.set(canvasName, { ...result.ruled, state });
      if (result.ruling.kind === "applied") {
        for (const fact of result.ruling.facts) record(fact, state);
        changed(canvasName);
      }
      return result.ruling.kind === "applied"
        ? { kind: "applied", opId: result.ruling.opId, facts: result.ruling.facts }
        : { kind: "refused", opId: result.ruling.opId, error: result.ruling.error };
    },
    labelColours: async (canvasName, nodeId) =>
      Object.assign(Object.create(null) as Record<string, ArtifactLabelColour>, colours.get(coloursKey(canvasName, nodeId))),
    colour: async (canvasName, nodeId, opId, label, colour) => {
      const result = rule(
        domain,
        ruledOf(canvasName),
        writer,
        { opId, canvasName, actor, target: { kind: "artifact", nodeId }, basis: null, after: [], op: { op: "labelColour", label, colour } },
        { inReach: () => true },
      );
      ruled.set(canvasName, result.ruled);
      if (result.ruling.kind === "refused") return { kind: "refused", opId, error: result.ruling.error };
      for (const fact of result.ruling.facts) {
        if (fact.fact !== "artifact.label.coloured") continue;
        const held = colours.get(coloursKey(canvasName, nodeId)) ?? (Object.create(null) as Record<string, ArtifactLabelColour>);
        if (fact.colour === null) delete held[fact.label];
        else held[fact.label] = fact.colour;
        colours.set(coloursKey(canvasName, nodeId), held);
      }
      changed(canvasName);
      return { kind: "applied", opId };
    },
    onChanged: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};

/** Main's artifact API; absent outside the app or with artifacts off. */
const mainArtifacts = (): ArtifactResourceApi | undefined =>
  typeof window === "undefined"
    ? undefined
    : (window as { junto?: { resource?: Partial<ResourceIpcApi> } }).junto?.resource?.artifact;

/** This window's source: main's when it serves artifacts, else the local stand-in. */
let source: ArtifactsSource = mainArtifacts() ?? makeLocalArtifactsSource();

export const artifactsSource = (): ArtifactsSource => source;

/** Tests and the main-side switch set the source. */
export const setArtifactsSource = (next: ArtifactsSource): void => {
  source = next;
};

/**
 * Re-read whenever the source changes or `key` does. A value read for an
 * earlier key is never shown for the new one: until its first read lands,
 * the new key reads `initial`.
 */
const useSourced = <T>(read: () => Promise<T>, initial: T, canvasName: string, key: string): T => {
  const [held, setHeld] = useState<{ readonly key: string; readonly value: T }>({ key, value: initial });
  const readRef = useRef(read);
  readRef.current = read;
  useEffect(() => {
    let live = true;
    const refresh = (): void => {
      void readRef.current().then((value) => {
        if (live) setHeld({ key, value });
      });
    };
    refresh();
    const unsubscribe = artifactsSource().onChanged((changed) => {
      if (changed.canvasName === canvasName) refresh();
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [canvasName, key]);
  return held.key === key ? held.value : initial;
};

const NONE: ReadonlyArray<never> = [];

export const useNodeArtifacts = (canvasName: string, nodeId: NodeId): ReadonlyArray<ArtifactHead> =>
  useSourced(() => artifactsSource().list(canvasName, nodeId), NONE, canvasName, nodeId);

/**
 * How many live (unarchived) artifacts a node holds, for its card's glance.
 * Any artifact change on the canvas re-reads, but only a change of this
 * count repaints the card. Only the latest read lands, and a failed read
 * keeps the last count.
 */
export const useNodeArtifactCount = (canvasName: string, nodeId: NodeId, enabled: boolean): number => {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!enabled || !canvasName) return;
    let live = true;
    let generation = 0;
    const refresh = (): void => {
      const mine = ++generation;
      artifactsSource().list(canvasName, nodeId).then(
        (heads) => {
          if (live && mine === generation) setCount(heads.filter((head) => !head.artifact.archived).length);
        },
        () => undefined,
      );
    };
    refresh();
    const unsubscribe = artifactsSource().onChanged((changed) => {
      if (changed.canvasName === canvasName) refresh();
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [canvasName, nodeId, enabled]);
  return enabled && canvasName ? count : 0;
};

/**
 * The head's body: the listed one, or, when main lists it as not loaded,
 * read by version. Null until it arrives.
 */
export const useHeadBody = (canvasName: string, head: ArtifactHead): ArtifactBody | null => {
  const { artifactId, version } = head.artifact;
  const read = useSourced(
    () => (head.body === null ? artifactsSource().body(canvasName, artifactId, version) : Promise.resolve(null)),
    null,
    canvasName,
    `${artifactId}\u0000${version}\u0000${head.body === null ? "load" : "held"}`,
  );
  return head.body ?? read;
};

export const useArtifactHistory = (canvasName: string, artifactId: ItemId | null): ReadonlyArray<ArtifactVersionRecord> =>
  useSourced(
    () => (artifactId === null ? Promise.resolve(NONE) : artifactsSource().history(canvasName, artifactId)),
    NONE,
    canvasName,
    `${artifactId}`,
  );

/** Every move of one artifact, oldest first: its history's move lines (0.11.1, 10). */
export const useArtifactMoves = (canvasName: string, artifactId: ItemId | null): ReadonlyArray<ArtifactMoveRecord> =>
  useSourced(
    () => (artifactId === null ? Promise.resolve(NONE) : artifactsSource().moves(canvasName, artifactId)),
    NONE,
    canvasName,
    `moves\u0000${artifactId}`,
  );

export const useNodePendingWrites = (canvasName: string, nodeId: NodeId): ReadonlyArray<ArtifactPendingWrite> =>
  useSourced(() => artifactsSource().pending(canvasName, nodeId), NONE, canvasName, `pending\u0000${nodeId}`);

/** A refusal said in one line for the pane. */
export const refusalLine = (ruling: ArtifactRuling): string | null =>
  ruling.kind === "refused" ? ruling.error.message : null;
