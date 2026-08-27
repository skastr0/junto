import { createHash } from "node:crypto";
import { Effect } from "effect";
import { ulid } from "ulid";
import {
  decodeCanvasDoc,
  serializeCanvas,
  type CanvasDoc,
  type CanvasEdge,
  type CanvasNode,
} from "@shared/canvas";
import { canonicalJson } from "../work/canonical-json";
import type {
  StateReader,
  StateWriter,
} from "../state/service";
import type {
  InstallOpsError,
  InstallOpsServiceShape,
} from "../install-ops/service";
import { BACKFILL_CANVAS_RELATIONAL_V1 } from "../install-ops/schema";

export { BACKFILL_CANVAS_RELATIONAL_V1 } from "../install-ops/schema";

export type CanvasRelationalBackfillReport = {
  readonly status: "complete" | "already-complete";
  readonly canvasesProcessed: number;
  readonly checkpointsCreated: number;
  readonly nodesCreated: number;
  readonly edgesCreated: number;
};

export class CanvasRelationalBackfillError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(
      message,
      options?.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = "CanvasRelationalBackfillError";
  }
}

type StateService = {
  readonly read: <A>(
    operation: string,
    body: (reader: StateReader) => A,
  ) => Effect.Effect<A, unknown>;
  readonly transaction: <A>(
    operation: string,
    body: (writer: StateWriter) => A,
  ) => Effect.Effect<A, unknown>;
};

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

/** Compute deterministic semantic hash of a node record */
export const nodeSemanticHash = (node: CanvasNode): string => {
  const norm = {
    id: node.id,
    type: node.type,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    color: node.color ?? null,
    text: node.type === "text" ? node.text : null,
    file: node.type === "file" ? node.file : null,
    subpath: node.type === "file" ? node.subpath ?? null : null,
    url: node.type === "link" ? node.url : null,
    label: node.type === "group" ? node.label ?? null : null,
    background: node.type === "group" ? node.background ?? null : null,
    backgroundStyle: node.type === "group" ? node.backgroundStyle ?? null : null,
    ether: node.ether ?? null,
  };
  return sha256(canonicalJson(norm));
};

/** Compute deterministic semantic hash of an edge record */
export const edgeSemanticHash = (edge: CanvasEdge): string => {
  const norm = {
    id: edge.id,
    fromNode: edge.fromNode,
    fromSide: edge.fromSide ?? null,
    fromEnd: edge.fromEnd ?? null,
    toNode: edge.toNode,
    toSide: edge.toSide ?? null,
    toEnd: edge.toEnd ?? null,
    verb: edge.ether?.verb ?? null,
    color: edge.color ?? null,
    label: edge.label ?? null,
    ether: edge.ether ?? null,
  };
  return sha256(canonicalJson(norm));
};

/**
 * Compute the combined semantic hash for an entire CanvasDoc (order-independent across nodes/edges)
 */
export const canvasDocSemanticHash = (doc: CanvasDoc): string => {
  const nodeHashes = doc.nodes.map(nodeSemanticHash).sort();
  const edgeHashes = doc.edges.map(edgeSemanticHash).sort();
  return sha256(canonicalJson({ nodeHashes, edgeHashes }));
};

const tableExists = (reader: StateReader, table: string): boolean =>
  reader.get<{ readonly name: string }>(
    `
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name = ?
    `,
    [table],
  ) !== undefined;

/**
 * Backfill one generation's documents into the relational tables.
 * Returns counts of inserted objects.
 */
export const backfillGenerationToRelational = (
  writer: StateWriter,
  generation: string,
  now = new Date().toISOString(),
): {
  readonly canvases: number;
  readonly checkpoints: number;
  readonly nodes: number;
  readonly edges: number;
} => {
  let canvases = 0;
  let checkpoints = 0;
  let nodes = 0;
  let edges = 0;

  const genRow = writer.get<{
    readonly generation: string;
    readonly created_at: string;
    readonly cause: string;
    readonly intent_sha256: string;
  }>(
    "SELECT generation, created_at, cause, intent_sha256 FROM canvas_generations WHERE generation = ?",
    [generation],
  );
  if (genRow === undefined) return { canvases: 0, checkpoints: 0, nodes: 0, edges: 0 };

  // Insert commit envelope if missing
  const existingEnvelope = writer.get<{ readonly generation: string }>(
    "SELECT generation FROM canvas_commit_envelopes WHERE generation = ?",
    [generation],
  );
  if (existingEnvelope === undefined) {
    const parentGen =
      generation === "1" || generation === "0"
        ? null
        : (BigInt(generation) - 1n).toString();
    writer.run(
      `
        INSERT INTO canvas_commit_envelopes (
          generation, parent_generation, cause, intent_sha256,
          author_seat_id, author_principal, idempotency_key, change_summary, created_at
        ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, ?)
      `,
      [generation, parentGen, genRow.cause, genRow.intent_sha256, genRow.created_at],
    );
  }

  // Process each document in this generation
  const docs = writer.all<{
    readonly name: string;
    readonly body: string;
    readonly sha256: string;
    readonly modified_at: string;
  }>(
    "SELECT name, body, sha256, modified_at FROM canvas_generation_documents WHERE generation = ? ORDER BY name",
    [generation],
  );

  for (const docRow of docs) {
    const canvasName = docRow.name;
    let decodedDoc: CanvasDoc;
    try {
      const parsed = JSON.parse(docRow.body);
      const decoded = decodeCanvasDoc(parsed);
      if (decoded._tag === "Success") {
        decodedDoc = decoded.success;
      } else {
        // Skip unparseable document body gracefully
        continue;
      }
    } catch {
      continue;
    }

    const checkpointSha = sha256(docRow.body);
    const byteLength = Buffer.byteLength(docRow.body, "utf8");
    const semanticSha = canvasDocSemanticHash(decodedDoc);

    // 1. Insert checkpoint if missing
    const existingCheckpoint = writer.get<{ readonly sha256: string }>(
      "SELECT sha256 FROM canvas_checkpoints WHERE sha256 = ?",
      [checkpointSha],
    );
    if (existingCheckpoint === undefined) {
      writer.run(
        `
          INSERT INTO canvas_checkpoints (sha256, byte_length, body, created_at)
          VALUES (?, ?, ?, ?)
        `,
        [checkpointSha, byteLength, docRow.body, docRow.modified_at || now],
      );
      checkpoints += 1;
    }

    // 2. Find or create canvas_documents row
    let canvasId: string;
    const existingCanvas = writer.get<{ readonly canvas_id: string }>(
      "SELECT canvas_id FROM canvas_documents WHERE canvas_name = ?",
      [canvasName],
    );
    if (existingCanvas !== undefined) {
      canvasId = existingCanvas.canvas_id;
      // Update head pointer if this generation is >= current head
      writer.run(
        `
          UPDATE canvas_documents
          SET head_generation = ?,
              head_checkpoint_sha256 = ?,
              head_semantic_sha256 = ?,
              updated_at = ?
          WHERE canvas_id = ?
            AND CAST(head_generation AS INTEGER) <= CAST(? AS INTEGER)
        `,
        [generation, checkpointSha, semanticSha, docRow.modified_at || now, canvasId, generation],
      );
    } else {
      canvasId = `canvas_${ulid().toLowerCase()}`;
      writer.run(
        `
          INSERT INTO canvas_documents (
            canvas_id, canvas_name, head_generation, head_checkpoint_sha256, head_semantic_sha256, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        [canvasId, canvasName, generation, checkpointSha, semanticSha, docRow.modified_at || now, docRow.modified_at || now],
      );
      canvases += 1;
    }

    // 3. Insert canvas_generation_manifests
    const existingManifest = writer.get<{ readonly generation: string }>(
      "SELECT generation FROM canvas_generation_manifests WHERE generation = ? AND canvas_id = ?",
      [generation, canvasId],
    );
    if (existingManifest === undefined) {
      writer.run(
        `
          INSERT INTO canvas_generation_manifests (
            generation, canvas_id, checkpoint_sha256, semantic_sha256
          ) VALUES (?, ?, ?, ?)
        `,
        [generation, canvasId, checkpointSha, semanticSha],
      );
    }

    // 4. Upsert canvas_objects & canvas_nodes
    let zIdx = 0;
    const seenNodeIds = new Set<string>();
    for (const node of decodedDoc.nodes) {
      seenNodeIds.add(node.id);
      const nodeSha = nodeSemanticHash(node);

      // Object identity
      writer.run(
        `
          INSERT INTO canvas_objects (
            canvas_id, object_id, object_kind, first_seen_generation, deleted_generation, created_at
          ) VALUES (?, ?, 'node', ?, NULL, ?)
          ON CONFLICT(canvas_id, object_id) DO UPDATE SET
            deleted_generation = NULL
        `,
        [canvasId, node.id, generation, now],
      );

      // Node details
      const color = node.color ?? null;
      const text = node.type === "text" ? node.text : null;
      const file = node.type === "file" ? node.file : null;
      const subpath = node.type === "file" ? node.subpath ?? null : null;
      const url = node.type === "link" ? node.url : null;
      const label = node.type === "group" ? node.label ?? null : null;
      const background = node.type === "group" ? node.background ?? null : null;
      const bgStyle = node.type === "group" ? node.backgroundStyle ?? null : null;
      const entityKind = node.ether?.entity?.kind ?? null;
      const entityName = node.ether?.entity?.name ?? null;
      const terminalBinding = node.ether?.terminal?.bindingId ?? null;
      const terminalHarness = node.ether?.terminal?.harness ?? null;
      const hostId = node.ether?.host ?? null;
      const flagsJson = node.ether?.flags ? JSON.stringify(node.ether.flags) : null;
      const etherJson = node.ether ? JSON.stringify(node.ether) : null;

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
          canvasId, node.id, zIdx++, node.type, node.x, node.y, node.width, node.height,
          color, text, file, subpath, url,
          label, background, bgStyle,
          entityKind, entityName, terminalBinding, terminalHarness,
          hostId, flagsJson, etherJson, nodeSha, now,
        ],
      );
      nodes += 1;
    }

    // 5. Upsert canvas_objects & canvas_edges
    let edgeZ = 0;
    const seenEdgeIds = new Set<string>();
    for (const edge of decodedDoc.edges) {
      // Must ensure from_node and to_node exist in canvas_nodes first
      if (!seenNodeIds.has(edge.fromNode) || !seenNodeIds.has(edge.toNode)) {
        continue;
      }
      seenEdgeIds.add(edge.id);
      const edgeSha = edgeSemanticHash(edge);

      writer.run(
        `
          INSERT INTO canvas_objects (
            canvas_id, object_id, object_kind, first_seen_generation, deleted_generation, created_at
          ) VALUES (?, ?, 'edge', ?, NULL, ?)
          ON CONFLICT(canvas_id, object_id) DO UPDATE SET
            deleted_generation = NULL
        `,
        [canvasId, edge.id, generation, now],
      );

      const verb = edge.ether?.verb ?? "relates";
      const color = edge.color ?? null;
      const label = edge.label ?? null;
      const etherJson = edge.ether ? JSON.stringify(edge.ether) : null;

      writer.run(
        `
          INSERT INTO canvas_edges (
            canvas_id, edge_id, z_index, from_node_id, from_side, from_end,
            to_node_id, to_side, to_end, verb, color, label, ether_json, semantic_sha256, updated_at
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
          canvasId, edge.id, edgeZ++, edge.fromNode, edge.fromSide ?? null, edge.fromEnd ?? null,
          edge.toNode, edge.toSide ?? null, edge.toEnd ?? null, verb, color, label, etherJson, edgeSha, now,
        ],
      );
      edges += 1;
    }
  }

  return { canvases, checkpoints, nodes, edges };
};

/**
 * Run the install-local backfill of whole-document canvas generations into the relational schema.
 * Only marks complete on installOps when all generations have been processed.
 */
export const runCanvasRelationalBackfill = (input: {
  readonly state: StateService;
  readonly installOps: InstallOpsServiceShape;
}): Effect.Effect<
  CanvasRelationalBackfillReport,
  CanvasRelationalBackfillError | InstallOpsError | unknown
> =>
  Effect.gen(function* () {
    const state = input.state;
    const installOps = input.installOps;
    const backfillId = BACKFILL_CANVAS_RELATIONAL_V1;

    const marker = yield* installOps.getBackfill(backfillId);
    if (marker?.status === "complete") {
      return {
        status: "already-complete" as const,
        canvasesProcessed: marker.objectsIngested,
        checkpointsCreated: 0,
        nodesCreated: 0,
        edgesCreated: 0,
      };
    }

    yield* installOps.ensurePending(backfillId);

    // Read all generations in chronological order
    const generations = yield* state.read("canvas.relational.backfill.generations", (reader) => {
      if (!tableExists(reader, "canvas_generations") || !tableExists(reader, "canvas_documents")) {
        return [];
      }
      return reader
        .all<{ readonly generation: string }>(
          "SELECT generation FROM canvas_generations ORDER BY CAST(generation AS INTEGER) ASC",
        )
        .map((row) => row.generation);
    });

    let totalCanvases = 0;
    let totalCheckpoints = 0;
    let totalNodes = 0;
    let totalEdges = 0;

    for (const gen of generations) {
      const counts = yield* state.transaction(
        `canvas.relational.backfill.gen.${gen}`,
        (writer) => backfillGenerationToRelational(writer, gen),
      );
      totalCanvases += counts.canvases;
      totalCheckpoints += counts.checkpoints;
      totalNodes += counts.nodes;
      totalEdges += counts.edges;
    }

    yield* installOps.markComplete(backfillId, totalCanvases);

    return {
      status: "complete" as const,
      canvasesProcessed: totalCanvases,
      checkpointsCreated: totalCheckpoints,
      nodesCreated: totalNodes,
      edgesCreated: totalEdges,
    };
  });
