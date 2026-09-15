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
 * `work_events` / `work_facts` / `work_commands` / `work_dispositions` IS the
 * marker. That cannot be forged — those tables
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
    // journal identity allocation
    ["work_event_sequences", "allocation"],
    // the materialized world
    ["work_tasks", "projection"],
    ["work_requests", "projection"],
    ["work_task_messages", "projection"],
    ["work_task_transitions", "projection"],
    ["work_task_dependencies", "projection"],
    ["work_task_finish", "projection"],
    ["work_messages", "projection"],
    ["work_artifacts", "projection"],
    ["work_delivery_receipts", "projection"],
    // Crew mail/review stores: durable Command Center-local operational state
    // written directly (never materialized from the replicated journal), so
    // every write declares an unjournaledWorkMutation(...) reason below.
    ["work_mail_attempts", "projection"],
    ["work_review_verdicts", "projection"],
    ["work_review_receipts", "projection"],
    ["work_review_checkout_observations", "projection"],
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
      "Delete src/main/vellum-command/content/inline-media-migration.ts once the " +
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
  "crew.mail-attempt": {
    why:
      "Mail delivery attempts (work_mail_attempts) are Command Center-local " +
      "transport state — queued/attempted/notified/unresolved/refused per " +
      "recipient generation. They mint no fact because a delivery attempt is " +
      "not a work transition and must never replicate to another installation.",
    retire:
      "Never while mail delivery is Command Center-homed; if attempts ever " +
      "replicate, mint a delivery-attempt fact and materialize it instead.",
  },
  "crew.review-verdict": {
    why:
      "Review verdicts (work_review_verdicts) are a Command Center-local " +
      "immutable judgement journal keyed by verdict id. A blocking verdict's " +
      "EFFECT (task send-back) is journaled by that transition; the verdict " +
      "row itself records the judgement and mints no separate fact.",
    retire:
      "Mint a review.verdict fact and materialize it if verdicts ever need to " +
      "replicate, then delete this reason.",
  },
  "crew.review-receipt": {
    why:
      "Review receipts (work_review_receipts) are a Command Center-local " +
      "dedupe and first-seen-sha provenance store for the receipt feed. They " +
      "mint no fact; the mail they gate is the journaled artifact.",
    retire:
      "Mint a review.receipt fact and materialize it if the feed ever " +
      "replicates, then delete this reason.",
  },
  "crew.checkout-observation": {
    why:
      "Checkout observations (work_review_checkout_observations) record commit " +
      "sightings in a shared checkout for author attribution. They are local " +
      "watcher state, not a work transition, and must not replicate.",
    retire:
      "Never while checkout watching is Command Center-local.",
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
  /**
   * `unreadable` marks a statement whose shape this parser classified but did
   * not model well enough to name a sink — it is always announced coarse.
   */
  readonly sink: "readable" | "unreadable";
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

/**
 * A mutation verb that does not lead the statement.
 *
 * SQLite accepts a common table expression in front of INSERT, UPDATE and
 * DELETE (`WITH x AS (...) DELETE FROM t ...`). Such a statement writes the
 * work plane exactly like any other, so the seam must see it: a statement it
 * does not classify skips the admission law AND makes no announcement, which
 * leaves the in-memory world resident on rows that are gone.
 *
 * Single-quoted strings are removed before the scan so a literal cannot be
 * mistaken for a statement. The verb only counts when a work-plane table name
 * follows it, so an unrelated CTE write is still invisible, as it should be.
 */
const EMBEDDED_MUTATION =
  /\b(insert\s+(?:or\s+\w+\s+)?into|replace\s+into|update(?:\s+or\s+\w+)?|delete\s+from)\s+(?:[`"[]?([A-Za-z_][\w$]*)[`"\]]?\s*\.\s*)?[`"[]?([A-Za-z_][\w$]*)/gi;

const withoutStringLiterals = (sql: string): string => {
  let out = "";
  let inString = false;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    if (inString) {
      out += character === "'" ? "'" : " ";
      if (character === "'") inString = false;
      continue;
    }
    if (character === "'") {
      inString = true;
      out += " ";
      continue;
    }
    out += character;
  }
  return out;
};

const embeddedWorkStatement = (sql: string): WorkStatement | null => {
  const scanned = withoutStringLiterals(sql);
  EMBEDDED_MUTATION.lastIndex = 0;
  for (
    let match = EMBEDDED_MUTATION.exec(scanned);
    match !== null;
    match = EMBEDDED_MUTATION.exec(scanned)
  ) {
    const table = (match[3] ?? match[2]).toLowerCase();
    const role = WORK_PLANE_TABLE_ROLES.get(table);
    if (role === undefined) continue;
    const keyword = match[1].toLowerCase();
    const verb: WorkStatement["verb"] = keyword.startsWith("insert")
      ? "INSERT"
      : keyword.startsWith("replace")
        ? "REPLACE"
        : keyword.startsWith("update")
          ? "UPDATE"
          : "DELETE";
    // The sink cannot be read out of a shape this parser did not model, so
    // the statement is admitted and announced COARSE rather than guessed at.
    return { verb, table, role, sink: "unreadable" };
  }
  return null;
};

const parseWorkStatement = (sql: string): WorkStatement | null => {
  const leading = LEADING_MUTATION.exec(sql);
  if (leading === null) return embeddedWorkStatement(sql);
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
  return { verb, table, role, sink: "readable" };
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
export const admitWorkStatement = (
  sql: string,
  bindings?: WorkStatementBindings,
): void => {
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
    announceWorkMutation(statement, sql, bindings);
    return;
  }
  if (statement.role === "allocation" || statement.role === "cursor") {
    announceWorkMutation(statement, sql, bindings);
    return;
  }
  if (scope.journaled || scope.unjournaled !== undefined) {
    announceWorkMutation(statement, sql, bindings);
    return;
  }
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

/* ------------------------------------------------------------------------ *
 * WHICH SINK A MUTATION TOUCHED
 *
 * The in-memory world (`work/world.ts`) keeps every sink's read model resident
 * and must know which ones a committed transaction disturbed. That question is
 * answered HERE, at the same chokepoint the admission law runs, because this
 * is the only place in the process that provably sees every work mutation: the
 * static gate pins which file may emit the SQL, the admission law pins that a
 * journal record explains it, and this pins which sink it lands on.
 *
 * Two properties make it safe rather than clever:
 *
 * 1. IT IS DERIVED FROM THE STATEMENT, NOT DECLARED BY THE CALLER. There is no
 *    "remember to call markDirty" a write path can forget. A statement is
 *    attributed by reading its own column list, so a new write path is
 *    attributed the moment it runs.
 * 2. UNATTRIBUTABLE MEANS COARSE, NEVER SILENT. If the sink cannot be read out
 *    of the statement, observers are told `undefined` — "something changed,
 *    I cannot say where" — which costs a full rebuild and is exactly the
 *    behaviour the world has without any of this. The failure direction is
 *    slow, never stale.
 *
 * The scan is bounded to {@link CANVAS_REVISION_TABLES}. Those are the tables
 * whose triggers move `work_canvas_revisions`, which is the freshness witness
 * every projection cache in this process already keys on. A write that cannot
 * move that counter cannot change what a cached read returns, so it needs no
 * announcement — the world inherits the memo's exact correctness envelope
 * rather than inventing a second one.
 * ------------------------------------------------------------------------ */

/** Positional or named bindings, exactly as the state engine receives them. */
export type WorkStatementBindings =
  | ReadonlyArray<unknown>
  | Readonly<Record<string, unknown>>;

/**
 * Every table carrying a `work_canvas_revisions` trigger.
 *
 * `tests/work-mutation-seam.test.ts` asserts this is EXACTLY the trigger set
 * declared by `WORK_PROJECTION_REVISION_TRIGGERS_SQL`, so a table cannot join
 * or leave the witness without this list moving with it.
 */
export const CANVAS_REVISION_TABLES: ReadonlySet<string> = new Set([
  "work_artifacts",
  "work_board_posts",
  "work_board_read_cursors",
  "work_board_topics",
  "work_delivery_receipts",
  "work_events",
  "work_mail_attempts",
  "work_messages",
  "work_pad_meta",
  "work_pad_posts",
  "work_pad_read_cursors",
  "work_pad_shapes",
  "work_requests",
  "work_review_verdicts",
  "work_task_dependencies",
  "work_task_finish",
  "work_task_messages",
  "work_tasks",
]);

/**
 * The (canvas, node) column pair naming the sink, per table.
 *
 * Most tables spell it `canvas_name` / `node_id`. The journal names the item's
 * home, and a delivery receipt names the sink it was DELIVERED to — which is
 * the sink whose inbox projection reads it back (`work/repository.ts`
 * `receiptAcceptedAtMs` keys on `delivered_*`), not the actor that sent it.
 */
const SINK_COLUMNS: ReadonlyMap<
  string,
  readonly [canvas: string, node: string]
> = new Map([
  ["work_events", ["item_canvas_name", "item_node_id"] as const],
  [
    "work_delivery_receipts",
    ["delivered_canvas_name", "delivered_node_id"] as const,
  ],
  // A task verdict's sink is the subject task's canvas/node, not the verdict row.
  [
    "work_review_verdicts",
    ["subject_task_canvas", "subject_task_node"] as const,
  ],
]);

const DEFAULT_SINK_COLUMNS = ["canvas_name", "node_id"] as const;

/** Which positional parameters carry the sink, for one exact statement. */
type SinkParams = { readonly canvas: number; readonly node: number };

/**
 * Does the statement use explicit `?NNN` parameter indices?
 *
 * Every ordinal below is "how many `?` precede this one", which is how SQLite
 * numbers BARE parameters. A numbered parameter breaks that correspondence, so
 * a statement carrying one cannot be attributed by position at all.
 */
const hasNumberedParameter = (sql: string): boolean => {
  let inString = false;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    if (inString) {
      if (character === "'") inString = false;
      continue;
    }
    if (character === "'") {
      inString = true;
      continue;
    }
    if (character !== "?") continue;
    const next = sql[index + 1];
    if (next !== undefined && next >= "0" && next <= "9") return true;
  }
  return false;
};

/**
 * Parenthesis depth at every offset, plus where this statement's own WHERE
 * begins.
 *
 * Both are needed to tell the predicate that names THIS statement's rows from
 * one that names some other statement's rows: a `canvas_name = ?` inside
 * parentheses belongs to a subquery, and one before the WHERE belongs to a SET
 * clause. Either would bind a different sink than the rows actually written.
 */
type StatementShape = {
  readonly depth: ReadonlyArray<number>;
  /** -1 when the statement has no top-level WHERE. */
  readonly whereAt: number;
};

const statementShape = (sql: string): StatementShape => {
  const depth: Array<number> = new Array(sql.length).fill(0);
  let current = 0;
  let inString = false;
  let whereAt = -1;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    depth[index] = current;
    if (inString) {
      if (character === "'") inString = false;
      continue;
    }
    if (character === "'") {
      inString = true;
      continue;
    }
    if (character === "(") {
      current += 1;
      continue;
    }
    if (character === ")") {
      current = Math.max(0, current - 1);
      continue;
    }
    if (
      whereAt < 0 &&
      current === 0 &&
      (character === "w" || character === "W") &&
      /^where\b/i.test(sql.slice(index, index + 6)) &&
      (index === 0 || /\s|\)/.test(sql[index - 1] ?? " "))
    ) {
      whereAt = index;
    }
  }
  return { depth, whereAt };
};

/** Every `?` offset in `sql`, skipping single-quoted string literals. */
const parameterOffsets = (sql: string): ReadonlyArray<number> => {
  const offsets: Array<number> = [];
  let inString = false;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    if (inString) {
      if (character === "'") inString = false;
      continue;
    }
    if (character === "'") {
      inString = true;
      continue;
    }
    if (character === "?") offsets.push(index);
  }
  return offsets;
};

/** The balanced `(...)` starting at `open`, exclusive of the parentheses. */
const balancedGroup = (
  sql: string,
  open: number,
): { readonly body: string; readonly end: number } | null => {
  let depth = 0;
  let inString = false;
  for (let index = open; index < sql.length; index += 1) {
    const character = sql[index];
    if (inString) {
      if (character === "'") inString = false;
      continue;
    }
    if (character === "'") inString = true;
    else if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) {
        return { body: sql.slice(open + 1, index), end: index };
      }
    }
  }
  return null;
};

/** Split on top-level commas, ignoring commas inside `(...)` or a string. */
const splitTopLevel = (body: string): ReadonlyArray<string> => {
  const parts: Array<string> = [];
  let depth = 0;
  let inString = false;
  let start = 0;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (inString) {
      if (character === "'") inString = false;
      continue;
    }
    if (character === "'") inString = true;
    else if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (character === "," && depth === 0) {
      parts.push(body.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
};

const countParameters = (fragment: string): number =>
  parameterOffsets(fragment).length;

/**
 * `INSERT INTO t(a, b, ...) VALUES (?, ?, 'literal', ...)`.
 *
 * Walks the VALUES tuple against the column list so a literal in the tuple
 * (`work_task_messages` writes `'history'` inline) shifts the parameter
 * indices exactly the way SQLite binds them. Anything after the tuple — an
 * `ON CONFLICT ... DO UPDATE SET x = ?` tail — binds AFTER these, so it can
 * never move an index this function returns.
 */
const insertSinkParams = (
  sql: string,
  columns: readonly [string, string],
): SinkParams | null => {
  const into = /\binto\b/i.exec(sql);
  if (into === null) return null;
  const columnOpen = sql.indexOf("(", into.index);
  if (columnOpen < 0) return null;
  const columnGroup = balancedGroup(sql, columnOpen);
  if (columnGroup === null) return null;
  const valuesKeyword = /\bvalues\b/i.exec(sql.slice(columnGroup.end));
  if (valuesKeyword === undefined || valuesKeyword === null) return null;
  const valuesOpen = sql.indexOf(
    "(",
    columnGroup.end + valuesKeyword.index,
  );
  if (valuesOpen < 0) return null;
  const valuesGroup = balancedGroup(sql, valuesOpen);
  if (valuesGroup === null) return null;

  // A second VALUES tuple can land on another sink, and this walk only reads
  // the first. Refuse the shape rather than announce one of several sinks.
  const afterValues = sql.slice(valuesGroup.end + 1).replace(/^[\s]+/, "");
  if (afterValues.startsWith(",")) return null;

  const names = splitTopLevel(columnGroup.body).map((name) =>
    name.trim().replace(/^["`[]|["`\]]$/g, "").toLowerCase(),
  );
  const values = splitTopLevel(valuesGroup.body);
  if (names.length !== values.length) return null;

  const indexes = new Map<string, number>();
  let parameter = 0;
  for (let position = 0; position < values.length; position += 1) {
    const value = values[position].trim();
    if (value === "?") {
      indexes.set(names[position], parameter);
      parameter += 1;
      continue;
    }
    parameter += countParameters(value);
  }
  const canvas = indexes.get(columns[0]);
  const node = indexes.get(columns[1]);
  if (canvas === undefined || node === undefined) return null;
  return { canvas, node };
};

/**
 * `UPDATE t SET ... WHERE canvas_name = ? AND node_id = ?` and the DELETE of
 * the same shape. The ordinal of a `?` is how many `?` precede it, which is
 * exactly how SQLite numbers positional parameters.
 */
const predicateSinkParams = (
  sql: string,
  columns: readonly [string, string],
): SinkParams | null => {
  const offsets = parameterOffsets(sql);
  const shape = statementShape(sql);
  if (shape.whereAt < 0) return null;
  // A SET clause that assigns a sink column moves the row from one sink to
  // another. Both ends change and the predicate names only the old one, so
  // there is no single sink to announce.
  for (const column of columns) {
    const assignment = new RegExp(`\\b${column}\\s*=`, "gi");
    for (
      let match = assignment.exec(sql);
      match !== null;
      match = assignment.exec(sql)
    ) {
      if ((shape.depth[match.index] ?? 0) !== 0) continue;
      if (match.index < shape.whereAt) return null;
    }
  }
  const ordinalOf = (column: string): number | undefined => {
    const pattern = new RegExp(`\\b${column}\\s*=\\s*\\?`, "gi");
    let found: number | undefined;
    for (
      let match = pattern.exec(sql);
      match !== null;
      match = pattern.exec(sql)
    ) {
      // Inside parentheses it filters a subquery's rows, not this
      // statement's; before the WHERE it is a SET clause assigning the row a
      // NEW sink while the OLD one goes unannounced.
      if ((shape.depth[match.index] ?? 0) !== 0) continue;
      if (match.index < shape.whereAt) continue;
      // A second top-level occurrence means the predicate is a shape this
      // parser did not model. Refuse rather than pick one.
      if (found !== undefined) return undefined;
      const at = sql.indexOf("?", match.index);
      const ordinal = offsets.indexOf(at);
      if (ordinal < 0) return undefined;
      found = ordinal;
    }
    return found;
  };
  const canvas = ordinalOf(columns[0]);
  const node = ordinalOf(columns[1]);
  if (canvas === undefined || node === undefined) return null;
  return { canvas, node };
};

/**
 * Attribution cache, keyed by exact SQL text — the same key discipline as the
 * classification cache above and as the engine's prepared-statement cache, so
 * the key set is the set of SQL literals in the source.
 */
const sinkParameters = new Map<string, SinkParams | null>();

/** Which positional parameters name the sink, or `null` if unreadable. */
export const workStatementSinkParams = (
  statement: {
    readonly verb: string;
    readonly table: string;
    readonly sink?: "readable" | "unreadable";
  },
  sql: string,
): SinkParams | null => {
  const cached = sinkParameters.get(sql);
  if (cached !== undefined) return cached;
  const columns = SINK_COLUMNS.get(statement.table) ?? DEFAULT_SINK_COLUMNS;
  const parsed =
    statement.sink === "unreadable" || hasNumberedParameter(sql)
      ? null
      : statement.verb === "INSERT" || statement.verb === "REPLACE"
        ? insertSinkParams(sql, columns)
        : predicateSinkParams(sql, columns);
  sinkParameters.set(sql, parsed);
  return parsed;
};

/**
 * Told about every mutation that can move `work_canvas_revisions`.
 *
 * `canvasName === undefined` means the sink could not be read out of the
 * statement: the listener must treat its whole world as stale.
 */
export type WorkMutationObserver = (
  canvasName: string | undefined,
  nodeId: string | undefined,
) => void;

const observers = new Set<WorkMutationObserver>();

/**
 * Subscribe to work mutations. Every observer hears EVERY mutation in the
 * process, including ones from another state engine (a test database, a tool
 * engine). That is deliberate: a cross-engine announcement costs the listener
 * a needless reload, while routing announcements per engine and getting the
 * routing wrong would cost it a stale read.
 */
export const onWorkMutation = (
  observer: WorkMutationObserver,
): (() => void) => {
  observers.add(observer);
  return () => {
    observers.delete(observer);
  };
};

const announceWorkMutation = (
  statement: WorkStatement,
  sql: string,
  bindings: WorkStatementBindings | undefined,
): void => {
  if (observers.size === 0) return;
  if (!CANVAS_REVISION_TABLES.has(statement.table)) return;
  let canvasName: string | undefined;
  let nodeId: string | undefined;
  if (Array.isArray(bindings)) {
    const params = workStatementSinkParams(statement, sql);
    if (params !== null) {
      const canvas = bindings[params.canvas];
      const node = bindings[params.node];
      if (typeof canvas === "string" && typeof node === "string") {
        canvasName = canvas;
        nodeId = node;
      }
    }
  }
  for (const observer of observers) observer(canvasName, nodeId);
};
