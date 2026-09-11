import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ManagedRuntime, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  CURRENT_STATE_SCHEMA_VERSION,
  CURRENT_STATE_SCHEMA_IDENTITY,
  STATE_SCHEMA_V21_IDENTITY,
  stateSchemaAdvanceRequired,
} from "../src/main/vellum-command/state/migrations";
import {
  STATE_SCHEMA_V21_FRAGMENTS,
  STATE_SCHEMA_V20_SQL,
} from "../src/main/vellum-command/state/schema";
import {
  actualStateSchemaSha256,
  verifyAndStampStateSchema,
} from "../src/main/vellum-command/state/schema-identity";
import { makeStateEngineLive, StateEngine } from "../src/main/vellum-command/state/engine";
import { canonicalJson } from "../src/main/vellum-command/work/canonical-json";
import {
  reconstructCanvasDoc,
  type CanvasPortfolioHeadRow,
} from "../src/main/vellum-command/canvas/records";
import { intentSha256Of } from "../src/main/vellum-command/canvas-intent-identity";
import { serializeCanvas } from "@shared/canvas";
import { WorkRecord } from "@shared/work-protocol";

/**
 * Schema-21 corrective migration integration:
 * - an invalid-21 database (retired Tasks vocabulary + proposal storage) is
 *   exact-identity detected, backed up, corrected atomically through
 *   StateEngine, and ends byte-identical in shape to a fresh corrected-21
 *   database;
 * - the converter is context-aware (only Tasks shapes canonicalize; unrelated
 *   objects using the same key names survive);
 * - proposals materialize into canonical task records (pending -> submitted
 *   with approval admission, rejected -> rejected, approved preserved);
 * - every content hash is repaired under the canonical record hashing
 *   contract, and every active record strict-decodes with the current
 *   WorkRecord schema;
 * - canvas identity advances honestly (revision hashes, one generation bump,
 *   recomputed intent) and no proposal storage or triggers remain;
 * - a collision fails closed: the database is left untouched and the verified
 *   backup taken before the transaction is available;
 * - a pending proposal whose same-id task already carries that proposal's
 *   brief (August boot backfill) is treated as already materialized.
 */

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const INVALID_21_SQL = STATE_SCHEMA_V21_FRAGMENTS.join("\n");

const SEAT = `seat_${"a".repeat(64)}`;
const T0 = "2026-07-01T00:00:00.000Z";
const T1 = "2026-07-02T00:00:00.000Z";
const T2 = "2026-07-03T00:00:00.000Z";
const T3 = "2026-07-04T00:00:00.000Z";

const PROPOSER = {
  seatId: SEAT,
  canvasName: "factory",
  nodeId: "board-1",
};

const OLD_BRIEF = {
  messageId: "msg-approved-1",
  role: "user",
  parts: [{ kind: "text", text: "approve me" }],
  taskId: "task-approved-1",
};

const OLD_SEND_ON_MARKER = {
  messageId: "msg-approved-2",
  role: "agent",
  parts: [
    {
      kind: "text",
      text: 'forwarded from "board-1" — ready for review',
    },
  ],
  taskId: "task-approved-1",
};

const OLD_USER_PROSE = {
  messageId: "msg-approved-3",
  role: "user",
  parts: [{ kind: "text", text: 'forwarded from "a story" is quoted prose' }],
  taskId: "task-approved-1",
};

const OLD_AGENT_PROSE = {
  messageId: "msg-approved-4",
  role: "agent",
  parts: [{ kind: "text", text: 'forwarded from "a story" is quoted prose' }],
  taskId: "task-approved-1",
};

const OLD_JOURNEY = [
  {
    nodeId: "board-1",
    enteredAt: T0,
    epoch: 1,
    claimedBy: SEAT,
    exitedAt: T1,
    exit: "forwarded",
    next: "board-2",
    emissionNote: "onward",
  },
];

const OLD_BOARDING = [
  {
    checkId: "ck1",
    side: "inbound",
    label: "incoming check",
    command: "true",
    exitCode: 0,
    outputTail: "ok",
    at: T1,
    epoch: 1,
  },
];

const OLD_CLAIMS = [
  { id: "c1", text: "claim one", severity: "hard", station: "board-1" },
];

const OLD_BAG = {
  claims: OLD_CLAIMS,
  epoch: 2,
  journey: OLD_JOURNEY,
  holdUntil: T0,
  boarding: OLD_BOARDING,
  admission: "operator-gated",
  raisedBy: PROPOSER,
};

const OLD_EVIDENCE = {
  artifacts: [{ artifactId: "art-1", nodeId: "artifacts" }],
  git: { commits: ["abc123"] },
  responses: [{ claimId: "c1", response: "done it", refs: ["ref-1"] }],
  claimWaivers: [{ claimId: "c2", reason: "waived" }],
};

const OLD_METADATA = {
  priority: "high",
  instruction: "keep me",
  claims: [{ id: "m1", text: "keep" }],
  station: "keep",
  "vellum.pipeline": OLD_BAG,
  "vellum.pipeline.admittedEpoch": 2,
};

const OLD_COMPLETED_TASK = {
  id: "task-approved-1",
  state: "completed",
  claimedBy: SEAT,
  history: [OLD_BRIEF, OLD_SEND_ON_MARKER, OLD_USER_PROSE, OLD_AGENT_PROSE],
  epoch: 2,
  journey: OLD_JOURNEY,
  defects: [{ epoch: 1, target: "board-1", at: T1 }],
  holdUntil: T0,
  boarding: OLD_BOARDING,
  completionEvidence: OLD_EVIDENCE,
  metadata: OLD_METADATA,
  reason: "operator approved",
  admission: "operator-gated",
  raisedBy: PROPOSER,
};

const OLD_SUBMITTED_TASK = {
  id: "task-approved-1",
  state: "submitted",
  history: [OLD_BRIEF],
  metadata: { priority: "high" },
  claims: OLD_CLAIMS,
  admission: "operator-gated",
  raisedBy: PROPOSER,
};

/** Old-shape record semantic (hashes in the fixture are computed from these). */
const oldSemantic = (
  input: {
    readonly eventHome: string;
    readonly entityHome: string;
    readonly seq: string;
    readonly recordType: "command" | "fact" | "disposition";
    readonly itemKind: string;
    readonly itemId: string;
    readonly operation: string;
    readonly predecessor?: unknown;
    readonly basis?: unknown;
    readonly body: unknown;
  },
): unknown => ({
  protocol: "vellum/work/v2",
  id: {
    route: { eventHome: input.eventHome, entityHome: input.entityHome },
    seq: input.seq,
  },
  recordType: input.recordType,
  item: {
    kind: input.itemKind,
    itemId: input.itemId,
    sink: { canvasName: "factory", nodeId: "board-1" },
  },
  operation: input.operation,
  ...(input.predecessor !== undefined ? { predecessor: input.predecessor } : {}),
  ...(input.basis !== undefined ? { basis: input.basis } : {}),
  body: input.body,
});

const oldHash = (semantic: unknown): string => sha256(canonicalJson(semantic));

const recordId = (
  eventHome: string,
  entityHome: string,
  seq: string,
): unknown => ({ route: { eventHome, entityHome }, seq });

const install = (database: DatabaseSync, installationId: string): void => {
  database
    .prepare(
      `INSERT INTO station_known_installations(installation_id, registered_at)
       VALUES (?, ?)`,
    )
    .run(installationId, T0);
};

const route = (
  database: DatabaseSync,
  eventHome: string,
  entityHome: string,
  lastSeq: string,
): void => {
  database
    .prepare(
      `INSERT INTO work_event_sequences(event_home, entity_home, last_seq)
       VALUES (?, ?, ?)`,
    )
    .run(eventHome, entityHome, lastSeq);
};

type EventSeed = {
  readonly eventHome: string;
  readonly entityHome: string;
  readonly seq: string;
  readonly recordType: "command" | "fact" | "disposition";
  readonly itemKind: string;
  readonly itemId: string;
  readonly operation: string;
  readonly contentSha256: string;
  readonly originAt: string;
  readonly receivedAt: string;
};

const insertEvent = (database: DatabaseSync, event: EventSeed): void => {
  database
    .prepare(
      `INSERT INTO work_events(
         event_home, entity_home, seq, protocol, record_type, item_kind,
         item_id, item_canvas_name, item_node_id, operation, content_sha256,
         origin_at, received_at
       ) VALUES (?, ?, ?, 'vellum/work/v2', ?, ?, ?, 'factory', 'board-1', ?, ?, ?, ?)`,
    )
    .run(
      event.eventHome,
      event.entityHome,
      event.seq,
      event.recordType,
      event.itemKind,
      event.itemId,
      event.operation,
      event.contentSha256,
      event.originAt,
      event.receivedAt,
    );
};

const insertCommand = (
  database: DatabaseSync,
  input: {
    readonly eventHome: string;
    readonly entityHome: string;
    readonly seq: string;
    readonly predecessor: unknown;
    readonly body: unknown;
    readonly originAt: string;
  },
): EventSeed => {
  const semantic = oldSemantic({
    eventHome: input.eventHome,
    entityHome: input.entityHome,
    seq: input.seq,
    recordType: "command",
    itemKind: "task",
    itemId: "task-approved-1",
    operation: "task.transition",
    predecessor: input.predecessor,
    body: input.body,
  });
  const seed: EventSeed = {
    eventHome: input.eventHome,
    entityHome: input.entityHome,
    seq: input.seq,
    recordType: "command",
    itemKind: "task",
    itemId: "task-approved-1",
    operation: "task.transition",
    contentSha256: oldHash(semantic),
    originAt: input.originAt,
    receivedAt: input.originAt,
  };
  insertEvent(database, seed);
  const predecessor = input.predecessor as {
    readonly route: { readonly eventHome: string; readonly entityHome: string };
    readonly seq: string;
  } | null;
  database
    .prepare(
      `INSERT INTO work_commands(
         event_home, entity_home, seq, predecessor_event_home,
         predecessor_entity_home, predecessor_seq, action_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.eventHome,
      input.entityHome,
      input.seq,
      predecessor?.route.eventHome ?? null,
      predecessor?.route.entityHome ?? null,
      predecessor?.seq ?? null,
      canonicalJson(input.body),
    );
  return seed;
};

const insertFact = (
  database: DatabaseSync,
  input: {
    readonly eventHome: string;
    readonly entityHome: string;
    readonly seq: string;
    readonly operation: string;
    readonly predecessor: unknown;
    readonly basis: unknown;
    readonly body: unknown;
    readonly originAt: string;
    readonly itemKind?: string;
    readonly itemId?: string;
  },
): EventSeed => {
  const semantic = oldSemantic({
    eventHome: input.eventHome,
    entityHome: input.entityHome,
    seq: input.seq,
    recordType: "fact",
    itemKind: input.itemKind ?? "task",
    itemId: input.itemId ?? "task-approved-1",
    operation: input.operation,
    predecessor: input.predecessor,
    basis: input.basis,
    body: input.body,
  });
  const seed: EventSeed = {
    eventHome: input.eventHome,
    entityHome: input.entityHome,
    seq: input.seq,
    recordType: "fact",
    itemKind: input.itemKind ?? "task",
    itemId: input.itemId ?? "task-approved-1",
    operation: input.operation,
    contentSha256: oldHash(semantic),
    originAt: input.originAt,
    receivedAt: input.originAt,
  };
  insertEvent(database, seed);
  const predecessor = input.predecessor as {
    readonly route: { readonly eventHome: string; readonly entityHome: string };
    readonly seq: string;
  } | null;
  const basis = input.basis as { readonly kind: string };
  const commandBasis = basis.kind === "command"
    ? (input.basis as {
        readonly command: {
          readonly route: { readonly eventHome: string; readonly entityHome: string };
          readonly seq: string;
        };
        readonly commandSha256: string;
      })
    : undefined;
  database
    .prepare(
      `INSERT INTO work_facts(
         event_home, entity_home, seq, predecessor_event_home,
         predecessor_entity_home, predecessor_seq, basis_kind,
         basis_authorial_generation, basis_authorial_content_sha256,
         basis_projected_generation, basis_projected_content_sha256,
         basis_command_event_home, basis_command_entity_home, basis_command_seq,
         basis_command_sha256, result_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.eventHome,
      input.entityHome,
      input.seq,
      predecessor?.route.eventHome ?? null,
      predecessor?.route.entityHome ?? null,
      predecessor?.seq ?? null,
      basis.kind,
      basis.kind === "authorial-intent"
        ? (input.basis as { readonly generation: string }).generation
        : null,
      basis.kind === "authorial-intent"
        ? (input.basis as { readonly contentSha256: string }).contentSha256
        : null,
      basis.kind === "projected-intent"
        ? (input.basis as { readonly generation: string }).generation
        : null,
      basis.kind === "projected-intent"
        ? (input.basis as { readonly contentSha256: string }).contentSha256
        : null,
      commandBasis?.command.route.eventHome ?? null,
      commandBasis?.command.route.entityHome ?? null,
      commandBasis?.command.seq ?? null,
      commandBasis?.commandSha256 ?? null,
      canonicalJson(input.body),
    );
  return seed;
};

const insertDisposition = (
  database: DatabaseSync,
  input: {
    readonly eventHome: string;
    readonly entityHome: string;
    readonly seq: string;
    readonly command: unknown;
    readonly commandSha256: string;
    readonly fact?: unknown;
    readonly factSha256?: string;
    readonly originAt: string;
  },
): EventSeed => {
  const body = input.fact === undefined
    ? {
        status: "rejected",
        command: input.command,
        commandSha256: input.commandSha256,
        reason: "invalid-transition",
        message: "no",
      }
    : {
        status: "applied",
        command: input.command,
        commandSha256: input.commandSha256,
        fact: input.fact,
        factSha256: input.factSha256,
      };
  const seed: EventSeed = {
    eventHome: input.eventHome,
    entityHome: input.entityHome,
    seq: input.seq,
    recordType: "disposition",
    itemKind: "task",
    itemId: "task-approved-1",
    operation: "task.transition",
    contentSha256: oldHash(
      oldSemantic({
        eventHome: input.eventHome,
        entityHome: input.entityHome,
        seq: input.seq,
        recordType: "disposition",
        itemKind: "task",
        itemId: "task-approved-1",
        operation: "task.transition",
        body,
      }),
    ),
    originAt: input.originAt,
    receivedAt: input.originAt,
  };
  insertEvent(database, seed);
  const command = input.command as {
    readonly route: { readonly eventHome: string; readonly entityHome: string };
    readonly seq: string;
  };
  const fact = input.fact as
    | {
        readonly route: { readonly eventHome: string; readonly entityHome: string };
        readonly seq: string;
      }
    | undefined;
  database
    .prepare(
      `INSERT INTO work_dispositions(
         event_home, entity_home, seq, status, command_event_home,
         command_entity_home, command_seq, command_sha256, fact_event_home,
         fact_entity_home, fact_seq, fact_sha256, rejection_reason,
         rejection_message
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.eventHome,
      input.entityHome,
      input.seq,
      input.fact === undefined ? "rejected" : "applied",
      command.route.eventHome,
      command.route.entityHome,
      command.seq,
      input.commandSha256,
      fact?.route.eventHome ?? null,
      fact?.route.entityHome ?? null,
      fact?.seq ?? null,
      input.factSha256 ?? null,
      input.fact === undefined ? "invalid-transition" : null,
      input.fact === undefined ? "no" : null,
    );
  return seed;
};

const insertProposalEvent = (
  database: DatabaseSync,
  input: {
    readonly seq: string;
    readonly recordType: "command" | "fact" | "disposition";
    readonly proposalId: string;
    readonly operation: "proposal.create" | "proposal.approve" | "proposal.reject";
    readonly recordJson: unknown;
    readonly originAt: string;
  },
): void => {
  const semantic = oldSemantic({
    eventHome: "cc-installation",
    entityHome: "cc-installation",
    seq: input.seq,
    recordType: input.recordType,
    itemKind: "proposal",
    itemId: input.proposalId,
    operation: input.operation,
    body: input.recordJson,
  });
  database
    .prepare(
      `INSERT INTO work_proposal_events(
         event_home, entity_home, seq, record_type, canvas_name, node_id,
         proposal_id, operation, content_sha256, record_json, origin_at,
         received_at
       ) VALUES ('cc-installation', 'cc-installation', ?, ?, 'factory', 'board-1', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.seq,
      input.recordType,
      input.proposalId,
      input.operation,
      oldHash(semantic),
      canonicalJson(semantic),
      input.originAt,
      input.originAt,
    );
};

const proposalRecord = (proposal: unknown): unknown => ({
  operation: "proposal.create",
  proposal,
});

const pendingProposal = {
  id: "prop-pending-1",
  state: "pending",
  brief: {
    messageId: "msg-pending-1",
    role: "user",
    parts: [{ kind: "text", text: "build the thing" }],
    metadata: {
      instruction: "keep",
      claims: [{ id: "x", text: "keep" }],
      station: "keep",
    },
  },
  proposedBy: PROPOSER,
  claims: [
    { id: "pc1", text: "proposal claim", severity: "hard", station: "board-1" },
  ],
  metadata: { source: "board", instruction: "keep too" },
  reason: "pending because",
};

const rejectedProposal = {
  id: "prop-rejected-1",
  state: "rejected",
  brief: {
    messageId: "msg-rejected-1",
    role: "user",
    parts: [{ kind: "text", text: "do not build" }],
  },
  proposedBy: PROPOSER,
  reason: "not needed",
};

const approvedProposal = {
  id: "prop-approved-1",
  state: "approved",
  brief: {
    messageId: "msg-approved-1",
    role: "user",
    parts: [{ kind: "text", text: "approve me" }],
  },
  proposedBy: PROPOSER,
  approvedTaskId: "task-approved-1",
};

const seedProposalRow = (
  database: DatabaseSync,
  input: {
    readonly proposalId: string;
    readonly state: "pending" | "approved" | "rejected";
    readonly factSeq: string;
    readonly approvedTaskId?: string;
    readonly metadata?: unknown;
    readonly reason?: string;
    readonly brief: unknown;
    readonly originAt: string;
  },
): void => {
  database
    .prepare(
      `INSERT INTO work_task_proposals(
         canvas_name, node_id, proposal_id, entity_home, fact_event_home,
         fact_entity_home, fact_seq, state, brief_json, proposer_seat_id,
         proposer_canvas_name, proposer_node_id, approved_task_id,
         metadata_json, reason, created_at, updated_at, origin_at, received_at
       ) VALUES ('factory', 'board-1', ?, 'cc-installation', 'cc-installation',
         'cc-installation', ?, ?, ?, ?, 'factory', 'board-1', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.proposalId,
      input.factSeq,
      input.state,
      canonicalJson(input.brief),
      SEAT,
      input.approvedTaskId ?? null,
      input.metadata === undefined ? null : canonicalJson(input.metadata),
      input.reason ?? null,
      input.originAt,
      input.originAt,
      input.originAt,
      input.originAt,
    );
};

const seedPlanning = (
  database: DatabaseSync,
  proposalId: string,
  dependsOn: ReadonlyArray<string> | undefined,
  finishCriteria: unknown,
): void => {
  database
    .prepare(
      `INSERT INTO work_proposal_planning(
         canvas_name, node_id, proposal_id, depends_on_json,
         finish_criteria_json
       ) VALUES ('factory', 'board-1', ?, ?, ?)`,
    )
    .run(
      proposalId,
      dependsOn === undefined ? null : canonicalJson(dependsOn),
      finishCriteria === undefined ? null : canonicalJson(finishCriteria),
    );
};

const seedPendingProposalCommand = (
  database: DatabaseSync,
  proposalId: string,
  seq: string,
  resolved?: {
    readonly status: "applied" | "rejected";
    readonly seq: string;
  },
): void => {
  database
    .prepare(
      `INSERT INTO work_pending_proposal_commands(
         event_home, entity_home, seq, canvas_name, node_id, proposal_id,
         operation, resolution_status, resolution_event_home,
         resolution_entity_home, resolution_seq, created_at, resolved_at
       ) VALUES ('cc-installation', 'cc-installation', ?, 'factory', 'board-1',
         ?, 'proposal.create', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      seq,
      proposalId,
      resolved?.status ?? null,
      resolved === undefined ? null : "cc-installation",
      resolved === undefined ? null : "cc-installation",
      resolved?.seq ?? null,
      T2,
      resolved === undefined ? null : T2,
    );
};

const seedCanvas = (database: DatabaseSync): void => {
  database
    .prepare(
      `INSERT INTO canvas_portfolio_head(
         singleton, generation, intent_sha256, created_at, updated_at
       ) VALUES (1, '7', ?, ?, ?)`,
    )
    .run("a".repeat(64), T0, T1);
  const oldDoc = {
    nodes: [
      {
        id: "board-1",
        type: "text",
        x: 0,
        y: 0,
        width: 220,
        height: 84,
        text: "Boarding",
        ether: {
          entity: { kind: "task" },
          tasks: {
            items: [],
            stationName: "Boarding",
            contract: {
              instruction: "standing purpose",
              claims: [{ id: "cc1", text: "contract claim", severity: "hard" }],
              inbound: {
                instruction: "triage",
                description: "arrivals",
                admission: "operator-gated",
                claimableAfterMs: 1000,
                checklist: [{ id: "ck1", label: "arrival check", command: "true" }],
              },
              outbound: {
                emission: "handoff",
                description: "departures",
                checklist: [{ id: "ck2", label: "departure check", command: "ls" }],
              },
            },
          },
        },
      },
      {
        id: "region-1",
        type: "group",
        x: 0,
        y: 200,
        width: 400,
        height: 200,
        label: "Region",
        ether: {
          region: {
            contract: {
              claims: [{ id: "rc1", text: "region rule", severity: "soft" }],
            },
          },
        },
      },
      {
        id: "plain",
        type: "text",
        x: 0,
        y: 500,
        width: 220,
        height: 84,
        text: "plain",
        ether: { entity: { kind: "agent", name: "local:seat" } },
      },
    ],
    edges: [],
  };
  database
    .prepare(
      `INSERT INTO canvas_documents(
         canvas_id, canvas_name, revision_sha256, created_at, modified_at
       ) VALUES ('cnv_factory', 'factory', ?, ?, ?)`,
    )
    .run(sha256(serializeCanvas(oldDoc as never)), T0, T1);
  const nodes = [
    {
      node_id: "board-1",
      z_index: 0,
      type: "text",
      x: 0,
      y: 0,
      width: 220,
      height: 84,
      color: null,
      text_content: "Boarding",
      file_path: null,
      file_subpath: null,
      link_url: null,
      group_label: null,
      group_background: null,
      group_background_style: null,
      ether_json: canonicalJson(
        (oldDoc.nodes[0] as { readonly ether: unknown }).ether,
      ),
    },
    {
      node_id: "region-1",
      z_index: 1,
      type: "group",
      x: 0,
      y: 200,
      width: 400,
      height: 200,
      color: null,
      text_content: null,
      file_path: null,
      file_subpath: null,
      link_url: null,
      group_label: "Region",
      group_background: null,
      group_background_style: null,
      ether_json: canonicalJson(
        (oldDoc.nodes[1] as { readonly ether: unknown }).ether,
      ),
    },
    {
      node_id: "plain",
      z_index: 2,
      type: "text",
      x: 0,
      y: 500,
      width: 220,
      height: 84,
      color: null,
      text_content: "plain",
      file_path: null,
      file_subpath: null,
      link_url: null,
      group_label: null,
      group_background: null,
      group_background_style: null,
      ether_json: canonicalJson(
        (oldDoc.nodes[2] as { readonly ether: unknown }).ether,
      ),
    },
  ];
  for (const node of nodes) {
    database
      .prepare(
        `INSERT INTO canvas_nodes(
           canvas_id, node_id, z_index, type, x, y, width, height, color,
           text_content, file_path, file_subpath, link_url, group_label,
           group_background, group_background_style, ether_json, updated_at
         ) VALUES ('cnv_factory', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        node.node_id,
        node.z_index,
        node.type,
        node.x,
        node.y,
        node.width,
        node.height,
        node.color,
        node.text_content,
        node.file_path,
        node.file_subpath,
        node.link_url,
        node.group_label,
        node.group_background,
        node.group_background_style,
        node.ether_json,
        T1,
      );
  }
};

const seedWorkRows = (database: DatabaseSync): void => {
  // task.create fact (local) for the approved task.
  insertFact(database, {
    eventHome: "cc-installation",
    entityHome: "cc-installation",
    seq: "1",
    operation: "task.create",
    predecessor: null,
    basis: {
      kind: "authorial-intent",
      generation: "7",
      contentSha256: "a".repeat(64),
    },
    body: { operation: "task.create", task: OLD_SUBMITTED_TASK },
    originAt: T0,
  });
  // Remote-applied task.transition -> completed with old evidence.
  const command = insertCommand(database, {
    eventHome: "remote-a",
    entityHome: "cc-installation",
    seq: "1",
    predecessor: recordId("cc-installation", "cc-installation", "1"),
    body: {
      operation: "task.transition",
      taskId: "task-approved-1",
      state: "completed",
      message: {
        messageId: "msg-approve-2",
        role: "agent",
        parts: [{ kind: "text", text: "done" }],
      },
      completionEvidence: OLD_EVIDENCE,
    },
    originAt: T1,
  });
  const transitionFact = insertFact(database, {
    eventHome: "cc-installation",
    entityHome: "cc-installation",
    seq: "2",
    operation: "task.transition",
    predecessor: recordId("cc-installation", "cc-installation", "1"),
    basis: {
      kind: "command",
      command: recordId("remote-a", "cc-installation", "1"),
      commandSha256: command.contentSha256,
    },
    body: { operation: "task.transition", task: OLD_COMPLETED_TASK },
    originAt: T1,
  });
  insertDisposition(database, {
    eventHome: "cc-installation",
    entityHome: "cc-installation",
    seq: "3",
    command: recordId("remote-a", "cc-installation", "1"),
    commandSha256: command.contentSha256,
    fact: recordId("cc-installation", "cc-installation", "2"),
    factSha256: transitionFact.contentSha256,
    originAt: T1,
  });
  database
    .prepare(
      `INSERT INTO work_tasks(
         canvas_name, node_id, task_id, entity_home, actor_seat_id,
         fact_event_home, fact_entity_home, fact_seq, state, brief_message_id,
         artifact_ids_json, metadata_json, reason, response, created_at,
         updated_at, origin_at, received_at
       ) VALUES ('factory', 'board-1', 'task-approved-1', 'cc-installation', ?,
         'cc-installation', 'cc-installation', '2', 'completed',
         'msg-approved-1', NULL, ?, 'operator approved', NULL, ?, ?, ?, ?)`,
    )
    .run(SEAT, canonicalJson(OLD_METADATA), T0, T1, T0, T1);
  database
    .prepare(
      `INSERT INTO work_task_finish(
         canvas_name, node_id, task_id, finish_criteria_json,
         completion_evidence_json
       ) VALUES ('factory', 'board-1', 'task-approved-1', NULL, ?)`,
    )
    .run(canonicalJson(OLD_EVIDENCE));
  database
    .prepare(
      `INSERT INTO work_task_messages(
         canvas_name, node_id, parent_lane, item_id, message_id, position,
         message_kind, entity_home, fact_event_home, fact_entity_home,
         fact_seq, role, parts_json, context_id, reference_task_ids_json,
         metadata_json, origin_at, received_at
       ) VALUES ('factory', 'board-1', 'task', 'task-approved-1',
         'msg-approved-1', 0, 'brief', 'cc-installation', 'cc-installation',
         'cc-installation', '2', 'user', ?, NULL, NULL, ?, ?, ?)`,
    )
    .run(
      canonicalJson(OLD_BRIEF.parts),
      canonicalJson({ instruction: "keep", claims: [{ id: "x", text: "keep" }], station: "keep" }),
      T1,
      T1,
    );
  for (const [position, message] of [
    [1, OLD_SEND_ON_MARKER],
    [2, OLD_USER_PROSE],
    [3, OLD_AGENT_PROSE],
  ] as const) {
    database
      .prepare(
        `INSERT INTO work_task_messages(
           canvas_name, node_id, parent_lane, item_id, message_id, position,
           message_kind, entity_home, fact_event_home, fact_entity_home,
           fact_seq, role, parts_json, context_id, reference_task_ids_json,
           metadata_json, origin_at, received_at
         ) VALUES ('factory', 'board-1', 'task', 'task-approved-1', ?, ?,
           'history', 'cc-installation', 'cc-installation', 'cc-installation',
           '2', ?, ?, NULL, NULL, NULL, ?, ?)`,
      )
      .run(message.messageId, position, message.role, canonicalJson(message.parts), T1, T1);
  }
};

const seedProposalStorage = (database: DatabaseSync): void => {
  // pending: create command at 4, create fact at (cc, cc, 5).
  insertProposalEvent(database, {
    seq: "4",
    recordType: "command",
    proposalId: "prop-pending-1",
    operation: "proposal.create",
    recordJson: proposalRecord(pendingProposal),
    originAt: T2,
  });
  insertProposalEvent(database, {
    seq: "5",
    recordType: "fact",
    proposalId: "prop-pending-1",
    operation: "proposal.create",
    recordJson: proposalRecord(pendingProposal),
    originAt: T2,
  });
  seedProposalRow(database, {
    proposalId: "prop-pending-1",
    state: "pending",
    factSeq: "5",
    brief: pendingProposal.brief,
    metadata: pendingProposal.metadata,
    reason: pendingProposal.reason,
    originAt: T2,
  });
  seedPlanning(
    database,
    "prop-pending-1",
    ["task-approved-1"],
    { description: "done means done" },
  );
  seedPendingProposalCommand(database, "prop-pending-1", "4");

  // rejected: create command 7, create fact 8, reject command 9, reject disposition 10,
  // reject fact 11.
  insertProposalEvent(database, {
    seq: "7",
    recordType: "command",
    proposalId: "prop-rejected-1",
    operation: "proposal.create",
    recordJson: proposalRecord(rejectedProposal),
    originAt: T2,
  });
  insertProposalEvent(database, {
    seq: "8",
    recordType: "fact",
    proposalId: "prop-rejected-1",
    operation: "proposal.create",
    recordJson: proposalRecord(rejectedProposal),
    originAt: T2,
  });
  insertProposalEvent(database, {
    seq: "9",
    recordType: "command",
    proposalId: "prop-rejected-1",
    operation: "proposal.reject",
    recordJson: { operation: "proposal.reject", proposalId: "prop-rejected-1" },
    originAt: T3,
  });
  insertProposalEvent(database, {
    seq: "10",
    recordType: "disposition",
    proposalId: "prop-rejected-1",
    operation: "proposal.reject",
    recordJson: {
      status: "rejected",
      command: recordId("cc-installation", "remote-a", "1"),
      commandSha256: "0".repeat(64),
      reason: "invalid-transition",
      message: "no",
    },
    originAt: T3,
  });
  insertProposalEvent(database, {
    seq: "11",
    recordType: "fact",
    proposalId: "prop-rejected-1",
    operation: "proposal.reject",
    recordJson: {
      operation: "proposal.reject",
      proposal: { ...rejectedProposal, state: "rejected" },
    },
    originAt: T3,
  });
  seedProposalRow(database, {
    proposalId: "prop-rejected-1",
    state: "rejected",
    factSeq: "8",
    brief: rejectedProposal.brief,
    reason: rejectedProposal.reason,
    originAt: T2,
  });
  seedPendingProposalCommand(database, "prop-rejected-1", "7", {
    status: "rejected",
    seq: "10",
  });

  // approved: create command 13, create fact 14, approve command 15, approve disposition 16,
  // approve fact 17. The approved task row already exists.
  insertProposalEvent(database, {
    seq: "13",
    recordType: "command",
    proposalId: "prop-approved-1",
    operation: "proposal.create",
    recordJson: proposalRecord(approvedProposal),
    originAt: T0,
  });
  insertProposalEvent(database, {
    seq: "14",
    recordType: "fact",
    proposalId: "prop-approved-1",
    operation: "proposal.create",
    recordJson: proposalRecord(approvedProposal),
    originAt: T0,
  });
  insertProposalEvent(database, {
    seq: "15",
    recordType: "command",
    proposalId: "prop-approved-1",
    operation: "proposal.approve",
    recordJson: {
      operation: "proposal.approve",
      proposalId: "prop-approved-1",
      task: OLD_SUBMITTED_TASK,
    },
    originAt: T0,
  });
  insertProposalEvent(database, {
    seq: "16",
    recordType: "disposition",
    proposalId: "prop-approved-1",
    operation: "proposal.approve",
    recordJson: {
      status: "applied",
      command: recordId("cc-installation", "remote-a", "2"),
      commandSha256: "0".repeat(64),
      fact: recordId("cc-installation", "cc-installation", "17"),
      factSha256: "0".repeat(64),
    },
    originAt: T0,
  });
  insertProposalEvent(database, {
    seq: "17",
    recordType: "fact",
    proposalId: "prop-approved-1",
    operation: "proposal.approve",
    recordJson: {
      operation: "proposal.approve",
      proposal: { ...approvedProposal, state: "approved" },
    },
    originAt: T0,
  });
  seedProposalRow(database, {
    proposalId: "prop-approved-1",
    state: "approved",
    factSeq: "14",
    approvedTaskId: "task-approved-1",
    brief: approvedProposal.brief,
    originAt: T0,
  });
  seedPendingProposalCommand(database, "prop-approved-1", "13", {
    status: "applied",
    seq: "16",
  });
};

const seedInvalid21Database = (path: string): DatabaseSync => {
  const database = new DatabaseSync(path, {
    open: true,
    enableForeignKeyConstraints: true,
  });
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(INVALID_21_SQL);
  install(database, "cc-installation");
  install(database, "remote-a");
  route(database, "cc-installation", "cc-installation", "17");
  route(database, "remote-a", "cc-installation", "1");
  seedCanvas(database);
  seedWorkRows(database);
  seedProposalStorage(database);
  verifyAndStampStateSchema(database, INVALID_21_SQL);
  database.exec("PRAGMA user_version = 21");
  return database;
};

type EngineHandle = {
  readonly path: string;
  readonly root: string;
  readonly runtime: ReturnType<typeof ManagedRuntime.make<StateEngine, unknown>>;
  readonly dispose: () => Promise<void>;
};

const handles: EngineHandle[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
  while (handles.length > 0) {
    const handle = handles.pop()!;
    await handle.dispose();
  }
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()!;
    await rm(root, { recursive: true, force: true });
  }
});

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "vellum-schema21-"));
  tempRoots.push(root);
  return root;
};

const readBackupFiles = async (root: string): Promise<ReadonlyArray<string>> =>
  readdir(join(root, "backups")).catch(() => []);

describe("schema-21 corrective migration", () => {
  it("detects the invalid-21 identity and requires an advance", async () => {
    const root = await makeRoot();
    const path = join(root, "vellum-command.db");
    const database = seedInvalid21Database(path);
    database.close();
    const probe = new DatabaseSync(path, { readOnly: true });
    try {
      expect(stateSchemaAdvanceRequired(probe)).toBe(true);
      expect(actualStateSchemaSha256(probe)).toBe(
        "3e45c771d981863bb41bfbd9cbcd2881144f0fcc118ce0f7824eb2c99886781f",
      );
    } finally {
      probe.close();
    }
  });

  it("corrects an invalid-21 database through StateEngine atomically", async () => {
    const root = await makeRoot();
    const path = join(root, "vellum-command.db");
    const database = seedInvalid21Database(path);
    database.close();

    const runtime = ManagedRuntime.make(makeStateEngineLive(path));
    const state = await runtime.runPromise(StateEngine);
    handles.push({
      path,
      root,
      runtime,
      dispose: async () => {
        await runtime.dispose();
      },
    });

    expect(state.info.schemaVersion).toBe(CURRENT_STATE_SCHEMA_VERSION);

    const witness = await runtime.runPromise(
      state.read("schema21.verify", (reader) => {
      const identity = reader.get<{ readonly actual_schema_sha256: string }>(
        `SELECT actual_schema_sha256 FROM state_schema_identity WHERE singleton = 1`,
      );
      if (identity === undefined) throw new Error("identity row is missing");
      const userVersion = Number(
        reader.get<{ readonly user_version: number }>("PRAGMA user_version")
          ?.user_version ?? 0,
      );
      const proposalObjects = reader.all<{ readonly type: string; readonly name: string }>(
        `SELECT type, name FROM sqlite_schema
         WHERE (name LIKE 'work_proposal%' OR name LIKE 'work_task_proposals%')
           AND name NOT GLOB 'sqlite_*'`,
      );
      const proposalTriggers = reader.all<{ readonly name: string }>(
        `SELECT name FROM sqlite_schema WHERE type = 'trigger'
         AND (
           name LIKE 'work_canvas_revision_proposal_events%'
           OR name LIKE 'work_canvas_revision_task_proposals%'
           OR name LIKE 'work_canvas_revision_proposal_planning%'
           OR name LIKE 'work_proposal_events_immutable%'
           OR name LIKE 'work_task_proposals_%'
         )`,
      );
      const head = reader.get<CanvasPortfolioHeadRow>(
        `SELECT generation, intent_sha256, created_at, updated_at
         FROM canvas_portfolio_head WHERE singleton = 1`,
      );
      const documents = reader.all<{
        readonly canvas_id: string;
        readonly canvas_name: string;
        readonly revision_sha256: string;
        readonly modified_at: string;
      }>(`SELECT canvas_id, canvas_name, revision_sha256, modified_at
          FROM canvas_documents ORDER BY canvas_name`);
      if (documents.length !== 1) throw new Error("unexpected document count");
      const document = documents[0]!;
      const doc = reconstructCanvasDoc(reader, document.canvas_id);
      const boardNode = doc.nodes.find((node) => node.id === "board-1");
      const regionNode = doc.nodes.find((node) => node.id === "region-1");
      const plainNode = doc.nodes.find((node) => node.id === "plain");
      const tasks = boardNode?.ether?.tasks;
      const region = regionNode?.ether?.region;
      const events = reader.all<{
        readonly event_home: string;
        readonly entity_home: string;
        readonly seq: string;
        readonly record_type: string;
        readonly content_sha256: string;
        readonly protocol: string;
        readonly origin_at: string;
      }>(`SELECT event_home, entity_home, seq, record_type, content_sha256,
                 protocol, origin_at
          FROM work_events ORDER BY length(seq), seq`);
      const dispositions = reader.all<{
        readonly command_event_home: string;
        readonly command_entity_home: string;
        readonly command_seq: string;
        readonly command_sha256: string;
        readonly fact_event_home: string | null;
        readonly fact_entity_home: string | null;
        readonly fact_seq: string | null;
        readonly fact_sha256: string | null;
      }>(`SELECT command_event_home, command_entity_home, command_seq,
                 command_sha256, fact_event_home, fact_entity_home, fact_seq,
                 fact_sha256
          FROM work_dispositions`);
      const commandBasisFacts = reader.all<{
        readonly event_home: string;
        readonly entity_home: string;
        readonly seq: string;
        readonly basis_command_event_home: string;
        readonly basis_command_entity_home: string;
        readonly basis_command_seq: string;
        readonly basis_command_sha256: string;
      }>(`SELECT event_home, entity_home, seq, basis_command_event_home,
                 basis_command_entity_home, basis_command_seq,
                 basis_command_sha256
          FROM work_facts WHERE basis_kind = 'command'`);
      const tasks2 = reader.all<{
        readonly task_id: string;
        readonly state: string;
        readonly metadata_json: string | null;
        readonly reason: string | null;
      }>(`SELECT task_id, state, metadata_json, reason FROM work_tasks
          ORDER BY created_at, task_id`);
      const messages = reader.all<{
        readonly item_id: string;
        readonly message_id: string;
        readonly position: number;
        readonly message_kind: string;
        readonly parts_json: string;
        readonly metadata_json: string | null;
      }>(`SELECT item_id, message_id, position, message_kind, parts_json,
                 metadata_json
          FROM work_task_messages ORDER BY item_id, position`);
      const correctedTransition = reader.get<{ readonly result_json: string }>(
        `SELECT result_json FROM work_facts
         WHERE event_home = 'cc-installation'
           AND entity_home = 'cc-installation' AND seq = '2'`,
      );
      const dependencies = reader.all<{
        readonly task_id: string;
        readonly depends_on_task_id: string;
      }>(`SELECT task_id, depends_on_task_id FROM work_task_dependencies`);
      const finish = reader.all<{
        readonly task_id: string;
        readonly finish_criteria_json: string | null;
        readonly completion_evidence_json: string | null;
      }>(`SELECT task_id, finish_criteria_json, completion_evidence_json
          FROM work_task_finish ORDER BY task_id`);
      const revisions = reader.get<{ readonly revision: number }>(
        `SELECT revision FROM work_canvas_revisions WHERE canvas_name = 'factory'`,
      );
      return {
        identity: identity.actual_schema_sha256,
        userVersion,
        proposalObjects,
        proposalTriggers,
        head,
        document,
        doc,
        tasks: tasks,
        region: region,
        plain: plainNode,
        events,
        dispositions,
        commandBasisFacts,
        tasks2,
        messages,
        correctedTransition,
        dependencies,
        finish,
        revisions,
      };
      }),
    );

    // Exact corrected identity after 21 repair plus 21 → 22, backup retained.
    expect(witness.identity).toBe(CURRENT_STATE_SCHEMA_IDENTITY.actualSchemaSha256);
    expect(witness.userVersion).toBe(CURRENT_STATE_SCHEMA_VERSION);
    const backups = await readBackupFiles(root);
    expect(backups.filter((name) => name.endsWith(".db"))).toHaveLength(1);
    expect(backups.some((name) => name.endsWith(".pending"))).toBe(false);

    // No proposal storage or proposal revision triggers remain.
    expect(witness.proposalObjects).toEqual([]);
    expect(witness.proposalTriggers).toEqual([]);

    // Canvas ether is canonical Tasks vocabulary; unrelated nodes preserved.
    expect(witness.tasks).toMatchObject({
      name: "Boarding",
      items: [],
      contract: {
        instructions: "standing purpose",
        rules: [{ id: "cc1", text: "contract claim" }],
        incoming: {
          handling: "triage",
          description: "arrivals",
          admission: "approval",
          waitMs: 1000,
          checks: [{ id: "ck1", label: "arrival check", command: "true" }],
        },
        outgoing: {
          handoff: "handoff",
          description: "departures",
          checks: [{ id: "ck2", label: "departure check", command: "ls" }],
        },
      },
    });
    expect(witness.region).toMatchObject({
      contract: { rules: [{ id: "rc1", text: "region rule" }] },
    });
    expect(witness.plain?.ether).toEqual({
      entity: { kind: "agent", name: "local:seat" },
    });

    // Canvas revision identity recomputed; generation advanced once; intent
    // recomputed over the corrected documents.
    expect(witness.document.revision_sha256).toBe(
      sha256(serializeCanvas(witness.doc)),
    );
    expect(witness.head?.generation).toBe("8");
    expect(witness.head?.intent_sha256).toBe(
      intentSha256Of(
        new Map([
          [
            "factory",
            { revisionSha256: witness.document.revision_sha256 },
          ],
        ]),
      ),
    );
    expect(witness.head?.created_at).toBe(T0);
    expect(witness.head?.updated_at).not.toBe(T1);

    // Task rows canonicalized: approved task preserved, pending -> submitted
    // with approval admission, rejected -> rejected with the same immutable
    // authoring fields, no duplicate approved.
    const byId = new Map(witness.tasks2.map((task) => [task.task_id, task]));
    expect(byId.size).toBe(3);
    const approved = byId.get("task-approved-1");
    const pending = byId.get("prop-pending-1");
    const rejected = byId.get("prop-rejected-1");
    expect(approved?.state).toBe("completed");
    expect(pending?.state).toBe("submitted");
    expect(rejected?.state).toBe("rejected");
    expect(byId.has("prop-approved-1")).toBe(false);

    const approvedMetadata = JSON.parse(approved!.metadata_json!) as Record<string, unknown>;
    expect(approvedMetadata["priority"]).toBe("high");
    expect(approvedMetadata["instruction"]).toBe("keep me");
    expect(approvedMetadata["claims"]).toEqual([{ id: "m1", text: "keep" }]);
    expect(approvedMetadata["station"]).toBe("keep");
    expect(approvedMetadata["vellum.tasks.approvedEpoch"]).toBe(2);
    expect(approvedMetadata["vellum.tasks"]).toMatchObject({
      rules: [{ id: "c1", text: "claim one", board: "board-1" }],
      epoch: 2,
      visits: [
        {
          board: "board-1",
          enteredAt: T0,
          epoch: 1,
          claimedBy: SEAT,
          exitedAt: T1,
          exit: "sent-on",
          next: "board-2",
          handoffNote: "onward",
        },
      ],
      waitUntil: T0,
      checkResults: [
        {
          checkId: "ck1",
          side: "incoming",
          command: "true",
          exitCode: 0,
          outputTail: "ok",
          at: T1,
          epoch: 1,
        },
      ],
      admission: "approval",
      raisedBy: PROPOSER,
    });
    expect(approvedMetadata["vellum.pipeline.admittedEpoch"]).toBeUndefined();

    const pendingMetadata = JSON.parse(pending!.metadata_json!) as Record<string, unknown>;
    expect(pendingMetadata["source"]).toBe("board");
    expect(pendingMetadata["instruction"]).toBe("keep too");
    expect(pendingMetadata["vellum.tasks"]).toMatchObject({
      rules: [
        { id: "pc1", text: "proposal claim", board: "board-1" },
      ],
      admission: "approval",
      raisedBy: PROPOSER,
    });
    expect(rejected!.reason).toBe("not needed");
    const rejectedMetadata = JSON.parse(rejected!.metadata_json!) as Record<string, unknown>;
    expect(rejectedMetadata["vellum.tasks"]).toMatchObject({
      admission: "approval",
      raisedBy: PROPOSER,
    });

    // Briefs copied to the normalized message table; preservation keys intact.
    const messageById = new Map(witness.messages.map((message) => [message.message_id, message]));
    expect(witness.messages).toHaveLength(6);
    expect(messageById.get("msg-pending-1")?.message_kind).toBe("brief");
    expect(messageById.get("msg-pending-1")?.position).toBe(0);
    expect(JSON.parse(messageById.get("msg-pending-1")!.metadata_json!)).toEqual({
      instruction: "keep",
      claims: [{ id: "x", text: "keep" }],
      station: "keep",
    });
    expect(messageById.get("msg-rejected-1")?.message_kind).toBe("brief");
    expect(messageById.get("msg-approved-1")?.message_kind).toBe("brief");
    expect(JSON.parse(messageById.get("msg-approved-2")!.parts_json)).toEqual([
      { kind: "text", text: 'sent on from "board-1" — ready for review' },
    ]);
    expect(JSON.parse(messageById.get("msg-approved-3")!.parts_json)).toEqual(
      OLD_USER_PROSE.parts,
    );
    expect(JSON.parse(messageById.get("msg-approved-4")!.parts_json)).toEqual(
      OLD_AGENT_PROSE.parts,
    );
    const correctedTask = (
      JSON.parse(witness.correctedTransition!.result_json) as {
        readonly task: { readonly history: ReadonlyArray<typeof OLD_BRIEF> };
      }
    ).task;
    expect(correctedTask.history[1]?.parts).toEqual([
      { kind: "text", text: 'sent on from "board-1" — ready for review' },
    ]);
    expect(correctedTask.history[2]?.parts).toEqual(OLD_USER_PROSE.parts);
    expect(correctedTask.history[3]?.parts).toEqual(OLD_AGENT_PROSE.parts);

    // Dependencies and finish criteria materialized from planning.
    expect(witness.dependencies).toEqual([
      { task_id: "prop-pending-1", depends_on_task_id: "task-approved-1" },
    ]);
    const pendingFinish = witness.finish.find(
      (row) => row.task_id === "prop-pending-1",
    );
    expect(pendingFinish?.finish_criteria_json).toBe(
      JSON.stringify({ description: "done means done" }),
    );

    // Completion evidence canonicalized.
    const approvedFinish = witness.finish.find(
      (row) => row.task_id === "task-approved-1",
    );
    expect(JSON.parse(approvedFinish!.completion_evidence_json!)).toEqual({
      artifacts: [{ artifactId: "art-1", nodeId: "artifacts" }],
      git: { commits: ["abc123"] },
      claims: [{ ruleId: "c1", text: "done it", refs: ["ref-1"] }],
      waivers: [{ ruleId: "c2", reason: "waived" }],
    });

    // Every record hash is exact under the canonical contract and every
    // correlated copy matches.
    const hashByKey = new Map<string, string>();
    for (const event of witness.events) {
      const semantic = recordSemanticFromDatabase(readerFor(path), event);
      const expected = sha256(canonicalJson(semantic));
      hashByKey.set(
        `${event.event_home}/${event.entity_home}/${event.seq}`,
        expected,
      );
      expect(event.content_sha256).toBe(expected);
    }
    for (const disposition of witness.dispositions) {
      expect(disposition.command_sha256).toBe(
        hashByKey.get(
          `${disposition.command_event_home}/${disposition.command_entity_home}/${disposition.command_seq}`,
        ),
      );
      if (disposition.fact_seq !== null) {
        expect(disposition.fact_sha256).toBe(
          hashByKey.get(
            `${disposition.fact_event_home}/${disposition.fact_entity_home}/${disposition.fact_seq}`,
          ),
        );
      }
    }
    for (const fact of witness.commandBasisFacts) {
      expect(fact.basis_command_sha256).toBe(
        hashByKey.get(
          `${fact.basis_command_event_home}/${fact.basis_command_entity_home}/${fact.basis_command_seq}`,
        ),
      );
    }

    // Every active record strict-decodes with the current WorkRecord schema.
    const strictDecode = Schema.decodeUnknownSync(WorkRecord, {
      onExcessProperty: "error",
    });
    for (const event of witness.events) {
      const record = loadRecordForTest(readerFor(path), event);
      expect(() => strictDecode(record)).not.toThrow();
    }

    // Revision counter advanced honestly for the materialized work.
    expect(witness.revisions?.revision ?? 0).toBeGreaterThan(3);

    // Integrity: foreign keys and quick_check.
    const foreignKeyViolations = foreignKeyViolationsOf(path);
    expect(foreignKeyViolations).toEqual([]);
    const quickCheck = quickCheckOf(path);
    expect(quickCheck).toBe("ok");
  });

  it("fresh databases build the exact corrected schema 21", async () => {
    const root = await makeRoot();
    const path = join(root, "vellum-command.db");
    const runtime = ManagedRuntime.make(makeStateEngineLive(path));
    const state = await runtime.runPromise(StateEngine);
    handles.push({
      path,
      root,
      runtime,
      dispose: async () => {
        await runtime.dispose();
      },
    });
    expect(state.info.schemaVersion).toBe(CURRENT_STATE_SCHEMA_VERSION);
    const probe = new DatabaseSync(path, { readOnly: true });
    try {
      expect(stateSchemaAdvanceRequired(probe)).toBe(false);
      expect(
        probe.prepare("PRAGMA user_version").get(),
      ).toEqual({ user_version: CURRENT_STATE_SCHEMA_VERSION });
      expect(
        probe
          .prepare(
            `SELECT count(*) AS count FROM sqlite_schema
             WHERE name LIKE 'work_proposal%' OR name LIKE 'work_task_proposals%'`,
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      probe.close();
    }
  });

  it("fails closed on a task id collision and leaves the database untouched", async () => {
    const root = await makeRoot();
    const path = join(root, "vellum-command.db");
    const database = seedInvalid21Database(path);
    // Collide: a pending proposal whose id is already an unrelated task row.
    insertFact(database, {
      eventHome: "cc-installation",
      entityHome: "cc-installation",
      seq: "99",
      operation: "task.create",
      predecessor: null,
      basis: {
        kind: "authorial-intent",
        generation: "7",
        contentSha256: "a".repeat(64),
      },
      body: {
        operation: "task.create",
        task: {
          id: "prop-pending-1",
          state: "submitted",
          history: [
            {
              messageId: "msg-other",
              role: "user",
              parts: [{ kind: "text", text: "other" }],
            },
          ],
        },
      },
      originAt: T2,
    });
    database
      .prepare(
        `INSERT INTO work_tasks(
           canvas_name, node_id, task_id, entity_home, actor_seat_id,
           fact_event_home, fact_entity_home, fact_seq, state,
           brief_message_id, artifact_ids_json, metadata_json, reason,
           response, created_at, updated_at, origin_at, received_at
         ) VALUES ('factory', 'board-1', 'prop-pending-1', 'cc-installation',
           NULL, 'cc-installation', 'cc-installation', '99', 'submitted',
           'msg-other', NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
      )
      .run(T2, T2, T2, T2);
    database
      .prepare(
        `INSERT INTO work_event_sequences(event_home, entity_home, last_seq)
         VALUES ('cc-installation', 'cc-installation', '100')
         ON CONFLICT(event_home, entity_home) DO UPDATE SET last_seq = '100'`,
      )
      .run();
    database.close();

    const before = snapshotDatabase(path);
    const runtime = ManagedRuntime.make(makeStateEngineLive(path));
    await expect(runtime.runPromise(StateEngine)).rejects.toThrow();
    await runtime.dispose();

    const after = snapshotDatabase(path);
    expect(after).toEqual(before);
    const backups = await readBackupFiles(root);
    expect(backups.filter((name) => name.endsWith(".db"))).toHaveLength(1);
  });

  it("keeps an already-materialized pending proposal and still drops proposal storage", async () => {
    const root = await makeRoot();
    const path = join(root, "vellum-command.db");
    const database = seedInvalid21Database(path);
    insertFact(database, {
      eventHome: "cc-installation",
      entityHome: "cc-installation",
      seq: "99",
      operation: "task.create",
      itemId: "prop-pending-1",
      predecessor: null,
      basis: {
        kind: "authorial-intent",
        generation: "7",
        contentSha256: "a".repeat(64),
      },
      body: {
        operation: "task.create",
        task: {
          id: "prop-pending-1",
          state: "submitted",
          history: [
            {
              messageId: pendingProposal.brief.messageId,
              role: "user",
              parts: pendingProposal.brief.parts,
            },
          ],
          metadata: {
            source: "board",
            instruction: "keep too",
            "vellum.pipeline": {
              admission: "operator-gated",
              raisedBy: PROPOSER,
            },
          },
          reason: pendingProposal.reason,
        },
      },
      originAt: T2,
    });
    database
      .prepare(
        `INSERT INTO work_tasks(
           canvas_name, node_id, task_id, entity_home, actor_seat_id,
           fact_event_home, fact_entity_home, fact_seq, state,
           brief_message_id, artifact_ids_json, metadata_json, reason,
           response, created_at, updated_at, origin_at, received_at
         ) VALUES ('factory', 'board-1', 'prop-pending-1', 'cc-installation',
           NULL, 'cc-installation', 'cc-installation', '99', 'submitted',
           ?, NULL, ?, ?, NULL, ?, ?, ?, ?)`,
      )
      .run(
        pendingProposal.brief.messageId,
        canonicalJson({
          source: "board",
          instruction: "keep too",
          "vellum.pipeline": {
            admission: "operator-gated",
            raisedBy: PROPOSER,
          },
        }),
        pendingProposal.reason,
        T2,
        T2,
        T2,
        T2,
      );
    database
      .prepare(
        `INSERT INTO work_task_messages(
           canvas_name, node_id, parent_lane, item_id, message_id, position,
           message_kind, entity_home, fact_event_home, fact_entity_home,
           fact_seq, role, parts_json, context_id, reference_task_ids_json,
           metadata_json, origin_at, received_at
         ) VALUES ('factory', 'board-1', 'task', 'prop-pending-1',
           ?, 0, 'brief', 'cc-installation', 'cc-installation',
           'cc-installation', '99', 'user', ?, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        pendingProposal.brief.messageId,
        canonicalJson(pendingProposal.brief.parts),
        T2,
        T2,
      );
    database
      .prepare(
        `INSERT INTO work_task_finish(
           canvas_name, node_id, task_id, finish_criteria_json,
           completion_evidence_json
         ) VALUES ('factory', 'board-1', 'prop-pending-1', ?, NULL)`,
      )
      .run(canonicalJson({ description: "done means done" }));
    database
      .prepare(
        `INSERT INTO work_event_sequences(event_home, entity_home, last_seq)
         VALUES ('cc-installation', 'cc-installation', '100')
         ON CONFLICT(event_home, entity_home) DO UPDATE SET last_seq = '100'`,
      )
      .run();
    database.close();

    const runtime = ManagedRuntime.make(makeStateEngineLive(path));
    const state = await runtime.runPromise(StateEngine);
    handles.push({
      path,
      root,
      runtime,
      dispose: async () => {
        await runtime.dispose();
      },
    });
    expect(state.info.schemaVersion).toBe(CURRENT_STATE_SCHEMA_VERSION);

    const witness = await runtime.runPromise(
      state.read("schema21.already-materialized", (reader) => {
        const proposalObjects = reader.all<{ readonly name: string }>(
          `SELECT name FROM sqlite_schema
           WHERE (name LIKE 'work_proposal%' OR name LIKE 'work_task_proposals%')
             AND name NOT GLOB 'sqlite_*'`,
        );
        const pending = reader.get<{
          readonly task_id: string;
          readonly state: string;
          readonly brief_message_id: string | null;
          readonly fact_seq: string;
          readonly metadata_json: string | null;
        }>(
          `SELECT task_id, state, brief_message_id, fact_seq, metadata_json
           FROM work_tasks WHERE task_id = 'prop-pending-1'`,
        );
        const creates = reader.all<{ readonly seq: string }>(
          `SELECT seq FROM work_events
           WHERE item_id = 'prop-pending-1' AND operation = 'task.create'`,
        );
        return { proposalObjects, pending, creates };
      }),
    );
    expect(witness.proposalObjects).toEqual([]);
    expect(witness.pending).toMatchObject({
      task_id: "prop-pending-1",
      state: "submitted",
      brief_message_id: pendingProposal.brief.messageId,
      fact_seq: "99",
    });
    expect(JSON.parse(witness.pending!.metadata_json!)).toMatchObject({
      source: "board",
      instruction: "keep too",
      "vellum.tasks": {
        admission: "approval",
        raisedBy: PROPOSER,
      },
    });
    expect(witness.creates).toEqual([{ seq: "99" }]);
  });

  it("corrects old-shape work data and proposals inside the 20 -> 21 step", async () => {
    const root = await makeRoot();
    const path = join(root, "vellum-command.db");
    const v20 = new DatabaseSync(path, {
      open: true,
      enableForeignKeyConstraints: true,
    });
    v20.exec("PRAGMA foreign_keys = ON");
    v20.exec(STATE_SCHEMA_V20_SQL);
    install(v20, "cc-installation");
    install(v20, "remote-a");
    route(v20, "cc-installation", "cc-installation", "17");
    route(v20, "remote-a", "cc-installation", "1");
    // Blob canvas head carrying the retired Tasks vocabulary. The corrective
    // converter must run before the relational cutover's strict decode.
    const body = JSON.stringify({
      nodes: [
        {
          id: "board-1",
          type: "text",
          x: 0,
          y: 0,
          width: 220,
          height: 84,
          text: "Boarding",
          ether: {
            entity: { kind: "task" },
            tasks: {
              items: [],
              stationName: "Build",
              contract: {
                instruction: "build the change",
                claims: [{ id: "rule-1", text: "tests pass", severity: "hard" }],
                inbound: {
                  instruction: "read the task",
                  admission: "operator-gated",
                  claimableAfterMs: 500,
                  checklist: [{ id: "check-in", label: "setup", command: "true" }],
                },
                outbound: {
                  emission: "summarize the work",
                  checklist: [{ id: "check-out", label: "tests", command: "bun test" }],
                },
              },
            },
          },
        },
      ],
      edges: [],
    });
    v20.prepare(
      `INSERT INTO canvas_generations(
         generation, created_at, cause, intent_sha256, document_count
       ) VALUES ('7', ?, 'seed', ?, 1)`,
    ).run(T0, "a".repeat(64));
    v20.prepare(
      `INSERT INTO canvas_generation_documents(
         generation, name, body, sha256, modified_at
       ) VALUES ('7', 'factory', ?, ?, ?)`,
    ).run(body, sha256(body), T1);
    v20.prepare(
      "INSERT INTO canvas_head(singleton, generation) VALUES (1, '7')",
    ).run();
    // Old-shape work data (as release N-1 wrote it).
    insertFact(v20, {
      eventHome: "cc-installation",
      entityHome: "cc-installation",
      seq: "1",
      operation: "task.create",
      predecessor: null,
      basis: {
        kind: "authorial-intent",
        generation: "7",
        contentSha256: "a".repeat(64),
      },
      body: { operation: "task.create", task: OLD_SUBMITTED_TASK },
      originAt: T0,
    });
    v20.prepare(
      `INSERT INTO work_tasks(
         canvas_name, node_id, task_id, entity_home, actor_seat_id,
         fact_event_home, fact_entity_home, fact_seq, state, brief_message_id,
         artifact_ids_json, metadata_json, reason, response, created_at,
         updated_at, origin_at, received_at
       ) VALUES ('factory', 'board-1', 'task-approved-1', 'cc-installation',
         NULL, 'cc-installation', 'cc-installation', '1', 'submitted',
         'msg-approved-1', NULL, ?, NULL, NULL, ?, ?, ?, ?)`,
    ).run(canonicalJson(OLD_METADATA), T0, T0, T0, T0);
    seedProposalStorage(v20);
    verifyAndStampStateSchema(v20, STATE_SCHEMA_V20_SQL);
    v20.exec("PRAGMA user_version = 20");
    v20.close();

    const runtime = ManagedRuntime.make(makeStateEngineLive(path));
    const state = await runtime.runPromise(StateEngine);
    handles.push({
      path,
      root,
      runtime,
      dispose: async () => {
        await runtime.dispose();
      },
    });
    expect(state.info.schemaVersion).toBe(CURRENT_STATE_SCHEMA_VERSION);
    const probe = new DatabaseSync(path, { readOnly: true });
    try {
      expect(
        probe
          .prepare(
            `SELECT count(*) AS count FROM sqlite_schema
             WHERE name LIKE 'work_proposal%' OR name LIKE 'work_task_proposals%'`,
          )
          .get(),
      ).toEqual({ count: 0 });
      expect(
        probe
          .prepare(
            `SELECT task_id, state FROM work_tasks ORDER BY created_at, task_id`,
          )
          .all(),
      ).toEqual([
        { task_id: "task-approved-1", state: "submitted" },
        { task_id: "prop-pending-1", state: "submitted" },
        { task_id: "prop-rejected-1", state: "rejected" },
      ]);
      expect(
        probe
          .prepare(
            `SELECT actual_schema_sha256 FROM state_schema_identity WHERE singleton = 1`,
          )
          .get(),
      ).toEqual({
        actual_schema_sha256: CURRENT_STATE_SCHEMA_IDENTITY.actualSchemaSha256,
      });
      const document = probe
        .prepare(
          `SELECT canvas_id FROM canvas_documents WHERE canvas_name = 'factory'`,
        )
        .get() as { readonly canvas_id: string };
      const migrated = reconstructCanvasDoc(
        {
          get: (sql, bindings) =>
            probe.prepare(sql).get(...((bindings ?? []) as never[])) as never,
          all: (sql, bindings) =>
            probe.prepare(sql).all(...((bindings ?? []) as never[])) as never,
        },
        document.canvas_id,
      );
      expect(migrated.nodes[0]?.ether?.tasks).toEqual({
        items: [],
        name: "Build",
        contract: {
          instructions: "build the change",
          rules: [{ id: "rule-1", text: "tests pass" }],
          incoming: {
            handling: "read the task",
            admission: "approval",
            waitMs: 500,
            checks: [{ id: "check-in", label: "setup", command: "true" }],
          },
          outgoing: {
            handoff: "summarize the work",
            checks: [{ id: "check-out", label: "tests", command: "bun test" }],
          },
        },
      });
    } finally {
      probe.close();
    }
  });
});

// ---- test-side row readers (mirror the repository's loadRecord) ----

const readerFor = (path: string) => {
  const database = new DatabaseSync(path, { readOnly: true });
  return {
    database,
    get: <Row>(sql: string, ...bindings: ReadonlyArray<unknown>): Row | undefined =>
      database.prepare(sql).get(...(bindings as never[])) as Row | undefined,
    all: <Row>(sql: string, ...bindings: ReadonlyArray<unknown>): ReadonlyArray<Row> =>
      database.prepare(sql).all(...(bindings as never[])) as Row[],
    close: () => database.close(),
  };
};

const foreignKeyViolationsOf = (path: string): ReadonlyArray<unknown> => {
  const reader = readerFor(path);
  try {
    return reader.all("PRAGMA foreign_key_check");
  } finally {
    reader.close();
  }
};

const quickCheckOf = (path: string): string => {
  const reader = readerFor(path);
  try {
    const row = reader.get<{ readonly quick_check: string }>("PRAGMA quick_check");
    return row?.quick_check ?? "missing";
  } finally {
    reader.close();
  }
};

const recordSemanticFromDatabase = (
  reader: ReturnType<typeof readerFor>,
  event: {
    readonly event_home: string;
    readonly entity_home: string;
    readonly seq: string;
    readonly record_type: string;
  },
): unknown => {
  const common = {
    protocol: "vellum/work/v2",
    id: {
      route: { eventHome: event.event_home, entityHome: event.entity_home },
      seq: event.seq,
    },
    item: { kind: "task", itemId: "", sink: { canvasName: "", nodeId: "" } },
    operation: "",
  };
  const eventRow = reader.get<{
    readonly item_kind: string;
    readonly item_id: string;
    readonly item_canvas_name: string;
    readonly item_node_id: string;
    readonly operation: string;
  }>(
    `SELECT item_kind, item_id, item_canvas_name, item_node_id, operation
     FROM work_events WHERE event_home = ? AND entity_home = ? AND seq = ?`,
    event.event_home,
    event.entity_home,
    event.seq,
  );
  if (eventRow === undefined) throw new Error("event row is missing");
  const base = {
    ...common,
    item: {
      kind: eventRow.item_kind,
      itemId: eventRow.item_id,
      sink: {
        canvasName: eventRow.item_canvas_name,
        nodeId: eventRow.item_node_id,
      },
    },
    operation: eventRow.operation,
  };
  if (event.record_type === "command") {
    const row = reader.get<{
      readonly predecessor_event_home: string | null;
      readonly predecessor_entity_home: string | null;
      readonly predecessor_seq: string | null;
      readonly action_json: string;
    }>(
      `SELECT predecessor_event_home, predecessor_entity_home,
              predecessor_seq, action_json
       FROM work_commands WHERE event_home = ? AND entity_home = ? AND seq = ?`,
      event.event_home,
      event.entity_home,
      event.seq,
    );
    if (row === undefined) throw new Error("command row is missing");
    return {
      ...base,
      recordType: "command",
      predecessor:
        row.predecessor_seq === null
          ? null
          : {
              route: {
                eventHome: row.predecessor_event_home,
                entityHome: row.predecessor_entity_home,
              },
              seq: row.predecessor_seq,
            },
      body: JSON.parse(row.action_json) as unknown,
    };
  }
  if (event.record_type === "fact") {
    const row = reader.get<{
      readonly predecessor_event_home: string | null;
      readonly predecessor_entity_home: string | null;
      readonly predecessor_seq: string | null;
      readonly basis_kind: string;
      readonly basis_authorial_generation: string | null;
      readonly basis_authorial_content_sha256: string | null;
      readonly basis_projected_generation: string | null;
      readonly basis_projected_content_sha256: string | null;
      readonly basis_command_event_home: string | null;
      readonly basis_command_entity_home: string | null;
      readonly basis_command_seq: string | null;
      readonly basis_command_sha256: string | null;
      readonly result_json: string;
    }>(
      `SELECT predecessor_event_home, predecessor_entity_home,
              predecessor_seq, basis_kind, basis_authorial_generation,
              basis_authorial_content_sha256, basis_projected_generation,
              basis_projected_content_sha256, basis_command_event_home,
              basis_command_entity_home, basis_command_seq,
              basis_command_sha256, result_json
       FROM work_facts WHERE event_home = ? AND entity_home = ? AND seq = ?`,
      event.event_home,
      event.entity_home,
      event.seq,
    );
    if (row === undefined) throw new Error("fact row is missing");
    const basis =
      row.basis_kind === "authorial-intent"
        ? {
            kind: "authorial-intent",
            generation: row.basis_authorial_generation,
            contentSha256: row.basis_authorial_content_sha256,
          }
        : row.basis_kind === "projected-intent"
          ? {
              kind: "projected-intent",
              generation: row.basis_projected_generation,
              contentSha256: row.basis_projected_content_sha256,
            }
          : {
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
    return {
      ...base,
      recordType: "fact",
      basis,
      predecessor:
        row.predecessor_seq === null
          ? null
          : {
              route: {
                eventHome: row.predecessor_event_home,
                entityHome: row.predecessor_entity_home,
              },
              seq: row.predecessor_seq,
            },
      body: JSON.parse(row.result_json) as unknown,
    };
  }
  const row = reader.get<{
    readonly status: string;
    readonly command_event_home: string;
    readonly command_entity_home: string;
    readonly command_seq: string;
    readonly command_sha256: string;
    readonly fact_event_home: string | null;
    readonly fact_entity_home: string | null;
    readonly fact_seq: string | null;
    readonly fact_sha256: string | null;
    readonly rejection_reason: string | null;
    readonly rejection_message: string | null;
  }>(
    `SELECT status, command_event_home, command_entity_home, command_seq,
            command_sha256, fact_event_home, fact_entity_home, fact_seq,
            fact_sha256, rejection_reason, rejection_message
     FROM work_dispositions
     WHERE event_home = ? AND entity_home = ? AND seq = ?`,
    event.event_home,
    event.entity_home,
    event.seq,
  );
  if (row === undefined) throw new Error("disposition row is missing");
  const command = {
    route: { eventHome: row.command_event_home, entityHome: row.command_entity_home },
    seq: row.command_seq,
  };
  const body =
    row.status === "applied"
      ? {
          status: "applied",
          command,
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
          command,
          commandSha256: row.command_sha256,
          reason: row.rejection_reason,
          message: row.rejection_message,
        };
  return {
    ...base,
    recordType: "disposition",
    body,
  };
};

const loadRecordForTest = (
  reader: ReturnType<typeof readerFor>,
  event: {
    readonly event_home: string;
    readonly entity_home: string;
    readonly seq: string;
    readonly record_type: string;
    readonly content_sha256: string;
    readonly protocol: string;
    readonly origin_at: string;
  },
): unknown => {
  const semantic = recordSemanticFromDatabase(reader, event) as Record<string, unknown>;
  return {
    ...semantic,
    contentSha256: event.content_sha256,
    originAt: event.origin_at,
  };
};

const snapshotDatabase = (path: string): unknown => {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      userVersion: database.prepare("PRAGMA user_version").get(),
      identity: database
        .prepare(
          `SELECT actual_schema_sha256 FROM state_schema_identity WHERE singleton = 1`,
        )
        .get(),
      schema: database
        .prepare(
          `SELECT type, name FROM sqlite_schema
           WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name`,
        )
        .all(),
      tasks: database
        .prepare(`SELECT task_id, state FROM work_tasks ORDER BY task_id`)
        .all(),
      events: database
        .prepare(`SELECT event_home, entity_home, seq FROM work_events ORDER BY seq`)
        .all(),
      proposals: database
        .prepare(`SELECT proposal_id, state FROM work_task_proposals ORDER BY proposal_id`)
        .all(),
    };
  } finally {
    database.close();
  }
};
