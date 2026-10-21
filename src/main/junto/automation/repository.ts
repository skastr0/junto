import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
  Automation,
  type AutomationId,
  type AutomationFiringsRequest,
  type Firing as FiringType,
  Firing,
  FIRINGS_PAGE_MAX,
  type FiringCause,
  type FiringOutcome,
  type LastOutcome,
  lastOutcomeOf,
} from "@shared/automation";
import {
  type AutomationFact,
  type AutomationState,
  applyAutomationFact,
} from "@shared/automation-domain";
import type { NodeId } from "@shared/physics/schema";
import { StateTransactionOperation } from "../state/service";

export class AutomationPersistenceError extends Schema.TaggedError<AutomationPersistenceError>()(
  "AutomationPersistenceError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Unknown,
  },
) {}

/** Firings kept per automation (07): older ones are pruned as new ones are claimed. */
export const FIRINGS_KEPT = 1_000;

export type ClaimResult = { readonly _tag: "Claimed" } | { readonly _tag: "Duplicate" };

/**
 * Automation storage on the editing machine (state-schema.ts). The ruled
 * heads are folded from domain facts by `applyFacts`; the runner keeps its
 * cursors and claims its firings here.
 */
export class AutomationRepository extends Context.Service<AutomationRepository,
  {
    /** Every automation of a canvas, archived included, as the ruler's state. */
    readonly loadState: (canvasName: string) => Effect.Effect<AutomationState, AutomationPersistenceError>;
    /** Fold ruled facts into the stored heads, in one transaction. */
    readonly applyFacts: (
      canvasName: string,
      facts: ReadonlyArray<AutomationFact>,
    ) => Effect.Effect<void, AutomationPersistenceError>;
    /** The live automations on one node, newest change first. */
    readonly list: (
      canvasName: string,
      nodeId: NodeId,
    ) => Effect.Effect<ReadonlyArray<Automation>, AutomationPersistenceError>;
    /** What each live automation's newest firing came to, by automation id; one that never fired has no key. */
    readonly lastOutcomes: (
      canvasName: string,
      nodeId: NodeId,
    ) => Effect.Effect<Readonly<Record<string, LastOutcome>>, AutomationPersistenceError>;
    readonly cursor: (
      canvasName: string,
      automationId: AutomationId,
    ) => Effect.Effect<number | undefined, AutomationPersistenceError>;
    readonly setCursor: (
      canvasName: string,
      automationId: AutomationId,
      cursorEpochMs: number,
    ) => Effect.Effect<void, AutomationPersistenceError>;
    /** How far change triggers have read this canvas's task rulings; undefined before the first pass. */
    readonly rulingCursor: (canvasName: string) => Effect.Effect<string | undefined, AutomationPersistenceError>;
    readonly setRulingCursor: (canvasName: string, seq: string) => Effect.Effect<void, AutomationPersistenceError>;
    /**
     * The applied task rulings that brought a task into a state, after `after`
     * in the order they landed here, from at most `limit` rows; `through` is
     * the seq the next read starts after, and `more` says the page was full,
     * counted before any row that does not decode is dropped.
     */
    readonly taskRulingsSince: (
      canvasName: string,
      after: string,
      limit: number,
    ) => Effect.Effect<
      { readonly rulings: ReadonlyArray<TaskRuling>; readonly through: string; readonly more: boolean },
      AutomationPersistenceError
    >;
    /** Record a considered firing once per claim key; a second claim is `Duplicate` and writes nothing. */
    readonly claimFiring: (canvasName: string, firing: FiringType) => Effect.Effect<ClaimResult, AutomationPersistenceError>;
    /** Replace a claimed firing's outcome once its actions are ruled. */
    readonly settleFiring: (
      canvasName: string,
      firing: FiringType,
      outcome: FiringOutcome,
    ) => Effect.Effect<void, AutomationPersistenceError>;
    /** When an automation fired at or after `sinceEpochMs`, claimed firings included; skips are not listed. */
    readonly firedSince: (
      canvasName: string,
      automationId: AutomationId,
      sinceEpochMs: number,
    ) => Effect.Effect<ReadonlyArray<number>, AutomationPersistenceError>;
    /** One page of firings, newest first. */
    readonly firings: (
      canvasName: string,
      request: AutomationFiringsRequest,
    ) => Effect.Effect<ReadonlyArray<FiringType>, AutomationPersistenceError>;
  }>()("@junto/AutomationRepository") {}

/** An applied task ruling that brought its task into a state, as a change trigger reads it. */
export type TaskRuling = {
  readonly opId: string;
  readonly taskId: string;
  readonly node: string;
  readonly became: string;
  /** Ruled on an automation's command: it never triggers an automation. */
  readonly byAutomation: boolean;
};

const parseRecord = (json: string): { readonly taskId?: unknown; readonly node?: unknown; readonly became?: unknown } | undefined => {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
};

/** The seq before every ruling: a cursor read from here fires each one. */
export const RULINGS_START = "0";

/** The claim key: a slot, a transition key, or a run's own firing id. */
export const claimKeyOf = (firing: FiringType): string => {
  const cause: FiringCause = firing.cause;
  switch (cause.kind) {
    case "schedule":
    case "poll":
      return String(cause.slot);
    case "change":
      return cause.key;
    case "run":
      return firing.firingId;
    default:
      return cause satisfies never;
  }
};

/**
 * Archive every live automation on a deleted Automations node, inside the
 * canvas change that deletes it. Deleting a node is a canvas act of the
 * operator or an overseer, so it is never refused for holding automations;
 * their history stays, and the runner skips archived ones.
 */
export const archiveAutomationsOnNode = (sql: SqlClient.SqlClient, canvasName: string, nodeId: string, at: number) =>
  Effect.gen(function* () {
    // Which ones this delete archived, for its undo.
    yield* sql`
      INSERT OR IGNORE INTO automation_node_archives(canvas_name, node_id, automation_id)
      SELECT canvas_name, node_id, automation_id FROM automations
      WHERE canvas_name = ${canvasName} AND node_id = ${nodeId} AND archived = 0
    `;
    yield* sql`
      UPDATE automations SET archived = 1, updated_at_epoch_ms = ${at}
      WHERE canvas_name = ${canvasName} AND node_id = ${nodeId} AND archived = 0
    `;
  });

/**
 * Undo of a node delete puts the node back with the same id: unarchive
 * exactly the automations that delete archived, each as it was, enabled or
 * not. A schedule that missed slots meanwhile fires once for its latest.
 */
export const restoreAutomationsOnNode = (sql: SqlClient.SqlClient, canvasName: string, nodeId: string, at: number) =>
  Effect.gen(function* () {
    yield* sql`
      UPDATE automations SET archived = 0, updated_at_epoch_ms = ${at}
      WHERE canvas_name = ${canvasName} AND node_id = ${nodeId} AND automation_id IN (
        SELECT automation_id FROM automation_node_archives WHERE canvas_name = ${canvasName} AND node_id = ${nodeId}
      )
    `;
    yield* sql`DELETE FROM automation_node_archives WHERE canvas_name = ${canvasName} AND node_id = ${nodeId}`;
  });

/** A claimed firing may have run its actions (at most once), so the limits count it. */
const countsAsFired = (outcome: FiringOutcome): boolean => outcome.kind !== "skipped";

const encodeAutomation = Schema.encodeSync(Automation);
const decodeAutomation = Schema.decodeUnknownSync(Automation);
const encodeFiring = Schema.encodeSync(Firing);
const decodeFiring = Schema.decodeUnknownSync(Firing);

const failure = (operation: string) => (error: unknown) =>
  AutomationPersistenceError.make({
    operation,
    message: error instanceof Error ? error.message : String(error),
    cause: error,
  });

type AutomationRow = { readonly automation_json: string; readonly archived: number; readonly updated_at_epoch_ms: number };

export const makeAutomationRepositoryLive = (): Layer.Layer<AutomationRepository, never, SqlClient.SqlClient> =>
  Layer.effect(
    AutomationRepository,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const transaction = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
        sql.withTransaction(effect).pipe(
          Effect.provideService(StateTransactionOperation, `automation.${operation}`),
          Effect.mapError(failure(operation)),
        );

      const loadState = Effect.fn("AutomationRepository.loadState")(function* (canvasName: string) {
        const rows = yield* sql<AutomationRow>`
          SELECT automation_json, archived, updated_at_epoch_ms FROM automations WHERE canvas_name = ${canvasName}
        `.pipe(Effect.mapError(failure("load-state")));
        return yield* Effect.try({
          try: (): AutomationState =>
            new Map(rows.map((row) => {
              const automation = decodeAutomation(JSON.parse(row.automation_json));
              return [automation.automationId, { automation, archived: row.archived === 1, updatedAt: row.updated_at_epoch_ms }];
            })),
          catch: failure("load-state"),
        });
      });

      const applyFacts = Effect.fn("AutomationRepository.applyFacts")(function* (
        canvasName: string,
        facts: ReadonlyArray<AutomationFact>,
      ) {
        if (facts.length === 0) return;
        yield* transaction("apply-facts", Effect.gen(function* () {
          const before = yield* loadState(canvasName);
          const after = facts.reduce(applyAutomationFact, before);
          for (const [automationId, entry] of after) {
            if (before.get(automationId) === entry) continue;
            const json = JSON.stringify(encodeAutomation(entry.automation));
            yield* sql`
              INSERT INTO automations(canvas_name, automation_id, node_id, version, archived, updated_at_epoch_ms, automation_json)
              VALUES (${canvasName}, ${automationId}, ${entry.automation.nodeId}, ${entry.automation.version},
                ${entry.archived ? 1 : 0}, ${entry.updatedAt}, ${json})
              ON CONFLICT (canvas_name, automation_id) DO UPDATE SET
                node_id = excluded.node_id, version = excluded.version, archived = excluded.archived,
                updated_at_epoch_ms = excluded.updated_at_epoch_ms, automation_json = excluded.automation_json
            `;
          }
        }));
      });

      const list = Effect.fn("AutomationRepository.list")(function* (canvasName: string, nodeId: NodeId) {
        const rows = yield* sql<{ readonly automation_json: string }>`
          SELECT automation_json FROM automations
          WHERE canvas_name = ${canvasName} AND node_id = ${nodeId} AND archived = 0
          ORDER BY updated_at_epoch_ms DESC, automation_id DESC
        `.pipe(Effect.mapError(failure("list")));
        return yield* Effect.try({
          try: () => rows.map((row) => decodeAutomation(JSON.parse(row.automation_json))),
          catch: failure("list"),
        });
      });

      const lastOutcomes = Effect.fn("AutomationRepository.lastOutcomes")(function* (canvasName: string, nodeId: NodeId) {
        const rows = yield* sql<{ readonly firing_json: string }>`
          SELECT f.firing_json FROM automation_firings f
          JOIN automations a ON a.canvas_name = f.canvas_name AND a.automation_id = f.automation_id
          WHERE a.canvas_name = ${canvasName} AND a.node_id = ${nodeId} AND a.archived = 0
            AND f.firing_id = (
              SELECT MAX(g.firing_id) FROM automation_firings g
              WHERE g.canvas_name = f.canvas_name AND g.automation_id = f.automation_id
            )
        `.pipe(Effect.mapError(failure("lastOutcomes")));
        return yield* Effect.try({
          try: () => {
            const byAutomation: Record<string, LastOutcome> = {};
            for (const row of rows) {
              const firing = decodeFiring(JSON.parse(row.firing_json));
              byAutomation[firing.automationId] = lastOutcomeOf(firing.outcome);
            }
            return byAutomation;
          },
          catch: failure("lastOutcomes"),
        });
      });

      const cursor = Effect.fn("AutomationRepository.cursor")(function* (canvasName: string, automationId: AutomationId) {
        const rows = yield* sql<{ readonly cursor_epoch_ms: number }>`
          SELECT cursor_epoch_ms FROM automation_cursors WHERE canvas_name = ${canvasName} AND automation_id = ${automationId}
        `.pipe(Effect.mapError(failure("cursor")));
        return rows[0]?.cursor_epoch_ms;
      });

      const setCursor = Effect.fn("AutomationRepository.setCursor")(function* (
        canvasName: string,
        automationId: AutomationId,
        cursorEpochMs: number,
      ) {
        yield* sql`
          INSERT INTO automation_cursors(canvas_name, automation_id, cursor_epoch_ms)
          VALUES (${canvasName}, ${automationId}, ${cursorEpochMs})
          ON CONFLICT (canvas_name, automation_id) DO UPDATE SET cursor_epoch_ms = excluded.cursor_epoch_ms
        `.pipe(Effect.mapError(failure("set-cursor")));
      });

      const rulingCursor = Effect.fn("AutomationRepository.rulingCursor")(function* (canvasName: string) {
        const rows = yield* sql<{ readonly seq: string }>`
          SELECT seq FROM automation_ruling_cursors WHERE canvas_name = ${canvasName}
        `.pipe(Effect.mapError(failure("ruling-cursor")));
        return rows[0]?.seq;
      });

      const setRulingCursor = Effect.fn("AutomationRepository.setRulingCursor")(function* (canvasName: string, seq: string) {
        yield* sql`
          INSERT INTO automation_ruling_cursors(canvas_name, seq) VALUES (${canvasName}, ${seq})
          ON CONFLICT (canvas_name) DO UPDATE SET seq = excluded.seq
        `.pipe(Effect.mapError(failure("set-ruling-cursor")));
      });

      // A ruling's `ruling.applied` fact commits with it (ruling-recorder.ts), so this
      // machine's event seq is the order rulings landed; seqs order by length, then text.
      const taskRulingsSince = Effect.fn("AutomationRepository.taskRulingsSince")(function* (
        canvasName: string,
        after: string,
        limit: number,
      ) {
        return yield* transaction("task-rulings-since", Effect.gen(function* () {
          // Read the newest seq first: a ruling that lands after it is past it, and read next time.
          const newest = yield* sql<{ readonly seq: string }>`
            SELECT seq FROM work_events
            WHERE event_home = (SELECT installation_id FROM installation WHERE singleton = 1) AND entity_home = event_home
            ORDER BY length(seq) DESC, seq DESC LIMIT 1
          `;
          const mark = newest[0]?.seq ?? RULINGS_START;
          const rows = yield* sql<{
            readonly seq: string;
            readonly op_id: string;
            readonly ruling_json: string;
            readonly actor_kind: string;
          }>`
            SELECT e.seq AS seq, r.op_id AS op_id, r.ruling_json AS ruling_json, r.actor_kind AS actor_kind
            FROM work_events AS e
            JOIN resource_rulings AS r ON r.canvas_name = e.item_canvas_name AND r.op_id = e.item_id
            WHERE e.event_home = (SELECT installation_id FROM installation WHERE singleton = 1) AND e.entity_home = e.event_home
              AND e.item_kind = 'ruling' AND e.item_canvas_name = ${canvasName}
              AND (length(e.seq) > ${after.length} OR (length(e.seq) = ${after.length} AND e.seq > ${after}))
              AND (length(e.seq) < ${mark.length} OR (length(e.seq) = ${mark.length} AND e.seq <= ${mark}))
              AND r.kind = 'applied' AND json_extract(r.ruling_json, '$.became') IS NOT NULL
            ORDER BY length(e.seq), e.seq
            LIMIT ${limit}
          `;
          const rulings = rows.flatMap((row): ReadonlyArray<TaskRuling> => {
            const record = parseRecord(row.ruling_json);
            if (record === undefined || typeof record.taskId !== "string" || typeof record.node !== "string" || typeof record.became !== "string") return [];
            return [{ opId: row.op_id, taskId: record.taskId, node: record.node, became: record.became, byAutomation: row.actor_kind === "automation" }];
          });
          // A full page stops at its last row; a short one has read through the mark.
          const more = rows.length === limit;
          return { rulings, through: more ? rows[rows.length - 1]!.seq : mark, more };
        }));
      });

      const claimFiring = Effect.fn("AutomationRepository.claimFiring")(function* (canvasName: string, firing: FiringType) {
        return yield* transaction("claim-firing", Effect.gen(function* () {
          // Only the claim key may conflict: a CHECK failure or a firing id
          // collision is an error, never a silent Duplicate.
          const rows = yield* sql<{ readonly firing_id: string }>`
            INSERT INTO automation_firings(
              canvas_name, automation_id, cause_kind, claim_key, firing_id, at_epoch_ms, fired, firing_json
            ) VALUES (${canvasName}, ${firing.automationId}, ${firing.cause.kind}, ${claimKeyOf(firing)}, ${firing.firingId},
              ${firing.at}, ${countsAsFired(firing.outcome) ? 1 : 0}, ${JSON.stringify(encodeFiring(firing))})
            ON CONFLICT (canvas_name, automation_id, cause_kind, claim_key) DO NOTHING
            RETURNING firing_id
          `;
          if (rows.length !== 1) return { _tag: "Duplicate" } as const;
          // Keep the newest FIRINGS_KEPT; the cursor's own slot is never pruned.
          yield* sql`
            DELETE FROM automation_firings
            WHERE canvas_name = ${canvasName} AND automation_id = ${firing.automationId}
              AND firing_id NOT IN (
                SELECT firing_id FROM automation_firings
                WHERE canvas_name = ${canvasName} AND automation_id = ${firing.automationId}
                ORDER BY firing_id DESC LIMIT ${FIRINGS_KEPT}
              )
              AND NOT (
                cause_kind IN ('schedule', 'poll')
                AND claim_key = (
                  SELECT CAST(cursor_epoch_ms AS TEXT) FROM automation_cursors
                  WHERE canvas_name = ${canvasName} AND automation_id = ${firing.automationId}
                )
              )
          `;
          return { _tag: "Claimed" } as const;
        }));
      });

      const settleFiring = Effect.fn("AutomationRepository.settleFiring")(function* (
        canvasName: string,
        firing: FiringType,
        outcome: FiringOutcome,
      ) {
        const settled: FiringType = { ...firing, outcome };
        yield* sql`
          UPDATE automation_firings
          SET fired = ${countsAsFired(outcome) ? 1 : 0}, firing_json = ${JSON.stringify(encodeFiring(settled))}
          WHERE canvas_name = ${canvasName} AND firing_id = ${firing.firingId}
        `.pipe(Effect.mapError(failure("settle-firing")));
      });

      const firedSince = Effect.fn("AutomationRepository.firedSince")(function* (
        canvasName: string,
        automationId: AutomationId,
        sinceEpochMs: number,
      ) {
        const rows = yield* sql<{ readonly at_epoch_ms: number }>`
          SELECT at_epoch_ms FROM automation_firings
          WHERE canvas_name = ${canvasName} AND automation_id = ${automationId} AND fired = 1 AND at_epoch_ms >= ${sinceEpochMs}
        `.pipe(Effect.mapError(failure("fired-since")));
        return rows.map((row) => row.at_epoch_ms);
      });

      const firings = Effect.fn("AutomationRepository.firings")(function* (
        canvasName: string,
        request: AutomationFiringsRequest,
      ) {
        const limit = Math.min(request.limit ?? FIRINGS_PAGE_MAX, FIRINGS_PAGE_MAX);
        // Firing ids are ULIDs: their order is the order they were minted in.
        const rows = yield* (request.before === undefined
          ? sql<{ readonly firing_json: string }>`
              SELECT firing_json FROM automation_firings
              WHERE canvas_name = ${canvasName} AND automation_id = ${request.automationId}
              ORDER BY firing_id DESC LIMIT ${limit}`
          : sql<{ readonly firing_json: string }>`
              SELECT firing_json FROM automation_firings
              WHERE canvas_name = ${canvasName} AND automation_id = ${request.automationId} AND firing_id < ${request.before}
              ORDER BY firing_id DESC LIMIT ${limit}`).pipe(Effect.mapError(failure("firings")));
        return yield* Effect.try({
          try: () => rows.map((row) => decodeFiring(JSON.parse(row.firing_json))),
          catch: failure("firings"),
        });
      });

      return AutomationRepository.of({
        loadState,
        applyFacts,
        list,
        lastOutcomes,
        cursor,
        setCursor,
        rulingCursor,
        setRulingCursor,
        taskRulingsSince,
        claimFiring,
        settleFiring,
        firedSince,
        firings,
      });
    }),
  );
