import { createHash } from "node:crypto";
import { Effect, Schema } from "effect";
import type { StateEngineShape, StateReader, StateRow, StateWriter } from "../../state/service";

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
const jsonObject = (value: unknown): LiveJsonObject => objectSchema(JSON.parse(String(value)));
const refs = (value: unknown): readonly string[] => stringArray(JSON.parse(String(value)));
const nullableString = (value: unknown): string | null => value === null ? null : String(value);

const sessionRecord = (row: StateRow): LiveSessionRecord => ({
  sessionId: String(row.session_id), seatNodeRef: String(row.seat_node_ref),
  occupantGeneration: String(row.occupant_generation), authorityEpoch: String(row.authority_epoch),
  status: row.status as LiveSessionStatus, backendConversationId: nullableString(row.backend_conversation_id),
  providerSessionId: nullableString(row.provider_session_id), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
});
const requestRecord = (row: StateRow): LiveRequestRecord => ({
  requestId: String(row.request_id), sessionId: String(row.session_id), providerDelegationId: nullableString(row.provider_delegation_id),
  intentRevision: Number(row.intent_revision), status: row.status as LiveRequestStatus, text: String(row.text),
  capturedContext: jsonObject(row.captured_context_json), transcriptRefs: refs(row.transcript_refs_json),
  createdAt: String(row.created_at), updatedAt: String(row.updated_at),
});
const operationRecord = (row: StateRow): LiveOperationRecord => ({
  operationId: String(row.operation_id), requestId: String(row.request_id), intentRevision: Number(row.intent_revision),
  operation: String(row.operation), args: jsonObject(row.args_json), argsSha256: String(row.args_sha256),
  targetRefs: refs(row.target_refs_json), targetRevision: nullableString(row.target_revision), status: row.status as LiveOperationStatus,
  outcome: row.outcome_json === null ? null : jsonObject(row.outcome_json), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
});
const eventRecord = (row: StateRow): LiveEventRecord => ({
  sequence: Number(row.sequence), sessionId: String(row.session_id), requestId: nullableString(row.request_id),
  operationId: nullableString(row.operation_id), kind: String(row.kind), detail: jsonObject(row.detail_json), createdAt: String(row.created_at),
});
const getSession = (reader: StateReader, id: string): LiveSessionRecord | undefined => {
  const row = reader.get("SELECT * FROM overseer_live_sessions WHERE session_id = ?", [id]);
  return row && sessionRecord(row);
};
const getRequest = (reader: StateReader, id: string): LiveRequestRecord | undefined => {
  const row = reader.get("SELECT * FROM overseer_live_requests WHERE request_id = ?", [id]);
  return row && requestRecord(row);
};
const getOperation = (reader: StateReader, id: string): LiveOperationRecord | undefined => {
  const row = reader.get("SELECT * FROM overseer_live_operations WHERE operation_id = ?", [id]);
  return row && operationRecord(row);
};
const requireSession = (reader: StateReader, id: string): LiveSessionRecord =>
  getSession(reader, id) ?? fail("missing", `Live session ${id} does not exist`);
const requireRequest = (reader: StateReader, id: string): LiveRequestRecord =>
  getRequest(reader, id) ?? fail("missing", `Live request ${id} does not exist`);
const requireOperation = (reader: StateReader, id: string): LiveOperationRecord =>
  getOperation(reader, id) ?? fail("missing", `Live operation ${id} does not exist`);
const pendingRequest = (status: LiveRequestStatus): boolean =>
  status === "queued" || status === "interpreting" || status === "waiting-approval" || status === "running";
const requireActiveRequest = (reader: StateReader, id: string, revision: number): LiveRequestRecord => {
  const request = requireRequest(reader, id);
  if (request.intentRevision !== revision || !pendingRequest(request.status)) fail("stale", "Live request intent is no longer current");
  if (requireSession(reader, request.sessionId).status !== "active") fail("stale", "Live session requires fresh admission");
  return request;
};

/** Call from the owning canvas/Work transaction immediately before its durable write. */
export const assertLiveRequestCurrent = (reader: StateReader, correlation: LiveRequestCorrelation): LiveRequestRecord => {
  const request = requireActiveRequest(reader, correlation.requestId, correlation.intentRevision);
  const session = requireSession(reader, request.sessionId);
  if (request.sessionId !== correlation.sessionId || session.occupantGeneration !== correlation.occupantGeneration ||
      session.authorityEpoch !== correlation.authorityEpoch) fail("stale", "Live session authority or occupant changed");
  return request;
};

const appendEvent = (writer: StateWriter, input: AppendLiveEvent, now: string): LiveEventRecord => {
  requireSession(writer, input.sessionId);
  if (input.requestId !== null && requireRequest(writer, input.requestId).sessionId !== input.sessionId) {
    fail("conflict", "Live event request belongs to another session");
  }
  if (input.operationId !== null) {
    const operation = requireOperation(writer, input.operationId);
    if (operation.requestId !== input.requestId) fail("conflict", "Live event operation belongs to another request");
  }
  const result = writer.run(`INSERT INTO overseer_live_events
    (session_id, request_id, operation_id, kind, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  [input.sessionId, input.requestId, input.operationId, input.kind, encodeObject(input.detail), now]);
  return { ...input, sequence: Number(result.lastInsertRowid), createdAt: now };
};
const operationTransitions: Record<LiveOperationStatus, readonly LiveOperationStatus[]> = {
  proposed: ["awaiting-approval", "admitted", "failed"],
  "awaiting-approval": ["admitted", "failed"],
  admitted: ["dispatched", "applied", "failed", "unknown"],
  dispatched: ["applied", "failed", "partial", "unknown"],
  applied: [], failed: [], partial: [], unknown: ["applied", "failed", "partial"],
};

/** Same-transaction receipt seam, supplied only to existing main-owned mutation services. */
export const transitionLiveOperationInTransaction = (
  writer: StateWriter, input: TransitionLiveOperation, now = new Date().toISOString(),
): LiveOperationRecord => {
  const operation = requireOperation(writer, input.operationId);
  if (operation.status !== input.from) fail("conflict", "Live operation state changed");
  if (!operationTransitions[operation.status].includes(input.to)) fail("invalid", `Invalid Live operation transition ${input.from} to ${input.to}`);
  if (input.to === "admitted" || input.to === "dispatched" || (input.to === "applied" && input.from === "admitted")) {
    if (!input.correlation) fail("invalid", "Live operation admission requires current request correlation");
    const correlation = input.correlation!;
    if (operation.requestId !== correlation.requestId || operation.intentRevision !== correlation.intentRevision) {
      fail("stale", "Live operation belongs to another intent revision");
    }
    assertLiveRequestCurrent(writer, correlation);
  }
  writer.run("UPDATE overseer_live_operations SET status = ?, outcome_json = ?, updated_at = ? WHERE operation_id = ?",
    [input.to, input.outcome === undefined ? null : encodeObject(input.outcome), now, input.operationId]);
  const request = requireRequest(writer, operation.requestId);
  appendEvent(writer, { sessionId: request.sessionId, requestId: request.requestId, operationId: operation.operationId,
    kind: "operation.transition", detail: { from: input.from, to: input.to, intentRevision: operation.intentRevision, outcome: input.outcome ?? null } }, now);
  return requireOperation(writer, input.operationId);
};

const boundedLimit = (limit = 100): number => {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) fail("invalid", "Live journal query limit must be between 1 and 200");
  return limit;
};
const journalError = (error: { readonly cause: unknown; readonly message: string }): LiveJournalError =>
  error.cause instanceof LiveJournalError ? error.cause : new LiveJournalError({ code: "persistence", message: error.message });

/** Uses the installation's existing connection; never opens a second product database. */
export const makeLiveRepository = (state: StateEngineShape, clock = () => new Date().toISOString()) => {
  const read = <A>(name: string, body: (reader: StateReader) => A) => state.read(`live.${name}`, body).pipe(Effect.mapError(journalError));
  const write = <A>(name: string, body: (writer: StateWriter) => A) => state.transaction(`live.${name}`, body).pipe(Effect.mapError(journalError));
  const invalidatePendingOperations = (writer: StateWriter, request: LiveRequestRecord, reason: string, now: string) => {
    const operations = writer.all("SELECT * FROM overseer_live_operations WHERE request_id = ? AND status IN ('proposed', 'awaiting-approval', 'admitted')", [request.requestId]);
    for (const row of operations) {
      const operation = operationRecord(row);
      transitionLiveOperationInTransaction(writer, { operationId: operation.operationId, from: operation.status,
        to: "failed", outcome: { reason, intentRevision: request.intentRevision } }, now);
    }
  };
  return {
    createSession: (input: LiveSessionBinding & { readonly backendConversationId?: string; readonly providerSessionId?: string }) => write("session.create", (writer) => {
      const now = clock();
      writer.run(`INSERT INTO overseer_live_sessions (session_id, seat_node_ref, occupant_generation, authority_epoch,
        status, backend_conversation_id, provider_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      [input.sessionId, input.seatNodeRef, input.occupantGeneration, input.authorityEpoch, input.backendConversationId ?? null, input.providerSessionId ?? null, now, now]);
      appendEvent(writer, { sessionId: input.sessionId, requestId: null, operationId: null, kind: "session.created", detail: {} }, now);
      return requireSession(writer, input.sessionId);
    }),
    getSession: (sessionId: string) => read("session.get", (reader) => getSession(reader, sessionId)),
    listSessions: (limit?: number) => read("session.list", (reader) => reader.all(
      "SELECT * FROM overseer_live_sessions ORDER BY created_at DESC, session_id DESC LIMIT ?", [boundedLimit(limit)]).map(sessionRecord)),
    updateSessionBackend: (sessionId: string, refs: { readonly backendConversationId?: string; readonly providerSessionId?: string }) => write("session.backend", (writer) => {
      const session = requireSession(writer, sessionId);
      if (session.status !== "active") fail("stale", "Live session requires fresh admission");
      writer.run("UPDATE overseer_live_sessions SET backend_conversation_id = ?, provider_session_id = ?, updated_at = ? WHERE session_id = ?",
        [refs.backendConversationId ?? session.backendConversationId, refs.providerSessionId ?? session.providerSessionId, clock(), sessionId]);
      return requireSession(writer, sessionId);
    }),
    closeSession: (sessionId: string) => write("session.close", (writer) => {
      const session = requireSession(writer, sessionId);
      if (session.status === "closed") return session;
      const now = clock();
      writer.run("UPDATE overseer_live_sessions SET status = 'closed', updated_at = ? WHERE session_id = ?", [now, sessionId]);
      for (const row of writer.all("SELECT * FROM overseer_live_requests WHERE session_id = ?", [sessionId])) {
        const request = requestRecord(row);
        if (!pendingRequest(request.status)) continue;
        invalidatePendingOperations(writer, request, "session-closed", now);
        writer.run("UPDATE overseer_live_requests SET status = 'cancelled', updated_at = ? WHERE request_id = ?", [now, request.requestId]);
      }
      appendEvent(writer, { sessionId, requestId: null, operationId: null, kind: "session.closed", detail: {} }, now);
      return requireSession(writer, sessionId);
    }),
    createRequest: (input: CreateLiveRequest) => write("request.create", (writer) => {
      if (input.providerDelegationId !== null) {
        const existing = writer.get("SELECT * FROM overseer_live_requests WHERE session_id = ? AND provider_delegation_id = ?", [input.sessionId, input.providerDelegationId]);
        if (existing) return { request: requestRecord(existing), created: false };
      }
      if (requireSession(writer, input.sessionId).status !== "active") fail("stale", "Live session requires fresh admission");
      const now = clock();
      writer.run(`INSERT INTO overseer_live_requests (request_id, session_id, provider_delegation_id, intent_revision,
        status, text, captured_context_json, transcript_refs_json, created_at, updated_at) VALUES (?, ?, ?, 1, 'queued', ?, ?, ?, ?, ?)`,
      [input.requestId, input.sessionId, input.providerDelegationId, input.text, encodeObject(input.capturedContext), encode(stringArray(input.transcriptRefs)), now, now]);
      appendEvent(writer, { sessionId: input.sessionId, requestId: input.requestId, operationId: null, kind: "request.created",
        detail: { intentRevision: 1, text: input.text, capturedContext: input.capturedContext,
          transcriptRefs: input.transcriptRefs, providerDelegationId: input.providerDelegationId } }, now);
      return { request: requireRequest(writer, input.requestId), created: true };
    }),
    getRequest: (requestId: string) => read("request.get", (reader) => getRequest(reader, requestId)),
    listRequests: (sessionId: string, limit?: number) => read("request.list", (reader) => reader.all(
      "SELECT * FROM overseer_live_requests WHERE session_id = ? ORDER BY created_at DESC, request_id DESC LIMIT ?", [sessionId, boundedLimit(limit)]).map(requestRecord)),
    updateRequestIntent: (requestId: string, expectedRevision: number, input: Pick<CreateLiveRequest, "text" | "capturedContext" | "transcriptRefs">) => write("request.revise", (writer) => {
      const request = requireActiveRequest(writer, requestId, expectedRevision);
      const now = clock();
      invalidatePendingOperations(writer, request, "intent-superseded", now);
      writer.run("UPDATE overseer_live_requests SET intent_revision = ?, status = 'queued', text = ?, captured_context_json = ?, transcript_refs_json = ?, updated_at = ? WHERE request_id = ?",
        [expectedRevision + 1, input.text, encodeObject(input.capturedContext), encode(stringArray(input.transcriptRefs)), now, requestId]);
      appendEvent(writer, { sessionId: request.sessionId, requestId, operationId: null, kind: "request.revised",
        detail: { previousRevision: expectedRevision, intentRevision: expectedRevision + 1, text: input.text,
          capturedContext: input.capturedContext, transcriptRefs: input.transcriptRefs } }, now);
      return requireRequest(writer, requestId);
    }),
    setRequestStatus: (requestId: string, expectedRevision: number, status: LiveRequestStatus) => write("request.status", (writer) => {
      const request = requireActiveRequest(writer, requestId, expectedRevision);
      const now = clock();
      if (!pendingRequest(status)) invalidatePendingOperations(writer, request, `request-${status}`, now);
      writer.run("UPDATE overseer_live_requests SET status = ?, updated_at = ? WHERE request_id = ?", [status, now, requestId]);
      appendEvent(writer, { sessionId: request.sessionId, requestId, operationId: null, kind: "request.status", detail: { from: request.status, to: status, intentRevision: expectedRevision } }, now);
      return requireRequest(writer, requestId);
    }),
    proposeOperation: (input: ProposeLiveOperation) => write("operation.propose", (writer) => {
      const argsSha256 = operationArgsHash(input.args);
      const targetRefs = encode(stringArray(input.targetRefs));
      const existing = getOperation(writer, input.operationId);
      if (existing) {
        if (existing.requestId !== input.requestId || existing.intentRevision !== input.intentRevision || existing.operation !== input.operation ||
            existing.argsSha256 !== argsSha256 || encode(existing.targetRefs) !== targetRefs || existing.targetRevision !== input.targetRevision) {
          fail("conflict", "Live operation id already binds different immutable intent");
        }
        return { operation: existing, created: false };
      }
      const request = requireActiveRequest(writer, input.requestId, input.intentRevision);
      const now = clock();
      writer.run(`INSERT INTO overseer_live_operations (operation_id, request_id, intent_revision, operation, args_json, args_sha256,
        target_refs_json, target_revision, status, outcome_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'proposed', NULL, ?, ?)`,
      [input.operationId, input.requestId, input.intentRevision, input.operation, encodeObject(input.args), argsSha256, targetRefs, input.targetRevision, now, now]);
      appendEvent(writer, { sessionId: request.sessionId, requestId: input.requestId, operationId: input.operationId, kind: "operation.proposed", detail: { intentRevision: input.intentRevision, operation: input.operation, argsSha256 } }, now);
      return { operation: requireOperation(writer, input.operationId), created: true };
    }),
    getOperation: (operationId: string) => read("operation.get", (reader) => getOperation(reader, operationId)),
    listOperations: (requestId: string, limit?: number) => read("operation.list", (reader) => reader.all(
      "SELECT * FROM overseer_live_operations WHERE request_id = ? ORDER BY created_at DESC, operation_id DESC LIMIT ?", [requestId, boundedLimit(limit)]).map(operationRecord)),
    transitionOperation: (input: TransitionLiveOperation) => write("operation.transition", (writer) => transitionLiveOperationInTransaction(writer, input, clock())),
    assertRequestCurrent: (correlation: LiveRequestCorrelation) => read("request.current", (reader) => assertLiveRequestCurrent(reader, correlation)),
    appendEvent: (input: AppendLiveEvent) => write("event.append", (writer) => appendEvent(writer, input, clock())),
    listEvents: (sessionId: string, afterSequence = 0, limit?: number) => read("event.list", (reader) => {
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) fail("invalid", "Live event cursor must be a nonnegative safe integer");
      return reader.all("SELECT * FROM overseer_live_events WHERE session_id = ? AND sequence > ? ORDER BY sequence LIMIT ?",
        [sessionId, afterSequence, boundedLimit(limit)]).map(eventRecord);
    }),
    /** Run once when the main-owned Live service starts. This never dispatches or replays. */
    recoverInterrupted: () => write("recover", (writer) => {
      const now = clock();
      const sessions = writer.all("SELECT * FROM overseer_live_sessions WHERE status = 'active'").map(sessionRecord);
      let uncertainOperations = 0;
      // Closing a call does not prove an already-dispatched native effect stopped.
      // Recover those receipts too, even when their conversation is closed.
      for (const row of writer.all("SELECT * FROM overseer_live_operations WHERE status IN ('admitted', 'dispatched')")) {
        const operation = operationRecord(row);
        transitionLiveOperationInTransaction(writer, { operationId: operation.operationId, from: operation.status, to: "unknown", outcome: { reason: "runtime-interrupted", reconciliationRequired: true } }, now);
        uncertainOperations += 1;
      }
      for (const session of sessions) {
        writer.run("UPDATE overseer_live_requests SET status = 'interrupted', updated_at = ? WHERE session_id = ? AND status IN ('queued', 'interpreting', 'waiting-approval', 'running')", [now, session.sessionId]);
        writer.run("UPDATE overseer_live_sessions SET status = 'interrupted', updated_at = ? WHERE session_id = ?", [now, session.sessionId]);
        appendEvent(writer, { sessionId: session.sessionId, requestId: null, operationId: null, kind: "session.interrupted", detail: { freshAdmissionRequired: true } }, now);
      }
      return { interruptedSessions: sessions.length, uncertainOperations };
    }),
  };
};
export type LiveRepository = ReturnType<typeof makeLiveRepository>;
