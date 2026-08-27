import { Result } from "effect";
import { ulid } from "ulid";
import {
  decodeCanvasDoc,
  type CanvasDoc,
  type CanvasEdge,
  type CanvasNode,
} from "@shared/canvas";
import type { StateReader, StateWriter } from "../state/service";
import {
  canvasDocSemanticHash,
  edgeSemanticHash,
  nodeSemanticHash,
} from "./relational-backfill";

export type RelationalStoredCanvas = {
  readonly doc: CanvasDoc;
  readonly body: string;
  readonly revisionSha256: string;
  readonly modifiedAt: string;
};

export type PersistRelationalPortfolioInput = {
  readonly generation: string;
  readonly parentGeneration: string | null;
  readonly cause: string;
  readonly intentSha256: string;
  readonly createdAt: string;
  readonly documents: ReadonlyMap<string, RelationalStoredCanvas>;
  readonly origin?: string | null;
  readonly admittedBaseGeneration?: string | null;
  readonly admittedBaseBodyHash?: string | null;
  readonly codecFamily?: string | null;
  readonly codecVersion?: number | null;
  readonly payloadHash?: string | null;
  readonly changedObjectHashesJson?: string | null;
  readonly changeId?: string | null;
};

export type PersistRelationalPortfolioResult = {
  readonly checkpointsCreated: number;
  readonly canvasesCreated: number;
};

type NodeRow = {
  readonly node_id: string;
  readonly z_index: number;
  readonly type: "text" | "file" | "link" | "group";
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly color: string | null;
  readonly text_content: string | null;
  readonly file_path: string | null;
  readonly file_subpath: string | null;
  readonly link_url: string | null;
  readonly group_label: string | null;
  readonly group_background: string | null;
  readonly group_background_style: "cover" | "ratio" | "repeat" | null;
  readonly ether_json: string | null;
};

type EdgeRow = {
  readonly edge_id: string;
  readonly z_index: number;
  readonly from_node_id: string;
  readonly from_side: "top" | "right" | "bottom" | "left" | null;
  readonly from_end: "none" | "arrow" | null;
  readonly to_node_id: string;
  readonly to_side: "top" | "right" | "bottom" | "left" | null;
  readonly to_end: "none" | "arrow" | null;
  readonly color: string | null;
  readonly label: string | null;
  readonly ether_json: string | null;
};

const parseEther = (raw: string | null): CanvasNode["ether"] | CanvasEdge["ether"] | undefined => {
  if (raw === null) return undefined;
  return JSON.parse(raw) as CanvasNode["ether"];
};

const optional = <T>(value: T | null | undefined): T | undefined =>
  value === null || value === undefined ? undefined : value;

export const reconstructCanvasDoc = (
  reader: StateReader,
  canvasId: string,
): CanvasDoc => {
  const nodeRows = reader.all<NodeRow>(
    `
      SELECT
        node_id, z_index, type, x, y, width, height, color,
        text_content, file_path, file_subpath, link_url,
        group_label, group_background, group_background_style, ether_json
      FROM canvas_nodes
      WHERE canvas_id = ?
      ORDER BY z_index ASC, node_id ASC
    `,
    [canvasId],
  );
  const edgeRows = reader.all<EdgeRow>(
    `
      SELECT
        edge_id, z_index, from_node_id, from_side, from_end,
        to_node_id, to_side, to_end, color, label, ether_json
      FROM canvas_edges
      WHERE canvas_id = ?
      ORDER BY z_index ASC, edge_id ASC
    `,
    [canvasId],
  );

  const nodes: CanvasNode[] = nodeRows.map((row) => {
    const ether = parseEther(row.ether_json) as CanvasNode["ether"];
    const base = {
      id: row.node_id,
      x: row.x,
      y: row.y,
      width: row.width,
      height: row.height,
      ...(optional(row.color) !== undefined ? { color: row.color as string } : {}),
      ...(ether !== undefined ? { ether } : {}),
    };
    switch (row.type) {
      case "text":
        return { ...base, type: "text", text: row.text_content ?? "" } as CanvasNode;
      case "file":
        return {
          ...base,
          type: "file",
          file: row.file_path ?? "",
          ...(optional(row.file_subpath) !== undefined
            ? { subpath: row.file_subpath as string }
            : {}),
        } as CanvasNode;
      case "link":
        return { ...base, type: "link", url: row.link_url ?? "" } as CanvasNode;
      case "group":
        return {
          ...base,
          type: "group",
          ...(optional(row.group_label) !== undefined
            ? { label: row.group_label as string }
            : {}),
          ...(optional(row.group_background) !== undefined
            ? { background: row.group_background as string }
            : {}),
          ...(optional(row.group_background_style) !== undefined
            ? { backgroundStyle: row.group_background_style as "cover" | "ratio" | "repeat" }
            : {}),
        } as CanvasNode;
    }
  });

  const edges: CanvasEdge[] = edgeRows.map((row) => {
    const ether = parseEther(row.ether_json) as CanvasEdge["ether"];
    return {
      id: row.edge_id,
      fromNode: row.from_node_id,
      ...(optional(row.from_side) !== undefined
        ? { fromSide: row.from_side as "top" | "right" | "bottom" | "left" }
        : {}),
      ...(optional(row.from_end) !== undefined
        ? { fromEnd: row.from_end as "none" | "arrow" }
        : {}),
      toNode: row.to_node_id,
      ...(optional(row.to_side) !== undefined
        ? { toSide: row.to_side as "top" | "right" | "bottom" | "left" }
        : {}),
      ...(optional(row.to_end) !== undefined
        ? { toEnd: row.to_end as "none" | "arrow" }
        : {}),
      ...(optional(row.color) !== undefined ? { color: row.color as string } : {}),
      ...(optional(row.label) !== undefined ? { label: row.label as string } : {}),
      ...(ether !== undefined ? { ether } : {}),
    };
  });

  const decoded = decodeCanvasDoc({ nodes, edges });
  if (Result.isFailure(decoded)) {
    throw new Error(
      `relational canvas rows failed validation: ${decoded.failure.message}`,
    );
  }
  return decoded.success;
};

const ensureCheckpoint = (
  writer: StateWriter,
  sha256: string,
  body: string,
  createdAt: string,
): boolean => {
  const existing = writer.get<{ readonly sha256: string }>(
    "SELECT sha256 FROM canvas_checkpoints WHERE sha256 = ?",
    [sha256],
  );
  if (existing !== undefined) return false;
  writer.run(
    `
      INSERT INTO canvas_checkpoints (sha256, byte_length, body, created_at)
      VALUES (?, ?, ?, ?)
    `,
    [sha256, Buffer.byteLength(body, "utf8"), body, createdAt],
  );
  return true;
};

const resolveCanvasId = (
  writer: StateWriter,
  canvasName: string,
  generation: string,
  checkpointSha: string,
  semanticSha: string,
  createdAt: string,
): { readonly canvasId: string; readonly created: boolean } => {
  const existing = writer.get<{ readonly canvas_id: string }>(
    "SELECT canvas_id FROM canvas_documents WHERE canvas_name = ?",
    [canvasName],
  );
  if (existing !== undefined) {
    writer.run(
      `
        UPDATE canvas_documents
        SET head_generation = ?,
            head_checkpoint_sha256 = ?,
            head_semantic_sha256 = ?,
            updated_at = ?
        WHERE canvas_id = ?
      `,
      [generation, checkpointSha, semanticSha, createdAt, existing.canvas_id],
    );
    return { canvasId: existing.canvas_id, created: false };
  }
  const canvasId = `canvas_${ulid().toLowerCase()}`;
  writer.run(
    `
      INSERT INTO canvas_documents (
        canvas_id, canvas_name, head_generation, head_checkpoint_sha256,
        head_semantic_sha256, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    [canvasId, canvasName, generation, checkpointSha, semanticSha, createdAt, createdAt],
  );
  return { canvasId, created: true };
};

const upsertObject = (
  writer: StateWriter,
  canvasId: string,
  objectId: string,
  kind: "node" | "edge",
  generation: string,
  createdAt: string,
): void => {
  writer.run(
    `
      INSERT INTO canvas_objects (
        canvas_id, object_id, object_kind, first_seen_generation, deleted_generation, created_at
      ) VALUES (?, ?, ?, ?, NULL, ?)
      ON CONFLICT(canvas_id, object_id) DO UPDATE SET
        deleted_generation = NULL
    `,
    [canvasId, objectId, kind, generation, createdAt],
  );
};

const tombstoneAbsentObjects = (
  writer: StateWriter,
  canvasId: string,
  liveNodeIds: ReadonlySet<string>,
  liveEdgeIds: ReadonlySet<string>,
  generation: string,
): void => {
  const live = new Set<string>([...liveNodeIds, ...liveEdgeIds]);
  const present = writer.all<{
    readonly object_id: string;
    readonly object_kind: "node" | "edge";
  }>(
    `
      SELECT object_id, object_kind
      FROM canvas_objects
      WHERE canvas_id = ?
        AND deleted_generation IS NULL
    `,
    [canvasId],
  );

  const extraEdges = present.filter(
    (row) => row.object_kind === "edge" && !liveEdgeIds.has(row.object_id),
  );
  const extraNodes = present.filter(
    (row) => row.object_kind === "node" && !liveNodeIds.has(row.object_id),
  );

  for (const edge of extraEdges) {
    writer.run(
      "DELETE FROM canvas_edges WHERE canvas_id = ? AND edge_id = ?",
      [canvasId, edge.object_id],
    );
  }
  for (const node of extraNodes) {
    writer.run(
      "DELETE FROM canvas_nodes WHERE canvas_id = ? AND node_id = ?",
      [canvasId, node.object_id],
    );
  }
  for (const row of present) {
    if (live.has(row.object_id)) continue;
    writer.run(
      `
        UPDATE canvas_objects
        SET deleted_generation = ?
        WHERE canvas_id = ?
          AND object_id = ?
          AND deleted_generation IS NULL
      `,
      [generation, canvasId, row.object_id],
    );
  }
};

const upsertNode = (
  writer: StateWriter,
  canvasId: string,
  node: CanvasNode,
  zIndex: number,
  generation: string,
  updatedAt: string,
): void => {
  upsertObject(writer, canvasId, node.id, "node", generation, updatedAt);
  writer.run(
    `
      INSERT INTO canvas_nodes (
        canvas_id, node_id, z_index, type, x, y, width, height,
        color, text_content, file_path, file_subpath, link_url,
        group_label, group_background, group_background_style,
        entity_kind, entity_name, terminal_binding_id, terminal_harness,
        host_id, flags_json, ether_json, semantic_sha256, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(canvas_id, node_id) DO UPDATE SET
        z_index = excluded.z_index,
        type = excluded.type,
        x = excluded.x,
        y = excluded.y,
        width = excluded.width,
        height = excluded.height,
        color = excluded.color,
        text_content = excluded.text_content,
        file_path = excluded.file_path,
        file_subpath = excluded.file_subpath,
        link_url = excluded.link_url,
        group_label = excluded.group_label,
        group_background = excluded.group_background,
        group_background_style = excluded.group_background_style,
        entity_kind = excluded.entity_kind,
        entity_name = excluded.entity_name,
        terminal_binding_id = excluded.terminal_binding_id,
        terminal_harness = excluded.terminal_harness,
        host_id = excluded.host_id,
        flags_json = excluded.flags_json,
        ether_json = excluded.ether_json,
        semantic_sha256 = excluded.semantic_sha256,
        updated_at = excluded.updated_at
    `,
    [
      canvasId,
      node.id,
      zIndex,
      node.type,
      node.x,
      node.y,
      node.width,
      node.height,
      node.color ?? null,
      node.type === "text" ? node.text : null,
      node.type === "file" ? node.file : null,
      node.type === "file" ? node.subpath ?? null : null,
      node.type === "link" ? node.url : null,
      node.type === "group" ? node.label ?? null : null,
      node.type === "group" ? node.background ?? null : null,
      node.type === "group" ? node.backgroundStyle ?? null : null,
      node.ether?.entity?.kind ?? null,
      node.ether?.entity?.name ?? null,
      node.ether?.terminal?.bindingId ?? null,
      node.ether?.terminal?.harness ?? null,
      node.ether?.host ?? null,
      node.ether?.flags ? JSON.stringify(node.ether.flags) : null,
      node.ether ? JSON.stringify(node.ether) : null,
      nodeSemanticHash(node),
      updatedAt,
    ],
  );
};

const upsertEdge = (
  writer: StateWriter,
  canvasId: string,
  edge: CanvasEdge,
  zIndex: number,
  generation: string,
  updatedAt: string,
): void => {
  upsertObject(writer, canvasId, edge.id, "edge", generation, updatedAt);
  writer.run(
    `
      INSERT INTO canvas_edges (
        canvas_id, edge_id, z_index, from_node_id, from_side, from_end,
        to_node_id, to_side, to_end, verb, color, label, ether_json,
        semantic_sha256, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(canvas_id, edge_id) DO UPDATE SET
        z_index = excluded.z_index,
        from_node_id = excluded.from_node_id,
        from_side = excluded.from_side,
        from_end = excluded.from_end,
        to_node_id = excluded.to_node_id,
        to_side = excluded.to_side,
        to_end = excluded.to_end,
        verb = excluded.verb,
        color = excluded.color,
        label = excluded.label,
        ether_json = excluded.ether_json,
        semantic_sha256 = excluded.semantic_sha256,
        updated_at = excluded.updated_at
    `,
    [
      canvasId,
      edge.id,
      zIndex,
      edge.fromNode,
      edge.fromSide ?? null,
      edge.fromEnd ?? null,
      edge.toNode,
      edge.toSide ?? null,
      edge.toEnd ?? null,
      edge.ether?.verb ?? "relates",
      edge.color ?? null,
      edge.label ?? null,
      edge.ether ? JSON.stringify(edge.ether) : null,
      edgeSemanticHash(edge),
      updatedAt,
    ],
  );
};

const applyCurrentGraph = (
  writer: StateWriter,
  canvasId: string,
  doc: CanvasDoc,
  generation: string,
  updatedAt: string,
): void => {
  const liveNodeIds = new Set(doc.nodes.map((node) => node.id));
  const liveEdgeIds = new Set(
    doc.edges
      .filter(
        (edge) => liveNodeIds.has(edge.fromNode) && liveNodeIds.has(edge.toNode),
      )
      .map((edge) => edge.id),
  );
  tombstoneAbsentObjects(writer, canvasId, liveNodeIds, liveEdgeIds, generation);

  let zIndex = 0;
  for (const node of doc.nodes) {
    upsertNode(writer, canvasId, node, zIndex, generation, updatedAt);
    zIndex += 1;
  }
  let edgeZ = 0;
  for (const edge of doc.edges) {
    if (!liveNodeIds.has(edge.fromNode) || !liveNodeIds.has(edge.toNode)) {
      continue;
    }
    upsertEdge(writer, canvasId, edge, edgeZ, generation, updatedAt);
    edgeZ += 1;
  }
};

const retireRemovedCanvases = (
  writer: StateWriter,
  liveNames: ReadonlySet<string>,
  generation: string,
): void => {
  const rows = writer.all<{
    readonly canvas_id: string;
    readonly canvas_name: string;
  }>("SELECT canvas_id, canvas_name FROM canvas_documents");
  for (const row of rows) {
    if (liveNames.has(row.canvas_name)) continue;
    tombstoneAbsentObjects(writer, row.canvas_id, new Set(), new Set(), generation);
  }
};

const ensureEnvelope = (
  writer: StateWriter,
  input: PersistRelationalPortfolioInput,
): void => {
  const existing = writer.get<{ readonly generation: string }>(
    "SELECT generation FROM canvas_commit_envelopes WHERE generation = ?",
    [input.generation],
  );
  if (existing !== undefined) return;
  writer.run(
    `
      INSERT INTO canvas_commit_envelopes (
        generation, parent_generation, cause, intent_sha256,
        author_seat_id, author_principal, idempotency_key, change_summary, created_at,
        origin, admitted_base_generation, admitted_base_body_hash,
        codec_family, codec_version, payload_hash, changed_object_hashes_json, change_id
      ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      input.generation,
      input.parentGeneration,
      input.cause,
      input.intentSha256,
      input.createdAt,
      input.origin ?? null,
      input.admittedBaseGeneration ?? null,
      input.admittedBaseBodyHash ?? null,
      input.codecFamily ?? null,
      input.codecVersion ?? null,
      input.payloadHash ?? null,
      input.changedObjectHashesJson ?? null,
      input.changeId ?? null,
    ],
  );
};

const ensureManifest = (
  writer: StateWriter,
  generation: string,
  canvasId: string,
  checkpointSha: string,
  semanticSha: string,
): void => {
  const existing = writer.get<{ readonly generation: string }>(
    `
      SELECT generation
      FROM canvas_generation_manifests
      WHERE generation = ? AND canvas_id = ?
    `,
    [generation, canvasId],
  );
  if (existing !== undefined) return;
  writer.run(
    `
      INSERT INTO canvas_generation_manifests (
        generation, canvas_id, checkpoint_sha256, semantic_sha256
      ) VALUES (?, ?, ?, ?)
    `,
    [generation, canvasId, checkpointSha, semanticSha],
  );
};

/**
 * Write the current relational graph, content-addressed checkpoints, compact
 * generation manifests, and the immutable commit envelope. Caller inserts
 * canvas_generations / canvas_head first so envelope FK resolves.
 *
 * Unchanged checkpoint bodies are reused (INSERT skipped when the sha exists).
 */
export const persistRelationalPortfolio = (
  writer: StateWriter,
  input: PersistRelationalPortfolioInput,
): PersistRelationalPortfolioResult => {
  ensureEnvelope(writer, input);

  let checkpointsCreated = 0;
  let canvasesCreated = 0;
  const liveNames = new Set(input.documents.keys());

  for (const [canvasName, entry] of [...input.documents].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (ensureCheckpoint(writer, entry.revisionSha256, entry.body, entry.modifiedAt)) {
      checkpointsCreated += 1;
    }
    const semanticSha = canvasDocSemanticHash(entry.doc);
    const resolved = resolveCanvasId(
      writer,
      canvasName,
      input.generation,
      entry.revisionSha256,
      semanticSha,
      entry.modifiedAt,
    );
    if (resolved.created) canvasesCreated += 1;
    applyCurrentGraph(
      writer,
      resolved.canvasId,
      entry.doc,
      input.generation,
      entry.modifiedAt,
    );
    ensureManifest(
      writer,
      input.generation,
      resolved.canvasId,
      entry.revisionSha256,
      semanticSha,
    );
  }

  retireRemovedCanvases(writer, liveNames, input.generation);
  return { checkpointsCreated, canvasesCreated };
};

export const readManifestDocuments = (
  reader: StateReader,
  generation: string,
): ReadonlyArray<{
  readonly name: string;
  readonly body: string;
  readonly sha256: string;
  readonly modifiedAt: string;
}> =>
  reader.all<{
    readonly name: string;
    readonly body: string;
    readonly sha256: string;
    readonly modifiedAt: string;
  }>(
    `
      SELECT
        document.canvas_name AS name,
        checkpoint.body AS body,
        checkpoint.sha256 AS sha256,
        document.updated_at AS modifiedAt
      FROM canvas_generation_manifests AS manifest
      JOIN canvas_documents AS document
        ON document.canvas_id = manifest.canvas_id
      JOIN canvas_checkpoints AS checkpoint
        ON checkpoint.sha256 = manifest.checkpoint_sha256
      WHERE manifest.generation = ?
      ORDER BY document.canvas_name
    `,
    [generation],
  );

/**
 * Authorized Remote-configure wipe of authorial canvas history.
 *
 * Manifest, envelope, and checkpoint rows refuse ordinary deletes. This
 * briefly drops those DELETE triggers, removes the relational current graph
 * and unique bodies, and restores the identical triggers. Caller still
 * deletes `canvas_head` / `canvas_generation_documents` / `canvas_generations`.
 */
export const wipeRelationalAuthorialGraph = (writer: StateWriter): void => {
  writer.run("DROP TRIGGER IF EXISTS canvas_generation_manifests_immutable_delete");
  writer.run("DROP TRIGGER IF EXISTS canvas_commit_envelopes_immutable_delete");
  writer.run("DROP TRIGGER IF EXISTS canvas_checkpoints_immutable_delete");
  writer.run("DROP TRIGGER IF EXISTS canvas_change_tail_immutable_delete");
  writer.run("DELETE FROM canvas_change_tail");
  writer.run("DELETE FROM canvas_authoring_tail_state");
  writer.run("DELETE FROM canvas_generation_manifests");
  writer.run("DELETE FROM canvas_commit_envelopes");
  writer.run("DELETE FROM canvas_edges");
  writer.run("DELETE FROM canvas_nodes");
  writer.run("DELETE FROM canvas_objects");
  writer.run("DELETE FROM canvas_documents");
  writer.run("DELETE FROM canvas_checkpoints");
  writer.run(`
    CREATE TRIGGER IF NOT EXISTS canvas_checkpoints_immutable_delete
    BEFORE DELETE ON canvas_checkpoints
    BEGIN
      SELECT RAISE(ABORT, 'canvas checkpoints are immutable');
    END
  `);
  writer.run(`
    CREATE TRIGGER IF NOT EXISTS canvas_commit_envelopes_immutable_delete
    BEFORE DELETE ON canvas_commit_envelopes
    BEGIN
      SELECT RAISE(ABORT, 'canvas commit envelopes are immutable');
    END
  `);
  writer.run(`
    CREATE TRIGGER IF NOT EXISTS canvas_generation_manifests_immutable_delete
    BEFORE DELETE ON canvas_generation_manifests
    BEGIN
      SELECT RAISE(ABORT, 'canvas generation manifests are immutable');
    END
  `);
  writer.run(`
    CREATE TRIGGER IF NOT EXISTS canvas_change_tail_immutable_delete
    BEFORE DELETE ON canvas_change_tail
    BEGIN
      SELECT RAISE(ABORT, 'canvas change tail is immutable');
    END
  `);
};
