import { Context, Effect, Layer, Result, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { ulid } from "ulid";
import {
  containsWorkProjection,
  decodeCanvasDoc,
  serializeCanvas,
  type CanvasDoc,
  type CanvasEdge,
  type CanvasNode,
} from "@shared/canvas";

import { canvasBodySha256Of, intentSha256Of } from "../canvas-intent-identity";
import {
  CanvasError, canvasLabel, canvasNameFrom, toCanvasError,
  type StoredCanvas, type StoredAuthoritySnapshot, type ActivePortfolioSnapshot,
} from "./domain";
import { StationConfigurationRepository } from "../station/configuration-state";
import { compileActorSeatRegistry } from "../station/actor-seat-compiler";
import { decodeStationPortfolioBody } from "../station/portfolio";
import { InstallationId } from "@shared/installation-id";
import { StationHostId } from "@shared/station-api";

/**
 * Relational canvas authority records — the sole durable representation of the
 * canvas. SqlClient uses the state owner's connection and transaction context.
 */
const CanvasPortfolioHeadRow = Schema.Struct({
  generation: Schema.String,
  intent_sha256: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
});
export type CanvasPortfolioHeadRow = typeof CanvasPortfolioHeadRow.Type;

const CanvasDocumentRow = Schema.Struct({
  canvas_id: Schema.String,
  canvas_name: Schema.String,
  revision_sha256: Schema.String,
  modified_at: Schema.String,
});
export type CanvasDocumentRow = typeof CanvasDocumentRow.Type;

const NodeRow = Schema.Struct({
  node_id: Schema.String,
  type: Schema.Literals(["text", "file", "link", "group"]),
  x: Schema.Number, y: Schema.Number, width: Schema.Number, height: Schema.Number,
  color: Schema.NullOr(Schema.String),
  text_content: Schema.NullOr(Schema.String),
  file_path: Schema.NullOr(Schema.String),
  file_subpath: Schema.NullOr(Schema.String),
  link_url: Schema.NullOr(Schema.String),
  group_label: Schema.NullOr(Schema.String),
  group_background: Schema.NullOr(Schema.String),
  group_background_style: Schema.NullOr(Schema.Literals(["cover", "ratio", "repeat"])),
  ether_json: Schema.NullOr(Schema.String),
});
type NodeRow = typeof NodeRow.Type;

const Side = Schema.NullOr(Schema.Literals(["top", "right", "bottom", "left"]));
const End = Schema.NullOr(Schema.Literals(["none", "arrow"]));
const EdgeRow = Schema.Struct({
  edge_id: Schema.String,
  from_node_id: Schema.String, from_side: Side, from_end: End,
  to_node_id: Schema.String, to_side: Side, to_end: End,
  color: Schema.NullOr(Schema.String),
  label: Schema.NullOr(Schema.String),
  ether_json: Schema.NullOr(Schema.String),
});
type EdgeRow = typeof EdgeRow.Type;

const optional = <T>(value: T | null | undefined): T | undefined =>
  value === null || value === undefined ? undefined : value;

/**
 * One canvas's relational rows in the canvas document shape, in stored
 * z-order, before any decode. The authority path decodes this; a canvas
 * migration reads it to prove the stored bytes it is about to rewrite.
 */
const rawDocumentFromRows = (nodeRows: ReadonlyArray<NodeRow>, edgeRows: ReadonlyArray<EdgeRow>) => {
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

  return { nodes, edges };
};

type PersistCanvasInput = {
  readonly canvasName: string;
  readonly doc: CanvasDoc;
  readonly revisionSha256: string;
  readonly modifiedAt: string;
};
type PortfolioHeadInput = { readonly generation: string; readonly intentSha256: string; readonly at: string };

/** Leaf authority repository. Multi-statement operations participate in the caller's SQL transaction. */
export class CanvasRecords extends Context.Service<CanvasRecords, {
  readonly readRevision: (canvasName: string) => Effect.Effect<string | undefined, CanvasError>;
  readonly readPortfolioHead: () => Effect.Effect<CanvasPortfolioHeadRow | undefined, CanvasError>;
  readonly writePortfolioHead: (input: PortfolioHeadInput) => Effect.Effect<void, CanvasError>;
  readonly readDocumentRows: () => Effect.Effect<ReadonlyArray<CanvasDocumentRow>, CanvasError>;
  readonly readRawCanvasDoc: (canvasId: string) => Effect.Effect<ReturnType<typeof rawDocumentFromRows>, CanvasError>;
  readonly reconstructCanvasDoc: (canvasId: string) => Effect.Effect<CanvasDoc, CanvasError>;
  readonly persistCanvas: (input: PersistCanvasInput) => Effect.Effect<{ readonly canvasId: string; readonly created: boolean }, CanvasError>;
  readonly deleteCanvas: (canvasName: string) => Effect.Effect<boolean, CanvasError>;
  readonly wipeCanvasAuthority: () => Effect.Effect<void, CanvasError>;
  readonly readStoredAuthority: () => Effect.Effect<StoredAuthoritySnapshot, CanvasError>;
  readonly readCommandCenterPortfolio: () => Effect.Effect<ActivePortfolioSnapshot, CanvasError>;
  readonly readCommandCenterTopology: () => Effect.Effect<ReadonlyMap<string, InstallationId>, CanvasError>;
  readonly readLocalStationRole: () => Effect.Effect<"" | "command-center" | "remote", CanvasError>;
  readonly readActivePortfolio: () => Effect.Effect<ActivePortfolioSnapshot, CanvasError>;
  readonly readActivePortfolioIdentity: () => Effect.Effect<string, CanvasError>;
}>()("@junto/CanvasRecords") {}

export const CanvasRecordsLive = Layer.effect(CanvasRecords, Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const station = yield* StationConfigurationRepository;
  const revisions = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({ revision_sha256: Schema.String }),
    execute: (canvasName) => sql`SELECT revision_sha256 FROM canvas_documents WHERE canvas_name = ${canvasName}`,
  });
  const readRevision = Effect.fn("CanvasRecords.readRevision")(
    (canvasName: string) => revisions(canvasName).pipe(Effect.map((rows) => rows[0]?.revision_sha256)),
    Effect.mapError(toCanvasError),
  );
  const headRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: CanvasPortfolioHeadRow,
    execute: () => sql`SELECT generation, intent_sha256, created_at, updated_at
      FROM canvas_portfolio_head WHERE singleton = 1`,
  });
  const readPortfolioHead = Effect.fn("CanvasRecords.readPortfolioHead")(
    () => headRows(undefined).pipe(Effect.map((rows) => rows[0])), Effect.mapError(toCanvasError),
  );
  const writePortfolioHead = Effect.fn("CanvasRecords.writePortfolioHead")((input: PortfolioHeadInput) =>
    sql`INSERT INTO canvas_portfolio_head(singleton, generation, intent_sha256, created_at, updated_at)
      VALUES (1, ${input.generation}, ${input.intentSha256}, ${input.at}, ${input.at})
      ON CONFLICT(singleton) DO UPDATE SET generation = excluded.generation,
        intent_sha256 = excluded.intent_sha256, updated_at = excluded.updated_at`,
    Effect.asVoid, Effect.mapError(toCanvasError),
  );
  const documentRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: CanvasDocumentRow,
    execute: () => sql`SELECT canvas_id, canvas_name, revision_sha256, modified_at
      FROM canvas_documents ORDER BY canvas_name`,
  });
  const readDocumentRows = Effect.fn("CanvasRecords.readDocumentRows")(
    () => documentRows(undefined), Effect.mapError(toCanvasError),
  );
  const nodeRows = SqlSchema.findAll({
    Request: Schema.String, Result: NodeRow,
    execute: (id) => sql`SELECT node_id, type, x, y, width, height, color,
      text_content, file_path, file_subpath, link_url, group_label,
      group_background, group_background_style, ether_json
      FROM canvas_nodes WHERE canvas_id = ${id} ORDER BY z_index ASC, node_id ASC`,
  });
  const edgeRows = SqlSchema.findAll({
    Request: Schema.String, Result: EdgeRow,
    execute: (id) => sql`SELECT edge_id, from_node_id, from_side, from_end,
      to_node_id, to_side, to_end, color, label, ether_json
      FROM canvas_edges WHERE canvas_id = ${id} ORDER BY z_index ASC, edge_id ASC`,
  });
  const readRawCanvasDoc = Effect.fn("CanvasRecords.readRawCanvasDoc")(function* (canvasId: string) {
    const nodes = yield* nodeRows(canvasId);
    const edges = yield* edgeRows(canvasId);
    // Preserve historical ether bytes until the grammar retirement proves and rewrites them.
    return yield* Effect.try({ try: () => rawDocumentFromRows(nodes, edges), catch: toCanvasError });
  }, Effect.mapError(toCanvasError));
  const reconstructCanvasDoc = Effect.fn("CanvasRecords.reconstructCanvasDoc")(function* (canvasId: string) {
    const decoded = decodeCanvasDoc(yield* readRawCanvasDoc(canvasId));
    if (Result.isFailure(decoded)) {
      return yield* Effect.fail(new CanvasError({
        message: `relational canvas rows failed validation: ${decoded.failure.message}`,
      }));
    }
    return decoded.success;
  });
  const canvasIds = SqlSchema.findAll({
    Request: Schema.String, Result: Schema.Struct({ canvas_id: Schema.String }),
    execute: (name) => sql`SELECT canvas_id FROM canvas_documents WHERE canvas_name = ${name}`,
  });
  const edgeIds = SqlSchema.findAll({
    Request: Schema.String, Result: Schema.Struct({ edge_id: Schema.String }),
    execute: (id) => sql`SELECT edge_id FROM canvas_edges WHERE canvas_id = ${id}`,
  });
  const nodeIds = SqlSchema.findAll({
    Request: Schema.String, Result: Schema.Struct({ node_id: Schema.String }),
    execute: (id) => sql`SELECT node_id FROM canvas_nodes WHERE canvas_id = ${id}`,
  });
  const persistCanvas = Effect.fn("CanvasRecords.persistCanvas")(function* (input: PersistCanvasInput) {
    const liveNodeIds = new Set(input.doc.nodes.map((node) => node.id));
    const liveEdgeIds = new Set(input.doc.edges.map((edge) => edge.id));
    if (liveNodeIds.size !== input.doc.nodes.length || liveEdgeIds.size !== input.doc.edges.length) {
      return yield* Effect.fail(new CanvasError({
        message: `canvas "${input.canvasName}" contains duplicate node or edge ids and cannot be persisted`,
      }));
    }
    const existing = (yield* canvasIds(input.canvasName))[0];
    const canvasId = existing?.canvas_id ?? `cnv_${ulid().toLowerCase()}`;
    if (existing === undefined) {
      yield* sql`INSERT INTO canvas_documents(canvas_id, canvas_name, revision_sha256, created_at, modified_at)
        VALUES (${canvasId}, ${input.canvasName}, ${input.revisionSha256}, ${input.modifiedAt}, ${input.modifiedAt})`;
    } else {
      yield* sql`UPDATE canvas_documents SET revision_sha256 = ${input.revisionSha256},
        modified_at = ${input.modifiedAt} WHERE canvas_id = ${canvasId}`;
    }
    for (const row of yield* edgeIds(canvasId)) {
      if (!liveEdgeIds.has(row.edge_id)) {
        yield* sql`DELETE FROM canvas_edges WHERE canvas_id = ${canvasId} AND edge_id = ${row.edge_id}`;
      }
    }
    for (const row of yield* nodeIds(canvasId)) {
      if (!liveNodeIds.has(row.node_id)) {
        yield* sql`DELETE FROM canvas_nodes WHERE canvas_id = ${canvasId} AND node_id = ${row.node_id}`;
      }
    }
    for (const [zIndex, node] of input.doc.nodes.entries()) {
      yield* sql`INSERT INTO canvas_nodes ${sql.insert({
        canvas_id: canvasId, node_id: node.id, z_index: zIndex, type: node.type,
        x: node.x, y: node.y, width: node.width, height: node.height,
        color: node.color ?? null,
        text_content: node.type === "text" ? node.text : null,
        file_path: node.type === "file" ? node.file : null,
        file_subpath: node.type === "file" ? node.subpath ?? null : null,
        link_url: node.type === "link" ? node.url : null,
        group_label: node.type === "group" ? node.label ?? null : null,
        group_background: node.type === "group" ? node.background ?? null : null,
        group_background_style: node.type === "group" ? node.backgroundStyle ?? null : null,
        ether_json: node.ether ? JSON.stringify(node.ether) : null, updated_at: input.modifiedAt,
      })} ON CONFLICT(canvas_id, node_id) DO UPDATE SET
        z_index = excluded.z_index, type = excluded.type, x = excluded.x, y = excluded.y,
        width = excluded.width, height = excluded.height, color = excluded.color,
        text_content = excluded.text_content, file_path = excluded.file_path,
        file_subpath = excluded.file_subpath, link_url = excluded.link_url,
        group_label = excluded.group_label, group_background = excluded.group_background,
        group_background_style = excluded.group_background_style,
        ether_json = excluded.ether_json, updated_at = excluded.updated_at`;
    }
    for (const [zIndex, edge] of input.doc.edges.entries()) {
      yield* sql`INSERT INTO canvas_edges ${sql.insert({
        canvas_id: canvasId, edge_id: edge.id, z_index: zIndex,
        from_node_id: edge.fromNode, from_side: edge.fromSide ?? null, from_end: edge.fromEnd ?? null,
        to_node_id: edge.toNode, to_side: edge.toSide ?? null, to_end: edge.toEnd ?? null,
        color: edge.color ?? null, label: edge.label ?? null,
        ether_json: edge.ether ? JSON.stringify(edge.ether) : null, updated_at: input.modifiedAt,
      })} ON CONFLICT(canvas_id, edge_id) DO UPDATE SET
        z_index = excluded.z_index, from_node_id = excluded.from_node_id,
        from_side = excluded.from_side, from_end = excluded.from_end,
        to_node_id = excluded.to_node_id, to_side = excluded.to_side, to_end = excluded.to_end,
        color = excluded.color, label = excluded.label, ether_json = excluded.ether_json,
        updated_at = excluded.updated_at`;
    }
    return { canvasId, created: existing === undefined };
  }, Effect.mapError(toCanvasError));
  const deleteCanvas = Effect.fn("CanvasRecords.deleteCanvas")(function* (canvasName: string) {
    const existing = (yield* canvasIds(canvasName))[0];
    if (existing === undefined) return false;
    yield* sql`DELETE FROM canvas_edges WHERE canvas_id = ${existing.canvas_id}`;
    yield* sql`DELETE FROM canvas_nodes WHERE canvas_id = ${existing.canvas_id}`;
    yield* sql`DELETE FROM canvas_documents WHERE canvas_id = ${existing.canvas_id}`;
    return true;
  }, Effect.mapError(toCanvasError));
  const wipeCanvasAuthority = Effect.fn("CanvasRecords.wipeCanvasAuthority")(function* () {
    yield* sql`DELETE FROM canvas_edges`;
    yield* sql`DELETE FROM canvas_nodes`;
    yield* sql`DELETE FROM canvas_documents`;
    yield* sql`DELETE FROM canvas_portfolio_head`;
  }, Effect.mapError(toCanvasError));

  const readStoredAuthority = Effect.fn("CanvasRecords.readStoredAuthority")(function* (): Effect.fn.Return<StoredAuthoritySnapshot, CanvasError> {
    const head = yield* readPortfolioHead();
    if (head === undefined) {
      return { hasHead: false, generation: "0", createdAt: undefined, intentSha256: undefined, documents: new Map() };
    }
    const documents = new Map<string, StoredCanvas>();
    for (const row of yield* readDocumentRows()) {
      const name = yield* Effect.try({ try: () => canvasNameFrom(row.canvas_name), catch: toCanvasError });
      if (name !== row.canvas_name || documents.has(name)) {
        return yield* Effect.fail(new CanvasError({ message: `canvas database contains a non-canonical or duplicate name: "${row.canvas_name}"` }));
      }
      const doc = yield* reconstructCanvasDoc(row.canvas_id).pipe(Effect.mapError((error) =>
        new CanvasError({ message: `${canvasLabel(name)} failed relational reconstruction: ${error.message}` }),
      ));
      if (containsWorkProjection(doc)) {
        return yield* Effect.fail(new CanvasError({ message: `${canvasLabel(name)} in the database contains runtime work projection data; authorial canvas rows must contain structure and intent only` }));
      }
      const body = serializeCanvas(doc);
      const revisionSha256 = canvasBodySha256Of(body);
      if (revisionSha256 !== row.revision_sha256) {
        return yield* Effect.fail(new CanvasError({ message: `canvas database revision hash mismatch: ${canvasLabel(name)}` }));
      }
      documents.set(name, { doc, body, revisionSha256, modifiedAt: row.modified_at });
    }
    const intentSha256 = intentSha256Of(documents);
    if (intentSha256 !== head.intent_sha256) {
      return yield* Effect.fail(new CanvasError({ message: `canvas portfolio generation ${head.generation} intent hash mismatch` }));
    }
    return { hasHead: true, generation: head.generation, createdAt: head.created_at, intentSha256, documents };
  });
  const readLocalStationRole = Effect.fn("CanvasRecords.readLocalStationRole")(
    () => station.read.pipe(Effect.map((stored) => stored?.configuration.role ?? "")),
    Effect.mapError((error) => new CanvasError({ message: `canonical station configuration is invalid: ${error.message}` })),
  );
  const installations = SqlSchema.findAll({
    Request: Schema.Void, Result: Schema.Struct({ installation_id: InstallationId }),
    execute: () => sql`SELECT installation_id FROM station_installation WHERE singleton = 1`,
  });
  const targets = SqlSchema.findAll({
    Request: Schema.Void, Result: Schema.Struct({ host_id: StationHostId, station_installation_id: InstallationId }),
    execute: () => sql`SELECT host_id, station_installation_id FROM station_fleet_targets
      WHERE retired_at IS NULL ORDER BY host_id`,
  });
  const readCommandCenterTopology = Effect.fn("CanvasRecords.readCommandCenterTopology")(function* () {
    const topology = new Map<string, InstallationId>();
    const configuration = (yield* station.read)?.configuration;
    if (configuration?.role === "command-center") {
      const local = (yield* installations(undefined))[0];
      if (local === undefined) {
        return yield* Effect.fail(new CanvasError({ message: "Command Center configuration exists without a local installation identity" }));
      }
      topology.set(configuration.hostId, local.installation_id);
    }
    for (const row of yield* targets(undefined)) {
      const established = topology.get(row.host_id);
      if (established !== undefined && established !== row.station_installation_id) {
        return yield* Effect.fail(new CanvasError({ message: `active Station topology maps host ${JSON.stringify(row.host_id)} to more than one installation` }));
      }
      topology.set(row.host_id, row.station_installation_id);
    }
    return topology;
  }, Effect.mapError(toCanvasError));
  const readCommandCenterPortfolio = Effect.fn("CanvasRecords.readCommandCenterPortfolio")(function* () {
    const snapshot = yield* readStoredAuthority();
    const topology = yield* readCommandCenterTopology();
    const actorSeats = yield* Effect.try({
      try: () => compileActorSeatRegistry(new Map([...snapshot.documents].map(([name, entry]) => [name, entry.doc])), topology),
      catch: toCanvasError,
    });
    return { ...snapshot, actorRefs: actorSeats.flatMap((seat) => seat.refs.map((ref) => ({
      seatId: seat.seatId, canvasName: ref.canvasName, nodeId: ref.nodeId,
    }))) };
  });
  const projectionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({ generation: Schema.String, body: Schema.String, content_sha256: Schema.String, created_at: Schema.String, received_at: Schema.String }),
    execute: () => sql`SELECT version.generation AS generation, version.body AS body,
      version.content_sha256 AS content_sha256, version.created_at AS created_at, version.received_at AS received_at
      FROM station_projection_head head JOIN station_projection_versions version
      ON version.generation = head.generation AND version.content_sha256 = head.content_sha256
      WHERE head.singleton = 1`,
  });
  const readActivePortfolio = Effect.fn("CanvasRecords.readActivePortfolio")(function* (): Effect.fn.Return<ActivePortfolioSnapshot, CanvasError | Schema.SchemaError | import("effect/unstable/sql/SqlError").SqlError> {
    if ((yield* readLocalStationRole()) !== "remote") return yield* readCommandCenterPortfolio();
    const row = (yield* projectionRows(undefined))[0];
    if (row === undefined) {
      return { hasHead: false, generation: "0", createdAt: undefined, intentSha256: undefined, documents: new Map(), actorRefs: [] };
    }
    const contentSha256 = canvasBodySha256Of(row.body);
    if (contentSha256 !== row.content_sha256) {
      return yield* Effect.fail(new CanvasError({ message: `station projection generation ${row.generation} failed its content hash` }));
    }
    return yield* Effect.try({ try: () => {
      const decoded = decodeStationPortfolioBody(row.body);
      const documents = new Map<string, StoredCanvas>();
      for (const [name, doc] of decoded.documents) {
        const canonicalName = canvasNameFrom(name);
        const body = serializeCanvas(doc);
        documents.set(canonicalName, { doc, body, revisionSha256: canvasBodySha256Of(body), modifiedAt: row.received_at });
      }
      return { hasHead: true, generation: row.generation, createdAt: row.created_at,
        intentSha256: contentSha256, documents,
        actorRefs: decoded.actorSeats.flatMap((seat) => seat.refs.map((ref) => ({
          seatId: seat.seatId, canvasName: ref.canvasName, nodeId: ref.nodeId,
        }))),
      };
    }, catch: toCanvasError });
  }, Effect.mapError(toCanvasError));
  const projectionHeads = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({ generation: Schema.String, content_sha256: Schema.String, received_at: Schema.String }),
    execute: () => sql`SELECT version.generation AS generation, version.content_sha256 AS content_sha256,
      version.received_at AS received_at FROM station_projection_head head
      JOIN station_projection_versions version ON version.generation = head.generation
        AND version.content_sha256 = head.content_sha256 WHERE head.singleton = 1`,
  });
  const readActivePortfolioIdentity = Effect.fn("CanvasRecords.readActivePortfolioIdentity")(function* () {
    const role = yield* readLocalStationRole();
    if (role === "remote") {
      const head = (yield* projectionHeads(undefined))[0];
      return (head === undefined ? ["remote", "none"] : ["remote", head.generation, head.content_sha256, head.received_at]).join("\0");
    }
    const head = yield* readPortfolioHead();
    const topology = [...yield* readCommandCenterTopology()].sort(([a], [b]) => a.localeCompare(b))
      .map(([hostId, installationId]) => `${hostId}\u0001${installationId}`).join("\u0002");
    return [role === "" ? "unconfigured" : role, head?.generation ?? "none", head?.intent_sha256 ?? "none", head?.updated_at ?? "none", topology].join("\0");
  }, Effect.mapError(toCanvasError));

  return CanvasRecords.of({ readRevision, readPortfolioHead, writePortfolioHead, readDocumentRows, readRawCanvasDoc,
    reconstructCanvasDoc, persistCanvas, deleteCanvas, wipeCanvasAuthority, readStoredAuthority,
    readCommandCenterPortfolio, readCommandCenterTopology, readLocalStationRole, readActivePortfolio, readActivePortfolioIdentity });
})).pipe(Layer.provide(StationConfigurationRepository.layer));
