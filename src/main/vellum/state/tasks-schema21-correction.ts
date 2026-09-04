import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { serializeCanvas } from "@shared/canvas";
import type { StateSchemaMigrationDatabase } from "./migrations";
import { canonicalJson } from "../work/canonical-json";
import {
  canvasBodySha256Of,
  intentSha256Of,
} from "../canvas-intent-identity";
import {
  persistCanvas,
  reconstructCanvasDoc,
  writePortfolioHead,
  type CanvasSqlWriter,
} from "../canvas/records";
import { WORK_STATE_SCHEMA_HEAD_BASIS_SQL } from "../work/state-schema";

/**
 * Isolated corrective converter for the rejected schema-21 Tasks shape.
 *
 * The invalid release shipped schema version 21 with proposal storage and the
 * retired Tasks vocabulary (claims / journey / boarding / holdUntil /
 * operator-gated admission, station ether contracts, claim responses in
 * completion evidence). This converter rewrites ONLY those shapes, in ONLY
 * the columns that carry them, and preserves every unrelated object that
 * happens to use the same key names (task metadata, message metadata, other
 * action/result payloads). It then materializes proposal rows into canonical
 * task command/fact records and projection rows, repairs every content hash
 * under the exact canonical record hashing contract, and drops the proposal
 * storage the corrected schema no longer composes.
 *
 * It runs inside `migrateStateSchema`'s startup transaction, either as the
 * exact-identity-gated corrective path (invalid 21 -> corrected 21) or at the
 * end of the 20 -> 21 consolidation step. A throw rolls everything back and
 * StateEngine's pre-open backup remains the recovery path.
 */

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

// ---------------------------------------------------------------------------
// Vocabulary maps (retired -> canonical)
// ---------------------------------------------------------------------------

const mapAdmission = (value: unknown): unknown =>
  value === "operator-gated"
    ? "approval"
    : value === "operator-owned"
      ? "operator"
      : value;

const mapVisitExit = (value: unknown): unknown =>
  value === "forwarded"
    ? "sent-on"
    : value === "closed"
      ? "completed"
      : value === "rejected-back"
        ? "sent-back"
        : value;

const mapCheckSide = (value: unknown): unknown =>
  value === "outbound"
    ? "outgoing"
    : value === "inbound"
      ? "incoming"
      : value;

const RETIRED_TASK_METADATA_BAG_KEY = "vellum.pipeline";
const TASK_METADATA_BAG_KEY = "vellum.tasks";
const RETIRED_ADMITTED_KEY = "vellum.pipeline.admittedEpoch";
const APPROVED_METADATA_KEY = "vellum.tasks.approvedEpoch";

/**
 * Correct the exact system-generated send-on marker. The role guard and exact
 * generated shape keep arbitrary prose untouched.
 */
const canonicalizeGeneratedTaskHistoryParts = (
  role: unknown,
  parts: unknown,
): unknown => {
  if (role !== "agent" || !Array.isArray(parts)) return parts;
  return parts.map((part) => {
    const marker =
      isObject(part) &&
      part.kind === "text" &&
      typeof part.text === "string"
        ? /^forwarded from ("[^"\r\n]+"(?: — [\s\S]+)?)$/u.exec(part.text)
        : null;
    if (!isObject(part) || marker === null) {
      return part;
    }
    return {
      ...part,
      text: `sent on from ${marker[1]}`,
    };
  });
};

const canonicalizeTaskHistoryMessage = (message: unknown): unknown => {
  if (!isObject(message)) return message;
  const parts = canonicalizeGeneratedTaskHistoryParts(
    message.role,
    message.parts,
  );
  return parts === message.parts ? message : { ...message, parts };
};

/**
 * ClaimDef / TaskClaim -> Rule / TaskRule. `severity` has no canonical
 * counterpart and is dropped; `station` (task-addressed claims) becomes the
 * rule's `board`.
 */
const canonicalizeRuleLike = (value: unknown, hasBoard: boolean): unknown => {
  if (!isObject(value)) return value;
  const out: JsonObject = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === "severity") continue;
    out[hasBoard && key === "station" ? "board" : key] = nested;
  }
  return out;
};

/** Passage -> Visit (journey -> visits). */
const canonicalizeVisit = (value: unknown): unknown => {
  if (!isObject(value)) return value;
  const out: JsonObject = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === "nodeId") out.board = nested;
    else if (key === "exit") out.exit = mapVisitExit(nested);
    else if (key === "emissionNote") out.handoffNote = nested;
    else out[key] = nested;
  }
  return out;
};

/** Ticket -> CheckResult (boarding -> checkResults). `label` has no canonical column. */
const canonicalizeCheckResult = (value: unknown): unknown => {
  if (!isObject(value)) return value;
  const out: JsonObject = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === "label") continue;
    out[key] = key === "side" ? mapCheckSide(nested) : nested;
  }
  return out;
};

/** ClaimResponse / ClaimWaiver arrays -> Claim / Waiver arrays. */
const canonicalizeClaimArray = (
  entries: unknown,
  keyMap: Readonly<Record<string, string>>,
): unknown => {
  if (!Array.isArray(entries)) return entries;
  return entries.map((entry) => {
    if (!isObject(entry)) return entry;
    const out: JsonObject = {};
    for (const [key, nested] of Object.entries(entry)) {
      out[keyMap[key] ?? key] = nested;
    }
    return out;
  });
};

/** Retired CompletionEvidence (responses / claimWaivers) -> canonical (claims / waivers). */
const canonicalizeEvidence = (value: unknown): unknown => {
  if (!isObject(value)) return value;
  const out: JsonObject = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === "responses") {
      out.claims = canonicalizeClaimArray(nested, {
        claimId: "ruleId",
        response: "text",
      });
    } else if (key === "claimWaivers") {
      out.waivers = canonicalizeClaimArray(nested, { claimId: "ruleId" });
    } else {
      out[key] = nested;
    }
  }
  return out;
};

/**
 * Retired pipeline metadata bag (claims / journey / holdUntil / boarding /
 * admission) -> canonical bag (rules / visits / waitUntil / checkResults /
 * admission). Unrelated bag keys (epoch, defects, raisedBy, ...) pass through.
 */
const canonicalizePipelineBag = (bag: unknown): unknown => {
  if (!isObject(bag)) return bag;
  const out: JsonObject = {};
  for (const [key, nested] of Object.entries(bag)) {
    switch (key) {
      case "claims":
        out.rules = Array.isArray(nested)
          ? nested.map((claim) => canonicalizeRuleLike(claim, true))
          : nested;
        break;
      case "journey":
        out.visits = Array.isArray(nested)
          ? nested.map(canonicalizeVisit)
          : nested;
        break;
      case "holdUntil":
        out.waitUntil = nested;
        break;
      case "boarding":
        out.checkResults = Array.isArray(nested)
          ? nested.map(canonicalizeCheckResult)
          : nested;
        break;
      case "admission":
        out.admission = mapAdmission(nested);
        break;
      case "history":
        out.history = Array.isArray(nested)
          ? nested.map(canonicalizeTaskHistoryMessage)
          : nested;
        break;
      default:
        out[key] = nested;
    }
  }
  return out;
};

/**
 * Task metadata: rename the retired flat `vellum.pipeline.admittedEpoch` key
 * to the canonical approval marker and canonicalize the pipeline bag. Every
 * other metadata key is preserved byte-for-byte.
 */
const canonicalizeMetadata = (metadata: unknown): unknown => {
  if (!isObject(metadata)) return metadata;
  const reserved = Object.keys(metadata).find((key) =>
    key.startsWith("vellum.tasks"),
  );
  if (reserved !== undefined) {
    throw new Error(
      `tasks-schema21 correction: invalid task metadata already occupies reserved key ${JSON.stringify(reserved)}`,
    );
  }
  const out: JsonObject = {};
  for (const [key, nested] of Object.entries(metadata)) {
    if (key === RETIRED_ADMITTED_KEY) {
      out[APPROVED_METADATA_KEY] = nested;
    } else if (key === RETIRED_TASK_METADATA_BAG_KEY) {
      out[TASK_METADATA_BAG_KEY] = canonicalizePipelineBag(nested);
    } else {
      out[key] = nested;
    }
  }
  return out;
};

/**
 * Retired Task vocabulary -> canonical Task vocabulary. Only the retired
 * first-class fields are touched; everything else passes through untouched.
 */
const canonicalizeTaskLike = (task: unknown): unknown => {
  if (!isObject(task)) return task;
  const out: JsonObject = {};
  for (const [key, nested] of Object.entries(task)) {
    switch (key) {
      case "claims":
        out.rules = Array.isArray(nested)
          ? nested.map((claim) => canonicalizeRuleLike(claim, true))
          : nested;
        break;
      case "journey":
        out.visits = Array.isArray(nested)
          ? nested.map(canonicalizeVisit)
          : nested;
        break;
      case "holdUntil":
        out.waitUntil = nested;
        break;
      case "boarding":
        out.checkResults = Array.isArray(nested)
          ? nested.map(canonicalizeCheckResult)
          : nested;
        break;
      case "completionEvidence":
        out.completionEvidence = canonicalizeEvidence(nested);
        break;
      case "metadata":
        out.metadata = canonicalizeMetadata(nested);
        break;
      case "admission":
        out.admission = mapAdmission(nested);
        break;
      case "history":
        out.history = Array.isArray(nested)
          ? nested.map(canonicalizeTaskHistoryMessage)
          : nested;
        break;
      default:
        out[key] = nested;
    }
  }
  return out;
};

// ---------------------------------------------------------------------------
// Canvas ether (authorial Tasks/region contracts only)
// ---------------------------------------------------------------------------

/** Retired TasksInboundContract -> canonical TasksIncoming. */
const canonicalizeTasksInbound = (inbound: unknown): unknown => {
  if (!isObject(inbound)) return inbound;
  const out: JsonObject = {};
  for (const [key, nested] of Object.entries(inbound)) {
    switch (key) {
      case "instruction":
        out.handling = nested;
        break;
      case "claimableAfterMs":
        out.waitMs = nested;
        break;
      case "checklist":
        out.checks = nested;
        break;
      case "admission":
        out.admission = mapAdmission(nested);
        break;
      default:
        out[key] = nested;
    }
  }
  return out;
};

/** Retired TasksOutboundContract -> canonical TasksOutgoing. */
const canonicalizeTasksOutbound = (outbound: unknown): unknown => {
  if (!isObject(outbound)) return outbound;
  const out: JsonObject = {};
  for (const [key, nested] of Object.entries(outbound)) {
    if (key === "emission") out.handoff = nested;
    else if (key === "checklist") out.checks = nested;
    else out[key] = nested;
  }
  return out;
};

/** Retired TasksSinkContract -> canonical TasksContract. */
const canonicalizeTasksContract = (contract: unknown): unknown => {
  if (!isObject(contract)) return contract;
  const out: JsonObject = {};
  for (const [key, nested] of Object.entries(contract)) {
    switch (key) {
      case "instruction":
        out.instructions = nested;
        break;
      case "claims":
        out.rules = Array.isArray(nested)
          ? nested.map((claim) => canonicalizeRuleLike(claim, false))
          : nested;
        break;
      case "inbound":
        out.incoming = canonicalizeTasksInbound(nested);
        break;
      case "outbound":
        out.outgoing = canonicalizeTasksOutbound(nested);
        break;
      default:
        out[key] = nested;
    }
  }
  return out;
};

/** Retired WorkTasks ether (`stationName` + sink contract) -> canonical. */
const canonicalizeEtherTasks = (tasks: unknown): unknown => {
  if (!isObject(tasks)) return tasks;
  const out: JsonObject = {};
  for (const [key, nested] of Object.entries(tasks)) {
    if (key === "stationName") out.name = nested;
    else if (key === "contract") out.contract = canonicalizeTasksContract(nested);
    else out[key] = nested;
  }
  return out;
};

/** Retired EtherRegionContract (claims) -> canonical (rules). */
const canonicalizeRegionContract = (contract: unknown): unknown => {
  if (!isObject(contract)) return contract;
  const out: JsonObject = {};
  for (const [key, nested] of Object.entries(contract)) {
    if (key === "claims") {
      out.rules = Array.isArray(nested)
        ? nested.map((claim) => canonicalizeRuleLike(claim, false))
        : nested;
    } else {
      out[key] = nested;
    }
  }
  return out;
};

/** Ether rewrite: `tasks` and `region.contract` only; all other ether keys preserved. */
const canonicalizeEther = (
  ether: unknown,
): { readonly changed: boolean; readonly value: unknown } => {
  if (!isObject(ether)) return { changed: false, value: ether };
  const out: JsonObject = {};
  let changed = false;
  for (const [key, nested] of Object.entries(ether)) {
    if (key === "tasks") {
      const next = canonicalizeEtherTasks(nested);
      if (!isDeepStrictEqual(next, nested)) changed = true;
      out.tasks = next;
    } else if (key === "region") {
      const next = canonicalizeRegionEther(nested);
      if (!isDeepStrictEqual(next, nested)) changed = true;
      out.region = next;
    } else {
      out[key] = nested;
    }
  }
  return { changed, value: changed ? out : ether };
};

const canonicalizeRegionEther = (region: unknown): unknown => {
  if (!isObject(region)) return region;
  const out: JsonObject = {};
  for (const [key, nested] of Object.entries(region)) {
    out[key] =
      key === "contract" ? canonicalizeRegionContract(nested) : nested;
  }
  return out;
};

/**
 * Correct retired Tasks ether in a schema-20 blob canvas before the relational
 * authority cutover performs its strict current-schema decode. This is part of
 * the same isolated schema-21 correction, not a runtime compatibility reader.
 */
export const correctInvalidTasksCanvasDocumentSchema21 = (
  document: unknown,
): unknown => {
  if (!isObject(document) || !Array.isArray(document.nodes)) return document;
  let changed = false;
  const nodes = document.nodes.map((node) => {
    if (!isObject(node) || !("ether" in node)) return node;
    const corrected = canonicalizeEther(node.ether);
    if (!corrected.changed) return node;
    changed = true;
    return { ...node, ether: corrected.value };
  });
  return changed ? { ...document, nodes } : document;
};

// ---------------------------------------------------------------------------
// Work action/result payloads
// ---------------------------------------------------------------------------

/** Only Task payloads and completion evidence inside action/result bodies. */
const canonicalizeWorkBody = (body: unknown): unknown => {
  if (!isObject(body)) return body;
  const out: JsonObject = {};
  for (const [key, nested] of Object.entries(body)) {
    if (key === "task" || key === "request" || key === "sourceTask") {
      out[key] = canonicalizeTaskLike(nested);
    } else if (key === "completionEvidence") {
      out[key] = canonicalizeEvidence(nested);
    } else {
      out[key] = nested;
    }
  }
  return out;
};

// ---------------------------------------------------------------------------
// Row rewrites
// ---------------------------------------------------------------------------

type JsonRow = {
  readonly [column: string]: unknown;
};

const rowsOf = (
  database: StateSchemaMigrationDatabase,
  sql: string,
  ...bindings: ReadonlyArray<unknown>
): ReadonlyArray<JsonRow> =>
  database.prepare(sql).all(...(bindings as never[])) as unknown as
    ReadonlyArray<JsonRow>;

const rowOf = (
  database: StateSchemaMigrationDatabase,
  sql: string,
  ...bindings: ReadonlyArray<unknown>
): JsonRow | undefined =>
  database.prepare(sql).get(...(bindings as never[])) as JsonRow | undefined;

const run = (
  database: StateSchemaMigrationDatabase,
  sql: string,
  ...bindings: ReadonlyArray<unknown>
): void => {
  database.prepare(sql).run(...(bindings as never[]));
};

const parseJson = (value: string | null): unknown =>
  value === null ? undefined : (JSON.parse(value) as unknown);

const storedCanonical = (value: string): string =>
  JSON.stringify(JSON.parse(value) as unknown);

/** Rewrite one JSON column; returns the primary-key rows whose bytes changed. */
const rewriteJsonColumn = (
  database: StateSchemaMigrationDatabase,
  table: string,
  column: string,
  keys: readonly string[],
  canonicalize: (value: unknown) => unknown,
): ReadonlyArray<JsonRow> => {
  const changed: JsonRow[] = [];
  const select = `SELECT ${keys.join(", ")}, ${column} AS body FROM ${table} WHERE ${column} IS NOT NULL`;
  const update = `UPDATE ${table} SET ${column} = ? WHERE ${keys.map((key) => `${key} = ?`).join(" AND ")}`;
  for (const row of rowsOf(database, select)) {
    const body = String(row.body);
    const rewritten = canonicalize(parseJson(body));
    const next = canonicalJson(rewritten);
    if (next === storedCanonical(body)) continue;
    run(database, update, next, ...keys.map((key) => row[key]));
    changed.push(row);
  }
  return changed;
};

/** Keep normalized history rows aligned with the corrected Work snapshots. */
const correctGeneratedTaskHistoryRows = (
  database: StateSchemaMigrationDatabase,
): void => {
  const update = `UPDATE work_task_messages
    SET parts_json = ?
    WHERE canvas_name = ? AND node_id = ? AND parent_lane = ?
      AND item_id = ? AND message_id = ?`;
  for (const row of rowsOf(
    database,
    `SELECT canvas_name, node_id, parent_lane, item_id, message_id, role,
            parts_json
     FROM work_task_messages
     WHERE role = 'agent'`,
  )) {
    const body = String(row.parts_json);
    const rewritten = canonicalizeGeneratedTaskHistoryParts(
      row.role,
      parseJson(body),
    );
    const next = canonicalJson(rewritten);
    if (next === storedCanonical(body)) continue;
    run(
      database,
      update,
      next,
      row.canvas_name,
      row.node_id,
      row.parent_lane,
      row.item_id,
      row.message_id,
    );
  }
};

// ---------------------------------------------------------------------------
// Work record hashing (exact canonical contract: sha256(canonicalJson(semantic)))
// ---------------------------------------------------------------------------

type WorkRouteKey = {
  readonly eventHome: string;
  readonly entityHome: string;
  readonly seq: string;
};

const routeKey = (route: WorkRouteKey): string =>
  `${route.eventHome}\u0000${route.entityHome}\u0000${route.seq}`;

type RecordRow = JsonRow & {
  readonly event_home: string;
  readonly entity_home: string;
  readonly seq: string;
  readonly protocol: string;
  readonly record_type: "command" | "fact" | "disposition";
  readonly item_kind: string;
  readonly item_id: string;
  readonly item_canvas_name: string;
  readonly item_node_id: string;
  readonly operation: string;
  readonly content_sha256: string;
  readonly predecessor_event_home: string | null;
  readonly predecessor_entity_home: string | null;
  readonly predecessor_seq: string | null;
  readonly basis_kind: string | null;
  readonly basis_authorial_generation: string | null;
  readonly basis_authorial_content_sha256: string | null;
  readonly basis_projected_generation: string | null;
  readonly basis_projected_content_sha256: string | null;
  readonly basis_command_event_home: string | null;
  readonly basis_command_entity_home: string | null;
  readonly basis_command_seq: string | null;
  readonly basis_command_sha256: string | null;
  readonly status: string | null;
  readonly command_event_home: string | null;
  readonly command_entity_home: string | null;
  readonly command_seq: string | null;
  readonly command_sha256: string | null;
  readonly fact_event_home: string | null;
  readonly fact_entity_home: string | null;
  readonly fact_seq: string | null;
  readonly fact_sha256: string | null;
  readonly rejection_reason: string | null;
  readonly rejection_message: string | null;
  readonly action_json: string | null;
  readonly result_json: string | null;
};

const predecessorOf = (row: RecordRow): unknown =>
  row.predecessor_seq === null
    ? null
    : {
        route: {
          eventHome: row.predecessor_event_home,
          entityHome: row.predecessor_entity_home,
        },
        seq: row.predecessor_seq,
      };

const basisOf = (row: RecordRow): unknown => {
  if (row.basis_kind === "authorial-intent") {
    return {
      kind: "authorial-intent",
      generation: row.basis_authorial_generation,
      contentSha256: row.basis_authorial_content_sha256,
    };
  }
  if (row.basis_kind === "projected-intent") {
    return {
      kind: "projected-intent",
      generation: row.basis_projected_generation,
      contentSha256: row.basis_projected_content_sha256,
    };
  }
  return {
    kind: "command",
    command: {
      route: {
        eventHome: row.basis_command_event_home,
        entityHome: row.basis_command_entity_home,
      },
      seq: row.basis_command_seq,
    },
    commandSha256: row.basis_command_sha256,
  };
};

const dispositionBodyOf = (row: RecordRow): unknown =>
  row.status === "applied"
    ? {
        status: "applied",
        command: {
          route: {
            eventHome: row.command_event_home,
            entityHome: row.command_entity_home,
          },
          seq: row.command_seq,
        },
        commandSha256: row.command_sha256,
        fact: {
          route: {
            eventHome: row.fact_event_home,
            entityHome: row.fact_entity_home,
          },
          seq: row.fact_seq,
        },
        factSha256: row.fact_sha256,
      }
    : {
        status: "rejected",
        command: {
          route: {
            eventHome: row.command_event_home,
            entityHome: row.command_entity_home,
          },
          seq: row.command_seq,
        },
        commandSha256: row.command_sha256,
        reason: row.rejection_reason,
        message: row.rejection_message,
      };

const recordSemanticOf = (row: RecordRow): unknown => {
  const common = {
    protocol: row.protocol,
    id: {
      route: {
        eventHome: row.event_home,
        entityHome: row.entity_home,
      },
      seq: row.seq,
    },
    recordType: row.record_type,
    item: {
      kind: row.item_kind,
      itemId: row.item_id,
      sink: {
        canvasName: row.item_canvas_name,
        nodeId: row.item_node_id,
      },
    },
    operation: row.operation,
  };
  switch (row.record_type) {
    case "command":
      return {
        ...common,
        predecessor: predecessorOf(row),
        body: parseJson(row.action_json),
      };
    case "fact":
      return {
        ...common,
        basis: basisOf(row),
        predecessor: predecessorOf(row),
        body: parseJson(row.result_json),
      };
    case "disposition":
      return { ...common, body: dispositionBodyOf(row) };
  }
};

const loadRecordRow = (
  database: StateSchemaMigrationDatabase,
  route: WorkRouteKey,
  recordType: "command" | "fact" | "disposition",
): RecordRow | undefined => {
  const variantColumns =
    recordType === "command"
      ? `predecessor_event_home, predecessor_entity_home, predecessor_seq,
         NULL AS basis_kind, NULL AS basis_authorial_generation,
         NULL AS basis_authorial_content_sha256, NULL AS basis_projected_generation,
         NULL AS basis_projected_content_sha256, NULL AS basis_command_event_home,
         NULL AS basis_command_entity_home, NULL AS basis_command_seq,
         NULL AS basis_command_sha256, NULL AS status, NULL AS command_event_home,
         NULL AS command_entity_home, NULL AS command_seq, NULL AS command_sha256,
         NULL AS fact_event_home, NULL AS fact_entity_home, NULL AS fact_seq,
         NULL AS fact_sha256, NULL AS rejection_reason, NULL AS rejection_message,
         action_json`
      : recordType === "fact"
        ? `predecessor_event_home, predecessor_entity_home, predecessor_seq,
           basis_kind, basis_authorial_generation, basis_authorial_content_sha256,
           basis_projected_generation, basis_projected_content_sha256,
           basis_command_event_home, basis_command_entity_home, basis_command_seq,
           basis_command_sha256, NULL AS status, NULL AS command_event_home,
           NULL AS command_entity_home, NULL AS command_seq, NULL AS command_sha256,
           NULL AS fact_event_home, NULL AS fact_entity_home, NULL AS fact_seq,
           NULL AS fact_sha256, NULL AS rejection_reason, NULL AS rejection_message,
           result_json`
        : `NULL AS predecessor_event_home, NULL AS predecessor_entity_home,
           NULL AS predecessor_seq, NULL AS basis_kind,
           NULL AS basis_authorial_generation, NULL AS basis_authorial_content_sha256,
           NULL AS basis_projected_generation, NULL AS basis_projected_content_sha256,
           NULL AS basis_command_event_home, NULL AS basis_command_entity_home,
           NULL AS basis_command_seq, NULL AS basis_command_sha256,
           status, command_event_home, command_entity_home, command_seq,
           command_sha256, fact_event_home, fact_entity_home, fact_seq,
           fact_sha256, rejection_reason, rejection_message,
           NULL AS action_json`;
  const table =
    recordType === "command"
      ? "work_commands"
      : recordType === "fact"
        ? "work_facts"
        : "work_dispositions";
  return rowOf(
    database,
    `SELECT
       work_events.event_home, work_events.entity_home, work_events.seq,
       protocol, work_events.record_type, item_kind,
       item_id, item_canvas_name, item_node_id, operation, content_sha256,
       ${variantColumns}
     FROM work_events
     JOIN ${table} USING (event_home, entity_home, seq)
     WHERE event_home = ? AND entity_home = ? AND seq = ?`,
    route.eventHome,
    route.entityHome,
    route.seq,
  ) as RecordRow | undefined;
};

/**
 * Recompute `work_events.content_sha256` for every record whose semantic
 * changed (rewritten action/result JSON, or a referent hash that feeds its
 * body/basis) and propagate the new hashes to every correlated copy:
 * work_dispositions.command_sha256 / fact_sha256 and
 * work_facts.basis_command_sha256. Runs to a fixed point so a hash change
 * that itself changes another record's semantic (a fact whose command basis
 * hash moved, a disposition whose command/fact hashes moved) is fully
 * propagated. Only rows whose computed hash actually changed are written.
 */
const repairWorkRecordHashes = (
  database: StateSchemaMigrationDatabase,
  changedCommands: ReadonlySet<string>,
  changedFacts: ReadonlySet<string>,
): void => {
  type Pending = {
    readonly route: WorkRouteKey;
    readonly recordType: "command" | "fact" | "disposition";
    readonly via: string;
  };
  const pending: Pending[] = [];
  const queued = new Set<string>();
  const enqueue = (
    route: WorkRouteKey,
    recordType: "command" | "fact" | "disposition",
    via: string,
  ): void => {
    const key = `${recordType}:${routeKey(route)}`;
    if (queued.has(key)) return;
    queued.add(key);
    pending.push({ route, recordType, via });
  };
  for (const key of changedCommands) {
    const [eventHome, entityHome, seq] = key.split("\u0000") as [
      string,
      string,
      string,
    ];
    enqueue({ eventHome, entityHome, seq }, "command", "body-rewrite");
  }
  for (const key of changedFacts) {
    const [eventHome, entityHome, seq] = key.split("\u0000") as [
      string,
      string,
      string,
    ];
    enqueue({ eventHome, entityHome, seq }, "fact", "body-rewrite");
  }

  const updateEventHash = database.prepare(
    "UPDATE work_events SET content_sha256 = ? WHERE event_home = ? AND entity_home = ? AND seq = ?",
  );
  const updateDispositionCommandSha = database.prepare(
    "UPDATE work_dispositions SET command_sha256 = ? WHERE command_event_home = ? AND command_entity_home = ? AND command_seq = ?",
  );
  const updateDispositionFactSha = database.prepare(
    "UPDATE work_dispositions SET fact_sha256 = ? WHERE fact_event_home = ? AND fact_entity_home = ? AND fact_seq = ?",
  );
  const updateFactBasisCommandSha = database.prepare(
    "UPDATE work_facts SET basis_command_sha256 = ? WHERE basis_command_event_home = ? AND basis_command_entity_home = ? AND basis_command_seq = ?",
  );
  const referentFacts = database.prepare(
    `SELECT event_home, entity_home, seq, basis_command_sha256 FROM work_facts
     WHERE basis_command_event_home = ? AND basis_command_entity_home = ? AND basis_command_seq = ?`,
  );
  const referentDispositionsByCommand = database.prepare(
    `SELECT event_home, entity_home, seq FROM work_dispositions
     WHERE command_event_home = ? AND command_entity_home = ? AND command_seq = ?`,
  );
  const referentDispositionsByFact = database.prepare(
    `SELECT event_home, entity_home, seq FROM work_dispositions
     WHERE fact_event_home = ? AND fact_entity_home = ? AND fact_seq = ?`,
  );

  while (pending.length > 0) {
    const next = pending.shift()!;
    const row = loadRecordRow(database, next.route, next.recordType);
    if (row === undefined) {
      throw new Error(
        `tasks-schema21 correction: ${next.recordType} record at ${next.via} (${routeKey(next.route)}) is missing`,
      );
    }
    const computed = sha256(canonicalJson(recordSemanticOf(row)));
    if (computed === row.content_sha256) continue;
    updateEventHash.run(
      computed,
      row.event_home,
      row.entity_home,
      row.seq,
    );
    if (next.recordType === "command") {
      for (const fact of referentFacts.all(
        row.event_home,
        row.entity_home,
        row.seq,
      ) as unknown as ReadonlyArray<{
        readonly event_home: string;
        readonly entity_home: string;
        readonly seq: string;
        readonly basis_command_sha256: string | null;
      }>) {
        if (fact.basis_command_sha256 === computed) continue;
        updateFactBasisCommandSha.run(
          computed,
          row.event_home,
          row.entity_home,
          row.seq,
        );
        enqueue(
          {
            eventHome: fact.event_home,
            entityHome: fact.entity_home,
            seq: fact.seq,
          },
          "fact",
          "command-basis-sha",
        );
      }
      for (const disposition of referentDispositionsByCommand.all(
        row.event_home,
        row.entity_home,
        row.seq,
      ) as unknown as ReadonlyArray<{
        readonly event_home: string;
        readonly entity_home: string;
        readonly seq: string;
      }>) {
        updateDispositionCommandSha.run(
          computed,
          row.event_home,
          row.entity_home,
          row.seq,
        );
        enqueue(
          {
            eventHome: disposition.event_home,
            entityHome: disposition.entity_home,
            seq: disposition.seq,
          },
          "disposition",
          "command-sha",
        );
      }
    } else if (next.recordType === "fact") {
      for (const disposition of referentDispositionsByFact.all(
        row.event_home,
        row.entity_home,
        row.seq,
      ) as unknown as ReadonlyArray<{
        readonly event_home: string;
        readonly entity_home: string;
        readonly seq: string;
      }>) {
        updateDispositionFactSha.run(
          computed,
          row.event_home,
          row.entity_home,
          row.seq,
        );
        enqueue(
          {
            eventHome: disposition.event_home,
            entityHome: disposition.entity_home,
            seq: disposition.seq,
          },
          "disposition",
          "fact-sha",
        );
      }
    }
  }
};

// ---------------------------------------------------------------------------
// Canvas reconstruction (rewritten ether -> revision identity -> portfolio head)
// ---------------------------------------------------------------------------

const canvasWriter = (
  database: StateSchemaMigrationDatabase,
): CanvasSqlWriter => ({
  get: (sql, bindings) =>
    database.prepare(sql).get(...((bindings ?? []) as never[])) as never,
  all: (sql, bindings) =>
    database.prepare(sql).all(...((bindings ?? []) as never[])) as never,
  run: (sql, bindings) =>
    database.prepare(sql).run(...((bindings ?? []) as never[])) as never,
});

/**
 * Rewrite authorial canvas ether, then rebuild every changed canvas's
 * relational rows and revision hash, advance the portfolio generation once,
 * and recompute the intent hash over the corrected documents.
 */
const correctCanvasAuthority = (
  database: StateSchemaMigrationDatabase,
): void => {
  const writer = canvasWriter(database);
  const changedCanvases: Array<{
    readonly canvas_id: string;
    readonly canvas_name: string;
  }> = [];
  const updateEther = database.prepare(
    "UPDATE canvas_nodes SET ether_json = ?, updated_at = ? WHERE canvas_id = ? AND node_id = ?",
  );
  const now = new Date().toISOString();
  const canvases = rowsOf(
    database,
    `SELECT canvas_id, canvas_name FROM canvas_documents ORDER BY canvas_name`,
  ) as ReadonlyArray<{
    readonly canvas_id: string;
    readonly canvas_name: string;
  }>;
  for (const canvas of canvases) {
    let canvasChanged = false;
    const nodes = rowsOf(
      database,
      `SELECT node_id, ether_json FROM canvas_nodes WHERE canvas_id = ? ORDER BY z_index, node_id`,
      canvas.canvas_id,
    ) as ReadonlyArray<{
      readonly node_id: string;
      readonly ether_json: string | null;
    }>;
    for (const node of nodes) {
      if (node.ether_json === null) continue;
      const parsed = parseJson(node.ether_json);
      const next = canonicalizeEther(parsed);
      if (!next.changed) continue;
      const body = canonicalJson(next.value);
      if (body === storedCanonical(node.ether_json)) continue;
      updateEther.run(body, now, canvas.canvas_id, node.node_id);
      canvasChanged = true;
    }
    if (!canvasChanged) continue;
    const doc = reconstructCanvasDoc(writer, canvas.canvas_id);
    const revisionSha256 = canvasBodySha256Of(serializeCanvas(doc));
    persistCanvas(writer, {
      canvasName: canvas.canvas_name,
      doc,
      revisionSha256,
      modifiedAt: now,
    });
    changedCanvases.push(canvas);
  }
  if (changedCanvases.length === 0) return;

  const head = rowOf(
    database,
    `SELECT generation, intent_sha256 FROM canvas_portfolio_head WHERE singleton = 1`,
  ) as
    | { readonly generation: string; readonly intent_sha256: string }
    | undefined;
  if (head === undefined) {
    throw new Error(
      "tasks-schema21 correction: canvas changed but portfolio head is missing",
    );
  }
  const revisions = new Map<string, { readonly revisionSha256: string }>();
  for (const document of rowsOf(
    database,
    `SELECT canvas_name, revision_sha256 FROM canvas_documents ORDER BY canvas_name`,
  ) as ReadonlyArray<{
    readonly canvas_name: string;
    readonly revision_sha256: string;
  }>) {
    revisions.set(document.canvas_name, {
      revisionSha256: document.revision_sha256,
    });
  }
  writePortfolioHead(writer, {
    generation: (BigInt(head.generation) + 1n).toString(),
    intentSha256: intentSha256Of(revisions),
    at: now,
  });
};

// ---------------------------------------------------------------------------
// Proposal materialization
// ---------------------------------------------------------------------------

type ProposalRow = JsonRow & {
  readonly canvas_name: string;
  readonly node_id: string;
  readonly proposal_id: string;
  readonly entity_home: string;
  readonly fact_event_home: string;
  readonly fact_entity_home: string;
  readonly fact_seq: string;
  readonly state: "pending" | "approved" | "rejected";
  readonly brief_json: string;
  readonly proposer_seat_id: string;
  readonly proposer_canvas_name: string;
  readonly proposer_node_id: string;
  readonly approved_task_id: string | null;
  readonly metadata_json: string | null;
  readonly reason: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly origin_at: string;
  readonly received_at: string;
};

const allocateSequence = (
  database: StateSchemaMigrationDatabase,
  eventHome: string,
  entityHome: string,
): string => {
  const current = rowOf(
    database,
    `SELECT last_seq FROM work_event_sequences WHERE event_home = ? AND entity_home = ?`,
    eventHome,
    entityHome,
  ) as { readonly last_seq: string } | undefined;
  const next = (current === undefined ? 1n : BigInt(current.last_seq) + 1n)
    .toString();
  run(
    database,
    `INSERT INTO work_event_sequences(event_home, entity_home, last_seq)
     VALUES (?, ?, ?)
     ON CONFLICT(event_home, entity_home) DO UPDATE SET last_seq = excluded.last_seq`,
    eventHome,
    entityHome,
    next,
  );
  return next;
};

/** Reuse the correlated proposal record's seq when the slot is free. */
const sequenceForFact = (
  database: StateSchemaMigrationDatabase,
  eventHome: string,
  entityHome: string,
  preferred: string | undefined,
): string => {
  if (preferred !== undefined) {
    const occupied = rowOf(
      database,
      `SELECT 1 AS present FROM work_events WHERE event_home = ? AND entity_home = ? AND seq = ?`,
      eventHome,
      entityHome,
      preferred,
    );
    if (occupied === undefined) return preferred;
  }
  return allocateSequence(database, eventHome, entityHome);
};

const proposalRejectFact = (
  database: StateSchemaMigrationDatabase,
  proposal: ProposalRow,
): {
  readonly event_home: string;
  readonly entity_home: string;
  readonly seq: string;
  readonly origin_at: string;
} | undefined => {
  const row = rowOf(
    database,
    `SELECT event_home, entity_home, seq, origin_at
     FROM work_proposal_events
     WHERE canvas_name = ? AND node_id = ? AND proposal_id = ?
       AND record_type = 'fact' AND operation = 'proposal.reject'
     ORDER BY length(seq) DESC, seq DESC LIMIT 1`,
    proposal.canvas_name,
    proposal.node_id,
    proposal.proposal_id,
  ) as
    | {
        readonly event_home: string;
        readonly entity_home: string;
        readonly seq: string;
        readonly origin_at: string;
      }
    | undefined;
  return row;
};

/** Recover task claims authored on the proposal from its immutable create record. */
const proposalClaims = (
  database: StateSchemaMigrationDatabase,
  proposal: ProposalRow,
): unknown[] | undefined => {
  const record = rowOf(
    database,
    `SELECT record_json FROM work_proposal_events
     WHERE canvas_name = ? AND node_id = ? AND proposal_id = ?
       AND record_type = 'fact' AND operation = 'proposal.create'
     ORDER BY length(seq) DESC, seq DESC LIMIT 1`,
    proposal.canvas_name,
    proposal.node_id,
    proposal.proposal_id,
  ) as { readonly record_json: string } | undefined;
  if (record === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(record.record_json) as unknown;
  } catch {
    throw new Error(
      `tasks-schema21 correction: proposal ${proposal.proposal_id} create record is not valid JSON`,
    );
  }
  if (!isObject(parsed) || !isObject(parsed.body)) return undefined;
  const proposalBody = (parsed as { readonly body: JsonObject }).body.proposal;
  if (!isObject(proposalBody) || !Array.isArray(proposalBody.claims)) {
    return undefined;
  }
  return proposalBody.claims;
};

type MintedFact = {
  readonly eventHome: string;
  readonly entityHome: string;
  readonly seq: string;
  readonly item: {
    readonly kind: "task";
    readonly itemId: string;
    readonly sink: {
      readonly canvasName: string;
      readonly nodeId: string;
    };
  };
  readonly operation: "task.create" | "task.transition";
  readonly predecessor: WorkRouteKey | null;
  readonly body: JsonObject;
  readonly contentSha256: string;
  readonly originAt: string;
  readonly receivedAt: string;
};

const mintTaskFact = (
  database: StateSchemaMigrationDatabase,
  head: { readonly generation: string; readonly intent_sha256: string },
  input: {
    readonly entityHome: string;
    readonly seq: string;
    readonly item: MintedFact["item"];
    readonly operation: MintedFact["operation"];
    readonly predecessor: WorkRouteKey | null;
    readonly body: JsonObject;
    readonly originAt: string;
    readonly receivedAt: string;
  },
): MintedFact => {
  const semantic = {
    protocol: "vellum/work/v2",
    id: {
      route: {
        eventHome: input.entityHome,
        entityHome: input.entityHome,
      },
      seq: input.seq,
    },
    recordType: "fact",
    item: input.item,
    operation: input.operation,
    predecessor:
      input.predecessor === null
        ? null
        : {
            route: {
              eventHome: input.predecessor.eventHome,
              entityHome: input.predecessor.entityHome,
            },
            seq: input.predecessor.seq,
          },
    basis: {
      kind: "authorial-intent",
      generation: head.generation,
      contentSha256: head.intent_sha256,
    },
    body: input.body,
  };
  const fact: MintedFact = {
    eventHome: input.entityHome,
    entityHome: input.entityHome,
    seq: input.seq,
    item: input.item,
    operation: input.operation,
    predecessor: input.predecessor,
    body: input.body,
    contentSha256: sha256(canonicalJson(semantic)),
    originAt: input.originAt,
    receivedAt: input.receivedAt,
  };
  run(
    database,
    `INSERT INTO work_events(
       event_home, entity_home, seq, protocol, record_type, item_kind,
       item_id, item_canvas_name, item_node_id, operation, content_sha256,
       origin_at, received_at
     ) VALUES (?, ?, ?, 'vellum/work/v2', 'fact', 'task', ?, ?, ?, ?, ?, ?, ?)`,
    fact.eventHome,
    fact.entityHome,
    fact.seq,
    fact.item.itemId,
    fact.item.sink.canvasName,
    fact.item.sink.nodeId,
    fact.operation,
    fact.contentSha256,
    fact.originAt,
    fact.receivedAt,
  );
  run(
    database,
    `INSERT INTO work_facts(
       event_home, entity_home, seq, predecessor_event_home,
       predecessor_entity_home, predecessor_seq, basis_kind,
       basis_authorial_generation, basis_authorial_content_sha256,
       basis_projected_generation, basis_projected_content_sha256,
       basis_command_event_home, basis_command_entity_home, basis_command_seq,
       basis_command_sha256, result_json
     ) VALUES (?, ?, ?, ?, ?, ?, 'authorial-intent', ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?)`,
    fact.eventHome,
    fact.entityHome,
    fact.seq,
    fact.predecessor?.eventHome ?? null,
    fact.predecessor?.entityHome ?? null,
    fact.predecessor?.seq ?? null,
    head.generation,
    head.intent_sha256,
    canonicalJson(fact.body),
  );
  return fact;
};

const materializedBrief = (
  brief: unknown,
  taskId: string,
): {
  readonly messageId: string;
  readonly role: string;
  readonly parts: unknown;
  readonly contextId?: string;
  readonly referenceTaskIds?: unknown;
  readonly metadata?: unknown;
} => {
  if (!isObject(brief)) {
    throw new Error(`tasks-schema21 correction: proposal brief is not an object`);
  }
  const out: JsonObject = {};
  for (const [key, nested] of Object.entries(brief)) {
    out[key] = nested;
  }
  out.taskId = taskId;
  if (typeof out.messageId !== "string" || out.messageId.length === 0) {
    throw new Error(`tasks-schema21 correction: proposal brief has no messageId`);
  }
  if (out.role !== "user" && out.role !== "agent") {
    throw new Error(`tasks-schema21 correction: proposal brief role is invalid`);
  }
  if (!Array.isArray(out.parts)) {
    throw new Error(`tasks-schema21 correction: proposal brief parts are invalid`);
  }
  return out as ReturnType<typeof materializedBrief>;
};

const writeMaterializedTaskProjection = (
  database: StateSchemaMigrationDatabase,
  input: {
    readonly sink: { readonly canvasName: string; readonly nodeId: string };
    readonly taskId: string;
    readonly entityHome: string;
    readonly state: "submitted" | "rejected";
    readonly brief: {
      readonly messageId: string;
      readonly role: string;
      readonly parts: unknown;
      readonly contextId?: string;
      readonly referenceTaskIds?: unknown;
      readonly metadata?: unknown;
    };
    readonly dependsOn: ReadonlyArray<string> | undefined;
    readonly finishCriteria: unknown;
    readonly metadataJson: string | null;
    readonly reason: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly createFact: MintedFact;
    readonly latestFact: MintedFact;
    readonly receivedAt: string;
  },
): void => {
  const { canvasName, nodeId } = input.sink;
  run(
    database,
    `INSERT INTO work_tasks(
       canvas_name, node_id, task_id, entity_home, actor_seat_id,
       fact_event_home, fact_entity_home, fact_seq, state, brief_message_id,
       artifact_ids_json, metadata_json, reason, response, created_at,
       updated_at, origin_at, received_at
     ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?)`,
    canvasName,
    nodeId,
    input.taskId,
    input.entityHome,
    input.latestFact.eventHome,
    input.latestFact.entityHome,
    input.latestFact.seq,
    input.state,
    input.brief.messageId,
    input.metadataJson,
    input.reason,
    input.createdAt,
    input.updatedAt,
    input.createFact.originAt,
    input.receivedAt,
  );
  run(
    database,
    `INSERT INTO work_task_messages(
       canvas_name, node_id, parent_lane, item_id, message_id, position,
       message_kind, entity_home, fact_event_home, fact_entity_home, fact_seq,
       role, parts_json, context_id, reference_task_ids_json, metadata_json,
       origin_at, received_at
     ) VALUES (?, ?, 'task', ?, ?, 0, 'brief', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    canvasName,
    nodeId,
    input.taskId,
    input.brief.messageId,
    input.entityHome,
    input.latestFact.eventHome,
    input.latestFact.entityHome,
    input.latestFact.seq,
    input.brief.role,
    canonicalJson(input.brief.parts),
    input.brief.contextId ?? null,
    input.brief.referenceTaskIds === undefined
      ? null
      : canonicalJson(input.brief.referenceTaskIds),
    input.brief.metadata === undefined
      ? null
      : canonicalJson(input.brief.metadata),
    input.latestFact.originAt,
    input.receivedAt,
  );
  if (input.dependsOn !== undefined) {
    input.dependsOn.forEach((dependsOnTaskId, position) => {
      run(
        database,
        `INSERT INTO work_task_dependencies(
           canvas_name, node_id, task_id, depends_on_task_id, position
         ) VALUES (?, ?, ?, ?, ?)`,
        canvasName,
        nodeId,
        input.taskId,
        dependsOnTaskId,
        position,
      );
    });
  }
  run(
    database,
    `INSERT INTO work_task_finish(
       canvas_name, node_id, task_id, finish_criteria_json,
       completion_evidence_json
     ) VALUES (?, ?, ?, ?, NULL)`,
    canvasName,
    nodeId,
    input.taskId,
    input.finishCriteria === undefined
      ? null
      : canonicalJson(input.finishCriteria),
  );
  const transitions: ReadonlyArray<{
    readonly fact: MintedFact;
    readonly operation: "task.create" | "task.transition";
    readonly fromState: string | null;
    readonly toState: string;
  }> =
    input.state === "rejected"
      ? [
          {
            fact: input.createFact,
            operation: "task.create",
            fromState: null,
            toState: "submitted",
          },
          {
            fact: input.latestFact,
            operation: "task.transition",
            fromState: "submitted",
            toState: "rejected",
          },
        ]
      : [
          {
            fact: input.createFact,
            operation: "task.create",
            fromState: null,
            toState: "submitted",
          },
        ];
  transitions.forEach((transition, ordinal) => {
    run(
      database,
      `INSERT INTO work_task_transitions(
         canvas_name, node_id, item_id, ordinal, lane, entity_home,
         actor_seat_id, fact_event_home, fact_entity_home, fact_seq,
         operation, from_state, to_state, origin_at, received_at
       ) VALUES (?, ?, ?, ?, 'task', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
      canvasName,
      nodeId,
      input.taskId,
      ordinal,
      input.entityHome,
      transition.fact.eventHome,
      transition.fact.entityHome,
      transition.fact.seq,
      transition.operation,
      transition.fromState,
      transition.toState,
      transition.fact.originAt,
      input.receivedAt,
    );
  });
};

/**
 * Materialize every proposal row into canonical task records before the
 * proposal tables are dropped:
 * - pending  -> submitted Task (admission "approval", raisedBy = proposer)
 * - rejected -> rejected Task via create + transition facts
 * - approved -> the correlated approved Task row is preserved, never duplicated
 * IDs are preserved (proposal id == task id). A collision fails closed unless
 * the occupying row is the correlated approved task. Brief, author fields,
 * claims/rules, dependencies, finish criteria, metadata and reason are copied
 * into the normalized task tables; nothing is silently discarded.
 */
const materializeProposals = (
  database: StateSchemaMigrationDatabase,
): void => {
  const proposals = rowsOf(
    database,
    `SELECT
       canvas_name, node_id, proposal_id, entity_home, fact_event_home,
       fact_entity_home, fact_seq, state, brief_json, proposer_seat_id,
       proposer_canvas_name, proposer_node_id, approved_task_id,
       metadata_json, reason, created_at, updated_at, origin_at, received_at
     FROM work_task_proposals
     ORDER BY created_at, proposal_id`,
  ) as ReadonlyArray<ProposalRow>;
  if (proposals.length === 0) return;
  const head = rowOf(
    database,
    `SELECT generation, intent_sha256 FROM canvas_portfolio_head WHERE singleton = 1`,
  ) as
    | { readonly generation: string; readonly intent_sha256: string }
    | undefined;
  if (head === undefined) {
    throw new Error(
      "tasks-schema21 correction: cannot materialize proposals without a portfolio head",
    );
  }
  const existingTask = database.prepare(
    `SELECT task_id, entity_home FROM work_tasks WHERE canvas_name = ? AND node_id = ? AND task_id = ?`,
  );
  const planning = database.prepare(
    `SELECT depends_on_json, finish_criteria_json FROM work_proposal_planning
     WHERE canvas_name = ? AND node_id = ? AND proposal_id = ?`,
  );

  for (const proposal of proposals) {
    if (proposal.state === "approved") {
      const approved = existingTask.get(
        proposal.canvas_name,
        proposal.node_id,
        proposal.approved_task_id,
      ) as { readonly task_id: string } | undefined;
      if (
        proposal.approved_task_id === null ||
        approved === undefined ||
        approved.task_id !== proposal.approved_task_id
      ) {
        throw new Error(
          `tasks-schema21 correction: approved proposal ${proposal.proposal_id} has no correlated approved task row`,
        );
      }
      continue;
    }
    const occupied = existingTask.get(
      proposal.canvas_name,
      proposal.node_id,
      proposal.proposal_id,
    ) as { readonly task_id: string } | undefined;
    if (occupied !== undefined) {
      throw new Error(
        `tasks-schema21 correction: task id collision materializing proposal ${proposal.proposal_id} (task ${occupied.task_id} already exists)`,
      );
    }

    const planned = planning.get(
      proposal.canvas_name,
      proposal.node_id,
      proposal.proposal_id,
    ) as
      | {
          readonly depends_on_json: string | null;
          readonly finish_criteria_json: string | null;
        }
      | undefined;
    const dependsOn =
      planned?.depends_on_json === null
        ? undefined
        : (parseJson(planned?.depends_on_json ?? null) as
            ReadonlyArray<string> | undefined);
    const finishCriteria = parseJson(planned?.finish_criteria_json ?? null);
    const authorMetadata = parseJson(proposal.metadata_json);
    const canonicalMetadata = canonicalizeMetadata(authorMetadata);
    const claims = proposalClaims(database, proposal);
    const rules =
      claims === undefined
        ? undefined
        : claims.map((claim) => canonicalizeRuleLike(claim, true));
    const raisedBy = {
      seatId: proposal.proposer_seat_id,
      canvasName: proposal.proposer_canvas_name,
      nodeId: proposal.proposer_node_id,
    };
    const bag: JsonObject = {
      ...(rules !== undefined && rules.length > 0 ? { rules } : {}),
      admission: "approval",
      raisedBy,
    };
    const metadataJson = canonicalJson({
      ...(isObject(canonicalMetadata) ? canonicalMetadata : {}),
      [TASK_METADATA_BAG_KEY]: bag,
    });
    const brief = materializedBrief(parseJson(proposal.brief_json), proposal.proposal_id);
    const item = {
      kind: "task" as const,
      itemId: proposal.proposal_id,
      sink: {
        canvasName: proposal.canvas_name,
        nodeId: proposal.node_id,
      },
    };
    const createSeq = sequenceForFact(
      database,
      proposal.fact_entity_home,
      proposal.fact_entity_home,
      proposal.fact_seq,
    );
    const submittedTask: JsonObject = {
      id: proposal.proposal_id,
      state: "submitted",
      history: [
        {
          messageId: brief.messageId,
          role: brief.role,
          parts: brief.parts,
          taskId: proposal.proposal_id,
          ...(brief.contextId === undefined
            ? {}
            : { contextId: brief.contextId }),
          ...(brief.referenceTaskIds === undefined
            ? {}
            : { referenceTaskIds: brief.referenceTaskIds }),
          ...(brief.metadata === undefined ? {} : { metadata: brief.metadata }),
        },
      ],
      ...(dependsOn !== undefined && dependsOn.length > 0
        ? { dependsOn }
        : {}),
      ...(finishCriteria !== undefined ? { finishCriteria } : {}),
      ...(rules !== undefined && rules.length > 0 ? { rules } : {}),
      ...(isObject(canonicalMetadata) ? { metadata: canonicalMetadata } : {}),
      ...(proposal.reason === null ? {} : { reason: proposal.reason }),
      admission: "approval",
      raisedBy,
    };
    const createFact = mintTaskFact(database, head, {
      entityHome: proposal.fact_entity_home,
      seq: createSeq,
      item,
      operation: "task.create",
      predecessor: null,
      body: { operation: "task.create", task: submittedTask },
      originAt: proposal.origin_at,
      receivedAt: proposal.received_at,
    });

    if (proposal.state === "pending") {
      writeMaterializedTaskProjection(database, {
        sink: item.sink,
        taskId: proposal.proposal_id,
        entityHome: proposal.fact_entity_home,
        state: "submitted",
        brief,
        dependsOn,
        finishCriteria,
        metadataJson,
        reason: proposal.reason,
        createdAt: proposal.created_at,
        updatedAt: proposal.updated_at,
        createFact,
        latestFact: createFact,
        receivedAt: proposal.received_at,
      });
      continue;
    }

    const rejectFact = proposalRejectFact(database, proposal);
    const transitionSeq = sequenceForFact(
      database,
      proposal.fact_entity_home,
      proposal.fact_entity_home,
      rejectFact?.seq,
    );
    const rejectedTask: JsonObject = { ...submittedTask, state: "rejected" };
    const transitionFact = mintTaskFact(database, head, {
      entityHome: proposal.fact_entity_home,
      seq: transitionSeq,
      item,
      operation: "task.transition",
      predecessor: {
        eventHome: createFact.eventHome,
        entityHome: createFact.entityHome,
        seq: createFact.seq,
      },
      body: {
        operation: "task.transition",
        task: rejectedTask,
      },
      originAt: rejectFact?.origin_at ?? proposal.updated_at,
      receivedAt: proposal.received_at,
    });
    writeMaterializedTaskProjection(database, {
      sink: item.sink,
      taskId: proposal.proposal_id,
      entityHome: proposal.fact_entity_home,
      state: "rejected",
      brief,
      dependsOn,
      finishCriteria,
      metadataJson,
      reason: proposal.reason,
      createdAt: proposal.created_at,
      updatedAt: rejectFact?.origin_at ?? proposal.updated_at,
      createFact,
      latestFact: transitionFact,
      receivedAt: proposal.received_at,
    });
  }
};

// ---------------------------------------------------------------------------
// Immutable trigger surgery (dropped only for the corrective writes, recreated
// byte-exact from the composed head-basis fragment)
// ---------------------------------------------------------------------------

const IMMUTABLE_UPDATE_TRIGGERS = [
  "work_events_immutable_update",
  "work_commands_immutable_update",
  "work_facts_immutable_update",
  "work_dispositions_immutable_update",
] as const;

const sliceTriggerSql = (name: string): string => {
  const start = WORK_STATE_SCHEMA_HEAD_BASIS_SQL.indexOf(
    `CREATE TRIGGER IF NOT EXISTS ${name}`,
  );
  if (start < 0) {
    throw new Error(
      `tasks-schema21 correction: trigger ${name} is missing from the head-basis schema`,
    );
  }
  const end = WORK_STATE_SCHEMA_HEAD_BASIS_SQL.indexOf("END;", start);
  if (end < 0) {
    throw new Error(
      `tasks-schema21 correction: trigger ${name} is not closed in the head-basis schema`,
    );
  }
  return WORK_STATE_SCHEMA_HEAD_BASIS_SQL.slice(start, end + "END;".length);
};

const IMMUTABLE_UPDATE_TRIGGERS_SQL = IMMUTABLE_UPDATE_TRIGGERS.map(
  sliceTriggerSql,
).join("\n");

/** Isolated destructive converter for the rejected schema-21 Tasks shape. */
export const correctInvalidTasksSchema21 = (
  database: StateSchemaMigrationDatabase,
): void => {
  // 1. The corrective writes mutate immutable journal rows. The immutable
  //    UPDATE triggers are dropped here and recreated byte-exact at the end.
  for (const trigger of IMMUTABLE_UPDATE_TRIGGERS) {
    database.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  }

  // 2. Authorial canvas ether (Tasks/region contracts only), then rebuild the
  //    changed relational canvases and the portfolio identity.
  correctCanvasAuthority(database);

  // 3. Normalized task metadata bag + completion evidence.
  rewriteJsonColumn(
    database,
    "work_tasks",
    "metadata_json",
    ["canvas_name", "node_id", "task_id"],
    canonicalizeMetadata,
  );
  rewriteJsonColumn(
    database,
    "work_task_finish",
    "completion_evidence_json",
    ["canvas_name", "node_id", "task_id"],
    canonicalizeEvidence,
  );
  correctGeneratedTaskHistoryRows(database);

  // 4. Task payloads in Work action/result records; repair every affected
  //    content hash and its correlated copies.
  const changedCommands = new Set(
    rewriteJsonColumn(
      database,
      "work_commands",
      "action_json",
      ["event_home", "entity_home", "seq"],
      canonicalizeWorkBody,
    ).map((row) =>
      `${String(row.event_home)}\u0000${String(row.entity_home)}\u0000${String(row.seq)}`,
    ),
  );
  const changedFacts = new Set(
    rewriteJsonColumn(
      database,
      "work_facts",
      "result_json",
      ["event_home", "entity_home", "seq"],
      canonicalizeWorkBody,
    ).map((row) =>
      `${String(row.event_home)}\u0000${String(row.entity_home)}\u0000${String(row.seq)}`,
    ),
  );
  repairWorkRecordHashes(database, changedCommands, changedFacts);

  // 5. Materialize proposals into canonical task records.
  materializeProposals(database);

  // 6. Recreate the immutable UPDATE triggers exactly as the corrected schema
  //    composes them.
  database.exec(IMMUTABLE_UPDATE_TRIGGERS_SQL);

  // 7. Retire proposal storage. DROP TABLE cascades the proposal-table
  //    triggers and the revision triggers attached to those tables.
  database.exec(`
    DROP TABLE IF EXISTS work_proposal_planning;
    DROP TABLE IF EXISTS work_pending_proposal_commands;
    DROP TABLE IF EXISTS work_task_proposals;
    DROP TABLE IF EXISTS work_proposal_events;
  `);
};
