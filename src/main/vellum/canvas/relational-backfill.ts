import { createHash } from "node:crypto";
import { Result, Effect } from "effect";
import { ulid } from "ulid";
import {
  containsWorkProjection,
  decodeCanvasDoc,
  serializeCanvas,
  type CanvasDoc,
} from "@shared/canvas";
import { isCanonicalCanvasName } from "@shared/canvas-name";
import { intentSha256Of } from "../canvas-intent-identity";
import type { StateReader, StateWriter } from "../state/service";
import type {
  InstallOpsError,
  InstallOpsServiceShape,
} from "../install-ops/service";
import { BACKFILL_CANVAS_RELATIONAL_V2 } from "../install-ops/schema";
import { selectStationConfiguration } from "../station/configuration-state";
import {
  compareDecimalGenerations,
  orderDecimalGenerations,
  parseDecimalGeneration,
  type DecimalGeneration,
} from "./decimal-generation";
import {
  canvasDocSemanticHash,
  edgeSemanticHash,
  nodeSemanticHash,
  sha256Utf8,
} from "./relational-hash";
import {
  persistRelationalPortfolio,
  reconstructCanvasDoc,
  type RelationalStoredCanvas,
} from "./relational-records";

export {
  BACKFILL_CANVAS_RELATIONAL_V1,
  BACKFILL_CANVAS_RELATIONAL_V2,
} from "../install-ops/schema";
export {
  canvasDocSemanticHash,
  edgeSemanticHash,
  nodeSemanticHash,
} from "./relational-hash";

/**
 * Install-ops v1 can remember only an id, status, count, and timestamp. It
 * cannot atomically bind completion to the exact source bytes proved here.
 * Keep v2 pending until install-ops has a separately reviewed forward schema
 * step with a source-prefix witness field.
 */
export const CANVAS_RELATIONAL_V2_WITNESS_FOLLOW_UP =
  "install-ops needs an append-only v1 -> v2 schema step that binds canvas.relational.v2 completion atomically to source_prefix_sha256 and head_generation; until then the verified walk remains pending";

export type CanvasRelationalBackfillReport =
  | {
      readonly status: "verified-pending-witness";
      readonly canvasesProcessed: number;
      readonly checkpointsCreated: number;
      readonly nodesCreated: number;
      readonly edgesCreated: number;
      readonly headGeneration: string | null;
      readonly sourcePrefixSha256: string;
      readonly followUp: string;
    }
  | {
      /** Remote projections are replace-only and never authorial backfill input. */
      readonly status: "skipped-remote";
      readonly reason: "authorial-relational-backfill-disabled-on-remote";
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

type SourceGenerationRow = {
  readonly generation: string;
  readonly created_at: string;
  readonly cause: string;
  readonly intent_sha256: string;
  readonly document_count: number | bigint;
};

type SourceDocumentRow = {
  readonly generation: string;
  readonly name: string;
  readonly body: string;
  readonly sha256: string;
  readonly modified_at: string;
};

type VerifiedSourceDocument = RelationalStoredCanvas & {
  readonly name: string;
  readonly byteLength: number;
  readonly semanticSha256: string;
};

type VerifiedSourceGeneration = {
  readonly generation: DecimalGeneration;
  readonly parentGeneration: DecimalGeneration | null;
  readonly createdAt: string;
  readonly cause: string;
  readonly intentSha256: string;
  readonly documents: ReadonlyMap<string, VerifiedSourceDocument>;
};

type HistoricalObjectIdentity = {
  readonly kind: "node" | "edge";
  readonly firstSeenGeneration: DecimalGeneration;
  readonly deletedGeneration: DecimalGeneration | null;
  /** Used only when the derived identity row is missing; never compared/re-written. */
  readonly createdAt: string;
};

type VerifiedSourcePrefix = {
  readonly headGeneration: DecimalGeneration | null;
  readonly generations: ReadonlyArray<VerifiedSourceGeneration>;
  readonly objectHistory: ReadonlyMap<
    string,
    ReadonlyMap<string, HistoricalObjectIdentity>
  >;
  readonly sourcePrefixSha256: string;
};

type EvidenceCounts = {
  readonly canvases: number;
  readonly checkpoints: number;
};

const HASH_PATTERN = /^[a-f0-9]{64}$/u;

const RELATIONAL_AUTHORITY_TABLES = [
  "canvas_documents",
  "canvas_objects",
  "canvas_nodes",
  "canvas_edges",
  "canvas_checkpoints",
  "canvas_generation_manifests",
  "canvas_commit_envelopes",
] as const;

const fail = (message: string, cause?: unknown): never => {
  throw new CanvasRelationalBackfillError(
    message,
    cause === undefined ? undefined : { cause },
  );
};

const assertAuthorialRelationalRole = (reader: StateReader): void => {
  if (selectStationConfiguration(reader)?.configuration.role === "remote") {
    return fail(
      "Remote role forbids authorial relational backfill mutation",
    );
  }
};

const tableExists = (reader: StateReader, table: string): boolean =>
  reader.get<{ readonly name: string }>(
    `
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name = ?
    `,
    [table],
  ) !== undefined;

const checkedCount = (value: number | bigint, label: string): number => {
  if (typeof value === "bigint") {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      return fail(`${label} is outside the safe count range: ${value}`);
    }
    return Number(value);
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    return fail(`${label} is not a non-negative safe integer: ${String(value)}`);
  }
  return value;
};

const rawRecord = (
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail(`${label} is not an object`);
  }
  return value as Readonly<Record<string, unknown>>;
};

type RawGraphIds = {
  readonly nodeIds: ReadonlySet<string>;
  readonly edgeIds: ReadonlySet<string>;
};

/** Reject shapes that scrubCanvasDocInput would otherwise silently discard. */
const validateRawGraphIds = (
  parsed: unknown,
  source: string,
): RawGraphIds => {
  const root = rawRecord(parsed, `${source} root`);
  if (!Array.isArray(root.nodes) || !Array.isArray(root.edges)) {
    return fail(`${source} must contain node and edge arrays`);
  }

  const nodeIds = new Set<string>();
  for (const [index, value] of root.nodes.entries()) {
    const node = rawRecord(value, `${source} node ${index}`);
    if (typeof node.id !== "string") {
      return fail(`${source} node ${index} has no string id`);
    }
    if (nodeIds.has(node.id)) {
      return fail(`${source} contains duplicate node id: ${node.id}`);
    }
    nodeIds.add(node.id);
  }

  const edgeIds = new Set<string>();
  for (const [index, value] of root.edges.entries()) {
    const edge = rawRecord(value, `${source} edge ${index}`);
    if (typeof edge.id !== "string") {
      return fail(`${source} edge ${index} has no string id`);
    }
    if (nodeIds.has(edge.id) || edgeIds.has(edge.id)) {
      return fail(
        `${source} contains duplicate or cross-kind object id: ${edge.id}`,
      );
    }
    edgeIds.add(edge.id);
    if (typeof edge.fromNode !== "string" || typeof edge.toNode !== "string") {
      return fail(`${source} edge ${edge.id} has a missing endpoint`);
    }
    if (!nodeIds.has(edge.fromNode) || !nodeIds.has(edge.toNode)) {
      return fail(
        `${source} edge ${edge.id} is dangling: ${edge.fromNode} -> ${edge.toNode}`,
      );
    }
  }
  return { nodeIds, edgeIds };
};

const assertDecodedIdentity = (
  raw: RawGraphIds,
  doc: CanvasDoc,
  source: string,
): void => {
  const decodedNodeIds = new Set(doc.nodes.map((node) => node.id));
  const decodedEdgeIds = new Set(doc.edges.map((edge) => edge.id));
  if (
    decodedNodeIds.size !== raw.nodeIds.size ||
    [...raw.nodeIds].some((id) => !decodedNodeIds.has(id))
  ) {
    fail(`${source} cannot preserve its exact node identity relationally`);
  }
  if (
    decodedEdgeIds.size !== raw.edgeIds.size ||
    [...raw.edgeIds].some((id) => !decodedEdgeIds.has(id))
  ) {
    fail(`${source} cannot preserve its exact edge identity relationally`);
  }
};

const decodeSourceDocument = (
  row: SourceDocumentRow,
): VerifiedSourceDocument => {
  const source = `generation ${row.generation} canvas ${JSON.stringify(row.name)}`;
  if (!isCanonicalCanvasName(row.name)) {
    return fail(`${source} has a non-canonical canvas name`);
  }
  if (!HASH_PATTERN.test(row.sha256)) {
    return fail(`${source} has a malformed stored body digest`);
  }
  const revisionSha256 = sha256Utf8(row.body);
  if (revisionSha256 !== row.sha256) {
    return fail(`${source} body sha256 mismatch`);
  }
  const byteLength = Buffer.byteLength(row.body, "utf8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.body);
  } catch (error) {
    return fail(`${source} body is malformed JSON`, error);
  }
  if (containsWorkProjection(parsed)) {
    return fail(`${source} contains protected runtime Work projection data`);
  }
  const rawIds = validateRawGraphIds(parsed, source);
  const decoded = decodeCanvasDoc(parsed);
  if (Result.isFailure(decoded)) {
    return fail(`${source} failed CanvasDoc decode: ${decoded.failure.message}`);
  }
  assertDecodedIdentity(rawIds, decoded.success, source);
  return {
    name: row.name,
    doc: decoded.success,
    body: row.body,
    revisionSha256,
    modifiedAt: row.modified_at,
    byteLength,
    semanticSha256: canvasDocSemanticHash(decoded.success),
  };
};

const updateFrame = (hash: ReturnType<typeof createHash>, value: string): void => {
  hash.update(String(Buffer.byteLength(value, "utf8")), "ascii");
  hash.update(":", "ascii");
  hash.update(value, "utf8");
  hash.update("\0", "ascii");
};

const sourcePrefixSha256Of = (
  headGeneration: string | null,
  generations: ReadonlyArray<VerifiedSourceGeneration>,
): string => {
  const hash = createHash("sha256");
  updateFrame(hash, "canvas.relational.source-prefix/v2");
  updateFrame(hash, headGeneration ?? "<none>");
  for (const generation of generations) {
    updateFrame(hash, generation.generation);
    updateFrame(hash, generation.parentGeneration ?? "<none>");
    updateFrame(hash, generation.createdAt);
    updateFrame(hash, generation.cause);
    updateFrame(hash, generation.intentSha256);
    updateFrame(hash, String(generation.documents.size));
    for (const document of generation.documents.values()) {
      updateFrame(hash, document.name);
      updateFrame(hash, document.revisionSha256);
      updateFrame(hash, document.modifiedAt);
      updateFrame(hash, document.body);
    }
  }
  return hash.digest("hex");
};

const readVerifiedSourcePrefix = (
  reader: StateReader,
): VerifiedSourcePrefix => {
  for (const table of [
    "canvas_generations",
    "canvas_generation_documents",
    "canvas_head",
    ...RELATIONAL_AUTHORITY_TABLES,
  ]) {
    if (!tableExists(reader, table)) {
      return fail(`canvas relational v2 cannot run: missing table ${table}`);
    }
  }

  const generationRows = reader.all<SourceGenerationRow>(
    `
      SELECT generation, created_at, cause, intent_sha256, document_count
      FROM canvas_generations
    `,
  );
  const headRow = reader.get<{ readonly generation: string }>(
    "SELECT generation FROM canvas_head WHERE singleton = 1",
  );
  if (generationRows.length === 0) {
    if (headRow !== undefined) {
      return fail("canvas head exists without a source generation");
    }
    const sourcePrefixSha256 = sourcePrefixSha256Of(null, []);
    return {
      headGeneration: null,
      generations: [],
      objectHistory: new Map(),
      sourcePrefixSha256,
    };
  }
  if (headRow === undefined) {
    return fail("canvas source generations exist without a current head");
  }

  let ordered: ReadonlyArray<DecimalGeneration>;
  try {
    ordered = orderDecimalGenerations(
      generationRows.map((row) => row.generation),
    );
  } catch (error) {
    return fail("canvas source history has a malformed generation", error);
  }
  const headGeneration = parseDecimalGeneration(
    headRow.generation,
    "canvas head generation",
  );
  const greatest = ordered.at(-1);
  if (greatest === undefined || compareDecimalGenerations(headGeneration, greatest) !== 0) {
    return fail(
      `canvas head ${headGeneration} is not the end of the exact ordered source prefix (greatest stored generation ${String(greatest)})`,
    );
  }

  const rowByGeneration = new Map(
    generationRows.map((row) => [row.generation, row] as const),
  );
  const documentRows = reader.all<SourceDocumentRow>(
    `
      SELECT generation, name, body, sha256, modified_at
      FROM canvas_generation_documents
    `,
  );
  const rowsByGeneration = new Map<string, SourceDocumentRow[]>();
  for (const row of documentRows) {
    const rows = rowsByGeneration.get(row.generation) ?? [];
    rows.push(row);
    rowsByGeneration.set(row.generation, rows);
  }

  const objectHistory = new Map<
    string,
    Map<string, HistoricalObjectIdentity>
  >();
  const generations: VerifiedSourceGeneration[] = [];
  for (const [index, generation] of ordered.entries()) {
    const row = rowByGeneration.get(generation);
    if (row === undefined) {
      return fail(`ordered source generation disappeared: ${generation}`);
    }
    if (!HASH_PATTERN.test(row.intent_sha256)) {
      return fail(`generation ${generation} has a malformed intent digest`);
    }
    const sourceRows = [...(rowsByGeneration.get(generation) ?? [])].sort(
      (left, right) => left.name.localeCompare(right.name),
    );
    const expectedCount = checkedCount(
      row.document_count,
      `generation ${generation} document_count`,
    );
    if (sourceRows.length !== expectedCount) {
      return fail(
        `generation ${generation} document_count mismatch: stored ${expectedCount}, actual ${sourceRows.length}`,
      );
    }

    const documents = new Map<string, VerifiedSourceDocument>();
    for (const sourceRow of sourceRows) {
      if (documents.has(sourceRow.name)) {
        return fail(
          `generation ${generation} contains duplicate canvas name ${sourceRow.name}`,
        );
      }
      const document = decodeSourceDocument(sourceRow);
      const history = objectHistory.get(document.name) ?? new Map();
      for (const node of document.doc.nodes) {
        const prior = history.get(node.id);
        if (prior !== undefined && prior.kind !== "node") {
          return fail(
            `canvas ${document.name} reuses object id ${node.id} across kinds (${prior.kind} -> node)`,
          );
        }
        if (prior === undefined) {
          history.set(node.id, {
            kind: "node",
            firstSeenGeneration: generation,
            deletedGeneration: null,
            createdAt: document.modifiedAt,
          });
        }
      }
      for (const edge of document.doc.edges) {
        const prior = history.get(edge.id);
        if (prior !== undefined && prior.kind !== "edge") {
          return fail(
            `canvas ${document.name} reuses object id ${edge.id} across kinds (${prior.kind} -> edge)`,
          );
        }
        if (prior === undefined) {
          history.set(edge.id, {
            kind: "edge",
            firstSeenGeneration: generation,
            deletedGeneration: null,
            createdAt: document.modifiedAt,
          });
        }
      }
      objectHistory.set(document.name, history);
      documents.set(document.name, document);
    }
    if (intentSha256Of(documents) !== row.intent_sha256) {
      return fail(`generation ${generation} intent digest mismatch`);
    }
    generations.push({
      generation,
      parentGeneration: index === 0 ? null : ordered[index - 1] ?? null,
      createdAt: row.created_at,
      cause: row.cause,
      intentSha256: row.intent_sha256,
      documents,
    });
  }

  for (const generation of rowsByGeneration.keys()) {
    if (!rowByGeneration.has(generation)) {
      return fail(`canvas document rows reference unknown generation ${generation}`);
    }
  }

  // Normal per-generation persistence tombstones an object at the first
  // generation where it becomes absent. A later upsert explicitly clears that
  // tombstone, so a resurrection that remains live at head is representable as
  // deleted_generation = NULL. For an object absent at head, retain the first
  // generation of its final contiguous absent run rather than inventing the
  // current head as its deletion provenance.
  for (const [canvasName, history] of objectHistory) {
    for (const [objectId, identity] of history) {
      let seen = false;
      let deletedGeneration: DecimalGeneration | null = null;
      for (const generation of generations) {
        const document = generation.documents.get(canvasName);
        const present =
          identity.kind === "node"
            ? document?.doc.nodes.some((node) => node.id === objectId) === true
            : document?.doc.edges.some((edge) => edge.id === objectId) === true;
        if (present) {
          seen = true;
          deletedGeneration = null;
        } else if (seen && deletedGeneration === null) {
          deletedGeneration = generation.generation;
        }
      }
      if (!seen) {
        return fail(
          `canvas ${canvasName} relational object ${objectId} has no source appearance`,
        );
      }
      history.set(objectId, { ...identity, deletedGeneration });
    }
  }

  return {
    headGeneration,
    generations,
    objectHistory,
    sourcePrefixSha256: sourcePrefixSha256Of(headGeneration, generations),
  };
};

type EnvelopeRow = {
  readonly parent_generation: string | null;
  readonly cause: string;
  readonly intent_sha256: string;
  readonly created_at: string;
};

const assertEnvelope = (
  row: EnvelopeRow,
  generation: VerifiedSourceGeneration,
): void => {
  if (row.parent_generation !== generation.parentGeneration) {
    fail(
      `generation ${generation.generation} has false relational ancestry: expected ${generation.parentGeneration ?? "NULL"}, found ${row.parent_generation ?? "NULL"}`,
    );
  }
  if (
    row.cause !== generation.cause ||
    row.intent_sha256 !== generation.intentSha256 ||
    row.created_at !== generation.createdAt
  ) {
    fail(`generation ${generation.generation} commit envelope does not match source evidence`);
  }
};

type ManifestRow = {
  readonly canvas_id: string;
  readonly canvas_name: string;
  readonly checkpoint_sha256: string;
  readonly semantic_sha256: string;
};

const readManifestRows = (
  reader: StateReader,
  generation: string,
): ReadonlyArray<ManifestRow> =>
  reader.all<ManifestRow>(
    `
      SELECT
        manifest.canvas_id AS canvas_id,
        document.canvas_name AS canvas_name,
        manifest.checkpoint_sha256 AS checkpoint_sha256,
        manifest.semantic_sha256 AS semantic_sha256
      FROM canvas_generation_manifests AS manifest
      JOIN canvas_documents AS document
        ON document.canvas_id = manifest.canvas_id
      WHERE manifest.generation = ?
    `,
    [generation],
  );

const assertCheckpoint = (
  reader: StateReader,
  document: VerifiedSourceDocument,
): boolean => {
  const checkpoint = reader.get<{
    readonly sha256: string;
    readonly byte_length: number | bigint;
    readonly body: string;
  }>(
    `
      SELECT sha256, byte_length, body
      FROM canvas_checkpoints
      WHERE sha256 = ?
    `,
    [document.revisionSha256],
  );
  if (checkpoint === undefined) return false;
  const byteLength = checkedCount(
    checkpoint.byte_length,
    `checkpoint ${document.revisionSha256} byte_length`,
  );
  if (
    checkpoint.sha256 !== document.revisionSha256 ||
    sha256Utf8(checkpoint.body) !== checkpoint.sha256 ||
    byteLength !== Buffer.byteLength(checkpoint.body, "utf8") ||
    byteLength !== document.byteLength ||
    checkpoint.body !== document.body
  ) {
    fail(`checkpoint ${document.revisionSha256} body digest or byte-length mismatch`);
  }
  return true;
};

const assertManifestRows = (
  rows: ReadonlyArray<ManifestRow>,
  generation: VerifiedSourceGeneration,
  requireComplete: boolean,
): void => {
  const seenNames = new Set<string>();
  for (const row of rows) {
    const document = generation.documents.get(row.canvas_name);
    if (document === undefined) {
      return fail(
        `generation ${generation.generation} has a relational manifest absent from source: ${row.canvas_name}`,
      );
    }
    if (seenNames.has(row.canvas_name)) {
      return fail(
        `generation ${generation.generation} has duplicate relational manifest identity: ${row.canvas_name}`,
      );
    }
    seenNames.add(row.canvas_name);
    if (
      row.checkpoint_sha256 !== document.revisionSha256 ||
      row.semantic_sha256 !== document.semanticSha256
    ) {
      return fail(
        `generation ${generation.generation} canvas ${row.canvas_name} manifest digest mismatch`,
      );
    }
  }
  if (requireComplete && seenNames.size !== generation.documents.size) {
    fail(
      `generation ${generation.generation} relational manifest count mismatch: expected ${generation.documents.size}, found ${seenNames.size}`,
    );
  }
};

const resolveEvidenceCanvas = (
  writer: StateWriter,
  document: VerifiedSourceDocument,
  generation: VerifiedSourceGeneration,
): { readonly canvasId: string; readonly created: boolean } => {
  const existing = writer.get<{ readonly canvas_id: string }>(
    "SELECT canvas_id FROM canvas_documents WHERE canvas_name = ?",
    [document.name],
  );
  if (existing !== undefined) {
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
    [
      canvasId,
      document.name,
      generation.generation,
      document.revisionSha256,
      document.semanticSha256,
      document.modifiedAt,
      document.modifiedAt,
    ],
  );
  return { canvasId, created: true };
};

const ensureGenerationEvidence = (
  writer: StateWriter,
  generation: VerifiedSourceGeneration,
): EvidenceCounts => {
  let canvases = 0;
  let checkpoints = 0;

  const envelope = writer.get<EnvelopeRow>(
    `
      SELECT parent_generation, cause, intent_sha256, created_at
      FROM canvas_commit_envelopes
      WHERE generation = ?
    `,
    [generation.generation],
  );
  if (envelope === undefined) {
    writer.run(
      `
        INSERT INTO canvas_commit_envelopes (
          generation, parent_generation, cause, intent_sha256,
          author_seat_id, author_principal, idempotency_key, change_summary,
          created_at
        ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, ?)
      `,
      [
        generation.generation,
        generation.parentGeneration,
        generation.cause,
        generation.intentSha256,
        generation.createdAt,
      ],
    );
  } else {
    assertEnvelope(envelope, generation);
  }

  const existingManifests = readManifestRows(writer, generation.generation);
  assertManifestRows(existingManifests, generation, false);
  const manifestByName = new Map(
    existingManifests.map((row) => [row.canvas_name, row] as const),
  );

  for (const document of generation.documents.values()) {
    if (!assertCheckpoint(writer, document)) {
      writer.run(
        `
          INSERT INTO canvas_checkpoints (sha256, byte_length, body, created_at)
          VALUES (?, ?, ?, ?)
        `,
        [
          document.revisionSha256,
          document.byteLength,
          document.body,
          document.modifiedAt,
        ],
      );
      checkpoints += 1;
    }
    const resolved = resolveEvidenceCanvas(writer, document, generation);
    if (resolved.created) canvases += 1;
    const manifest = manifestByName.get(document.name);
    if (manifest !== undefined) {
      if (manifest.canvas_id !== resolved.canvasId) {
        return fail(
          `generation ${generation.generation} canvas ${document.name} manifest points at a different canvas identity`,
        );
      }
      continue;
    }
    writer.run(
      `
        INSERT INTO canvas_generation_manifests (
          generation, canvas_id, checkpoint_sha256, semantic_sha256
        ) VALUES (?, ?, ?, ?)
      `,
      [
        generation.generation,
        resolved.canvasId,
        document.revisionSha256,
        document.semanticSha256,
      ],
    );
  }

  assertManifestRows(
    readManifestRows(writer, generation.generation),
    generation,
    true,
  );
  return { canvases, checkpoints };
};

const assertGenerationEvidence = (
  reader: StateReader,
  generation: VerifiedSourceGeneration,
): void => {
  const envelope = reader.get<EnvelopeRow>(
    `
      SELECT parent_generation, cause, intent_sha256, created_at
      FROM canvas_commit_envelopes
      WHERE generation = ?
    `,
    [generation.generation],
  );
  if (envelope === undefined) {
    return fail(`generation ${generation.generation} is missing its commit envelope`);
  }
  assertEnvelope(envelope, generation);
  for (const document of generation.documents.values()) {
    if (!assertCheckpoint(reader, document)) {
      return fail(
        `generation ${generation.generation} canvas ${document.name} is missing its checkpoint`,
      );
    }
  }
  assertManifestRows(
    readManifestRows(reader, generation.generation),
    generation,
    true,
  );
};

const currentDocuments = (
  generation: VerifiedSourceGeneration,
): ReadonlyMap<string, RelationalStoredCanvas> =>
  new Map(
    [...generation.documents].map(([name, document]) => [
      name,
      {
        doc: document.doc,
        body: document.body,
        revisionSha256: document.revisionSha256,
        modifiedAt: document.modifiedAt,
      },
    ]),
  );

const ensureHistoricalObjectIdentities = (
  writer: StateWriter,
  prefix: VerifiedSourcePrefix,
  throughGeneration?: DecimalGeneration,
): void => {
  for (const [canvasName, history] of prefix.objectHistory) {
    if (
      throughGeneration !== undefined &&
      ![...history.values()].some(
        (identity) =>
          compareDecimalGenerations(
            identity.firstSeenGeneration,
            throughGeneration,
          ) <= 0,
      )
    ) {
      continue;
    }
    const canvas = writer.get<{ readonly canvas_id: string }>(
      "SELECT canvas_id FROM canvas_documents WHERE canvas_name = ?",
      [canvasName],
    );
    if (canvas === undefined) {
      return fail(`historical canvas ${canvasName} has no relational identity`);
    }
    for (const [objectId, identity] of history) {
      if (
        throughGeneration !== undefined &&
        compareDecimalGenerations(
          identity.firstSeenGeneration,
          throughGeneration,
        ) > 0
      ) {
        continue;
      }
      const existing = writer.get<{
        readonly object_kind: "node" | "edge";
        readonly first_seen_generation: string;
      }>(
        `
          SELECT object_kind, first_seen_generation
          FROM canvas_objects
          WHERE canvas_id = ? AND object_id = ?
        `,
        [canvas.canvas_id, objectId],
      );
      if (existing === undefined) {
        writer.run(
          `
            INSERT INTO canvas_objects(
              canvas_id, object_id, object_kind, first_seen_generation,
              deleted_generation, created_at
            ) VALUES (?, ?, ?, ?, NULL, ?)
          `,
          [
            canvas.canvas_id,
            objectId,
            identity.kind,
            identity.firstSeenGeneration,
            identity.createdAt,
          ],
        );
        continue;
      }
      if (existing.object_kind !== identity.kind) {
        return fail(
          `canvas ${canvasName} relational object ${objectId} has cross-kind identity (${existing.object_kind} != ${identity.kind})`,
        );
      }
      if (existing.first_seen_generation !== identity.firstSeenGeneration) {
        writer.run(
          `
            UPDATE canvas_objects
            SET first_seen_generation = ?
            WHERE canvas_id = ? AND object_id = ?
          `,
          [identity.firstSeenGeneration, canvas.canvas_id, objectId],
        );
      }
    }
  }
};

const reconcileHistoricalObjectLifecycles = (
  writer: StateWriter,
  prefix: VerifiedSourcePrefix,
): void => {
  for (const [canvasName, history] of prefix.objectHistory) {
    const canvas = writer.get<{ readonly canvas_id: string }>(
      "SELECT canvas_id FROM canvas_documents WHERE canvas_name = ?",
      [canvasName],
    );
    if (canvas === undefined) {
      return fail(`historical canvas ${canvasName} has no relational identity`);
    }
    for (const [objectId, identity] of history) {
      const row = writer.get<{
        readonly object_kind: "node" | "edge";
        readonly first_seen_generation: string;
        readonly deleted_generation: string | null;
      }>(
        `
          SELECT object_kind, first_seen_generation, deleted_generation
          FROM canvas_objects
          WHERE canvas_id = ? AND object_id = ?
        `,
        [canvas.canvas_id, objectId],
      );
      if (row === undefined) {
        return fail(
          `canvas ${canvasName} relational object ${objectId} is missing its lifecycle row`,
        );
      }
      if (
        row.object_kind !== identity.kind ||
        row.first_seen_generation !== identity.firstSeenGeneration
      ) {
        return fail(
          `canvas ${canvasName} relational object ${objectId} lifecycle identity mismatch`,
        );
      }
      if (row.deleted_generation !== identity.deletedGeneration) {
        writer.run(
          `
            UPDATE canvas_objects
            SET deleted_generation = ?
            WHERE canvas_id = ? AND object_id = ?
          `,
          [identity.deletedGeneration, canvas.canvas_id, objectId],
        );
      }
    }
  }
};

const assertHistoricalObjectLifecycleParity = (
  reader: StateReader,
  prefix: VerifiedSourcePrefix,
): void => {
  for (const [canvasName, history] of prefix.objectHistory) {
    const canvas = reader.get<{ readonly canvas_id: string }>(
      "SELECT canvas_id FROM canvas_documents WHERE canvas_name = ?",
      [canvasName],
    );
    if (canvas === undefined) {
      return fail(`historical canvas ${canvasName} has no relational identity`);
    }
    for (const [objectId, identity] of history) {
      const row = reader.get<{
        readonly object_kind: "node" | "edge";
        readonly first_seen_generation: string;
        readonly deleted_generation: string | null;
      }>(
        `
          SELECT object_kind, first_seen_generation, deleted_generation
          FROM canvas_objects
          WHERE canvas_id = ? AND object_id = ?
        `,
        [canvas.canvas_id, objectId],
      );
      if (
        row === undefined ||
        row.object_kind !== identity.kind ||
        row.first_seen_generation !== identity.firstSeenGeneration ||
        row.deleted_generation !== identity.deletedGeneration
      ) {
        return fail(
          `canvas ${canvasName} relational object ${objectId} lifecycle provenance mismatch`,
        );
      }
    }
  }
};

const applyCurrentHead = (
  writer: StateWriter,
  prefix: VerifiedSourcePrefix,
): { readonly nodes: number; readonly edges: number } => {
  if (prefix.headGeneration === null) return { nodes: 0, edges: 0 };
  const head = prefix.generations.at(-1);
  if (head === undefined || head.generation !== prefix.headGeneration) {
    return fail("verified source prefix lost its current head");
  }
  persistRelationalPortfolio(writer, {
    generation: head.generation,
    parentGeneration: head.parentGeneration,
    cause: head.cause,
    intentSha256: head.intentSha256,
    createdAt: head.createdAt,
    documents: currentDocuments(head),
  });
  return {
    nodes: [...head.documents.values()].reduce(
      (count, document) => count + document.doc.nodes.length,
      0,
    ),
    edges: [...head.documents.values()].reduce(
      (count, document) => count + document.doc.edges.length,
      0,
    ),
  };
};

const assertCurrentHeadParity = (
  reader: StateReader,
  prefix: VerifiedSourcePrefix,
): void => {
  if (prefix.headGeneration === null) {
    for (const table of RELATIONAL_AUTHORITY_TABLES) {
      const row = reader.get<{ readonly count: number | bigint }>(
        `SELECT count(*) AS count FROM ${table}`,
      );
      if (
        row === undefined ||
        checkedCount(row.count, `empty-source ${table} row count`) !== 0
      ) {
        return fail(
          `empty canvas source has unverifiable relational residue in ${table}`,
        );
      }
    }
    return;
  }
  const head = prefix.generations.at(-1);
  if (head === undefined || head.generation !== prefix.headGeneration) {
    return fail("cannot prove relational parity without the verified current head");
  }

  const relationalDocuments = reader.all<{
    readonly canvas_id: string;
    readonly canvas_name: string;
    readonly head_generation: string;
    readonly head_checkpoint_sha256: string;
    readonly head_semantic_sha256: string;
  }>(
    `
      SELECT canvas_id, canvas_name, head_generation,
             head_checkpoint_sha256, head_semantic_sha256
      FROM canvas_documents
    `,
  );
  const byName = new Map(
    relationalDocuments.map((row) => [row.canvas_name, row] as const),
  );

  for (const document of head.documents.values()) {
    const relational = byName.get(document.name);
    if (relational === undefined) {
      return fail(`current canvas ${document.name} has no relational identity`);
    }
    if (
      relational.head_generation !== head.generation ||
      relational.head_checkpoint_sha256 !== document.revisionSha256 ||
      relational.head_semantic_sha256 !== document.semanticSha256
    ) {
      return fail(`current canvas ${document.name} relational head digest mismatch`);
    }
    const reconstructed = reconstructCanvasDoc(reader, relational.canvas_id);
    if (serializeCanvas(reconstructed) !== serializeCanvas(document.doc)) {
      return fail(`current canvas ${document.name} relational graph parity mismatch`);
    }

    const activeObjects = reader.all<{
      readonly object_id: string;
      readonly object_kind: "node" | "edge";
    }>(
      `
        SELECT object_id, object_kind
        FROM canvas_objects
        WHERE canvas_id = ? AND deleted_generation IS NULL
      `,
      [relational.canvas_id],
    );
    const expected = new Map<string, "node" | "edge">();
    for (const node of document.doc.nodes) expected.set(node.id, "node");
    for (const edge of document.doc.edges) expected.set(edge.id, "edge");
    if (
      activeObjects.length !== expected.size ||
      activeObjects.some((row) => expected.get(row.object_id) !== row.object_kind)
    ) {
      return fail(`current canvas ${document.name} active object parity mismatch`);
    }
  }

  for (const relational of relationalDocuments) {
    if (head.documents.has(relational.canvas_name)) continue;
    const live = reader.get<{ readonly count: number | bigint }>(
      `
        SELECT
          (SELECT count(*) FROM canvas_nodes WHERE canvas_id = ?) +
          (SELECT count(*) FROM canvas_edges WHERE canvas_id = ?) +
          (SELECT count(*) FROM canvas_objects
             WHERE canvas_id = ? AND deleted_generation IS NULL) AS count
      `,
      [relational.canvas_id, relational.canvas_id, relational.canvas_id],
    );
    if (live === undefined || checkedCount(live.count, "retired canvas live row count") !== 0) {
      return fail(
        `canvas ${relational.canvas_name} is absent from the current head but still has live relational rows`,
      );
    }
  }
};

const assertFullParity = (
  reader: StateReader,
  expectedPrefix: VerifiedSourcePrefix,
): void => {
  const actualPrefix = readVerifiedSourcePrefix(reader);
  if (
    actualPrefix.headGeneration !== expectedPrefix.headGeneration ||
    actualPrefix.sourcePrefixSha256 !== expectedPrefix.sourcePrefixSha256
  ) {
    fail("canvas source prefix changed while relational v2 was walking it");
  }
  for (const generation of actualPrefix.generations) {
    assertGenerationEvidence(reader, generation);
  }
  assertHistoricalObjectLifecycleParity(reader, actualPrefix);
  assertCurrentHeadParity(reader, actualPrefix);
};

/**
 * Backfill one verified generation. Kept for migration fixture proofs; startup
 * uses runCanvasRelationalBackfill so it can authenticate the whole prefix.
 */
export const backfillGenerationToRelational = (
  writer: StateWriter,
  generation: string,
): {
  readonly canvases: number;
  readonly checkpoints: number;
  readonly nodes: number;
  readonly edges: number;
} => {
  assertAuthorialRelationalRole(writer);
  const prefix = readVerifiedSourcePrefix(writer);
  const target = prefix.generations.find((entry) => entry.generation === generation);
  if (target === undefined) {
    return fail(`cannot backfill missing source generation ${generation}`);
  }
  const evidence = ensureGenerationEvidence(writer, target);
  ensureHistoricalObjectIdentities(writer, prefix, target.generation);
  const isHead = prefix.headGeneration === target.generation;
  const graph = isHead
    ? applyCurrentHead(writer, prefix)
    : { nodes: 0, edges: 0 };
  if (isHead) {
    reconcileHistoricalObjectLifecycles(writer, prefix);
  }
  assertGenerationEvidence(writer, target);
  if (isHead) {
    assertHistoricalObjectLifecycleParity(writer, prefix);
    assertCurrentHeadParity(writer, prefix);
  }
  return { ...evidence, ...graph };
};

/**
 * Verify the exact source history, preserve immutable evidence for every
 * generation, and project only the actual current head into mutable relational
 * rows. Failures leave the install-local v2 job pending; Canvases bootstrap
 * catches them so normal app boot remains open.
 */
export const runCanvasRelationalBackfill = (input: {
  readonly state: StateService;
  readonly installOps: InstallOpsServiceShape;
}): Effect.Effect<
  CanvasRelationalBackfillReport,
  CanvasRelationalBackfillError | InstallOpsError | unknown
> =>
  Effect.gen(function* () {
    // Role is canonical product state. Check it before touching install-ops or
    // reading any authorial source/relational row. The caller also gates Remote
    // startup, but this boundary must remain safe when invoked directly.
    const stationRole = yield* input.state.read(
      "canvas.relational.v2.station-role",
      (reader) =>
        selectStationConfiguration(reader)?.configuration.role ?? "",
    );
    if (stationRole === "remote") {
      return {
        status: "skipped-remote" as const,
        reason: "authorial-relational-backfill-disabled-on-remote" as const,
      };
    }

    const marker = yield* input.installOps.getBackfill(
      BACKFILL_CANVAS_RELATIONAL_V2,
    );
    if (marker?.status === "complete") {
      // Current install-ops has no source witness. A complete bit alone is not
      // proof and must never suppress the v2 walk.
      yield* input.installOps.reopenPending(BACKFILL_CANVAS_RELATIONAL_V2);
    } else {
      yield* input.installOps.ensurePending(BACKFILL_CANVAS_RELATIONAL_V2);
    }

    const prefix = yield* input.state.read(
      "canvas.relational.v2.source-prefix",
      readVerifiedSourcePrefix,
    );
    let canvases = 0;
    let checkpoints = 0;
    let graph = { nodes: 0, edges: 0 };
    if (prefix.headGeneration !== null) {
      for (const generation of prefix.generations) {
        const counts = yield* input.state.transaction(
          `canvas.relational.v2.evidence.${generation.generation}`,
          (writer) => {
            assertAuthorialRelationalRole(writer);
            return ensureGenerationEvidence(writer, generation);
          },
        );
        canvases += counts.canvases;
        checkpoints += counts.checkpoints;
      }
      yield* input.state.transaction(
        "canvas.relational.v2.object-history",
        (writer) => {
          assertAuthorialRelationalRole(writer);
          return ensureHistoricalObjectIdentities(writer, prefix);
        },
      );
      graph = yield* input.state.transaction(
        "canvas.relational.v2.current-head",
        (writer) => {
          // Role admission and source authentication share the exact SQLite
          // transaction that mutates the graph. A serialized CC -> Remote flip
          // therefore prevents every later authorial relational write.
          assertAuthorialRelationalRole(writer);
          // Re-authenticate inside the same SQLite transaction that mutates the
          // current graph. This transaction serializes with normal authoring
          // writes, so a head advance cannot make us apply a captured stale
          // prefix and then discover the downgrade only in post-write parity.
          const admittedPrefix = readVerifiedSourcePrefix(writer);
          if (
            admittedPrefix.headGeneration !== prefix.headGeneration ||
            admittedPrefix.sourcePrefixSha256 !== prefix.sourcePrefixSha256
          ) {
            return fail(
              "canvas source prefix changed before relational current-head mutation",
            );
          }
          const counts = applyCurrentHead(writer, prefix);
          reconcileHistoricalObjectLifecycles(writer, prefix);
          return counts;
        },
      );
    }
    yield* input.state.read(
      "canvas.relational.v2.parity",
      (reader) => assertFullParity(reader, prefix),
    );

    // Deliberately do not mark complete. INSTALL_OPS_SCHEMA_VERSION=1 cannot
    // bind the proof digest to the completion bit without lying.
    return {
      status: "verified-pending-witness" as const,
      canvasesProcessed: canvases,
      checkpointsCreated: checkpoints,
      nodesCreated: graph.nodes,
      edgesCreated: graph.edges,
      headGeneration: prefix.headGeneration,
      sourcePrefixSha256: prefix.sourcePrefixSha256,
      followUp: CANVAS_RELATIONAL_V2_WITNESS_FOLLOW_UP,
    };
  }).pipe(
    Effect.tap((report) =>
      Effect.sync(() => {
        if (report.status === "verified-pending-witness") {
          console.warn(
            `[canvases] relational v2 verified ${report.sourcePrefixSha256}; ${report.followUp}`,
          );
        }
      }),
    ),
    Effect.mapError((error) =>
      error instanceof CanvasRelationalBackfillError
        ? error
        : new CanvasRelationalBackfillError(
            "canvas relational v2 walk deferred",
            { cause: error },
          ),
    ),
  );
