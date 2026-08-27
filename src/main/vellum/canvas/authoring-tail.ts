import { createHash } from "node:crypto";
import { canonicalJson } from "../work/canonical-json";
import type { StateReader, StateWriter } from "../state/service";
import {
  AUTHORING_CODEC_FAMILY,
  AUTHORING_CODEC_VERSION,
  AUTHORING_ORIGIN_COMMAND_CENTER,
  DOCUMENT_REPLACE_V1,
  type DocumentReplaceV1,
} from "@shared/canvas-authoring";
import {
  edgeSemanticHash,
  nodeSemanticHash,
} from "./relational-backfill";
import type { CanvasDoc } from "@shared/canvas";

/** Read-horizon for incremental tail; rows stay, clients behind rebase. */
export const AUTHORING_TAIL_RETENTION_GENERATIONS = 256;

export type AuthoringTailRow = {
  readonly changeId: string;
  readonly parentChangeId: string | null;
  readonly canvasId: string;
  readonly generation: string;
  readonly operationKind: typeof DOCUMENT_REPLACE_V1;
  readonly payloadHash: string;
  readonly bodyHash: string;
  readonly createdAt: string;
};

export type AuthoringTailRead =
  | {
      readonly kind: "commands";
      readonly commands: ReadonlyArray<AuthoringTailRow>;
    }
  | {
      readonly kind: "checkpoint-required";
      readonly generation: string;
      readonly checkpointSha256: string;
    };

export const authoringPayloadHash = (command: DocumentReplaceV1): string =>
  createHash("sha256")
    .update(
      canonicalJson({
        kind: command.kind,
        changeId: command.changeId,
        canvasName: command.canvasName,
        doc: command.doc,
        baseGeneration: command.baseGeneration ?? null,
        baseBodyHash: command.baseBodyHash ?? null,
        objectHashes: command.objectHashes ?? null,
      }),
      "utf8",
    )
    .digest("hex");

export const changedObjectHashesJson = (doc: CanvasDoc): string => {
  const hashes: Record<string, string> = {};
  for (const node of doc.nodes) hashes[node.id] = nodeSemanticHash(node);
  for (const edge of doc.edges) hashes[edge.id] = edgeSemanticHash(edge);
  return canonicalJson(hashes);
};

export const assertObjectHashesAdmit = (
  previous: CanvasDoc | undefined,
  claimed: Readonly<Record<string, string>> | undefined,
): void => {
  if (claimed === undefined) return;
  const current: Record<string, string> = {};
  if (previous !== undefined) {
    for (const node of previous.nodes) current[node.id] = nodeSemanticHash(node);
    for (const edge of previous.edges) current[edge.id] = edgeSemanticHash(edge);
  }
  for (const [objectId, hash] of Object.entries(claimed)) {
    if (current[objectId] !== hash) {
      throw new Error(
        `stale object hash for ${objectId}; reload before saving`,
      );
    }
  }
};

export const findChangeTail = (
  reader: StateReader,
  changeId: string,
): AuthoringTailRow | undefined => {
  const row = reader.get<{
    readonly change_id: string;
    readonly parent_change_id: string | null;
    readonly canvas_id: string;
    readonly generation: string;
    readonly operation_kind: typeof DOCUMENT_REPLACE_V1;
    readonly payload_hash: string;
    readonly body_hash: string;
    readonly created_at: string;
  }>(
    `
      SELECT
        change_id, parent_change_id, canvas_id, generation, operation_kind,
        payload_hash, body_hash, created_at
      FROM canvas_change_tail
      WHERE change_id = ?
    `,
    [changeId],
  );
  if (row === undefined) return undefined;
  return {
    changeId: row.change_id,
    parentChangeId: row.parent_change_id,
    canvasId: row.canvas_id,
    generation: row.generation,
    operationKind: row.operation_kind,
    payloadHash: row.payload_hash,
    bodyHash: row.body_hash,
    createdAt: row.created_at,
  };
};

const latestChangeId = (
  reader: StateReader,
  canvasId: string,
): string | null =>
  reader.get<{ readonly change_id: string }>(
    `
      SELECT change_id
      FROM canvas_change_tail
      WHERE canvas_id = ?
      ORDER BY CAST(generation AS INTEGER) DESC, created_at DESC, change_id DESC
      LIMIT 1
    `,
    [canvasId],
  )?.change_id ?? null;

export const appendDocumentReplaceTail = (
  writer: StateWriter,
  input: {
    readonly changeId: string;
    readonly canvasId: string;
    readonly generation: string;
    readonly payloadHash: string;
    readonly bodyHash: string;
    readonly admittedBaseGeneration: string | null;
    readonly admittedBaseBodyHash: string | null;
    readonly changedObjectHashesJson: string;
    readonly createdAt: string;
  },
): void => {
  const parentChangeId = latestChangeId(writer, input.canvasId);
  writer.run(
    `
      INSERT INTO canvas_change_tail (
        change_id, parent_change_id, canvas_id, generation, operation_kind,
        codec_family, codec_version, payload_hash, body_hash,
        admitted_base_generation, admitted_base_body_hash,
        changed_object_hashes_json, origin, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      input.changeId,
      parentChangeId,
      input.canvasId,
      input.generation,
      DOCUMENT_REPLACE_V1,
      AUTHORING_CODEC_FAMILY,
      AUTHORING_CODEC_VERSION,
      input.payloadHash,
      input.bodyHash,
      input.admittedBaseGeneration,
      input.admittedBaseBodyHash,
      input.changedObjectHashesJson,
      AUTHORING_ORIGIN_COMMAND_CENTER,
      input.createdAt,
    ],
  );
  advanceTailFloor(writer, input.generation, input.bodyHash);
};

const advanceTailFloor = (
  writer: StateWriter,
  headGeneration: string,
  headCheckpointSha: string,
): void => {
  const head = BigInt(headGeneration);
  const floor =
    head + 1n > BigInt(AUTHORING_TAIL_RETENTION_GENERATIONS)
      ? (head + 1n - BigInt(AUTHORING_TAIL_RETENTION_GENERATIONS)).toString()
      : "1";
  const floorChange =
    writer.get<{ readonly change_id: string }>(
      `
        SELECT change_id
        FROM canvas_change_tail
        WHERE CAST(generation AS INTEGER) >= CAST(? AS INTEGER)
        ORDER BY CAST(generation AS INTEGER) ASC, created_at ASC, change_id ASC
        LIMIT 1
      `,
      [floor],
    )?.change_id ?? null;
  writer.run(
    `
      INSERT INTO canvas_authoring_tail_state (
        singleton, tail_floor_generation, tail_floor_change_id, retained_checkpoint_sha256
      ) VALUES (1, ?, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET
        tail_floor_generation = excluded.tail_floor_generation,
        tail_floor_change_id = excluded.tail_floor_change_id,
        retained_checkpoint_sha256 = excluded.retained_checkpoint_sha256
    `,
    [floor, floorChange, headCheckpointSha],
  );
};

export const readAuthoringTail = (
  reader: StateReader,
  input: {
    readonly afterChangeId?: string;
    readonly canvasName?: string;
  },
): AuthoringTailRead => {
  const state = reader.get<{
    readonly tail_floor_generation: string;
    readonly tail_floor_change_id: string | null;
    readonly retained_checkpoint_sha256: string | null;
  }>(
    `
      SELECT tail_floor_generation, tail_floor_change_id, retained_checkpoint_sha256
      FROM canvas_authoring_tail_state
      WHERE singleton = 1
    `,
  );
  if (input.afterChangeId !== undefined) {
    const cursor = findChangeTail(reader, input.afterChangeId);
    if (
      state !== undefined &&
      (
        cursor === undefined ||
        BigInt(cursor.generation) < BigInt(state.tail_floor_generation)
      )
    ) {
      const checkpoint =
        state.retained_checkpoint_sha256 ??
        reader.get<{ readonly head_checkpoint_sha256: string }>(
          "SELECT head_checkpoint_sha256 FROM canvas_documents LIMIT 1",
        )?.head_checkpoint_sha256;
      if (checkpoint === undefined) {
        throw new Error("authoring tail floor requires a retained checkpoint");
      }
      return {
        kind: "checkpoint-required",
        generation: state.tail_floor_generation,
        checkpointSha256: checkpoint,
      };
    }
  }

  const canvasId =
    input.canvasName === undefined
      ? undefined
      : reader.get<{ readonly canvas_id: string }>(
          "SELECT canvas_id FROM canvas_documents WHERE canvas_name = ?",
          [input.canvasName],
        )?.canvas_id;
  const rows = reader.all<{
    readonly change_id: string;
    readonly parent_change_id: string | null;
    readonly canvas_id: string;
    readonly generation: string;
    readonly operation_kind: typeof DOCUMENT_REPLACE_V1;
    readonly payload_hash: string;
    readonly body_hash: string;
    readonly created_at: string;
  }>(
    `
      SELECT
        change_id, parent_change_id, canvas_id, generation, operation_kind,
        payload_hash, body_hash, created_at
      FROM canvas_change_tail
      WHERE CAST(generation AS INTEGER) >= CAST(? AS INTEGER)
        AND (? IS NULL OR canvas_id = ?)
        AND (? IS NULL OR change_id > ?)
      ORDER BY CAST(generation AS INTEGER) ASC, created_at ASC, change_id ASC
    `,
    [
      state?.tail_floor_generation ?? "1",
      canvasId ?? null,
      canvasId ?? null,
      input.afterChangeId ?? null,
      input.afterChangeId ?? null,
    ],
  );
  return {
    kind: "commands",
    commands: rows.map((row) => ({
      changeId: row.change_id,
      parentChangeId: row.parent_change_id,
      canvasId: row.canvas_id,
      generation: row.generation,
      operationKind: row.operation_kind,
      payloadHash: row.payload_hash,
      bodyHash: row.body_hash,
      createdAt: row.created_at,
    })),
  };
};
