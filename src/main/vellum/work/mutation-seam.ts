/**
 * The single work mutation seam.
 *
 * The operator invariant: the factory world is an event-sourced simulation and
 * SQLite is its append-only journal. A materialized work row that no journal
 * record explains is a forked source of truth — the world cannot be rebuilt
 * from the journal, and no replica can converge on it.
 *
 * `scripts/lint-single-write-seam.ts` already pins WHICH FILE may emit work
 * mutation SQL. That is a static gate over file paths. It cannot see ordering,
 * so it cannot say whether a projection row was explained by a record. This
 * module is the runtime half: it classifies every statement the state engine
 * executes and refuses a work projection write that no journal append in the
 * same transaction accounts for.
 *
 * THE LAW, enforced per transaction:
 *
 *   a `projection` write is admitted only after a `journal` record row has
 *   been written in the SAME transaction, or inside an explicitly declared
 *   {@link unjournaledWorkMutation} window.
 *
 * The journal append needs no marker call: writing a record row into
 * `work_events` / `work_facts` / `work_commands` / `work_dispositions` /
 * `work_proposal_events` IS the marker. That cannot be forged — those tables
 * carry the strictest CHECK constraints and immutability triggers in the
 * schema (`work/state-schema.ts`), so "append a record" means minting a real,
 * hash-witnessed, route-identified record.
 *
 * Scope lifecycle is owned by `state/engine.ts`: one scope per transaction,
 * opened before the body and closed in a `finally`. The engine's transaction
 * body is synchronous and non-reentrant, so a module-level scope is exact.
 *
 * WHY THIS LIVES UNDER `work/` AND THE ENGINE CALLS IN: the table roles below
 * are work-plane semantics, not storage semantics. `state/migrations.ts`
 * already imports `work/state-schema.ts` for the same reason — the state layer
 * composes the plane's own declarations rather than restating them.
 */

/**
 * What a work-plane table is, for admission purposes.
 *
 * - `journal`     the append-only record log. Writing one is the proof a
 *                 mutation is explained; these rows are immutable by trigger.
 * - `allocation`  identity allocation for the journal (sequence high-water).
 *                 Written immediately BEFORE the record it numbers, so it
 *                 cannot itself count as the explanation.
 * - `projection`  the materialized world. Rebuildable from the journal, and
 *                 therefore never writable without one.
 * - `cursor`      per-principal read position. Not a work fact: never
 *                 replicated, carries no authority, and is not part of any
 *                 rebuild. Admitted inside any transaction.
 * - `derived`     maintained by SQL triggers only. No application statement
 *                 may write it at all.
 */
export type WorkPlaneTableRole =
  | "journal"
  | "allocation"
  | "projection"
  | "cursor"
  | "derived";

/**
 * Every `work_*` table in the durable schema, classified.
 *
 * `tests/work-mutation-seam.test.ts` asserts this map covers EXACTLY the
 * tables `work/state-schema.ts` creates, so a new work table cannot be added
 * without classifying it here.
 */
export const WORK_PLANE_TABLE_ROLES: ReadonlyMap<string, WorkPlaneTableRole> =
  new Map<string, WorkPlaneTableRole>([
    // the journal
    ["work_events", "journal"],
    ["work_facts", "journal"],
    ["work_commands", "journal"],
    ["work_dispositions", "journal"],
    ["work_proposal_events", "journal"],
    // journal identity allocation
    ["work_event_sequences", "allocation"],
    // the materialized world
    ["work_tasks", "projection"],
    ["work_requests", "projection"],
    ["work_task_messages", "projection"],
    ["work_task_transitions", "projection"],
    ["work_task_dependencies", "projection"],
    ["work_task_finish", "projection"],
    ["work_task_proposals", "projection"],
    ["work_proposal_planning", "projection"],
    ["work_messages", "projection"],
    ["work_artifacts", "projection"],
    ["work_delivery_receipts", "projection"],
    ["work_board_topics", "projection"],
    ["work_board_posts", "projection"],
    ["work_pad_meta", "projection"],
    ["work_pad_images", "projection"],
    ["work_pad_shapes", "projection"],
    ["work_pad_edges", "projection"],
    ["work_pad_inks", "projection"],
    ["work_pad_pins", "projection"],
    ["work_pad_posts", "projection"],
    ["work_pending_commands", "projection"],
    ["work_pending_proposal_commands", "projection"],
    // per-principal read positions
    ["work_pad_read_cursors", "cursor"],
    ["work_board_read_cursors", "cursor"],
    // trigger-maintained
    ["work_canvas_revisions", "derived"],
  ]);

/**
 * The complete list of work mutations that deliberately mint no journal
 * record. Adding one is a type-level edit in this file, reviewed here — it
 * cannot grow by accident at a call site.
 *
 * Every entry carries what would remove it. None of these is a good state; the
 * list is a debt register with a compiler behind it.
 */
export const UNJOURNALED_WORK_REASONS = {
  "work.artifact.set_archived": {
    why:
      "Operator soft-archive / restore rewrites work_artifacts.metadata_json " +
      "in place and mints no fact, so no replica learns the artifact was " +
      "archived and a journal rebuild loses the flag.",
    retire:
      "Mint an artifact.archive fact and materialize it like every other " +
      "operation, then delete this reason.",
  },
  "work.artifact.delete": {
    why:
      "Operator delete removes the work_artifacts row outright with no " +
      "tombstone record, so a journal rebuild resurrects the artifact.",
    retire:
      "Mint an artifact.retract fact carrying the tombstone, materialize it, " +
      "then delete this reason.",
  },
  "content.inline-media.backfill": {
    why:
      "BACKFILL_INLINE_MEDIA_V1 rewrites parts_json in six work_* projection " +
      "tables to externalize inline media. It is a one-time content move, " +
      "not a work transition, and must not mint facts that replicate.",
    retire:
      "Delete src/main/vellum/content/inline-media-migration.ts once the " +
      "backfill has run on every install.",
  },
  "test.fixture-seed": {
    why:
      "A migration/schema test seeds projection rows to pin how OLD rows " +
      "survive a migration. Seeding through the repository would exercise the " +
      "NEW write path and prove nothing about the old shape.",
    retire:
      "Never — but `bun run lint:single-write-seam` forbids this reason under " +
      "src/, so it can only ever appear in tests and fixtures.",
  },
} as const;

export type UnjournaledWorkReason = keyof typeof UNJOURNALED_WORK_REASONS;

/**
 * A work mutation that the journal does not explain. This is a programming
 * error, never an operator-reachable condition: it means a code path writes
 * the materialized world behind the seam's back.
 */
export class WorkMutationSeamError extends Error {
  override readonly name = "WorkMutationSeamError";
  constructor(message: string) {
    super(`work mutation seam: ${message}`);
  }
}

type WorkStatement = {
  readonly verb: "INSERT" | "UPDATE" | "DELETE" | "REPLACE";
  readonly table: string;
  readonly role: WorkPlaneTableRole;
};

/**
 * Leading mutation verb of a statement. `node:sqlite` prepares exactly one
 * statement, so the leading verb is the whole statement's verb — an
 * `ON CONFLICT ... DO UPDATE` tail is part of the INSERT, not a second write.
 */
const LEADING_MUTATION =
  /^[\s;]*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*(insert|replace|update|delete)\b/i;

const INSERT_TARGET = /\binto\s+(?:[`"[]?([A-Za-z_][\w$]*)[`"\]]?\s*\.\s*)?[`"[]?([A-Za-z_][\w$]*)/i;
const UPDATE_TARGET =
  /^[\s;]*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*update\s+(?:or\s+\w+\s+)?(?:[`"[]?([A-Za-z_][\w$]*)[`"\]]?\s*\.\s*)?[`"[]?([A-Za-z_][\w$]*)/i;
const DELETE_TARGET = /\bfrom\s+(?:[`"[]?([A-Za-z_][\w$]*)[`"\]]?\s*\.\s*)?[`"[]?([A-Za-z_][\w$]*)/i;

/**
 * Classification cache, keyed by exact SQL text — the same key discipline the
 * state engine already uses for its prepared-statement cache, so the key set
 * is the set of SQL literals in the source and cannot grow unbounded at
 * runtime. A cached `null` means "not a work-plane mutation".
 */
const classified = new Map<string, WorkStatement | null>();

const parseWorkStatement = (sql: string): WorkStatement | null => {
  const leading = LEADING_MUTATION.exec(sql);
  if (leading === null) return null;
  const verb = leading[1].toUpperCase() as WorkStatement["verb"];
  const target =
    verb === "UPDATE"
      ? UPDATE_TARGET.exec(sql)
      : verb === "DELETE"
        ? DELETE_TARGET.exec(sql)
        : INSERT_TARGET.exec(sql);
  if (target === null) return null;
  const table = (target[2] ?? target[1]).toLowerCase();
  const role = WORK_PLANE_TABLE_ROLES.get(table);
  if (role === undefined) return null;
  return { verb, table, role };
};

/** Classify one statement against the work plane. Cached by exact SQL text. */
export const classifyWorkStatement = (sql: string): WorkStatement | null => {
  const cached = classified.get(sql);
  if (cached !== undefined) return cached;
  const parsed = parseWorkStatement(sql);
  classified.set(sql, parsed);
  return parsed;
};

type Scope = {
  readonly operation: string;
  journaled: boolean;
  unjournaled: UnjournaledWorkReason | undefined;
};

/**
 * Open transaction scopes, innermost last.
 *
 * A state engine forbids nesting its OWN transactions and its transaction body
 * cannot yield, so within one engine exactly one scope is live. The stack
 * exists because a process may hold more than one engine (a test opening a
 * second database, a tool engine beside the product one): each transaction
 * gets its own scope, so one database's journal can never explain another
 * database's projection write.
 */
const scopes: Array<Scope> = [];

const current = (): Scope | undefined => scopes[scopes.length - 1];

/**
 * Open the scope for one transaction. Called ONLY by the state engine, once
 * per `transaction` / `chunkedWrite` chunk. Returns the closer, which the
 * engine runs in a `finally` so a thrown body cannot leak an open scope.
 */
export const beginWorkMutationScope = (operation: string): (() => void) => {
  const opened: Scope = {
    operation,
    journaled: false,
    unjournaled: undefined,
  };
  scopes.push(opened);
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    const top = scopes.pop();
    if (top === opened) return;
    // Unreachable while the engine closes in a `finally`. If it ever happens
    // the stack is already wrong, so say so instead of silently continuing.
    if (top !== undefined) scopes.push(top);
    throw new WorkMutationSeamError(
      `scope for "${operation}" closed out of order (top is ` +
        `"${top?.operation ?? "none"}")`,
    );
  };
};

const statementHead = (sql: string): string =>
  sql.replace(/\s+/g, " ").trim().slice(0, 120);

/**
 * Admit one statement, or throw. Called by the state engine for every
 * statement it runs through a writer, before the statement executes.
 */
export const admitWorkStatement = (sql: string): void => {
  const statement = classifyWorkStatement(sql);
  if (statement === null) return;
  if (statement.role === "derived") {
    throw new WorkMutationSeamError(
      `"${statement.table}" is maintained by SQL triggers only; no ` +
        `application statement may write it (${statementHead(sql)})`,
    );
  }
  const scope = current();
  if (scope === undefined) {
    throw new WorkMutationSeamError(
      `${statement.verb} on "${statement.table}" ran outside any state ` +
        `transaction (${statementHead(sql)})`,
    );
  }
  if (statement.role === "journal") {
    scope.journaled = true;
    return;
  }
  if (statement.role === "allocation" || statement.role === "cursor") return;
  if (scope.journaled || scope.unjournaled !== undefined) return;
  throw new WorkMutationSeamError(
    `${statement.verb} on the work projection table "${statement.table}" in ` +
      `"${scope.operation}" is not explained by any journal record in this ` +
      "transaction. Mint a work record and materialize it, or declare the " +
      "write with unjournaledWorkMutation(...) if it deliberately mints no " +
      `fact (${statementHead(sql)})`,
  );
};

/**
 * Declare a work projection write that deliberately mints no journal record,
 * for the duration of `body`. Must run inside a state transaction.
 *
 * This is the ONLY escape from the law above, the reason set is closed at the
 * type level, and `bun run lint:single-write-seam` pins every call site.
 */
export const unjournaledWorkMutation = <A>(
  reason: UnjournaledWorkReason,
  body: () => A,
): A => {
  const scope = current();
  if (scope === undefined) {
    throw new WorkMutationSeamError(
      `unjournaledWorkMutation("${reason}") ran outside any state transaction`,
    );
  }
  if (scope.unjournaled !== undefined) {
    throw new WorkMutationSeamError(
      `unjournaledWorkMutation("${reason}") nests inside ` +
        `"${scope.unjournaled}" — one declaration per transaction`,
    );
  }
  scope.unjournaled = reason;
  try {
    return body();
  } finally {
    scope.unjournaled = undefined;
  }
};

/** Test-only introspection: is a scope open, and has it been journalled? */
export const workMutationScopeForTest = (): {
  readonly operation: string;
  readonly journaled: boolean;
  readonly unjournaled: UnjournaledWorkReason | undefined;
} | undefined => {
  const scope = current();
  return scope === undefined
    ? undefined
    : {
      operation: scope.operation,
      journaled: scope.journaled,
      unjournaled: scope.unjournaled,
    };
};
