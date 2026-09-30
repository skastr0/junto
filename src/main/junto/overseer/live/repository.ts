import { createHash } from "node:crypto";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlError, SqlSchema } from "effect/unstable/sql";
import { StateTransactionOperation } from "../../state/service";
import { withSqlRead } from "../../state/sql-read";

export type LiveJsonObject = Readonly<Record<string, unknown>>;
export type LiveSessionStatus = "active" | "closed" | "interrupted";
export type LiveRequestStatus = "queued" | "interpreting" | "waiting-approval" | "running" |
  "completed" | "failed" | "cancelled" | "superseded" | "interrupted";
export type LiveOperationStatus = "proposed" | "awaiting-approval" | "admitted" | "dispatched" |
  "applied" | "failed" | "partial" | "unknown";

export interface LiveSessionBinding {
  readonly sessionId: string;
  readonly seatNodeRef: string;
  readonly occupantGeneration: string;
  readonly authorityEpoch: string;
}
export interface LiveSessionRecord extends LiveSessionBinding {
  readonly status: LiveSessionStatus;
  readonly backendConversationId: string | null;
  readonly providerSessionId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface LiveRequestRecord {
  readonly requestId: string;
  readonly sessionId: string;
  readonly providerDelegationId: string | null;
  readonly intentRevision: number;
  readonly status: LiveRequestStatus;
  readonly text: string;
  readonly capturedContext: LiveJsonObject;
  readonly transcriptRefs: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface LiveOperationRecord {
  readonly operationId: string;
  readonly requestId: string;
  readonly intentRevision: number;
  readonly operation: string;
  readonly args: LiveJsonObject;
  readonly argsSha256: string;
  readonly targetRefs: readonly string[];
  readonly targetRevision: string | null;
  readonly status: LiveOperationStatus;
  readonly outcome: LiveJsonObject | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface LiveEventRecord {
  readonly sequence: number;
  readonly sessionId: string;
  readonly requestId: string | null;
  readonly operationId: string | null;
  readonly kind: string;
  readonly detail: LiveJsonObject;
  readonly createdAt: string;
}
export interface LiveRequestCorrelation {
  readonly sessionId: string;
  readonly requestId: string;
  readonly intentRevision: number;
  readonly occupantGeneration: string;
  readonly authorityEpoch: string;
}
export type CreateLiveRequest = Pick<LiveRequestRecord,
  "requestId" | "sessionId" | "providerDelegationId" | "text" | "capturedContext" | "transcriptRefs">;
export type ProposeLiveOperation = Pick<LiveOperationRecord,
  "operationId" | "requestId" | "intentRevision" | "operation" | "args" | "targetRefs" | "targetRevision">;
export type AppendLiveEvent = Pick<LiveEventRecord,
  "sessionId" | "requestId" | "operationId" | "kind" | "detail">;
export interface TransitionLiveOperation {
  readonly operationId: string;
  readonly from: LiveOperationStatus;
  readonly to: LiveOperationStatus;
  readonly outcome?: LiveJsonObject;
  /** Required for admission, native dispatch and a database-owned commit. */
  readonly correlation?: LiveRequestCorrelation;
}

export class LiveJournalError extends Schema.TaggedError<LiveJournalError>()("LiveJournalError", {
  code: Schema.Literals(["invalid", "missing", "conflict", "stale", "persistence"]),
  message: Schema.String,
}) {}

const fail = (code: LiveJournalError["code"], message: string): never => {
  throw new LiveJournalError({ code, message });
};
const MAX_JSON_BYTES = 262_144;
const stringArray = Schema.decodeUnknownSync(Schema.Array(Schema.String));
const objectSchema = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));

/** Stable, strict JSON identity: undefined, non-finite numbers and non-JSON objects fail. */
const canonical = (value: unknown): unknown => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return fail("invalid", "Live journal values must be finite JSON");
};
const encode = (value: unknown): string => {
  const result = JSON.stringify(canonical(value));
  if (Buffer.byteLength(result, "utf8") > MAX_JSON_BYTES) fail("invalid", "Live journal value exceeds 256 KiB");
  return result;
};
const encodeObject = (value: LiveJsonObject): string => encode(objectSchema(value));
export const operationArgsHash = (args: LiveJsonObject): string =>
  createHash("sha256").update(encodeObject(args)).digest("hex");
const pendingRequest = (status: LiveRequestStatus): boolean =>
  status === "queued" || status === "interpreting" || status === "waiting-approval" || status === "running";
const operationTransitions: Record<LiveOperationStatus, readonly LiveOperationStatus[]> = {
  proposed: ["awaiting-approval", "admitted", "failed"],
  "awaiting-approval": ["admitted", "failed"],
  admitted: ["dispatched", "applied", "failed", "unknown"],
  dispatched: ["applied", "failed", "partial", "unknown"],
  applied: [], failed: [], partial: [], unknown: ["applied", "failed", "partial"],
};

const boundedLimit = (limit = 100): number => {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) fail("invalid", "Live journal query limit must be between 1 and 200");
  return limit;
};
const journalError = (error: unknown): LiveJournalError => {
  if (error instanceof LiveJournalError) return error;
  if (SqlError.isSqlError(error) && error.reason.cause instanceof LiveJournalError) return error.reason.cause;
  return new LiveJournalError({ code: "persistence", message: error instanceof Error ? error.message : String(error) });
};

const JsonObject = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const StringRefs = Schema.fromJsonString(Schema.Array(Schema.String));
const SessionRow = Schema.Struct({
  sessionId: Schema.String, seatNodeRef: Schema.String, occupantGeneration: Schema.String, authorityEpoch: Schema.String,
  status: Schema.Literals(["active", "closed", "interrupted"]),
  backendConversationId: Schema.NullOr(Schema.String), providerSessionId: Schema.NullOr(Schema.String),
  createdAt: Schema.String, updatedAt: Schema.String,
}).pipe(Schema.encodeKeys({
  sessionId: "session_id", seatNodeRef: "seat_node_ref", occupantGeneration: "occupant_generation", authorityEpoch: "authority_epoch",
  backendConversationId: "backend_conversation_id", providerSessionId: "provider_session_id", createdAt: "created_at", updatedAt: "updated_at",
}));
const RequestRow = Schema.Struct({
  requestId: Schema.String, sessionId: Schema.String, providerDelegationId: Schema.NullOr(Schema.String), intentRevision: Schema.Number,
  status: Schema.Literals(["queued", "interpreting", "waiting-approval", "running", "completed", "failed", "cancelled", "superseded", "interrupted"]),
  text: Schema.String, capturedContext: JsonObject, transcriptRefs: StringRefs, createdAt: Schema.String, updatedAt: Schema.String,
}).pipe(Schema.encodeKeys({
  requestId: "request_id", sessionId: "session_id", providerDelegationId: "provider_delegation_id", intentRevision: "intent_revision",
  capturedContext: "captured_context_json", transcriptRefs: "transcript_refs_json", createdAt: "created_at", updatedAt: "updated_at",
}));
const OperationRow = Schema.Struct({
  operationId: Schema.String, requestId: Schema.String, intentRevision: Schema.Number, operation: Schema.String,
  args: JsonObject, argsSha256: Schema.String, targetRefs: StringRefs, targetRevision: Schema.NullOr(Schema.String),
  status: Schema.Literals(["proposed", "awaiting-approval", "admitted", "dispatched", "applied", "failed", "partial", "unknown"]),
  outcome: Schema.NullOr(JsonObject), createdAt: Schema.String, updatedAt: Schema.String,
}).pipe(Schema.encodeKeys({
  operationId: "operation_id", requestId: "request_id", intentRevision: "intent_revision", args: "args_json", argsSha256: "args_sha256",
  targetRefs: "target_refs_json", targetRevision: "target_revision", outcome: "outcome_json", createdAt: "created_at", updatedAt: "updated_at",
}));
const EventRow = Schema.Struct({
  sequence: Schema.Number, sessionId: Schema.String, requestId: Schema.NullOr(Schema.String), operationId: Schema.NullOr(Schema.String),
  kind: Schema.String, detail: JsonObject, createdAt: Schema.String,
}).pipe(Schema.encodeKeys({ sessionId: "session_id", requestId: "request_id", operationId: "operation_id", detail: "detail_json", createdAt: "created_at" }));

/** Uses the installation's existing connection; never opens a second product database. */
export const makeLiveRepository = (sql: SqlClient.SqlClient, clock = () => new Date().toISOString()) => {
  const attempt = <A>(body: () => A) => Effect.try({ try: body, catch: journalError });
  const write = (name: string) => <A, E, R>(body: Effect.Effect<A, E, R>) => body.pipe(
    sql.withTransaction, Effect.provideService(StateTransactionOperation, `live.${name}`), Effect.mapError(journalError),
  );
  const sessionById = SqlSchema.findOneOption({
    Request: Schema.String, Result: SessionRow,
    execute: (id) => sql`SELECT * FROM overseer_live_sessions WHERE session_id = ${id}`,
  });
  const sessionsByRecency = SqlSchema.findAll({
    Request: Schema.Number, Result: SessionRow,
    execute: (limit) => sql`SELECT * FROM overseer_live_sessions ORDER BY created_at DESC, session_id DESC LIMIT ${limit}`,
  });
  const activeSessions = SqlSchema.findAll({
    Request: Schema.Void, Result: SessionRow,
    execute: () => sql`SELECT * FROM overseer_live_sessions WHERE status = 'active'`,
  });
  const requestById = SqlSchema.findOneOption({
    Request: Schema.String, Result: RequestRow,
    execute: (id) => sql`SELECT * FROM overseer_live_requests WHERE request_id = ${id}`,
  });
  const requestByDelegation = SqlSchema.findOneOption({
    Request: Schema.Struct({ sessionId: Schema.String, providerDelegationId: Schema.String }), Result: RequestRow,
    execute: ({ sessionId, providerDelegationId }) => sql`
      SELECT * FROM overseer_live_requests WHERE session_id = ${sessionId} AND provider_delegation_id = ${providerDelegationId}`,
  });
  const requestsByRecency = SqlSchema.findAll({
    Request: Schema.Struct({ sessionId: Schema.String, limit: Schema.Number }), Result: RequestRow,
    execute: ({ sessionId, limit }) => sql`
      SELECT * FROM overseer_live_requests WHERE session_id = ${sessionId} ORDER BY created_at DESC, request_id DESC LIMIT ${limit}`,
  });
  const requestsBySession = SqlSchema.findAll({
    Request: Schema.String, Result: RequestRow,
    execute: (sessionId) => sql`SELECT * FROM overseer_live_requests WHERE session_id = ${sessionId}`,
  });
  const operationById = SqlSchema.findOneOption({
    Request: Schema.String, Result: OperationRow,
    execute: (id) => sql`SELECT * FROM overseer_live_operations WHERE operation_id = ${id}`,
  });
  const operationsByRecency = SqlSchema.findAll({
    Request: Schema.Struct({ requestId: Schema.String, limit: Schema.Number }), Result: OperationRow,
    execute: ({ requestId, limit }) => sql`
      SELECT * FROM overseer_live_operations WHERE request_id = ${requestId} ORDER BY created_at DESC, operation_id DESC LIMIT ${limit}`,
  });
  const pendingOperations = SqlSchema.findAll({
    Request: Schema.String, Result: OperationRow,
    execute: (requestId) => sql`SELECT * FROM overseer_live_operations WHERE request_id = ${requestId} AND status IN ('proposed', 'awaiting-approval', 'admitted')`,
  });
  const uncertainOperations = SqlSchema.findAll({
    Request: Schema.Void, Result: OperationRow,
    execute: () => sql`SELECT * FROM overseer_live_operations WHERE status IN ('admitted', 'dispatched')`,
  });
  const eventsAfter = SqlSchema.findAll({
    Request: Schema.Struct({ sessionId: Schema.String, afterSequence: Schema.Number, limit: Schema.Number }), Result: EventRow,
    execute: ({ sessionId, afterSequence, limit }) => sql`
      SELECT * FROM overseer_live_events WHERE session_id = ${sessionId} AND sequence > ${afterSequence} ORDER BY sequence LIMIT ${limit}`,
  });
  const insertEvent = SqlSchema.findOne({
    Request: Schema.Struct({ sessionId: Schema.String, requestId: Schema.NullOr(Schema.String), operationId: Schema.NullOr(Schema.String),
      kind: Schema.String, detail: Schema.String, now: Schema.String }),
    Result: Schema.Struct({ lastInsertRowid: Schema.Union([Schema.Number, Schema.BigInt]) }),
    execute: (input) => sql`INSERT INTO overseer_live_events
      (session_id, request_id, operation_id, kind, detail_json, created_at)
      VALUES (${input.sessionId}, ${input.requestId}, ${input.operationId}, ${input.kind}, ${input.detail}, ${input.now})`
      .raw.pipe(Effect.map((result) => [result])),
  });

  const requireSession = Effect.fn("live.session.require")(function* (id: string) {
    const row = yield* sessionById(id);
    if (Option.isNone(row)) return yield* new LiveJournalError({ code: "missing", message: `Live session ${id} does not exist` });
    return row.value;
  });
  const requireRequest = Effect.fn("live.request.require")(function* (id: string) {
    const row = yield* requestById(id);
    if (Option.isNone(row)) return yield* new LiveJournalError({ code: "missing", message: `Live request ${id} does not exist` });
    return row.value;
  });
  const requireOperation = Effect.fn("live.operation.require")(function* (id: string) {
    const row = yield* operationById(id);
    if (Option.isNone(row)) return yield* new LiveJournalError({ code: "missing", message: `Live operation ${id} does not exist` });
    return row.value;
  });
  const requireActiveRequest = Effect.fn("live.request.require-active")(function* (id: string, revision: number) {
    const request = yield* requireRequest(id);
    if (request.intentRevision !== revision || !pendingRequest(request.status)) {
      return yield* new LiveJournalError({ code: "stale", message: "Live request intent is no longer current" });
    }
    if ((yield* requireSession(request.sessionId)).status !== "active") {
      return yield* new LiveJournalError({ code: "stale", message: "Live session requires fresh admission" });
    }
    return request;
  });
  /** Participates in the caller's SQL transaction without taking ownership or invoking hooks. */
  const assertRequestCurrentWithin = Effect.fn("live.request.current-within")(function* (correlation: LiveRequestCorrelation) {
    const request = yield* requireActiveRequest(correlation.requestId, correlation.intentRevision);
    const session = yield* requireSession(request.sessionId);
    if (request.sessionId !== correlation.sessionId || session.occupantGeneration !== correlation.occupantGeneration ||
        session.authorityEpoch !== correlation.authorityEpoch) {
      return yield* new LiveJournalError({ code: "stale", message: "Live session authority or occupant changed" });
    }
    return request;
  }, Effect.mapError(journalError));
  const appendEventWithin = Effect.fn("live.event.append-within")(function* (input: AppendLiveEvent, now: string) {
    yield* requireSession(input.sessionId);
    if (input.requestId !== null && (yield* requireRequest(input.requestId)).sessionId !== input.sessionId) {
      return yield* new LiveJournalError({ code: "conflict", message: "Live event request belongs to another session" });
    }
    if (input.operationId !== null) {
      const operation = yield* requireOperation(input.operationId);
      if (operation.requestId !== input.requestId) {
        return yield* new LiveJournalError({ code: "conflict", message: "Live event operation belongs to another request" });
      }
    }
    const detail = yield* attempt(() => encodeObject(input.detail));
    const result = yield* insertEvent({ ...input, detail, now });
    return { ...input, sequence: Number(result.lastInsertRowid), createdAt: now };
  });
  /** Same-transaction receipt; deliberately does not call sql.withTransaction. */
  const transitionOperationWithin = Effect.fn("live.operation.transition-within")(function* (input: TransitionLiveOperation, timestamp?: string) {
    const now = timestamp ?? (yield* attempt(clock));
    const operation = yield* requireOperation(input.operationId);
    if (operation.status !== input.from) return yield* new LiveJournalError({ code: "conflict", message: "Live operation state changed" });
    if (!operationTransitions[operation.status].includes(input.to)) {
      return yield* new LiveJournalError({ code: "invalid", message: `Invalid Live operation transition ${input.from} to ${input.to}` });
    }
    if (input.to === "admitted" || input.to === "dispatched" || (input.to === "applied" && input.from === "admitted")) {
      if (!input.correlation) return yield* new LiveJournalError({ code: "invalid", message: "Live operation admission requires current request correlation" });
      const correlation = input.correlation;
      if (operation.requestId !== correlation.requestId || operation.intentRevision !== correlation.intentRevision) {
        return yield* new LiveJournalError({ code: "stale", message: "Live operation belongs to another intent revision" });
      }
      yield* assertRequestCurrentWithin(correlation);
    }
    const outcome = yield* attempt(() => input.outcome === undefined ? null : encodeObject(input.outcome));
    yield* sql`UPDATE overseer_live_operations SET status = ${input.to}, outcome_json = ${outcome}, updated_at = ${now} WHERE operation_id = ${input.operationId}`;
    const request = yield* requireRequest(operation.requestId);
    yield* appendEventWithin({ sessionId: request.sessionId, requestId: request.requestId, operationId: operation.operationId,
      kind: "operation.transition", detail: { from: input.from, to: input.to, intentRevision: operation.intentRevision, outcome: input.outcome ?? null } }, now);
    return yield* requireOperation(input.operationId);
  }, Effect.mapError(journalError));
  const invalidatePendingOperations = Effect.fn("live.operation.invalidate-pending")(function* (request: LiveRequestRecord, reason: string, now: string) {
    for (const operation of yield* pendingOperations(request.requestId)) {
      yield* transitionOperationWithin({ operationId: operation.operationId, from: operation.status,
        to: "failed", outcome: { reason, intentRevision: request.intentRevision } }, now);
    }
  });
  return {
    createSession: Effect.fn("live.session.create")(function* (input: LiveSessionBinding & { readonly backendConversationId?: string; readonly providerSessionId?: string }) {
      const now = yield* attempt(clock);
      yield* sql`INSERT INTO overseer_live_sessions (session_id, seat_node_ref, occupant_generation, authority_epoch,
        status, backend_conversation_id, provider_session_id, created_at, updated_at) VALUES
        (${input.sessionId}, ${input.seatNodeRef}, ${input.occupantGeneration}, ${input.authorityEpoch}, 'active', ${input.backendConversationId ?? null}, ${input.providerSessionId ?? null}, ${now}, ${now})`;
      yield* appendEventWithin({ sessionId: input.sessionId, requestId: null, operationId: null, kind: "session.created", detail: {} }, now);
      return yield* requireSession(input.sessionId);
    }, write("session.create")),
    getSession: Effect.fn("live.session.get")(function* (sessionId: string) {
      return Option.getOrUndefined(yield* sessionById(sessionId));
    }, Effect.mapError(journalError)),
    listSessions: Effect.fn("live.session.list")(function* (limit?: number) {
      return yield* sessionsByRecency(yield* attempt(() => boundedLimit(limit))).pipe(Effect.mapError(journalError));
    }),
    updateSessionBackend: Effect.fn("live.session.backend")(function* (sessionId: string, refs: { readonly backendConversationId?: string; readonly providerSessionId?: string }) {
      const session = yield* requireSession(sessionId);
      if (session.status !== "active") return yield* new LiveJournalError({ code: "stale", message: "Live session requires fresh admission" });
      const backendConversationId = refs.backendConversationId ?? session.backendConversationId;
      const providerSessionId = refs.providerSessionId ?? session.providerSessionId;
      const now = yield* attempt(clock);
      yield* sql`UPDATE overseer_live_sessions SET backend_conversation_id = ${backendConversationId}, provider_session_id = ${providerSessionId}, updated_at = ${now} WHERE session_id = ${sessionId}`;
      return yield* requireSession(sessionId);
    }, write("session.backend")),
    closeSession: Effect.fn("live.session.close")(function* (sessionId: string) {
      const session = yield* requireSession(sessionId);
      if (session.status === "closed") return session;
      const now = yield* attempt(clock);
      yield* sql`UPDATE overseer_live_sessions SET status = 'closed', updated_at = ${now} WHERE session_id = ${sessionId}`;
      for (const request of yield* requestsBySession(sessionId)) {
        if (!pendingRequest(request.status)) continue;
        yield* invalidatePendingOperations(request, "session-closed", now);
        yield* sql`UPDATE overseer_live_requests SET status = 'cancelled', updated_at = ${now} WHERE request_id = ${request.requestId}`;
      }
      yield* appendEventWithin({ sessionId, requestId: null, operationId: null, kind: "session.closed", detail: {} }, now);
      return yield* requireSession(sessionId);
    }, write("session.close")),
    createRequest: Effect.fn("live.request.create")(function* (input: CreateLiveRequest) {
      if (input.providerDelegationId !== null) {
        const existing = yield* requestByDelegation({ sessionId: input.sessionId, providerDelegationId: input.providerDelegationId });
        if (Option.isSome(existing)) return { request: existing.value, created: false };
      }
      if ((yield* requireSession(input.sessionId)).status !== "active") return yield* new LiveJournalError({ code: "stale", message: "Live session requires fresh admission" });
      const now = yield* attempt(clock);
      const capturedContext = yield* attempt(() => encodeObject(input.capturedContext));
      const transcriptRefs = yield* attempt(() => encode(stringArray(input.transcriptRefs)));
      yield* sql`INSERT INTO overseer_live_requests (request_id, session_id, provider_delegation_id, intent_revision,
        status, text, captured_context_json, transcript_refs_json, created_at, updated_at) VALUES
        (${input.requestId}, ${input.sessionId}, ${input.providerDelegationId}, 1, 'queued', ${input.text}, ${capturedContext}, ${transcriptRefs}, ${now}, ${now})`;
      yield* appendEventWithin({ sessionId: input.sessionId, requestId: input.requestId, operationId: null, kind: "request.created",
        detail: { intentRevision: 1, text: input.text, capturedContext: input.capturedContext,
          transcriptRefs: input.transcriptRefs, providerDelegationId: input.providerDelegationId } }, now);
      return { request: yield* requireRequest(input.requestId), created: true };
    }, write("request.create")),
    getRequest: Effect.fn("live.request.get")(function* (requestId: string) {
      return Option.getOrUndefined(yield* requestById(requestId));
    }, Effect.mapError(journalError)),
    listRequests: Effect.fn("live.request.list")(function* (sessionId: string, limit?: number) {
      return yield* requestsByRecency({ sessionId, limit: yield* attempt(() => boundedLimit(limit)) });
    }, Effect.mapError(journalError)),
    updateRequestIntent: Effect.fn("live.request.revise")(function* (requestId: string, expectedRevision: number, input: Pick<CreateLiveRequest, "text" | "capturedContext" | "transcriptRefs">) {
      const request = yield* requireActiveRequest(requestId, expectedRevision);
      const now = yield* attempt(clock);
      yield* invalidatePendingOperations(request, "intent-superseded", now);
      const capturedContext = yield* attempt(() => encodeObject(input.capturedContext));
      const transcriptRefs = yield* attempt(() => encode(stringArray(input.transcriptRefs)));
      yield* sql`UPDATE overseer_live_requests SET intent_revision = ${expectedRevision + 1}, status = 'queued', text = ${input.text},
        captured_context_json = ${capturedContext}, transcript_refs_json = ${transcriptRefs}, updated_at = ${now} WHERE request_id = ${requestId}`;
      yield* appendEventWithin({ sessionId: request.sessionId, requestId, operationId: null, kind: "request.revised",
        detail: { previousRevision: expectedRevision, intentRevision: expectedRevision + 1, text: input.text,
          capturedContext: input.capturedContext, transcriptRefs: input.transcriptRefs } }, now);
      return yield* requireRequest(requestId);
    }, write("request.revise")),
    setRequestStatus: Effect.fn("live.request.status")(function* (requestId: string, expectedRevision: number, status: LiveRequestStatus) {
      const request = yield* requireActiveRequest(requestId, expectedRevision);
      const now = yield* attempt(clock);
      if (!pendingRequest(status)) yield* invalidatePendingOperations(request, `request-${status}`, now);
      yield* sql`UPDATE overseer_live_requests SET status = ${status}, updated_at = ${now} WHERE request_id = ${requestId}`;
      yield* appendEventWithin({ sessionId: request.sessionId, requestId, operationId: null, kind: "request.status", detail: { from: request.status, to: status, intentRevision: expectedRevision } }, now);
      return yield* requireRequest(requestId);
    }, write("request.status")),
    proposeOperation: Effect.fn("live.operation.propose")(function* (input: ProposeLiveOperation) {
      const argsSha256 = yield* attempt(() => operationArgsHash(input.args));
      const targetRefs = yield* attempt(() => encode(stringArray(input.targetRefs)));
      const existing = Option.getOrUndefined(yield* operationById(input.operationId));
      if (existing) {
        const conflict = yield* attempt(() => existing.requestId !== input.requestId || existing.intentRevision !== input.intentRevision || existing.operation !== input.operation ||
          existing.argsSha256 !== argsSha256 || encode(existing.targetRefs) !== targetRefs || existing.targetRevision !== input.targetRevision);
        if (conflict) {
          return yield* new LiveJournalError({ code: "conflict", message: "Live operation id already binds different immutable intent" });
        }
        return { operation: existing, created: false };
      }
      const request = yield* requireActiveRequest(input.requestId, input.intentRevision);
      const now = yield* attempt(clock);
      const args = yield* attempt(() => encodeObject(input.args));
      yield* sql`INSERT INTO overseer_live_operations (operation_id, request_id, intent_revision, operation, args_json, args_sha256,
        target_refs_json, target_revision, status, outcome_json, created_at, updated_at) VALUES
        (${input.operationId}, ${input.requestId}, ${input.intentRevision}, ${input.operation}, ${args}, ${argsSha256}, ${targetRefs}, ${input.targetRevision}, 'proposed', NULL, ${now}, ${now})`;
      yield* appendEventWithin({ sessionId: request.sessionId, requestId: input.requestId, operationId: input.operationId, kind: "operation.proposed", detail: { intentRevision: input.intentRevision, operation: input.operation, argsSha256 } }, now);
      return { operation: yield* requireOperation(input.operationId), created: true };
    }, write("operation.propose")),
    getOperation: Effect.fn("live.operation.get")(function* (operationId: string) {
      return Option.getOrUndefined(yield* operationById(operationId));
    }, Effect.mapError(journalError)),
    listOperations: Effect.fn("live.operation.list")(function* (requestId: string, limit?: number) {
      return yield* operationsByRecency({ requestId, limit: yield* attempt(() => boundedLimit(limit)) });
    }, Effect.mapError(journalError)),
    transitionOperation: Effect.fn("live.operation.transition")(function* (input: TransitionLiveOperation) {
      return yield* transitionOperationWithin(input, yield* attempt(clock));
    }, write("operation.transition")),
    assertRequestCurrent: Effect.fn("live.request.current")(function* (correlation: LiveRequestCorrelation) {
      return yield* withSqlRead(sql, assertRequestCurrentWithin(correlation)).pipe(Effect.mapError(journalError));
    }),
    assertRequestCurrentWithin,
    transitionOperationWithin,
    appendEvent: Effect.fn("live.event.append")(function* (input: AppendLiveEvent) {
      return yield* appendEventWithin(input, yield* attempt(clock));
    }, write("event.append")),
    listEvents: Effect.fn("live.event.list")(function* (sessionId: string, afterSequence = 0, limit?: number) {
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
        return yield* new LiveJournalError({ code: "invalid", message: "Live event cursor must be a nonnegative safe integer" });
      }
      return yield* eventsAfter({ sessionId, afterSequence, limit: yield* attempt(() => boundedLimit(limit)) });
    }, Effect.mapError(journalError)),
    /** Run once when the main-owned Live service starts. This never dispatches or replays. */
    recoverInterrupted: Effect.fn("live.recover")(function* () {
      const now = yield* attempt(clock);
      const sessions = yield* activeSessions(undefined);
      let uncertainCount = 0;
      // Closing a call does not prove an already-dispatched native effect stopped.
      // Recover those receipts too, even when their conversation is closed.
      for (const operation of yield* uncertainOperations(undefined)) {
        yield* transitionOperationWithin({ operationId: operation.operationId, from: operation.status, to: "unknown", outcome: { reason: "runtime-interrupted", reconciliationRequired: true } }, now);
        uncertainCount += 1;
      }
      for (const session of sessions) {
        yield* sql`UPDATE overseer_live_requests SET status = 'interrupted', updated_at = ${now} WHERE session_id = ${session.sessionId} AND status IN ('queued', 'interpreting', 'waiting-approval', 'running')`;
        yield* sql`UPDATE overseer_live_sessions SET status = 'interrupted', updated_at = ${now} WHERE session_id = ${session.sessionId}`;
        yield* appendEventWithin({ sessionId: session.sessionId, requestId: null, operationId: null, kind: "session.interrupted", detail: { freshAdmissionRequired: true } }, now);
      }
      return { interruptedSessions: sessions.length, uncertainOperations: uncertainCount };
    }, write("recover")),
  };
};
export type LiveRepositoryShape = ReturnType<typeof makeLiveRepository>;

export class LiveRepository extends Context.Service<LiveRepository, LiveRepositoryShape>()("@junto/LiveRepository") {
  static readonly layer: Layer.Layer<LiveRepository, never, SqlClient.SqlClient> = Layer.effect(
    LiveRepository, Effect.map(SqlClient.SqlClient, (sql) => makeLiveRepository(sql)),
  );
}
