/**
 * Audit generator for the schema-v1 durable baseline fixtures.
 *
 * This file is never imported by the test suite. Re-run it after any
 * intentional baseline change to regenerate both committed databases in
 * place; the fixture test pins their SHA-256.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Schema } from "effect";
import {
  serializeCanvas,
  type CanvasDoc,
  type CanvasEdge,
  type CanvasNode,
} from "../../../src/shared/canvas";
import { InstallationId } from "../../../src/shared/installation-id";
import {
  WORK_PROTOCOL,
  WorkRecord,
  type WorkRecord as WorkRecordValue,
} from "../../../src/shared/work-protocol";
import {
  STATE_SCHEMA_V1_IDENTITY,
} from "../../../src/main/junto/state/migrations";
import {
  STATE_SCHEMA_V1_SQL,
} from "../../../src/main/junto/state/schema";
import {
  expectedStateSchemaIdentity,
} from "../../../src/main/junto/state/schema-identity";
import {
  compileStationPortfolioBody,
  decodeStationPortfolioBody,
} from "../../../src/main/junto/station/portfolio";
import {
  stationProjectionContentSha256,
} from "../../../src/main/junto/station/repository";
import {
  workRecordContentSha256,
} from "../../../src/main/junto/work/repository";

const CREATED_AT = "2026-07-28T12:00:00.000Z";
const RECEIVED_AT = "2026-07-28T12:00:03.000Z";
const COMMAND_CENTER_ID = Schema.decodeUnknownSync(InstallationId)(
  "command-center-v1",
);
const REMOTE_ID = Schema.decodeUnknownSync(InstallationId)("remote-v1");
const strictDecode = { onExcessProperty: "error" } as const;
const decodeRecord = Schema.decodeUnknownSync(WorkRecord, strictDecode);

const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const canonicalJson = (value: unknown): string => {
  const normalize = (nested: unknown): unknown => {
    if (Array.isArray(nested)) return nested.map(normalize);
    if (
      nested === null ||
      typeof nested !== "object"
    ) {
      return nested;
    }
    return Object.fromEntries(
      Object.entries(nested as Readonly<Record<string, unknown>>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0
        )
        .map(([key, child]) => [key, normalize(child)]),
    );
  };
  return JSON.stringify(normalize(value));
};

const makeRecord = (
  semantic: unknown,
  originAt: string,
): WorkRecordValue => {
  const body = semantic as Parameters<
    typeof workRecordContentSha256
  >[0];
  return decodeRecord({
    ...(semantic as Readonly<Record<string, unknown>>),
    contentSha256: workRecordContentSha256(body),
    originAt,
  });
};

const commandCenterCanvas = (): CanvasDoc => ({
  nodes: [
    {
      id: "tasks",
      type: "text",
      x: 0,
      y: 0,
      width: 240,
      height: 100,
      text: "Command Center task queue",
      ether: { entity: { kind: "task" } },
    },
    {
      id: "agent",
      type: "text",
      x: 360,
      y: 0,
      width: 240,
      height: 100,
      text: "Command Center builder",
      ether: {
        entity: { kind: "agent", name: "local:codex" },
        terminal: {
          bindingId: "fixture-cc-agent",
          launch: { kind: "harness", argv: ["codex"] },
          harness: "codex",
        },
        host: "local",
      },
    },
  ],
  edges: [
    {
      id: "claim-edge",
      fromNode: "tasks",
      toNode: "agent",
      ether: { verb: "works" },
    },
  ],
});

const remoteCanvas = (): CanvasDoc => ({
  nodes: [
    {
      id: "tasks",
      type: "text",
      x: 0,
      y: 0,
      width: 240,
      height: 100,
      text: "Remote task queue",
      ether: { entity: { kind: "task" } },
    },
    {
      id: "agent",
      type: "text",
      x: 360,
      y: 0,
      width: 240,
      height: 100,
      text: "Remote builder",
      ether: {
        entity: { kind: "agent", name: "studio:codex" },
        terminal: {
          bindingId: "fixture-remote-agent",
          launch: { kind: "harness", argv: ["codex"] },
          harness: "codex",
        },
        host: "studio",
      },
    },
    {
      id: "timer-v1",
      type: "text",
      x: 0,
      y: 180,
      width: 240,
      height: 100,
      text: "Every minute",
      ether: {
        entity: { kind: "timer" },
        timer: { everyMinutes: 1 },
        host: "studio",
      },
    },
  ],
  edges: [
    {
      id: "claim-edge",
      fromNode: "tasks",
      toNode: "agent",
      ether: { verb: "works" },
    },
    {
      id: "timer-edge",
      fromNode: "timer-v1",
      toNode: "agent",
    },
  ],
});

const actorFor = (
  canvas: CanvasDoc,
  installationByHost: ReadonlyMap<string, typeof COMMAND_CENTER_ID>,
) => {
  const projection = compileStationPortfolioBody(
    new Map([["factory", canvas]]),
    installationByHost,
  );
  const actor = decodeStationPortfolioBody(projection).actorSeats[0];
  if (actor === undefined) throw new Error("fixture actor did not compile");
  return { actor, projection };
};

const initializeSchema = (database: DatabaseSync): void => {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = DELETE;
    PRAGMA trusted_schema = OFF;
    ${STATE_SCHEMA_V1_SQL}
  `);
};

const stampVersionOne = (database: DatabaseSync): void => {
  const identity = expectedStateSchemaIdentity(STATE_SCHEMA_V1_SQL);
  if (
    identity.actualSchemaSha256 !==
      STATE_SCHEMA_V1_IDENTITY.actualSchemaSha256
  ) {
    throw new Error("exported schema v1 no longer matches its frozen witness");
  }
  database.prepare(
    `
      INSERT INTO state_schema_identity(
        singleton,
        actual_schema_sha256,
        source_schema_sha256,
        verified_at
      ) VALUES (1, ?, ?, ?)
    `,
  ).run(
    identity.actualSchemaSha256,
    "0".repeat(64),
    CREATED_AT,
  );
  database.exec("PRAGMA user_version = 1");
};

const seedKnownInstallations = (
  database: DatabaseSync,
  localInstallationId: typeof COMMAND_CENTER_ID,
): void => {
  for (const installationId of [COMMAND_CENTER_ID, REMOTE_ID]) {
    database.prepare(
      `
        INSERT INTO station_known_installations(
          installation_id,
          registered_at
        ) VALUES (?, ?)
      `,
    ).run(installationId, CREATED_AT);
  }
  database.prepare(
    `
      INSERT INTO station_installation(
        singleton,
        installation_id,
        created_at
      ) VALUES (1, ?, ?)
    `,
  ).run(localInstallationId, CREATED_AT);
};

const seedHostRegistry = (database: DatabaseSync): void => {
  database.prepare(
    `
      INSERT INTO host_registry_state(
        singleton,
        version,
        initialized_at
      ) VALUES (1, 1, ?)
    `,
  ).run(CREATED_AT);
  database.prepare(
    `
      INSERT INTO host_registry(
        id,
        label,
        kind,
        ssh_endpoint,
        ssh_identity_file,
        ssh_host_key_policy,
        capability_mask,
        hermes_id,
        effective_hermes_id,
        appearance_color,
        appearance_glyph,
        sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    "local",
    "Fixture Local",
    "local",
    null,
    null,
    null,
    null,
    null,
    "local",
    null,
    null,
    0,
  );
  database.prepare(
    `
      INSERT INTO host_registry(
        id,
        label,
        kind,
        ssh_endpoint,
        ssh_identity_file,
        ssh_host_key_policy,
        capability_mask,
        hermes_id,
        effective_hermes_id,
        appearance_color,
        appearance_glyph,
        sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    "studio",
    "Studio Mini",
    "remote",
    "studio",
    null,
    "system",
    11,
    null,
    "studio",
    "#5ec6d6",
    "mini",
    1,
  );
};

const insertEvent = (
  database: DatabaseSync,
  record: WorkRecordValue,
  receivedAt: string,
): void => {
  database.prepare(
    `
      INSERT INTO work_events(
        event_home,
        entity_home,
        seq,
        protocol,
        record_type,
        item_kind,
        item_id,
        item_canvas_name,
        item_node_id,
        operation,
        content_sha256,
        origin_at,
        received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    record.id.route.eventHome,
    record.id.route.entityHome,
    record.id.seq,
    record.protocol,
    record.recordType,
    record.item.kind,
    record.item.itemId,
    record.item.sink.canvasName,
    record.item.sink.nodeId,
    record.operation,
    record.contentSha256,
    record.originAt,
    receivedAt,
  );
};

const insertFact = (
  database: DatabaseSync,
  record: Extract<WorkRecordValue, { readonly recordType: "fact" }>,
): void => {
  database.prepare(
    `
      INSERT INTO work_facts(
        event_home,
        entity_home,
        seq,
        predecessor_event_home,
        predecessor_entity_home,
        predecessor_seq,
        basis_kind,
        basis_authorial_generation,
        basis_authorial_content_sha256,
        basis_projected_generation,
        basis_projected_content_sha256,
        basis_command_event_home,
        basis_command_entity_home,
        basis_command_seq,
        basis_command_sha256,
        result_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    record.id.route.eventHome,
    record.id.route.entityHome,
    record.id.seq,
    record.predecessor?.route.eventHome ?? null,
    record.predecessor?.route.entityHome ?? null,
    record.predecessor?.seq ?? null,
    record.basis.kind,
    record.basis.kind === "authorial-intent"
      ? record.basis.generation
      : null,
    record.basis.kind === "authorial-intent"
      ? record.basis.contentSha256
      : null,
    record.basis.kind === "projected-intent"
      ? record.basis.generation
      : null,
    record.basis.kind === "projected-intent"
      ? record.basis.contentSha256
      : null,
    record.basis.kind === "command"
      ? record.basis.command.route.eventHome
      : null,
    record.basis.kind === "command"
      ? record.basis.command.route.entityHome
      : null,
    record.basis.kind === "command"
      ? record.basis.command.seq
      : null,
    record.basis.kind === "command"
      ? record.basis.commandSha256
      : null,
    canonicalJson(record.body),
  );
};

const insertMaterializedTask = (
  database: DatabaseSync,
  task: {
    readonly id: string;
    readonly state: "working";
    readonly claimedBy: string;
    readonly history: ReadonlyArray<{
      readonly messageId: string;
      readonly role: "user";
      readonly parts: ReadonlyArray<{
        readonly kind: "text";
        readonly text: string;
      }>;
      readonly contextId: string;
    }>;
    readonly metadata: Readonly<Record<string, string>>;
  },
  fact: Extract<WorkRecordValue, { readonly recordType: "fact" }>,
  createdAt: string,
  fromState: "submitted" | null,
  ordinal: number,
): void => {
  const message = task.history[0]!;
  database.prepare(
    `
      INSERT INTO work_tasks(
        canvas_name,
        node_id,
        task_id,
        entity_home,
        actor_seat_id,
        fact_event_home,
        fact_entity_home,
        fact_seq,
        state,
        brief_message_id,
        artifact_ids_json,
        metadata_json,
        reason,
        response,
        created_at,
        updated_at,
        origin_at,
        received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    "factory",
    "tasks",
    task.id,
    fact.id.route.entityHome,
    task.claimedBy,
    fact.id.route.eventHome,
    fact.id.route.entityHome,
    fact.id.seq,
    task.state,
    message.messageId,
    null,
    canonicalJson(task.metadata),
    null,
    null,
    createdAt,
    fact.originAt,
    fact.originAt,
    RECEIVED_AT,
  );
  database.prepare(
    `
      INSERT INTO work_task_messages(
        canvas_name,
        node_id,
        parent_lane,
        item_id,
        message_id,
        position,
        message_kind,
        entity_home,
        fact_event_home,
        fact_entity_home,
        fact_seq,
        role,
        parts_json,
        context_id,
        reference_task_ids_json,
        metadata_json,
        origin_at,
        received_at
      ) VALUES (?, ?, 'task', ?, ?, 0, 'brief', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    "factory",
    "tasks",
    task.id,
    message.messageId,
    fact.id.route.entityHome,
    fact.id.route.eventHome,
    fact.id.route.entityHome,
    fact.id.seq,
    message.role,
    canonicalJson(message.parts),
    message.contextId,
    null,
    null,
    fact.originAt,
    RECEIVED_AT,
  );
  database.prepare(
    `
      INSERT INTO work_task_transitions(
        canvas_name,
        node_id,
        item_id,
        ordinal,
        lane,
        entity_home,
        actor_seat_id,
        fact_event_home,
        fact_entity_home,
        fact_seq,
        operation,
        from_state,
        to_state,
        origin_at,
        received_at
      ) VALUES (?, ?, ?, ?, 'task', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    "factory",
    "tasks",
    task.id,
    ordinal,
    fact.id.route.entityHome,
    task.claimedBy,
    fact.id.route.eventHome,
    fact.id.route.entityHome,
    fact.id.seq,
    fact.operation,
    fromState,
    task.state,
    fact.originAt,
    RECEIVED_AT,
  );
};

/** Mirror of canvas/records.ts persistCanvas with a fixed canvas id. */
const seedCanvasDocument = (
  database: DatabaseSync,
  input: {
    readonly canvasId: string;
    readonly canvasName: string;
    readonly doc: CanvasDoc;
    readonly revisionSha256: string;
    readonly modifiedAt: string;
  },
): void => {
  database.prepare(
    `
      INSERT INTO canvas_documents(
        canvas_id,
        canvas_name,
        revision_sha256,
        created_at,
        modified_at
      ) VALUES (?, ?, ?, ?, ?)
    `,
  ).run(
    input.canvasId,
    input.canvasName,
    input.revisionSha256,
    input.modifiedAt,
    input.modifiedAt,
  );
  const insertNode = database.prepare(
    `
      INSERT INTO canvas_nodes(
        canvas_id,
        node_id,
        z_index,
        type,
        x,
        y,
        width,
        height,
        color,
        text_content,
        file_path,
        file_subpath,
        link_url,
        group_label,
        group_background,
        group_background_style,
        ether_json,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  );
  input.doc.nodes.forEach((node: CanvasNode, index: number) => {
    insertNode.run(
      input.canvasId,
      node.id,
      index,
      node.type,
      node.x,
      node.y,
      node.width,
      node.height,
      node.color ?? null,
      node.type === "text" ? node.text : null,
      node.type === "file" ? node.file : null,
      node.type === "file" ? (node.subpath ?? null) : null,
      node.type === "link" ? node.url : null,
      node.type === "group" ? (node.label ?? null) : null,
      node.type === "group" ? (node.background ?? null) : null,
      node.type === "group" ? (node.backgroundStyle ?? null) : null,
      node.ether === undefined ? null : JSON.stringify(node.ether),
      input.modifiedAt,
    );
  });
  const insertEdge = database.prepare(
    `
      INSERT INTO canvas_edges(
        canvas_id,
        edge_id,
        z_index,
        from_node_id,
        from_side,
        from_end,
        to_node_id,
        to_side,
        to_end,
        color,
        label,
        ether_json,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  );
  input.doc.edges.forEach((edge: CanvasEdge, index: number) => {
    insertEdge.run(
      input.canvasId,
      edge.id,
      index,
      edge.fromNode,
      edge.fromSide ?? null,
      edge.fromEnd ?? null,
      edge.toNode,
      edge.toSide ?? null,
      edge.toEnd ?? null,
      edge.color ?? null,
      edge.label ?? null,
      edge.ether === undefined ? null : JSON.stringify(edge.ether),
      input.modifiedAt,
    );
  });
};

const authorialIntentSha256 = (
  name: string,
  documentSha256: string,
): string => {
  const hash = createHash("sha256");
  hash.update(String(Buffer.byteLength(name, "utf8")));
  hash.update("\0");
  hash.update(name, "utf8");
  hash.update("\0");
  hash.update(documentSha256, "ascii");
  hash.update("\0");
  return hash.digest("hex");
};

const seedCommandCenter = (database: DatabaseSync): void => {
  seedKnownInstallations(database, COMMAND_CENTER_ID);
  seedHostRegistry(database);
  database.prepare(
    `
      INSERT INTO station_configuration(
        singleton,
        role,
        host_id,
        agent_host_id,
        command_center_installation_id,
        supervised_preferred,
        configured_at
      ) VALUES (1, 'command-center', 'local', NULL, NULL, 1, ?)
    `,
  ).run(CREATED_AT);
  database.prepare(
    `
      INSERT INTO station_fleet_targets(
        host_id,
        station_installation_id,
        bound_at
      ) VALUES ('studio', ?, ?)
    `,
  ).run(REMOTE_ID, CREATED_AT);

  const canvas = commandCenterCanvas();
  const body = serializeCanvas(canvas);
  const documentSha256 = sha256(body);
  const intentSha256 = authorialIntentSha256(
    "factory",
    documentSha256,
  );
  seedCanvasDocument(database, {
    canvasId: "cnv_fixture_factory",
    canvasName: "factory",
    doc: canvas,
    revisionSha256: documentSha256,
    modifiedAt: CREATED_AT,
  });
  database.prepare(
    `
      INSERT INTO canvas_portfolio_head(
        singleton,
        generation,
        intent_sha256,
        created_at,
        updated_at
      ) VALUES (1, '9', ?, ?, ?)
    `,
  ).run(intentSha256, CREATED_AT, CREATED_AT);

  const { actor } = actorFor(
    canvas,
    new Map([
      ["local", COMMAND_CENTER_ID],
      ["studio", REMOTE_ID],
    ]),
  );
  const sink = { canvasName: "factory", nodeId: "tasks" } as const;
  const actorRef = {
    seatId: actor.seatId,
    canvasName: "factory",
    nodeId: "agent",
  } as const;
  const submittedTask = {
    id: "task-v1-cc",
    state: "submitted" as const,
    history: [
      {
        messageId: "brief-v1-cc",
        role: "user" as const,
        parts: [
          {
            kind: "text" as const,
            text: "Preserve the authored v1 canvas",
          },
        ],
        contextId: "factory",
      },
    ],
    metadata: { fixture: "state-v1-command-center" },
  };
  const createFact = makeRecord(
    {
      protocol: WORK_PROTOCOL,
      id: {
        route: {
          eventHome: COMMAND_CENTER_ID,
          entityHome: COMMAND_CENTER_ID,
        },
        seq: "1",
      },
      recordType: "fact",
      item: {
        kind: "task",
        itemId: submittedTask.id,
        sink,
      },
      operation: "task.create",
      predecessor: null,
      basis: {
        kind: "authorial-intent",
        generation: "9",
        contentSha256: intentSha256,
      },
      body: { operation: "task.create", task: submittedTask },
    },
    "2026-07-28T12:00:01.000Z",
  );
  if (createFact.recordType !== "fact") {
    throw new Error("Command Center create record did not decode as a fact");
  }
  const claimedTask = {
    ...submittedTask,
    state: "working" as const,
    claimedBy: actor.seatId,
  };
  const claimFact = makeRecord(
    {
      protocol: WORK_PROTOCOL,
      id: {
        route: {
          eventHome: COMMAND_CENTER_ID,
          entityHome: COMMAND_CENTER_ID,
        },
        seq: "2",
      },
      recordType: "fact",
      item: createFact.item,
      operation: "task.claim",
      predecessor: createFact.id,
      basis: {
        kind: "authorial-intent",
        generation: "9",
        contentSha256: intentSha256,
      },
      body: {
        operation: "task.claim",
        task: claimedTask,
        claimedBy: actorRef,
        previousHome: COMMAND_CENTER_ID,
      },
    },
    "2026-07-28T12:00:02.000Z",
  );
  if (claimFact.recordType !== "fact") {
    throw new Error("Command Center claim record did not decode as a fact");
  }
  database.prepare(
    `
      INSERT INTO work_event_sequences(event_home, entity_home, last_seq)
      VALUES (?, ?, '2')
    `,
  ).run(COMMAND_CENTER_ID, COMMAND_CENTER_ID);
  insertEvent(database, createFact, RECEIVED_AT);
  insertFact(database, createFact);
  insertEvent(database, claimFact, RECEIVED_AT);
  insertFact(database, claimFact);
  insertMaterializedTask(
    database,
    claimedTask,
    claimFact,
    createFact.originAt,
    "submitted",
    1,
  );
  database.prepare(
    `
      INSERT INTO work_task_transitions(
        canvas_name,
        node_id,
        item_id,
        ordinal,
        lane,
        entity_home,
        actor_seat_id,
        fact_event_home,
        fact_entity_home,
        fact_seq,
        operation,
        from_state,
        to_state,
        origin_at,
        received_at
      ) VALUES (
        'factory',
        'tasks',
        ?,
        0,
        'task',
        ?,
        NULL,
        ?,
        ?,
        ?,
        'task.create',
        NULL,
        'submitted',
        ?,
        ?
      )
    `,
  ).run(
    submittedTask.id,
    COMMAND_CENTER_ID,
    createFact.id.route.eventHome,
    createFact.id.route.entityHome,
    createFact.id.seq,
    createFact.originAt,
    RECEIVED_AT,
  );
  database.prepare(
    `
      INSERT INTO station_peer_ack_cursors(
        peer_installation_id,
        event_home,
        entity_home,
        through_sequence,
        acknowledged_at
      ) VALUES (?, ?, ?, '2', ?)
    `,
  ).run(
    REMOTE_ID,
    COMMAND_CENTER_ID,
    COMMAND_CENTER_ID,
    RECEIVED_AT,
  );
};

const seedRemote = (database: DatabaseSync): void => {
  seedKnownInstallations(database, REMOTE_ID);
  seedHostRegistry(database);
  database.prepare(
    `
      INSERT INTO station_pairing(
        singleton,
        command_center_installation_id,
        station_label,
        app_version,
        paired_at
      ) VALUES (1, ?, 'Studio Mini', '0.1.0-v1', ?)
    `,
  ).run(COMMAND_CENTER_ID, CREATED_AT);
  database.prepare(
    `
      INSERT INTO station_configuration(
        singleton,
        role,
        host_id,
        agent_host_id,
        command_center_installation_id,
        supervised_preferred,
        configured_at
      ) VALUES (1, 'remote', 'studio', 'studio', ?, 1, ?)
    `,
  ).run(COMMAND_CENTER_ID, CREATED_AT);

  const canvas = remoteCanvas();
  const { actor, projection } = actorFor(
    canvas,
    new Map([["studio", REMOTE_ID]]),
  );
  const projectionSha256 = stationProjectionContentSha256(projection);
  const sourceIntentSha256 = sha256("state-v1-remote-source-intent");
  database.prepare(
    `
      INSERT INTO station_projection_versions(
        generation,
        content_sha256,
        source_canvas_generation,
        source_intent_sha256,
        body,
        created_at,
        received_at
      ) VALUES ('3', ?, '9', ?, ?, ?, ?)
    `,
  ).run(
    projectionSha256,
    sourceIntentSha256,
    projection,
    CREATED_AT,
    RECEIVED_AT,
  );
  database.prepare(
    `
      INSERT INTO station_projection_head(
        singleton,
        generation,
        content_sha256
      ) VALUES (1, '3', ?)
    `,
  ).run(projectionSha256);

  const sink = { canvasName: "factory", nodeId: "tasks" } as const;
  const actorRef = {
    seatId: actor.seatId,
    canvasName: "factory",
    nodeId: "agent",
  } as const;
  const sourceTask = {
    id: "task-v1-remote",
    state: "submitted" as const,
    history: [
      {
        messageId: "brief-v1-remote",
        role: "user" as const,
        parts: [
          {
            kind: "text" as const,
            text: "Continue the claimed v1 task while Command Center sleeps",
          },
        ],
        contextId: "factory",
      },
    ],
    metadata: { fixture: "state-v1-remote" },
  };
  const command = makeRecord(
    {
      protocol: WORK_PROTOCOL,
      id: {
        route: {
          eventHome: COMMAND_CENTER_ID,
          entityHome: REMOTE_ID,
        },
        seq: "1",
      },
      recordType: "command",
      item: {
        kind: "task",
        itemId: sourceTask.id,
        sink,
      },
      operation: "task.claim",
      predecessor: null,
      body: {
        operation: "task.claim",
        sourceQueueHome: COMMAND_CENTER_ID,
        sourcePredecessor: {
          route: {
            eventHome: COMMAND_CENTER_ID,
            entityHome: COMMAND_CENTER_ID,
          },
          seq: "7",
        },
        sourceTask,
        sink,
        actor: actorRef,
        targetHome: REMOTE_ID,
      },
    },
    "2026-07-28T12:00:00.000Z",
  );
  if (command.recordType !== "command") {
    throw new Error("Remote claim command did not decode as a command");
  }
  const claimedTask = {
    ...sourceTask,
    state: "working" as const,
    claimedBy: actor.seatId,
  };
  const fact = makeRecord(
    {
      protocol: WORK_PROTOCOL,
      id: {
        route: { eventHome: REMOTE_ID, entityHome: REMOTE_ID },
        seq: "1",
      },
      recordType: "fact",
      item: command.item,
      operation: "task.claim",
      predecessor: null,
      basis: {
        kind: "command",
        command: command.id,
        commandSha256: command.contentSha256,
      },
      body: {
        operation: "task.claim",
        task: claimedTask,
        claimedBy: actorRef,
        previousHome: COMMAND_CENTER_ID,
      },
    },
    "2026-07-28T12:00:01.000Z",
  );
  if (fact.recordType !== "fact") {
    throw new Error("Remote claim fact did not decode as a fact");
  }
  const disposition = makeRecord(
    {
      protocol: WORK_PROTOCOL,
      id: {
        route: { eventHome: REMOTE_ID, entityHome: REMOTE_ID },
        seq: "2",
      },
      recordType: "disposition",
      item: command.item,
      operation: "task.claim",
      body: {
        status: "applied",
        command: command.id,
        commandSha256: command.contentSha256,
        fact: fact.id,
        factSha256: fact.contentSha256,
      },
    },
    "2026-07-28T12:00:02.000Z",
  );
  if (disposition.recordType !== "disposition") {
    throw new Error(
      "Remote claim disposition did not decode as a disposition",
    );
  }

  database.prepare(
    `
      INSERT INTO work_event_sequences(event_home, entity_home, last_seq)
      VALUES (?, ?, '1'), (?, ?, '2')
    `,
  ).run(
    COMMAND_CENTER_ID,
    REMOTE_ID,
    REMOTE_ID,
    REMOTE_ID,
  );
  insertEvent(database, command, RECEIVED_AT);
  database.prepare(
    `
      INSERT INTO work_commands(
        event_home,
        entity_home,
        seq,
        predecessor_event_home,
        predecessor_entity_home,
        predecessor_seq,
        action_json
      ) VALUES (?, ?, ?, NULL, NULL, NULL, ?)
    `,
  ).run(
    command.id.route.eventHome,
    command.id.route.entityHome,
    command.id.seq,
    canonicalJson(command.body),
  );
  insertEvent(database, fact, RECEIVED_AT);
  insertFact(database, fact);
  insertEvent(database, disposition, RECEIVED_AT);
  database.prepare(
    `
      INSERT INTO work_dispositions(
        event_home,
        entity_home,
        seq,
        status,
        command_event_home,
        command_entity_home,
        command_seq,
        command_sha256,
        fact_event_home,
        fact_entity_home,
        fact_seq,
        fact_sha256,
        rejection_reason,
        rejection_message
      ) VALUES (?, ?, ?, 'applied', ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
    `,
  ).run(
    disposition.id.route.eventHome,
    disposition.id.route.entityHome,
    disposition.id.seq,
    command.id.route.eventHome,
    command.id.route.entityHome,
    command.id.seq,
    command.contentSha256,
    fact.id.route.eventHome,
    fact.id.route.entityHome,
    fact.id.seq,
    fact.contentSha256,
  );
  insertMaterializedTask(
    database,
    claimedTask,
    fact,
    fact.originAt,
    null,
    0,
  );
  database.prepare(
    `
      INSERT INTO station_received_cursors(
        event_home,
        entity_home,
        through_sequence,
        updated_at
      ) VALUES (?, ?, '1', ?)
    `,
  ).run(COMMAND_CENTER_ID, REMOTE_ID, RECEIVED_AT);
  database.prepare(
    `
      INSERT INTO station_peer_ack_cursors(
        peer_installation_id,
        event_home,
        entity_home,
        through_sequence,
        acknowledged_at
      ) VALUES (?, ?, ?, '2', ?)
    `,
  ).run(
    COMMAND_CENTER_ID,
    REMOTE_ID,
    REMOTE_ID,
    RECEIVED_AT,
  );
  database.prepare(
    `
      INSERT INTO scheduler_interval_state(
        home_station,
        timer_key,
        schedule_id,
        interval_milliseconds,
        catch_up_policy,
        next_due_at_epoch_ms,
        next_due_slot,
        last_fired_slot,
        updated_at
      ) VALUES (
        'studio',
        'factory::timer-v1',
        'schedule-v1',
        60000,
        'coalesce-latest',
        1300000,
        '4',
        '3',
        ?
      )
    `,
  ).run(RECEIVED_AT);
  database.prepare(
    `
      INSERT INTO scheduler_interval_firings(
        home_station,
        timer_key,
        schedule_id,
        catch_up_policy,
        claim_slot,
        due_slot,
        scheduled_for_epoch_ms,
        observed_at_epoch_ms,
        coalesced_missed_slots,
        claimed_at
      ) VALUES (
        'studio',
        'factory::timer-v1',
        'schedule-v1',
        'coalesce-latest',
        '0',
        '3',
        1240000,
        1250000,
        '3',
        ?
      )
    `,
  ).run(RECEIVED_AT);
};

const verifyFixture = (database: DatabaseSync): void => {
  stampVersionOne(database);
  const quickCheck = database.prepare("PRAGMA quick_check").get() as
    | { readonly quick_check: string }
    | undefined;
  if (quickCheck?.quick_check !== "ok") {
    throw new Error("generated fixture failed SQLite quick_check");
  }
  const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeys.length > 0) {
    throw new Error(
      `generated fixture has ${foreignKeys.length} foreign-key violation(s)`,
    );
  }
  database.exec("VACUUM");
};

const generate = (
  fileName: string,
  seed: (database: DatabaseSync) => void,
): string => {
  const path = fileURLToPath(new URL(fileName, import.meta.url));
  if (existsSync(path)) {
    unlinkSync(path);
  }
  const database = new DatabaseSync(path, {
    open: true,
    readOnly: false,
    allowExtension: false,
    enableForeignKeyConstraints: true,
  });
  try {
    initializeSchema(database);
    seed(database);
    verifyFixture(database);
  } catch (error) {
    database.close();
    unlinkSync(path);
    throw error;
  }
  database.close();
  return path;
};

const commandCenterPath = generate(
  "./command-center-v1.db",
  seedCommandCenter,
);
const remotePath = generate("./remote-v1.db", seedRemote);

for (const path of [commandCenterPath, remotePath]) {
  const database = new DatabaseSync(path, {
    readOnly: true,
    allowExtension: false,
    enableForeignKeyConstraints: true,
  });
  try {
    const version = database.prepare("PRAGMA user_version").get();
    console.log(`${path}\n  sha256=${sha256(readFileSync(path))}`);
    console.log(`  version=${JSON.stringify(version)}`);
  } finally {
    database.close();
  }
}
