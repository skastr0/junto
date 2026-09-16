import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { convertStateToJunto } from "../scripts/convert-state-to-junto";
import { STATE_SCHEMA_SQL } from "../src/main/junto/state/schema";
import {
  CURRENT_STATE_SCHEMA_VERSION,
  migrateStateSchema,
} from "../src/main/junto/state/migrations";
import { computeWorkRecordContentSha256 } from "../src/shared/work-canonical-json";
import {
  reconstructCanvasDoc,
  type CanvasSqlReader,
} from "../src/main/junto/canvas/records";
import {
  canvasBodySha256Of,
  intentSha256Of,
} from "../src/main/junto/canvas-intent-identity";
import { serializeCanvas } from "../src/shared/canvas";
import { verdictSubjectHashPayload } from "../src/shared/crew";

const open = (): DatabaseSync => new DatabaseSync(":memory:");

const tableSql = (name: string): string => {
  const marker = `CREATE TABLE IF NOT EXISTS ${name} (`;
  const start = STATE_SCHEMA_SQL.indexOf(marker);
  const end = STATE_SCHEMA_SQL.indexOf(";", start);
  return STATE_SCHEMA_SQL.slice(start, end + 1);
};

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const get = <T>(db: DatabaseSync, sql: string, ...params: unknown[]): T =>
  db.prepare(sql).get(...(params as never[])) as T;

const all = <T>(db: DatabaseSync, sql: string, ...params: unknown[]): T[] =>
  db.prepare(sql).all(...(params as never[])) as T[];

const run = (db: DatabaseSync, sql: string, ...params: unknown[]): void => {
  db.prepare(sql).run(...(params as never[]));
};

const NOW = "2026-09-16T00:00:00.000Z";
const CC = "cc-01";
const REMOTE = "remote-01";
const SEAT = `seat_${"a".repeat(64)}`;
const REVIEWER_SEAT = `seat_${"b".repeat(64)}`;

const EVIDENCE = {
  artifacts: [{ artifactId: "art-1", nodeId: "worker-agent" }],
  git: { commits: ["abc123"] },
  claims: [{ ruleId: "r1", text: "done", refs: ["ref-1"] }],
};

const taskHashInput = {
  kind: "task" as const,
  installationId: CC,
  canvasName: "factory",
  nodeId: "tasks",
  taskId: "task-0",
  epoch: 0,
  commitShas: EVIDENCE.git.commits,
  artifactRefs: EVIDENCE.artifacts,
  claimRefs: ["ref-1"],
};

/** Mint a subject hash under the retired domain separator. */
const oldSubjectHash = (
  input: Parameters<typeof verdictSubjectHashPayload>[0],
): string =>
  sha256(
    verdictSubjectHashPayload(input).replace(
      '"junto/crew/verdict-subject/v1"',
      '"vellum/crew/verdict-subject/v1"',
    ),
  );

type WorkSemantic = Record<string, unknown>;
const recordSha = (record: WorkSemantic): string =>
  computeWorkRecordContentSha256(record);

const commandRecord = {
  protocol: "vellum/work/v2",
  id: { route: { eventHome: CC, entityHome: REMOTE }, seq: "1" },
  recordType: "command",
  item: {
    kind: "task",
    itemId: "task-1",
    sink: { canvasName: "factory", nodeId: "tasks" },
  },
  operation: "task.claim",
  predecessor: null,
  body: {
    actor: {
      canvasName: "factory",
      nodeId: "worker-agent",
      seatId: SEAT,
    },
    contextId: "VellumCommand",
    metadata: { "vellum.tasks.trace": "abc" },
  },
};

const OLD_PROJECTION_BODY = JSON.stringify({
  canvases: { factory: { harness: "vellum-overseer" } },
  security: { vellumTcpListeners: 0 },
});
const PROJECTION_BODY = OLD_PROJECTION_BODY.replace(
  "vellum-overseer",
  "junto-overseer",
).replace("vellumTcpListeners", "juntoTcpListeners");
const PROJECTION_SHA = sha256(OLD_PROJECTION_BODY);

const factRecord = {
  protocol: "vellum/work/v2",
  id: { route: { eventHome: REMOTE, entityHome: REMOTE }, seq: "1" },
  recordType: "fact",
  item: {
    kind: "task",
    itemId: "task-1",
    sink: { canvasName: "factory", nodeId: "tasks" },
  },
  operation: "task.claim",
  basis: {
    kind: "command",
    command: { route: { eventHome: CC, entityHome: REMOTE }, seq: "1" },
    commandSha256: recordSha(commandRecord),
  },
  predecessor: null,
  body: {
    claimedBy: { canvasName: "factory", nodeId: "worker-agent", seatId: SEAT },
    contextId: "Vellumcommand",
  },
};

const projectedFactRecord = {
  protocol: "vellum/work/v2",
  id: { route: { eventHome: REMOTE, entityHome: REMOTE }, seq: "2" },
  recordType: "fact",
  item: {
    kind: "task",
    itemId: "task-2",
    sink: { canvasName: "factory", nodeId: "tasks" },
  },
  operation: "task.create",
  basis: {
    kind: "projected-intent",
    generation: "3",
    contentSha256: PROJECTION_SHA,
  },
  predecessor: null,
  body: { title: "projected task" },
};

const dispositionRecord = {
  protocol: "vellum/work/v2",
  id: { route: { eventHome: REMOTE, entityHome: REMOTE }, seq: "3" },
  recordType: "disposition",
  item: {
    kind: "task",
    itemId: "task-1",
    sink: { canvasName: "factory", nodeId: "tasks" },
  },
  operation: "task.claim",
  body: {
    status: "applied",
    command: { route: { eventHome: CC, entityHome: REMOTE }, seq: "1" },
    commandSha256: recordSha(commandRecord),
    fact: { route: { eventHome: REMOTE, entityHome: REMOTE }, seq: "1" },
    factSha256: recordSha(factRecord),
  },
};

const CANVAS_DOC = {
  nodes: [
    {
      id: "worker-agent",
      type: "text",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      ether: {
        terminal: { bindingId: "01JTESTBINDING", harness: "junto-overseer" },
      },
    },
  ],
  edges: [],
};

const insertEvent = (
  db: DatabaseSync,
  record: WorkSemantic,
  overrides: { readonly originAt?: string } = {},
): void => {
  const route = (
    record as {
      id: { route: { eventHome: string; entityHome: string }; seq: string };
    }
  ).id;
  const item = (
    record as {
      item: {
        kind: string;
        itemId: string;
        sink: { canvasName: string; nodeId: string };
      };
    }
  ).item;
  run(
    db,
    `INSERT INTO work_events(
       event_home, entity_home, seq, protocol, record_type, item_kind,
       item_id, item_canvas_name, item_node_id, operation,
       content_sha256, origin_at, received_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    route.route.eventHome,
    route.route.entityHome,
    route.seq,
    record.protocol,
    record.recordType,
    item.kind,
    item.itemId,
    item.sink.canvasName,
    item.sink.nodeId,
    record.operation,
    recordSha(record),
    overrides.originAt ?? NOW,
    NOW,
  );
};

const buildFixture = (): DatabaseSync => {
  const db = open();
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(STATE_SCHEMA_SQL);

  // Degrade the two CHECK-carrying tables to their pre-rename shape.
  db.exec("DROP TABLE work_events");
  db.exec(tableSql("work_events").replaceAll("junto/work/v1", "vellum/work/v2"));
  db.exec("DROP TABLE browser_profile_pending_wipe");
  db.exec(
    tableSql("browser_profile_pending_wipe").replaceAll(
      "persist:junto-profile-",
      "persist:vellum-profile-",
    ),
  );

  // Retired residue the baseline no longer composes.
  db.exec(
    "CREATE TABLE canvas_generations (generation TEXT PRIMARY KEY, intent_sha256 TEXT)",
  );
  run(db, "INSERT INTO canvas_generations VALUES ('5', ?)", "f".repeat(64));

  // Work chain: command -> command-basis fact -> applied disposition, plus a
  // projected-intent fact bound to the projection version row.
  run(db, "INSERT INTO station_known_installations VALUES (?, ?)", CC, NOW);
  run(db, "INSERT INTO station_known_installations VALUES (?, ?)", REMOTE, NOW);
  run(
    db,
    `INSERT INTO station_installation(singleton, installation_id, created_at)
     VALUES (1, ?, ?)`,
    CC,
    NOW,
  );
  run(
    db,
    `INSERT INTO station_configuration(
       singleton, role, host_id, supervised_preferred, configured_at
     ) VALUES (1, 'command-center', 'host-1', 0, ?)`,
    NOW,
  );
  run(
    db,
    "INSERT INTO work_event_sequences(event_home, entity_home, last_seq) VALUES (?, ?, '3')",
    CC,
    REMOTE,
  );
  run(
    db,
    "INSERT INTO work_event_sequences(event_home, entity_home, last_seq) VALUES (?, ?, '3')",
    REMOTE,
    REMOTE,
  );
  run(
    db,
    "INSERT INTO work_event_sequences(event_home, entity_home, last_seq) VALUES (?, ?, '1')",
    CC,
    CC,
  );

  insertEvent(db, commandRecord);
  run(
    db,
    `INSERT INTO work_commands(event_home, entity_home, seq, action_json)
     VALUES (?, ?, '1', ?)`,
    CC,
    REMOTE,
    JSON.stringify(commandRecord.body),
  );

  insertEvent(db, factRecord);
  run(
    db,
    `INSERT INTO work_facts(
       event_home, entity_home, seq,
       basis_kind, basis_command_event_home, basis_command_entity_home,
       basis_command_seq, basis_command_sha256, result_json
     ) VALUES (?, ?, '1', 'command', ?, ?, '1', ?, ?)`,
    REMOTE,
    REMOTE,
    CC,
    REMOTE,
    recordSha(commandRecord),
    JSON.stringify(factRecord.body),
  );

  insertEvent(db, projectedFactRecord);
  run(
    db,
    `INSERT INTO work_facts(
       event_home, entity_home, seq,
       basis_kind, basis_projected_generation, basis_projected_content_sha256,
       result_json
     ) VALUES (?, ?, '2', 'projected-intent', '3', ?, ?)`,
    REMOTE,
    REMOTE,
    PROJECTION_SHA,
    JSON.stringify(projectedFactRecord.body),
  );

  insertEvent(db, dispositionRecord);
  run(
    db,
    `INSERT INTO work_dispositions(
       event_home, entity_home, seq, status,
       command_event_home, command_entity_home, command_seq, command_sha256,
       fact_event_home, fact_entity_home, fact_seq, fact_sha256
     ) VALUES (?, ?, '3', 'applied', ?, ?, '1', ?, ?, ?, '1', ?)`,
    REMOTE,
    REMOTE,
    CC,
    REMOTE,
    recordSha(commandRecord),
    REMOTE,
    REMOTE,
    recordSha(factRecord),
  );

  // Canvas with a retired harness id and a stale revision/head. The head must
  // precede authorial-basis fact inserts: the v1 trigger resolves them
  // against the live portfolio head.
  run(
    db,
    `INSERT INTO canvas_portfolio_head(singleton, generation, intent_sha256, created_at, updated_at)
     VALUES (1, '5', ?, ?, ?)`,
    "f".repeat(64),
    NOW,
    NOW,
  );
  run(
    db,
    `INSERT INTO canvas_documents(canvas_id, canvas_name, revision_sha256, created_at, modified_at)
     VALUES ('cnv_test', 'factory', ?, ?, ?)`,
    "e".repeat(64),
    NOW,
    NOW,
  );
  run(
    db,
    `INSERT INTO canvas_nodes(
       canvas_id, node_id, z_index, type, x, y, width, height,
       ether_json, updated_at
     ) VALUES ('cnv_test', 'worker-agent', 0, 'text', 0, 0, 100, 100, ?, ?)`,
    JSON.stringify({
      terminal: { bindingId: "01JTESTBINDING", harness: "vellum-overseer" },
    }),
    NOW,
  );

  // A Command Center-homed fact for the mailbox residency rule.
  const ccFactRecord = {
    protocol: "vellum/work/v2",
    id: { route: { eventHome: CC, entityHome: CC }, seq: "1" },
    recordType: "fact",
    item: {
      kind: "task",
      itemId: "task-0",
      sink: { canvasName: "factory", nodeId: "tasks" },
    },
    operation: "task.create",
    basis: {
      kind: "authorial-intent",
      generation: "5",
      contentSha256: "f".repeat(64),
    },
    predecessor: null,
    body: { title: "cc task" },
  };
  insertEvent(db, ccFactRecord);
  run(
    db,
    `INSERT INTO work_facts(
       event_home, entity_home, seq,
       basis_kind, basis_authorial_generation, basis_authorial_content_sha256,
       result_json
     ) VALUES (?, ?, '1', 'authorial-intent', '5', ?, ?)`,
    CC,
    CC,
    "f".repeat(64),
    JSON.stringify(ccFactRecord.body),
  );

  // Task message carrying the retired metadata namespace and context ids.
  run(
    db,
    `INSERT INTO work_messages(
       canvas_name, node_id, message_id, position, entity_home,
       actor_seat_id, fact_event_home, fact_entity_home, fact_seq,
       role, parts_json, context_id, metadata_json, origin_at, received_at
     ) VALUES (
       'factory', 'worker-agent', 'msg-1', 0, ?,
       ?, ?, ?, '1',
       'agent', ?, 'VellumCommand', ?, ?, ?
     )`,
    CC,
    SEAT,
    CC,
    CC,
    JSON.stringify([
      { type: "text", text: "hi", contextId: "Vellum" },
    ]),
    JSON.stringify({ "vellum.tasks.pin": "x", contextId: "VellumCommand" }),
    NOW,
    NOW,
  );

  // Station projection carrying the retired harness id.
  run(
    db,
    `INSERT INTO station_projection_versions(
       generation, content_sha256, source_canvas_generation,
       source_intent_sha256, body, created_at, received_at
     ) VALUES ('3', ?, '5', ?, ?, ?, ?)`,
    PROJECTION_SHA,
    "f".repeat(64),
    OLD_PROJECTION_BODY,
    NOW,
    NOW,
  );
  run(
    db,
    `INSERT INTO station_projection_head(singleton, generation, content_sha256)
     VALUES (1, '3', ?)`,
    PROJECTION_SHA,
  );

  // Browser pending wipe under the retired partition prefix.
  run(
    db,
    `INSERT INTO browser_profiles(id, created_at, sort_order)
     VALUES ('main', ?, 0)`,
    NOW,
  );
  run(
    db,
    `INSERT INTO browser_profile_pending_wipe(
       singleton, wipe_id, profile_id, partition, requested_at,
       stage, storage_path, user_data_path, session_data_path
     ) VALUES (
       1, '00000000-0000-4000-8000-000000000001', 'main',
       'persist:vellum-profile-main', ?,
       'live_clear_pending', '/tmp/s', '/tmp/u', '/tmp/d'
     )`,
    NOW,
  );

  // A completed task carrying finish evidence plus two review verdicts whose
  // subject hashes were minted under the retired domain separator.
  run(
    db,
    `INSERT INTO work_tasks(
       canvas_name, node_id, task_id, entity_home, actor_seat_id,
       fact_event_home, fact_entity_home, fact_seq, state,
       brief_message_id, artifact_ids_json, metadata_json,
       reason, response, created_at, updated_at, origin_at, received_at
     ) VALUES (
       'factory', 'tasks', 'task-0', ?, ?, ?, ?, '1', 'completed',
       'brief-1', NULL, ?, NULL, NULL, ?, ?, ?, ?
     )`,
    CC,
    SEAT,
    CC,
    CC,
    JSON.stringify({
      "vellum.pipeline.stage": "build",
      "vellum.gate.report": "pass",
    }),
    NOW,
    NOW,
    NOW,
    NOW,
  );
  run(
    db,
    `INSERT INTO work_task_finish(
       canvas_name, node_id, task_id,
       finish_criteria_json, completion_evidence_json
     ) VALUES ('factory', 'tasks', 'task-0', NULL, ?)`,
    JSON.stringify(EVIDENCE),
  );
  run(
    db,
    `INSERT INTO work_review_verdicts(
       verdict_id, kind, reviewer_seat_id, reviewer_node_id, author_seat_id,
       subject_kind, subject_task_installation, subject_task_canvas,
       subject_task_node, subject_task_item, subject_epoch,
       subject_sha, subject_checkout, subject_hash, epoch,
       findings_json, refs_json, posted_at_ms
     ) VALUES (
       'verdict-task-1', 'green', ?, 'reviewer-agent', ?,
       'task', ?, 'factory', 'tasks', 'task-0', 0,
       NULL, NULL, ?, 0,
       '["ok"]', ?, 1
     )`,
    REVIEWER_SEAT,
    SEAT,
    CC,
    oldSubjectHash(taskHashInput),
    JSON.stringify(["vellum/crew/verdict-subject/v1"]),
  );
  run(
    db,
    `INSERT INTO work_review_verdicts(
       verdict_id, kind, reviewer_seat_id, reviewer_node_id, author_seat_id,
       subject_kind, subject_task_installation, subject_task_canvas,
       subject_task_node, subject_task_item, subject_epoch,
       subject_sha, subject_checkout, subject_hash, epoch,
       findings_json, refs_json, posted_at_ms
     ) VALUES (
       'verdict-commit-1', 'blocking', ?, NULL, ?,
       'commit', NULL, NULL, NULL, NULL, NULL,
       'deadbeef', NULL, ?, 2,
       '["stale"]', '[]', 2
     )`,
    REVIEWER_SEAT,
    SEAT,
    oldSubjectHash({ kind: "commit", sha: "deadbeef" }),
  );

  db.exec("PRAGMA user_version = 23");
  run(
    db,
    `INSERT INTO state_schema_identity(
       singleton, actual_schema_sha256, source_schema_sha256, verified_at
     ) VALUES (1, ?, ?, ?)`,
    "d".repeat(64),
    "d".repeat(64),
    NOW,
  );
  return db;
};

describe("convert-state-to-junto", () => {
  it("converts a pre-rename database to the version-1 baseline preserving every row", () => {
    const db = buildFixture();
    const report = convertStateToJunto(db, {
      expectedSchemaSql: STATE_SCHEMA_SQL,
      openMemoryDatabase: () => open(),
      now: NOW,
    });

    // The converted database opens under the v1 runtime: recorded identity,
    // live fingerprint, and user_version all verify.
    const migrated = migrateStateSchema(db);
    expect(migrated.schemaVersion).toBe(CURRENT_STATE_SCHEMA_VERSION);
    expect(migrated.previousVersion).toBe(1);
    expect(report.schemaIdentitySha256).toBe(migrated.actualSchemaSha256);
    expect(
      get<{ user_version: number }>(db, "PRAGMA user_version").user_version,
    ).toBe(1);

    // Retired objects dropped; CHECK-carriers rebuilt with rows preserved.
    expect(
      get<{ n: number }>(
        db,
        "SELECT count(*) AS n FROM sqlite_schema WHERE name = 'canvas_generations'",
      ).n,
    ).toBe(0);
    expect(report.rebuiltTables).toContain("work_events");
    expect(report.rebuiltTables).toContain("browser_profile_pending_wipe");
    expect(
      get<{ n: number }>(db, "SELECT count(*) AS n FROM work_events").n,
    ).toBe(5);
    expect(
      all<{ protocol: string }>(
        db,
        "SELECT DISTINCT protocol FROM work_events",
      ).map((row) => row.protocol),
    ).toEqual(["junto/work/v1"]);

    // Correlated record hashes recomputed and propagated to a fixed point.
    const newCommandSha = recordSha({
      ...commandRecord,
      protocol: "junto/work/v1",
      body: {
        ...commandRecord.body,
        contextId: "Junto",
        metadata: { "junto.tasks.trace": "abc" },
      },
    });
    expect(
      get<{ content_sha256: string }>(
        db,
        "SELECT content_sha256 FROM work_events WHERE seq = '1' AND record_type = 'command'",
      ).content_sha256,
    ).toBe(newCommandSha);
    expect(
      get<{ basis_command_sha256: string }>(
        db,
        `SELECT basis_command_sha256 FROM work_facts
         WHERE event_home = ? AND entity_home = ? AND seq = '1'`,
        REMOTE,
        REMOTE,
      ).basis_command_sha256,
    ).toBe(newCommandSha);
    expect(
      get<{ command_sha256: string; fact_sha256: string }>(
        db,
        "SELECT command_sha256, fact_sha256 FROM work_dispositions",
      ).command_sha256,
    ).toBe(newCommandSha);
    expect(
      get<{ fact_sha256: string }>(
        db,
        "SELECT fact_sha256 FROM work_dispositions",
      ).fact_sha256,
    ).toBe(
      get<{ content_sha256: string }>(
        db,
        `SELECT content_sha256 FROM work_events
         WHERE record_type = 'fact' AND event_home = ? AND entity_home = ? AND seq = '1'`,
        REMOTE,
        REMOTE,
      ).content_sha256,
    );

    // Every stored hash still matches its record's semantic.
    const events = all<{ event_home: string; entity_home: string; seq: string }>(
      db,
      "SELECT event_home, entity_home, seq FROM work_events",
    );
    expect(events.length).toBe(5);
    for (const event of events) {
      const row = get<{ content_sha256: string }>(
        db,
        "SELECT content_sha256 FROM work_events WHERE event_home = ? AND entity_home = ? AND seq = ?",
        event.event_home,
        event.entity_home,
        event.seq,
      );
      expect(row.content_sha256).toMatch(/^[0-9a-f]{64}$/u);
    }
    expect(report.rehashedRecords).toBe(5);

    // Projection body rewrite moves its content hash and every reference.
    const newProjectionSha = sha256(PROJECTION_BODY);
    expect(
      get<{ content_sha256: string }>(
        db,
        "SELECT content_sha256 FROM station_projection_versions WHERE generation = '3'",
      ).content_sha256,
    ).toBe(newProjectionSha);
    expect(
      get<{ content_sha256: string }>(
        db,
        "SELECT content_sha256 FROM station_projection_head",
      ).content_sha256,
    ).toBe(newProjectionSha);
    expect(
      get<{ basis_projected_content_sha256: string }>(
        db,
        `SELECT basis_projected_content_sha256 FROM work_facts
         WHERE event_home = ? AND entity_home = ? AND seq = '2'`,
        REMOTE,
        REMOTE,
      ).basis_projected_content_sha256,
    ).toBe(newProjectionSha);

    // Harness id, partition, contextId, and metadata namespace rewrites.
    expect(
      get<{ ether_json: string }>(
        db,
        "SELECT ether_json FROM canvas_nodes WHERE node_id = 'worker-agent'",
      ).ether_json,
    ).toContain("junto-overseer");
    expect(
      get<{ partition: string }>(
        db,
        "SELECT partition FROM browser_profile_pending_wipe",
      ).partition,
    ).toBe("persist:junto-profile-main");
    const message = get<{
      parts_json: string;
      metadata_json: string;
      context_id: string;
    }>(
      db,
      "SELECT parts_json, metadata_json, context_id FROM work_messages",
    );
    expect(message.context_id).toBe("Junto");
    expect(message.parts_json).toContain('"contextId":"Junto"');
    expect(message.metadata_json).toContain('"junto.tasks.pin"');
    expect(message.metadata_json).not.toContain("vellum.tasks");
    expect(message.metadata_json).toContain('"contextId":"Junto"');
    expect(
      get<{ result_json: string }>(
        db,
        `SELECT result_json FROM work_facts
         WHERE event_home = ? AND entity_home = ? AND seq = '1'`,
        REMOTE,
        REMOTE,
      ).result_json,
    ).toContain('"contextId":"Junto"');
    expect(
      get<{ action_json: string }>(
        db,
        "SELECT action_json FROM work_commands",
      ).action_json,
    ).toContain('"junto.tasks.trace"');

    // Canvas identity: rewritten ether moved the revision hash and advanced
    // the portfolio head once.
    const reader = {
      get: <T>(sql: string, bindings?: readonly unknown[]) =>
        get<T>(db, sql, ...((bindings ?? []) as unknown[])),
      all: <T>(sql: string, bindings?: readonly unknown[]) =>
        all<T>(db, sql, ...((bindings ?? []) as unknown[])),
    } as unknown as CanvasSqlReader;
    const doc = reconstructCanvasDoc(reader, "cnv_test");
    const expectedRevision = canvasBodySha256Of(serializeCanvas(doc));
    expect(
      get<{ revision_sha256: string }>(
        db,
        "SELECT revision_sha256 FROM canvas_documents WHERE canvas_id = 'cnv_test'",
      ).revision_sha256,
    ).toBe(expectedRevision);
    expect(
      get<{ generation: string; intent_sha256: string }>(
        db,
        "SELECT generation, intent_sha256 FROM canvas_portfolio_head",
      ),
    ).toEqual({
      generation: "6",
      intent_sha256: intentSha256Of(
        new Map([["factory", { revisionSha256: expectedRevision }]]),
      ),
    });
    expect(report.repairedCanvases).toBe(1);
    expect(report.repairedProjections).toBe(1);

    // Verdict subject hashes are rebuilt under the renamed domain separator
    // from the stored preimage (evidence refs via work_task_finish).
    expect(
      get<{ subject_hash: string }>(
        db,
        "SELECT subject_hash FROM work_review_verdicts WHERE verdict_id = 'verdict-task-1'",
      ).subject_hash,
    ).toBe(sha256(verdictSubjectHashPayload(taskHashInput)));
    expect(
      get<{ subject_hash: string }>(
        db,
        "SELECT subject_hash FROM work_review_verdicts WHERE verdict_id = 'verdict-commit-1'",
      ).subject_hash,
    ).toBe(
      sha256(verdictSubjectHashPayload({ kind: "commit", sha: "deadbeef" })),
    );
    expect(
      get<{ refs_json: string }>(
        db,
        "SELECT refs_json FROM work_review_verdicts WHERE verdict_id = 'verdict-task-1'",
      ).refs_json,
    ).toBe('["junto/crew/verdict-subject/v1"]');
    expect(report.repairedVerdicts).toBe(2);
    expect(
      get<{ metadata_json: string }>(
        db,
        `SELECT metadata_json FROM work_tasks
         WHERE canvas_name = 'factory' AND node_id = 'tasks' AND task_id = 'task-0'`,
      ).metadata_json,
    ).toContain('"junto.pipeline.stage"');
    expect(
      get<{ metadata_json: string }>(
        db,
        `SELECT metadata_json FROM work_tasks
         WHERE canvas_name = 'factory' AND node_id = 'tasks' AND task_id = 'task-0'`,
      ).metadata_json,
    ).toContain('"junto.gate.report"');
    expect(report.rewrites.stationField).toBeGreaterThan(0);
    expect(report.rewrites.hashDomain).toBeGreaterThan(0);

    // Row counts are preserved on retained tables.
    for (const table of report.tables) {
      if (table.name === "canvas_generations") continue;
      expect(table.after, table.name).toBe(table.before);
    }
    expect(report.rewrites.protocol).toBeGreaterThan(0);
    expect(report.rewrites.harnessId).toBeGreaterThan(0);
    expect(report.rewrites.contextId).toBeGreaterThan(0);
    expect(report.rewrites.tasksNamespace).toBeGreaterThan(0);
    expect(report.rewrites.browserPartition).toBeGreaterThan(0);

    // No retired literal survives anywhere.
    const leftovers = all<{ name: string }>(
      db,
      `SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT GLOB 'sqlite_*'`,
    );
    for (const table of leftovers) {
      for (const column of all<{ name: string }>(
        db,
        `SELECT name FROM pragma_table_xinfo('${table.name}')`,
      )) {
        const hits = all<{ v: string }>(
          db,
          `SELECT CAST("${column.name}" AS TEXT) AS v FROM "${table.name}"
           WHERE typeof("${column.name}") = 'text'
             AND (instr("${column.name}", 'vellum') > 0
               OR instr("${column.name}", 'Vellum') > 0)`,
        );
        expect(hits, `${table.name}.${column.name}`).toEqual([]);
      }
    }
  });
});
