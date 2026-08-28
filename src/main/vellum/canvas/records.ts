import { Result } from "effect";
import { ulid } from "ulid";
import {
  decodeCanvasDoc,
  type CanvasDoc,
  type CanvasEdge,
  type CanvasNode,
} from "@shared/canvas";

import type { StateReader, StateWriter } from "../state/service";

/**
 * Relational canvas authority records — the sole durable representation of the
 * canvas. StateReader/StateWriter are the SQL surface; the schema migration
 * adapts node:sqlite's DatabaseSync to the same shape with a small wrapper.
 */
export type CanvasSqlReader = StateReader;
export type CanvasSqlWriter = StateWriter;

export type CanvasPortfolioHeadRow = {
  readonly generation: string;
  readonly intent_sha256: string;
  readonly created_at: string;
  readonly updated_at: string;
};

export type CanvasDocumentRow = {
  readonly canvas_id: string;
  readonly canvas_name: string;
  readonly revision_sha256: string;
  readonly modified_at: string;
};

type NodeRow = {
  readonly node_id: string;
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

const optional = <T>(value: T | null | undefined): T | undefined =>
  value === null || value === undefined ? undefined : value;

export const readPortfolioHead = (
  reader: CanvasSqlReader,
): CanvasPortfolioHeadRow | undefined =>
  reader.get<CanvasPortfolioHeadRow>(
    `SELECT generation, intent_sha256, created_at, updated_at
     FROM canvas_portfolio_head
     WHERE singleton = 1`,
  );

export const writePortfolioHead = (
  writer: CanvasSqlWriter,
  input: {
    readonly generation: string;
    readonly intentSha256: string;
    readonly at: string;
  },
): void => {
  writer.run(
    `INSERT INTO canvas_portfolio_head(singleton, generation, intent_sha256, created_at, updated_at)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(singleton) DO UPDATE SET
       generation = excluded.generation,
       intent_sha256 = excluded.intent_sha256,
       updated_at = excluded.updated_at`,
    [input.generation, input.intentSha256, input.at, input.at],
  );
};

export const readDocumentRows = (
  reader: CanvasSqlReader,
): ReadonlyArray<CanvasDocumentRow> =>
  reader.all<CanvasDocumentRow>(
    `SELECT canvas_id, canvas_name, revision_sha256, modified_at
     FROM canvas_documents
     ORDER BY canvas_name`,
  );

/** Rebuild one canvas document from its relational rows, in stored z-order. */
export const reconstructCanvasDoc = (
  reader: CanvasSqlReader,
  canvasId: string,
): CanvasDoc => {
  const nodeRows = reader.all<NodeRow>(
    `SELECT
       node_id, type, x, y, width, height, color,
       text_content, file_path, file_subpath, link_url,
       group_label, group_background, group_background_style, ether_json
     FROM canvas_nodes
     WHERE canvas_id = ?
     ORDER BY z_index ASC, node_id ASC`,
    [canvasId],
  );
  const edgeRows = reader.all<EdgeRow>(
    `SELECT
       edge_id, from_node_id, from_side, from_end,
       to_node_id, to_side, to_end, color, label, ether_json
     FROM canvas_edges
     WHERE canvas_id = ?
     ORDER BY z_index ASC, edge_id ASC`,
    [canvasId],
  );

  const nodes: CanvasNode[] = nodeRows.map((row) => {
    const ether =
      row.ether_json === null
        ? undefined
        : (JSON.parse(row.ether_json) as CanvasNode["ether"]);
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
            ? {
                backgroundStyle:
                  row.group_background_style as "cover" | "ratio" | "repeat",
              }
            : {}),
        } as CanvasNode;
    }
  });

  const edges: CanvasEdge[] = edgeRows.map((row) => {
    const ether =
      row.ether_json === null
        ? undefined
        : (JSON.parse(row.ether_json) as CanvasEdge["ether"]);
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

const upsertNode = (
  writer: CanvasSqlWriter,
  canvasId: string,
  node: CanvasNode,
  zIndex: number,
  updatedAt: string,
): void => {
  writer.run(
    `INSERT INTO canvas_nodes (
       canvas_id, node_id, z_index, type, x, y, width, height,
       color, text_content, file_path, file_subpath, link_url,
       group_label, group_background, group_background_style,
       ether_json, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
       ether_json = excluded.ether_json,
       updated_at = excluded.updated_at`,
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
      node.ether ? JSON.stringify(node.ether) : null,
      updatedAt,
    ],
  );
};

const upsertEdge = (
  writer: CanvasSqlWriter,
  canvasId: string,
  edge: CanvasEdge,
  zIndex: number,
  updatedAt: string,
): void => {
  writer.run(
    `INSERT INTO canvas_edges (
       canvas_id, edge_id, z_index, from_node_id, from_side, from_end,
       to_node_id, to_side, to_end, color, label, ether_json, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(canvas_id, edge_id) DO UPDATE SET
       z_index = excluded.z_index,
       from_node_id = excluded.from_node_id,
       from_side = excluded.from_side,
       from_end = excluded.from_end,
       to_node_id = excluded.to_node_id,
       to_side = excluded.to_side,
       to_end = excluded.to_end,
       color = excluded.color,
       label = excluded.label,
       ether_json = excluded.ether_json,
       updated_at = excluded.updated_at`,
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
      edge.color ?? null,
      edge.label ?? null,
      edge.ether ? JSON.stringify(edge.ether) : null,
      updatedAt,
    ],
  );
};

/**
 * Persist one canvas's head state: upsert the document row, replace its node
 * and edge rows to exactly match the document. Idempotent; deletion-ordered so
 * edge->node foreign keys always hold.
 */
export const persistCanvas = (
  writer: CanvasSqlWriter,
  input: {
    readonly canvasName: string;
    readonly doc: CanvasDoc;
    readonly revisionSha256: string;
    readonly modifiedAt: string;
  },
): { readonly canvasId: string; readonly created: boolean } => {
  const existing = writer.get<{ readonly canvas_id: string }>(
    "SELECT canvas_id FROM canvas_documents WHERE canvas_name = ?",
    [input.canvasName],
  );
  const canvasId = existing?.canvas_id ?? `cnv_${ulid().toLowerCase()}`;
  if (existing === undefined) {
    writer.run(
      `INSERT INTO canvas_documents(canvas_id, canvas_name, revision_sha256, created_at, modified_at)
       VALUES (?, ?, ?, ?, ?)`,
      [canvasId, input.canvasName, input.revisionSha256, input.modifiedAt, input.modifiedAt],
    );
  } else {
    writer.run(
      `UPDATE canvas_documents
       SET revision_sha256 = ?, modified_at = ?
       WHERE canvas_id = ?`,
      [input.revisionSha256, input.modifiedAt, canvasId],
    );
  }

  const liveNodeIds = new Set(input.doc.nodes.map((node) => node.id));
  const liveEdgeIds = new Set(input.doc.edges.map((edge) => edge.id));
  // The document codec tolerates duplicate ids (first occurrence wins), but a
  // primary-keyed row set cannot represent them and an upsert would silently
  // keep the LAST occurrence — a graph the author never saw. Refuse loudly so
  // the write transaction rolls back instead of committing divergent rows.
  if (
    liveNodeIds.size !== input.doc.nodes.length ||
    liveEdgeIds.size !== input.doc.edges.length
  ) {
    throw new Error(
      `canvas "${input.canvasName}" contains duplicate node or edge ids and cannot be persisted`,
    );
  }
  for (const row of writer.all<{ readonly edge_id: string }>(
    "SELECT edge_id FROM canvas_edges WHERE canvas_id = ?",
    [canvasId],
  )) {
    if (!liveEdgeIds.has(row.edge_id)) {
      writer.run(
        "DELETE FROM canvas_edges WHERE canvas_id = ? AND edge_id = ?",
        [canvasId, row.edge_id],
      );
    }
  }
  for (const row of writer.all<{ readonly node_id: string }>(
    "SELECT node_id FROM canvas_nodes WHERE canvas_id = ?",
    [canvasId],
  )) {
    if (!liveNodeIds.has(row.node_id)) {
      writer.run(
        "DELETE FROM canvas_nodes WHERE canvas_id = ? AND node_id = ?",
        [canvasId, row.node_id],
      );
    }
  }
  input.doc.nodes.forEach((node, index) => {
    upsertNode(writer, canvasId, node, index, input.modifiedAt);
  });
  input.doc.edges.forEach((edge, index) => {
    upsertEdge(writer, canvasId, edge, index, input.modifiedAt);
  });
  return { canvasId, created: existing === undefined };
};

/**
 * Remove the entire authorial canvas plane (Remote-configure wipe): a Remote
 * consumes Command Center projections and holds no authorial rows.
 */
export const wipeCanvasAuthority = (writer: CanvasSqlWriter): void => {
  writer.run("DELETE FROM canvas_edges");
  writer.run("DELETE FROM canvas_nodes");
  writer.run("DELETE FROM canvas_documents");
  writer.run("DELETE FROM canvas_portfolio_head");
};

/** Remove one canvas and all of its rows. Deletion-ordered for the FKs. */
export const deleteCanvas = (
  writer: CanvasSqlWriter,
  canvasName: string,
): boolean => {
  const existing = writer.get<{ readonly canvas_id: string }>(
    "SELECT canvas_id FROM canvas_documents WHERE canvas_name = ?",
    [canvasName],
  );
  if (existing === undefined) return false;
  writer.run("DELETE FROM canvas_edges WHERE canvas_id = ?", [existing.canvas_id]);
  writer.run("DELETE FROM canvas_nodes WHERE canvas_id = ?", [existing.canvas_id]);
  writer.run("DELETE FROM canvas_documents WHERE canvas_id = ?", [existing.canvas_id]);
  return true;
};
