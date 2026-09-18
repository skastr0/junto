/**
 * Awareness transport and adapter boundary — the one place the sidecar speaks
 * to the provider.
 *
 * Authority: this file owns the provider call and nothing else. It cannot reach
 * a seat, a managed write decision, a submitted byte, a delivery receipt,
 * occupancy, or the canvas. Its only product is a validated assessment that the
 * scheduler may publish as advisory display.
 *
 * WHAT THIS OWNS
 * --------------
 *   - the SDK client: constructed only when a key exists, with retries off,
 *     body logging off, and a ~2s per-attempt timeout;
 *   - the call: `client.systemOne({ state, questions })` with a
 *     generation-scoped AbortSignal and its own deadline, so the in-flight slot
 *     frees on time even if the SDK's own timer is late;
 *   - the wire mapping in both directions: workstream C's canonical request
 *     becomes the SDK's `state` plus one typed question per pack question, and
 *     the SDK's typed answers become C's raw answer list with the evidence-hash
 *     provenance echo C validates against;
 *   - failure classification, which is transport policy: credential, rate
 *     limit, timeout, transport, unavailable, aborted.
 *
 * WHAT THIS DOES NOT OWN
 * ----------------------
 * Question text, evidence selection, redaction, the window digest, and answer
 * validation all belong to workstream C (`questions.ts`, `select-input.ts`,
 * `project-result.ts`). This adapter never re-implements any of them: a
 * provider body is turned into an assessment by calling C's projector, and
 * every transport failure is turned into an honest `unavailable` assessment by
 * calling C's constructor. There is no second answer envelope here.
 *
 * A missing key constructs no client at all. Every failure path is total: an
 * assessment comes back either way, so nothing in this file can throw into the
 * deterministic path.
 */

import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  AuthenticationError,
  PermissionDeniedError,
  RateLimitError,
  TypeSafeClient,
  TypeSafeError,
  choice,
  noul,
  type ChoiceCriteria,
  type EntryType,
  type Question,
  type SystemOneResult,
} from "@typesafe-ai/sdk";
import { Context, Effect, Layer } from "effect";
import { awarenessQuestion } from "./questions";
import {
  projectAwarenessAnswers,
  projectAwarenessUnavailable,
  type AwarenessAssessment,
  type RawAwarenessAnswer,
  type RawAwarenessResponse,
  type UnavailableReason,
} from "./project-result";
import type { AwarenessRequestState } from "./select-input";

/** The SDK's own default, and the model the pack was calibrated against. */
export const DEFAULT_AWARENESS_MODEL = "jev-latest";

/**
 * Per-attempt timeout. The SDK default is 10s with no total retry budget, which
 * is far too long to hold an in-flight slot on the terminal path.
 */
export const DEFAULT_AWARENESS_TIMEOUT_MS = 2_000;

// ---------------------------------------------------------------------------
// Transport failure vocabulary
// ---------------------------------------------------------------------------

export type AwarenessTransportFailureKind =
  /** No key, or the client could not be constructed at all. */
  | "unavailable"
  /** The provider rejected the credential. Stops calls until reconfigured. */
  | "credential"
  | "rate-limited"
  | "timeout"
  | "transport"
  /** The caller retired the request before the provider answered. */
  | "aborted";

export type AwarenessTransportFailure = {
  readonly kind: AwarenessTransportFailureKind;
  readonly message: string;
  readonly status: number | undefined;
  readonly retryable: boolean;
};

/** Kinds the scheduler may retry later under its own backoff. */
export const isRetryableFailure = (kind: AwarenessTransportFailureKind): boolean =>
  kind === "timeout" || kind === "rate-limited" || kind === "transport";

/** Kinds a short station-wide circuit breaker counts. */
export const isBreakerFailure = (kind: AwarenessTransportFailureKind): boolean =>
  kind === "transport" || kind === "timeout";

const failure = (
  kind: AwarenessTransportFailureKind,
  message: string,
  status: number | undefined,
): AwarenessTransportFailure => ({
  kind,
  message,
  status,
  retryable: isRetryableFailure(kind),
});

// ---------------------------------------------------------------------------
// Ask
// ---------------------------------------------------------------------------

export type AwarenessUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
};

export type AwarenessAskOutcome = {
  /** Always present: a provider answer, an abstention, or an honest failure. */
  readonly assessment: AwarenessAssessment;
  /** Present only when the transport failed. Policy input, never display. */
  readonly failure: AwarenessTransportFailure | undefined;
  /** Provider-reported tokens, when the provider reported any. */
  readonly usage: AwarenessUsage | undefined;
};

export type AwarenessAsk = {
  readonly request: AwarenessRequestState;
  /** Harness occupying the seat. Context for the model, not evidence. */
  readonly harness: string;
};

export type AwarenessModelShape = {
  /** Configured provider model id. Part of the advisory cache key. */
  readonly id: string;
  /**
   * Availability, not reachability: true when a key is configured, so a call is
   * worth attempting. A configured-but-unreachable provider fails at `ask`.
   */
  readonly available: boolean;
  /** Why the model is unavailable, when it is. */
  readonly reason: string | undefined;
  readonly ask: (
    ask: AwarenessAsk,
    signal: AbortSignal,
  ) => Effect.Effect<AwarenessAskOutcome>;
  /**
   * The honest assessment for an observation this sidecar cannot ask about:
   * no key, a rejected credential, or an open breaker. Built through the same
   * projection as a provider failure so the display has exactly one shape.
   * Pure and cheap; constructs no client and sends nothing.
   */
  readonly unavailable: (input: {
    readonly request: AwarenessRequestState;
    readonly reason: UnavailableReason;
    readonly detail: string;
  }) => AwarenessAssessment;
};

/**
 * effect-foundation style service id: `@junto/AwarenessModel` — single
 * definition, no dual Live + `.layer` export.
 */
export class AwarenessModel extends Context.Service<AwarenessModel, AwarenessModelShape>()(
  "@junto/AwarenessModel",
) {}

export type JevClientOptions = {
  /** Discovered or enrolled key. Never logged, never projected, never in IPC. */
  readonly apiKey: string | undefined;
  /** Provider model id. Defaults to the SDK's own default. */
  readonly model?: string;
  readonly timeoutMs?: number;
  /** Alternate API root (a proxy or a test server). */
  readonly baseURL?: string;
  /** Test seam: replaces the SDK's HTTP transport. */
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
};

// ---------------------------------------------------------------------------
// Redaction of provider words
// ---------------------------------------------------------------------------

const makeRedactor = (secret: string) => {
  const scrubbed = secret.trim();
  return (text: string): string =>
    scrubbed === "" ? text : text.split(scrubbed).join("[redacted]");
};

// ---------------------------------------------------------------------------
// Deadline
// ---------------------------------------------------------------------------

class AwarenessDeadline extends Error {
  constructor() {
    super("awareness deadline exceeded");
    this.name = "AwarenessDeadline";
  }
}

/** The deadline and the caller's signal both end the call; the SDK sees the signal. */
const raceDeadline = async (
  call: Promise<unknown>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<unknown> => {
  if (signal.aborted) throw new AwarenessDeadline();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const settled = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new AwarenessDeadline()), timeoutMs);
    onAbort = () => reject(new AwarenessDeadline());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([call, settled]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
};

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

/**
 * One classification site, over the SDK's own error classes. Keys are scrubbed
 * here because provider errors can echo the credential back in a message.
 */
export const classifyAwarenessFailure = (
  cause: unknown,
  signal: AbortSignal,
  redact: (text: string) => string,
): AwarenessTransportFailure => {
  if (cause instanceof AwarenessDeadline) {
    return signal.aborted
      ? failure("aborted", "awareness request retired before Jev answered", undefined)
      : failure("timeout", redact("Jev did not answer inside the awareness deadline"), undefined);
  }
  const rawMessage = cause instanceof Error ? cause.message : String(cause);
  const message = redact(rawMessage);
  const status = cause instanceof APIError ? cause.status : undefined;
  if (cause instanceof APIUserAbortError) {
    return failure("aborted", "awareness request retired before Jev answered", status);
  }
  if (cause instanceof APITimeoutError) return failure("timeout", message, status);
  if (cause instanceof RateLimitError) return failure("rate-limited", message, status);
  if (cause instanceof AuthenticationError || cause instanceof PermissionDeniedError) {
    return failure("credential", message, status);
  }
  if (cause instanceof APIConnectionError) return failure("transport", message, status);
  if (cause instanceof APIError) {
    // A 4xx that is not a credential or rate-limit problem means the request
    // itself was wrong: retrying it changes nothing.
    return status !== undefined && status >= 400 && status < 500
      ? failure("unavailable", message, status)
      : failure("transport", message, status);
  }
  // Config problems (bad key shape, unsupported runtime) are not retryable.
  if (cause instanceof TypeSafeError) return failure("unavailable", message, undefined);
  return failure("transport", message, status);
};

// ---------------------------------------------------------------------------
// Wire mapping: C's canonical request <-> the SDK's typed questions
// ---------------------------------------------------------------------------

/**
 * The `state` object the model reads. C's prompts speak about "the evidence"
 * and "the note below it", so the evidence block comes first and the temporal
 * note second. Key order is the payload order.
 */
const buildState = (ask: AwarenessAsk): EntryType => ({
  packVersion: ask.request.packVersion,
  harness: ask.harness,
  evidence: ask.request.wire.evidence,
  note: ask.request.wire.note,
});

/**
 * One SDK question per pack question. The SDK's descriptor shape is transport
 * detail, so it is built here from C's pack: a Noul carries no criteria (the
 * pack has no polarity text to describe), a static Choice carries the pack's
 * option labels, and the evidence-line Choice carries this observation's line
 * ids plus the pack's decline option.
 */
const buildQuestion = (id: string, prompt: string, request: AwarenessRequestState): Question | undefined => {
  const packQuestion = awarenessQuestion(id);
  if (packQuestion === undefined) return undefined;
  if (packQuestion.kind === "noul") return noul(prompt);
  const criteria: ChoiceCriteria = {};
  if (packQuestion.optionSource === "evidence_lines") {
    for (const line of request.evidenceLines) criteria[line.id] = null;
  }
  for (const option of packQuestion.options) criteria[option.id] = option.label;
  return choice(prompt, criteria);
};

const buildQuestions = (request: AwarenessRequestState): Record<string, Question> => {
  const questions: Record<string, Question> = {};
  for (const question of request.wire.questions) {
    const descriptor = buildQuestion(question.id, question.prompt, request);
    if (descriptor !== undefined) questions[question.id] = descriptor;
  }
  return questions;
};

/**
 * The SDK's answers, normalized into C's raw answer shape. The evidence-hash
 * echo is mandatory: C rejects an answer that cannot be traced to this exact
 * observation, so an answer is never resolved against a later screen's lines.
 */
const buildRawAnswers = (
  request: AwarenessRequestState,
  raw: unknown,
  requestedModel: string,
  returnedModel: string | undefined,
): readonly RawAwarenessAnswer[] => {
  const answers: RawAwarenessAnswer[] = [];
  // The SDK casts parsed JSON into its response type, so a body whose answers
  // field is not an object arrives here as-is. It becomes `no_answers` at the
  // projection, never a crash.
  if (raw === null || typeof raw !== "object") return answers;
  const byId = new Map(request.questions.map((question) => [question.id, question]));
  for (const [questionId, value] of Object.entries(raw)) {
    const kind = byId.get(questionId)?.kind;
    const record =
      value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
    const answer: RawAwarenessAnswer = {
      questionId,
      evidenceHash: request.evidenceHash,
      requestedModel,
      ...(returnedModel !== undefined ? { returnedModel } : {}),
      ...(kind !== undefined ? { kind } : {}),
      ...(kind === "noul" ? { probability: record?.["noul"] } : {}),
      ...(kind === "choice"
        ? {
            selectedOptionId: record?.["choice"],
            confidence: record?.["confidence"],
            optionProbabilities: record?.["probabilities"],
          }
        : {}),
    };
    answers.push(answer);
  }
  return answers;
};

const buildRawResponse = (
  request: AwarenessRequestState,
  raw: unknown,
  requestedModel: string,
): RawAwarenessResponse => {
  const record = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const returned =
    typeof record["model"] === "string" && record["model"].length > 0
      ? record["model"]
      : typeof record["returnedModel"] === "string" && record["returnedModel"].length > 0
        ? record["returnedModel"]
        : undefined;
  // The SDK's typed result does not include a response-level pack version, but
  // the provider may echo one. Forward it when it is there so the projection's
  // pack-mismatch guard is reachable; otherwise the request's own version is the
  // truth of what was asked.
  const echoed =
    typeof record["packVersion"] === "string" && record["packVersion"].length > 0
      ? record["packVersion"]
      : request.packVersion;
  return {
    packVersion: echoed,
    requestedModel,
    ...(returned !== undefined ? { returnedModel: returned } : {}),
    answers: buildRawAnswers(request, record["answers"], requestedModel, returned),
  };
};

const usageOf = (raw: unknown): AwarenessUsage | undefined => {
  const record = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const usage = record["usage"];
  if (usage === null || typeof usage !== "object") return undefined;
  const usageRecord = usage as Record<string, unknown>;
  const inputTokens = usageRecord["input_tokens"];
  const outputTokens = usageRecord["output_tokens"];
  if (typeof inputTokens !== "number" || !Number.isFinite(inputTokens)) return undefined;
  return {
    inputTokens,
    outputTokens:
      typeof outputTokens === "number" && Number.isFinite(outputTokens) ? outputTokens : 0,
  };
};

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

const unavailableAssessment = (
  request: AwarenessRequestState,
  reason: UnavailableReason,
  detail: string,
): AwarenessAssessment =>
  projectAwarenessUnavailable({
    bindingId: request.bindingId,
    epoch: request.epoch,
    sourceSeq: request.sourceSeq,
    observedAt: request.observedAt,
    evidenceHash: request.evidenceHash,
    packVersion: request.packVersion,
    reason,
    detail,
  });

/** Opt-in call trace: `JUNTO_AWARENESS_TRACE=1` logs one line per provider call. */
export const JEV_TRACE_ENV = "JUNTO_AWARENESS_TRACE";

export const makeAwarenessModel = (options: JevClientOptions): AwarenessModelShape => {
  const apiKey = options.apiKey?.trim();
  const model = options.model?.trim() || DEFAULT_AWARENESS_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_AWARENESS_TIMEOUT_MS;
  const unavailable: AwarenessModelShape["unavailable"] = ({ request, reason, detail }) =>
    unavailableAssessment(request, reason, detail);

  if (apiKey === undefined || apiKey === "") {
    const reason = "no Jev API key configured";
    return {
      id: model,
      available: false,
      reason,
      unavailable,
      ask: (ask) => Effect.succeed(notConfiguredOutcome(ask, reason)),
    };
  }

  const redact = makeRedactor(apiKey);
  // Constructed on first use, never at wiring time: building the awareness
  // plane must not touch the terminal startup path.
  let client: TypeSafeClient | undefined;
  let clientFailure: AwarenessTransportFailure | undefined;
  const resolveClient = (): TypeSafeClient | undefined => {
    if (client !== undefined) return client;
    if (clientFailure !== undefined) return undefined;
    try {
      client = new TypeSafeClient({
        apiKey,
        defaultModel: model,
        // `off` disables logging entirely; `debug` is what adds bodies.
        logLevel: "off",
        timeout: timeoutMs,
        // The scheduler owns backoff; the SDK must not retry behind its back.
        retry: { maxRetries: 0 },
        ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
        ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
      });
      return client;
    } catch (error) {
      clientFailure = classifyAwarenessFailure(error, new AbortController().signal, redact);
      return undefined;
    }
  };

  const runAsk = async (ask: AwarenessAsk, signal: AbortSignal): Promise<AwarenessAskOutcome> => {
    // Cost visibility, off by default: one line per real provider call, so an
    // operator (or a live test) can count calls and see what each one was
    // asked about without reading the provider's dashboard. No prompt text and
    // no key ever reaches this line.
    if (process.env[JEV_TRACE_ENV] === "1") {
      console.log(
        "[jev-call] " +
          JSON.stringify({
            bindingId: ask.request.bindingId,
            questions: ask.request.questions.length,
            evidenceLines: ask.request.evidenceLines.length,
            at: Date.now(),
          }),
      );
    }
    const resolved = resolveClient();
    if (resolved === undefined) {
      const transport = clientFailure ?? failure("unavailable", "the Jev client is unavailable", undefined);
      return {
        assessment: unavailableAssessment(ask.request, "not_configured", transport.message),
        failure: transport,
        usage: undefined,
      };
    }
    const call = (async () =>
      // `withResponse()` keeps the parsed body: the SDK's typed result omits any
      // response-level pack version, and the projection's mismatch guard needs
      // whatever the provider actually said.
      (await resolved.systemOne(
        { state: buildState(ask), questions: buildQuestions(ask.request) },
        { signal, timeout: timeoutMs, retry: { maxRetries: 0 } },
      ).withResponse()).data as unknown)();
    let result: unknown;
    try {
      result = await raceDeadline(call, signal, timeoutMs);
    } catch (error) {
      const transport = classifyAwarenessFailure(error, signal, redact);
      return {
        assessment: unavailableAssessment(ask.request, "transport_error", transport.message),
        failure: transport,
        usage: undefined,
      };
    }
    // No freshness opinion is passed in: display freshness is the scheduler's
    // retention policy and the renderer's derivation, never the projection's.
    return {
      assessment: projectAwarenessAnswers(ask.request, buildRawResponse(ask.request, result, model)),
      failure: undefined,
      usage: usageOf(result),
    };
  };

  return {
    id: model,
    available: true,
    reason: undefined,
    unavailable,
    ask: (ask, signal) =>
      Effect.promise(async (): Promise<AwarenessAskOutcome> => {
        try {
          return await runAsk(ask, signal);
        } catch (error) {
          // Last-resort guard: a defect in the transport is still an outcome.
          const transport = classifyAwarenessFailure(error, signal, redact);
          return {
            assessment: unavailableAssessment(ask.request, "transport_error", transport.message),
            failure: transport,
            usage: undefined,
          };
        }
      }),
  };
};

const notConfiguredOutcome = (ask: AwarenessAsk, detail: string): AwarenessAskOutcome => ({
  assessment: unavailableAssessment(ask.request, "not_configured", detail),
  failure: failure("unavailable", detail, undefined),
  usage: undefined,
});

export const makeAwarenessModelLive = (options: JevClientOptions): Layer.Layer<AwarenessModel> =>
  Layer.succeed(AwarenessModel, makeAwarenessModel(options));

/**
 * Fold one model Effect into the promise-shaped outcome the scheduler owns.
 * Total by construction: typed failures and defects both become outcomes, so a
 * provider fault can never throw into the deterministic path.
 */
export const runAwarenessAsk = <R>(
  runtime: Context.Context<R>,
  model: AwarenessModelShape,
  ask: AwarenessAsk,
  signal: AbortSignal,
): Promise<AwarenessAskOutcome> =>
  Effect.runPromiseWith(runtime)(
    model.ask(ask, signal).pipe(
      Effect.catchDefect((): Effect.Effect<AwarenessAskOutcome> => {
        const transport = failure("transport", "Jev adapter defect", undefined);
        return Effect.succeed({
          assessment: model.unavailable({
            request: ask.request,
            reason: "transport_error",
            detail: transport.message,
          }),
          failure: transport,
          usage: undefined,
        });
      }),
    ),
  );
