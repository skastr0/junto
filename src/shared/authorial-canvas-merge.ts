import type { CanvasDoc, CanvasEdge, CanvasNode, EtherNodeExtension } from "./canvas";
import { resolveNodeHostId } from "./station";
import { mergeLocalCanvasWithWorkWrite } from "./work-canvas-merge";

const WORK_PROJECTION_KEYS = new Set([
  "requests",
  "artifacts",
  "messages",
  "board",
  "pad",
]);

type JsonObject = Readonly<Record<string, unknown>>;

export interface CanvasMergeConflict {
  readonly object: "node" | "edge";
  readonly id: string;
  readonly path: string;
  readonly kind: "concurrent-add" | "delete-vs-edit" | "field";
}

export type AuthorialCanvasMergeResult =
  | { readonly ok: true; readonly doc: CanvasDoc }
  | { readonly ok: false; readonly conflicts: ReadonlyArray<CanvasMergeConflict> };

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const equal = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length
      && left.every((entry, index) => equal(entry, right[index]));
  }
  if (!isObject(left) || !isObject(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) =>
      key === rightKeys[index] && equal(left[key], right[key]),
    );
};

const stripProjectionAndAuthority = (node: CanvasNode): CanvasNode => {
  if (node.ether === undefined) return node;
  const {
    overseer: _overseer,
    tasks,
    ...withoutOverseer
  } = node.ether;
  const rest = Object.fromEntries(
    Object.entries(withoutOverseer).filter(([key]) => !WORK_PROJECTION_KEYS.has(key)),
  ) as EtherNodeExtension;
  const authoredTasks =
    tasks?.name !== undefined || tasks?.contract !== undefined
      ? {
          items: [],
          ...(tasks.name !== undefined ? { name: tasks.name } : {}),
          ...(tasks.contract !== undefined ? { contract: tasks.contract } : {}),
        }
      : undefined;
  const ether: EtherNodeExtension = {
    ...rest,
    ...(authoredTasks !== undefined ? { tasks: authoredTasks } : {}),
  };
  if (Object.keys(ether).length > 0) return { ...node, ether };
  const { ether: _removed, ...plain } = node;
  return plain as CanvasNode;
};

const seatIdentity = (node: CanvasNode | undefined): string | undefined => {
  if (node?.ether?.entity?.kind !== "agent") return undefined;
  const bindingId = node.ether.terminal?.bindingId.trim();
  if (!bindingId) return undefined;
  return `${resolveNodeHostId(node)}\0${bindingId}`;
};

const restoreRemoteOverseer = (
  node: CanvasNode,
  remote: CanvasNode | undefined,
): CanvasNode => {
  const identity = seatIdentity(node);
  const overseer =
    identity !== undefined && identity === seatIdentity(remote)
      ? remote?.ether?.overseer
      : undefined;
  const localEther = node.ether;
  if (overseer === undefined) {
    if (localEther?.overseer === undefined) return node;
    const { overseer: _removed, ...ether } = localEther;
    if (Object.keys(ether).length > 0) return { ...node, ether };
    const { ether: _removedEther, ...plain } = node;
    return plain as CanvasNode;
  }
  return { ...node, ether: { ...(localEther ?? {}), overseer } };
};

const mergeObject = (
  base: JsonObject,
  local: JsonObject,
  remote: JsonObject,
  path: string,
  conflicts: string[],
): JsonObject => {
  const merged: Record<string, unknown> = {};
  const keys = new Set([
    ...Object.keys(base),
    ...Object.keys(local),
    ...Object.keys(remote),
  ]);
  for (const key of keys) {
    const baseHas = Object.hasOwn(base, key);
    const localHas = Object.hasOwn(local, key);
    const remoteHas = Object.hasOwn(remote, key);
    const baseValue = base[key];
    const localValue = local[key];
    const remoteValue = remote[key];
    const fieldPath = path === "" ? key : `${path}.${key}`;

    if (localHas === remoteHas && equal(localValue, remoteValue)) {
      if (localHas) merged[key] = localValue;
      continue;
    }
    if (localHas === baseHas && equal(localValue, baseValue)) {
      if (remoteHas) merged[key] = remoteValue;
      continue;
    }
    if (remoteHas === baseHas && equal(remoteValue, baseValue)) {
      if (localHas) merged[key] = localValue;
      continue;
    }
    if (
      baseHas && localHas && remoteHas
      && isObject(baseValue) && isObject(localValue) && isObject(remoteValue)
    ) {
      merged[key] = mergeObject(
        baseValue,
        localValue,
        remoteValue,
        fieldPath,
        conflicts,
      );
      continue;
    }
    conflicts.push(fieldPath);
  }
  return merged;
};

const mergeCollection = <T extends CanvasNode | CanvasEdge>(
  object: CanvasMergeConflict["object"],
  baseEntries: ReadonlyArray<T>,
  localEntries: ReadonlyArray<T>,
  remoteEntries: ReadonlyArray<T>,
): { readonly entries: T[]; readonly conflicts: CanvasMergeConflict[] } => {
  const base = new Map(baseEntries.map((entry) => [entry.id, entry]));
  const local = new Map(localEntries.map((entry) => [entry.id, entry]));
  const remote = new Map(remoteEntries.map((entry) => [entry.id, entry]));
  const ids = [
    ...localEntries.map((entry) => entry.id),
    ...remoteEntries
      .map((entry) => entry.id)
      .filter((id) => !local.has(id)),
  ];
  const entries: T[] = [];
  const conflicts: CanvasMergeConflict[] = [];

  for (const id of ids) {
    const baseEntry = base.get(id);
    const localEntry = local.get(id);
    const remoteEntry = remote.get(id);
    if (baseEntry === undefined) {
      if (localEntry !== undefined && remoteEntry !== undefined) {
        if (equal(localEntry, remoteEntry)) entries.push(localEntry);
        else conflicts.push({ object, id, path: "", kind: "concurrent-add" });
      } else if (localEntry !== undefined) entries.push(localEntry);
      else if (remoteEntry !== undefined) entries.push(remoteEntry);
      continue;
    }
    if (localEntry === undefined || remoteEntry === undefined) {
      if (localEntry === undefined && remoteEntry === undefined) continue;
      const survivor = localEntry ?? remoteEntry;
      if (equal(survivor, baseEntry)) continue;
      conflicts.push({ object, id, path: "", kind: "delete-vs-edit" });
      continue;
    }
    const fieldConflicts: string[] = [];
    const merged = mergeObject(baseEntry, localEntry, remoteEntry, "", fieldConflicts) as T;
    entries.push(merged);
    conflicts.push(...fieldConflicts.map((path) => ({
      object,
      id,
      path,
      kind: "field" as const,
    })));
  }

  return { entries, conflicts };
};

/**
 * Merge renderer edits against the exact authorial document they started from.
 * Runtime Work projection fields and overseer authority always come from the
 * latest main-owned read. Conflicts are returned instead of silently choosing
 * either side, so the renderer can preserve the local draft as a recovery copy.
 */
export const mergeAuthorialCanvas = (
  baseDoc: CanvasDoc,
  localDoc: CanvasDoc,
  remoteDoc: CanvasDoc,
): AuthorialCanvasMergeResult => {
  const baseNodes = baseDoc.nodes.map(stripProjectionAndAuthority);
  const localNodes = localDoc.nodes.map(stripProjectionAndAuthority);
  const remoteNodes = remoteDoc.nodes.map(stripProjectionAndAuthority);
  const nodes = mergeCollection("node", baseNodes, localNodes, remoteNodes);
  const edges = mergeCollection("edge", baseDoc.edges, localDoc.edges, remoteDoc.edges);
  const conflicts = [...nodes.conflicts, ...edges.conflicts];
  if (conflicts.length > 0) return { ok: false, conflicts };

  const remoteNodesById = new Map(remoteDoc.nodes.map((node) => [node.id, node]));
  const structural: CanvasDoc = {
    nodes: nodes.entries.map((node) => restoreRemoteOverseer(node, remoteNodesById.get(node.id))),
    edges: edges.entries,
  };
  return {
    ok: true,
    doc: mergeLocalCanvasWithWorkWrite(structural, remoteDoc),
  };
};
