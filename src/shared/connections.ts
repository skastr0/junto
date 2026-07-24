import type { CanvasDoc, EtherEntity } from "./canvas";
import type { Entity, EntitySource, SnapshotState } from "./entities";
import type { BindingHint } from "./ipc";

// The ONE place node identity joins the live corpus. A node stores only what
// it IS (ether.entity: kind + immutable name); which hermes agent it connects
// to is DERIVED here, per snapshot, and never written back into the document
// (kernel law #1: derived state is never stored).
//
// Live adapter plane is hermes-only. Agents carry their hermes
// "<host>:<profile>" key AS their identity name, so the connection is
// declared — present or not in the current hermes bundle. Project / orbit
// cards do not join the live corpus (no private-source plane).

export interface Connection {
  readonly source: EntitySource;
  readonly key: string;
  // The live corpus entity backing this connection. Absent only for the
  // identity-declared hermes connection when the agent isn't in the current
  // bundle — the key must survive an offline fleet (chat/pulse routing).
  readonly entity?: Entity;
}

// Built once per snapshot, O(corpus); every node resolution is O(1) lookups.
export interface ConnectionIndex {
  readonly byKey: ReadonlyMap<string, Entity>; // `${source}:${key}`
}

export const buildConnectionIndex = (snapshots: SnapshotState): ConnectionIndex => {
  const byKey = new Map<string, Entity>();

  for (const bundle of snapshots.bundles) {
    for (const entity of bundle.entities) {
      // A failed bundle may still carry facts observed during this exact
      // partial attempt. Admit only those explicit current rows; unspecified
      // or retained stale facts must not become authoritative connections.
      if (!bundle.ok && entity.stale !== false) continue;
      byKey.set(`${entity.source}:${entity.key}`, entity);
    }
  }

  return { byKey };
};

export const resolveConnections = (
  entity: EtherEntity | undefined,
  index: ConnectionIndex,
): ReadonlyArray<Connection> => {
  const name = entity?.name;
  if (!name) return [];

  if (entity.kind === "agent") {
    const live = index.byKey.get(`hermes:${name}`);
    return [{ source: "hermes", key: name, ...(live === undefined ? {} : { entity: live }) }];
  }

  // Non-agent entities do not join the live hermes corpus.
  return [];
};

// Convenience for one-shot call sites; index-building callers (per-frame UI)
// should build the index once per snapshot and share it.
export const resolveNodeConnections = (
  entity: EtherEntity | undefined,
  snapshots: SnapshotState,
): ReadonlyArray<Connection> => resolveConnections(entity, buildConnectionIndex(snapshots));

export const connectionKey = (
  connections: ReadonlyArray<Connection>,
  source: EntitySource,
): string | undefined => connections.find((connection) => connection.source === source)?.key;

export const connectionKeys = (
  connections: ReadonlyArray<Connection>,
  source: EntitySource,
): ReadonlyArray<string> =>
  connections.filter((connection) => connection.source === source).map((connection) => connection.key);

// Adapter enrichment hints, derived from identity resolution over documents.
// Only hermes agent keys are emitted (live plane).
export const identityHints = (
  docs: Iterable<CanvasDoc>,
  snapshots: SnapshotState,
): ReadonlyArray<BindingHint> => {
  const index = buildConnectionIndex(snapshots);
  const seen = new Set<string>();
  const hints: BindingHint[] = [];
  for (const doc of docs) {
    for (const node of doc.nodes) {
      for (const connection of resolveConnections(node.ether?.entity, index)) {
        const dedup = `${connection.source}:${connection.key}`;
        if (seen.has(dedup)) continue;
        seen.add(dedup);
        hints.push({ source: connection.source, key: connection.key });
      }
    }
  }
  return hints;
};
