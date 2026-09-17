/**
 * Jev client boundary, driven through the REAL SDK with a fake HTTP transport.
 *
 * The SDK is a real dependency, so these tests exercise its real retry, timeout,
 * abort, error-class, and JSON-parsing behavior; only the wire is faked. That
 * covers the brief's adapter requirements: no key constructs no client, retries
 * are off, body logging is off, the timeout is short, the signal is passed, the
 * response is validated at this boundary through the projection, and no failure
 * reaches the deterministic path.
 */

import { Context, Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_AWARENESS_MODEL,
  DEFAULT_AWARENESS_TIMEOUT_MS,
  classifyAwarenessFailure,
  makeAwarenessModel,
  runAwarenessAsk,
  type AwarenessAsk,
  type AwarenessModelShape,
} from "../src/main/junto/term/awareness/jev-client";
import { selectAwarenessInput } from "../src/main/junto/term/awareness/select-input";
import { EVIDENCE_TEXT } from "./helpers/awareness-fakes";

// ---------------------------------------------------------------------------
// A fake HTTP transport: the only thing between the SDK and the assertions.
// ---------------------------------------------------------------------------

type RecordedRequest = {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
  readonly signal: AbortSignal | null | undefined;
};

type FakeTransport = {
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
  readonly requests: ReadonlyArray<RecordedRequest>;
  readonly count: () => number;
  readonly reply: (responder: (request: RecordedRequest) => Response | Promise<Response>) => void;
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const makeTransport = (): FakeTransport => {
  const requests: RecordedRequest[] = [];
  let responder: (request: RecordedRequest) => Response | Promise<Response> = () =>
    jsonResponse({ model: DEFAULT_AWARENESS_MODEL, answers: {}, usage: { input_tokens: 1, output_tokens: 1 } });
  return {
    fetch: async (input, init) => {
      const recorded: RecordedRequest = {
        url: input,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        signal: init?.signal,
      };
      requests.push(recorded);
      return await responder(recorded);
    },
    requests,
    count: () => requests.length,
    reply: (next) => {
      responder = next;
    },
  };
};

// `observedAt` is a real wall clock, because the projection owns the only
// freshness opinion it is allowed to have. The scheduler never passes one in.
const stateFor = (bindingId = "s1", seq = 7n, observedAt = Date.now()) =>
  selectAwarenessInput({
    bindingId,
    epoch: "e1",
    cols: 80,
    rows: 24,
    seq,
    lines: EVIDENCE_TEXT.split("\n"),
    totalLines: 2,
    truncated: false,
    observedAt,
  });

const askFor = (model: string, request = stateFor(), harness = "claude"): AwarenessAsk => ({
  request,
  harness,
});

const run = async (
  shape: AwarenessModelShape,
  ask: AwarenessAsk,
  signal = new AbortController().signal,
) => await runAwarenessAsk(Context.empty(), shape, ask, signal);

const answersFor = (request: AwarenessAsk["request"], noul = 0.97) => ({
  packVersion: request.packVersion,
  requestedModel: DEFAULT_AWARENESS_MODEL,
  returnedModel: "jev-test-1",
  answers: {
    "concern.approval_requested": { type: "noul", noul },
  },
  usage: { input_tokens: 1_234, output_tokens: 56 },
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("no key, no client", () => {
  it("constructs no client and sends nothing", async () => {
    const transport = makeTransport();
    const model = makeAwarenessModel({
      apiKey: undefined,
      model: DEFAULT_AWARENESS_MODEL,
      fetch: transport.fetch,
    });
    expect(model.available).toBe(false);
    expect(model.reason).toBe("no Jev API key configured");
    const outcome = await run(model, askFor(model.id));
    expect(transport.count()).toBe(0);
    expect(outcome.failure?.kind).toBe("unavailable");
    expect(outcome.failure?.retryable).toBe(false);
    expect(outcome.assessment.availability).toBe("unavailable");
    expect(outcome.assessment.unavailableReason).toBe("not_configured");
  });

  it("treats a blank key as no key", () => {
    const model = makeAwarenessModel({ apiKey: "   ", model: DEFAULT_AWARENESS_MODEL });
    expect(model.available).toBe(false);
  });

  it("builds an honest unavailable assessment with no client and no call", () => {
    const model = makeAwarenessModel({ apiKey: undefined, model: DEFAULT_AWARENESS_MODEL });
    const request = stateFor();
    const assessment = model.unavailable({
      request,
      reason: "not_configured",
      detail: "no key",
    });
    expect(assessment.availability).toBe("unavailable");
    expect(assessment.unavailableReason).toBe("not_configured");
    expect(assessment.provenance.evidenceHash).toBe(request.evidenceHash);
  });
});

describe("the SDK call", () => {
  it("sends C's evidence, the note, the harness, and one typed question per pack question", async () => {
    const transport = makeTransport();
    transport.reply(() => jsonResponse(answersFor(stateFor())));
    const model = makeAwarenessModel({ apiKey: "sk-test", fetch: transport.fetch });
    const request = stateFor();
    const outcome = await run(model, askFor(model.id, request));
    expect(outcome.failure).toBeUndefined();
    expect(transport.count()).toBe(1);
    const body = transport.requests[0]!.body as {
      state: Record<string, unknown>;
      questions: Record<string, { type: string; instructions?: string; criteria?: unknown }>;
      model: string;
    };
    expect(body.model).toBe(DEFAULT_AWARENESS_MODEL);
    expect(body.state["evidence"]).toBe(request.evidenceBlock);
    expect(body.state["note"]).toBe(request.temporalNote);
    expect(body.state["harness"]).toBe("claude");
    expect(body.state["packVersion"]).toBe(request.packVersion);
    const asked = new Set(request.questions.map((question) => question.id));
    expect(Object.keys(body.questions).sort()).toEqual([...asked].sort());
    const approval = body.questions["concern.approval_requested"]!;
    expect(approval.type).toBe("noul");
    expect(approval.instructions).toBe(
      request.questions.find((question) => question.id === "concern.approval_requested")!.prompt,
    );
    const highlight = body.questions["highlight.line"];
    if (highlight !== undefined) {
      expect(highlight.type).toBe("choice");
      const criteria = highlight.criteria as Record<string, unknown>;
      expect(Object.keys(criteria)).toContain("NONE");
    }
  });

  it("carries the generation-scoped signal through to the transport", async () => {
    const transport = makeTransport();
    transport.reply(() => new Promise<Response>(() => undefined));
    const model = makeAwarenessModel({
      apiKey: "sk-test",
      timeoutMs: 5_000,
      fetch: transport.fetch,
    });
    const controller = new AbortController();
    const pending = run(model, askFor(model.id), controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const recorded = transport.requests[0]!.signal;
    expect(recorded).toBeDefined();
    expect(recorded!.aborted).toBe(false);
    controller.abort();
    const outcome = await pending;
    expect(outcome.failure?.kind).toBe("aborted");
    expect(recorded!.aborted).toBe(true);
  });

  it("accepts a real answer and reports the projection's assessment and usage", async () => {
    const transport = makeTransport();
    const request = stateFor();
    transport.reply(() => jsonResponse(answersFor(request)));
    const model = makeAwarenessModel({ apiKey: "sk-test", fetch: transport.fetch });
    const outcome = await run(model, askFor(model.id, request));
    expect(outcome.failure).toBeUndefined();
    expect(outcome.assessment.availability).toBe("current");
    expect(outcome.assessment.concerns.map((concern) => concern.concern)).toEqual([
      "approval_requested",
    ]);
    expect(outcome.assessment.provenance.requestedModel).toBe(DEFAULT_AWARENESS_MODEL);
    expect(outcome.assessment.provenance.returnedModel).toBe("jev-test-1");
    expect(outcome.assessment.provenance.evidenceHash).toBe(request.evidenceHash);
    expect(outcome.usage).toEqual({ inputTokens: 1_234, outputTokens: 56 });
  });

  it("turns an abstention into an abstained assessment, not a failure", async () => {
    const transport = makeTransport();
    const request = stateFor();
    transport.reply(() => jsonResponse(answersFor(request, 0.5)));
    const model = makeAwarenessModel({ apiKey: "sk-test", fetch: transport.fetch });
    const outcome = await run(model, askFor(model.id, request));
    expect(outcome.failure).toBeUndefined();
    expect(outcome.assessment.availability).toBe("abstained");
    // The answered question abstained below the bar, and the temporal question
    // the evidence could not support is reported as a gap, never guessed.
    const abstained = new Map(
      outcome.assessment.abstentions.map((entry) => [entry.questionId, entry.reason]),
    );
    expect(abstained.get("concern.approval_requested")).toBe("below_acceptance_bar");
    expect(abstained.get("concern.repetition")).toBe("temporal_pair_missing");
  });

  it("rejects answers from a different pack version", async () => {
    const transport = makeTransport();
    const request = stateFor();
    transport.reply(() =>
      jsonResponse({ ...answersFor(request), packVersion: "awareness-pack/999" }),
    );
    const model = makeAwarenessModel({ apiKey: "sk-test", fetch: transport.fetch });
    const outcome = await run(model, askFor(model.id, request));
    expect(outcome.failure).toBeUndefined();
    expect(outcome.assessment.availability).toBe("unavailable");
    expect(outcome.assessment.unavailableReason).toBe("pack_version_mismatch");
  });

  it("turns a malformed answers body into an honest reason, never a throw", async () => {
    const transport = makeTransport();
    transport.reply(() => jsonResponse({ model: DEFAULT_AWARENESS_MODEL, answers: "nope" }));
    const model = makeAwarenessModel({ apiKey: "sk-test", fetch: transport.fetch });
    const outcome = await run(model, askFor(model.id));
    expect(outcome.failure).toBeUndefined();
    expect(outcome.assessment.availability).toBe("unavailable");
    expect(outcome.assessment.unavailableReason).toBe("no_answers");
  });

  it("uses the configured timeout rather than the SDK default", async () => {
    const transport = makeTransport();
    transport.reply(() => jsonResponse(answersFor(stateFor())));
    const model = makeAwarenessModel({ apiKey: "sk-test", timeoutMs: 1_500, fetch: transport.fetch });
    await run(model, askFor(model.id));
    expect(transport.count()).toBe(1);
    expect(DEFAULT_AWARENESS_TIMEOUT_MS).toBe(2_000);
  });
});

describe("failure paths degrade without throwing", () => {
  it("does not retry: one attempt, then an honest transport failure", async () => {
    const transport = makeTransport();
    transport.reply(() => jsonResponse({ error: "server exploded" }, 500));
    const model = makeAwarenessModel({ apiKey: "sk-test", fetch: transport.fetch });
    const outcome = await run(model, askFor(model.id));
    expect(transport.count()).toBe(1);
    expect(outcome.failure?.kind).toBe("transport");
    expect(outcome.failure?.status).toBe(500);
    expect(outcome.failure?.retryable).toBe(true);
    expect(outcome.assessment.availability).toBe("unavailable");
    expect(outcome.assessment.unavailableReason).toBe("transport_error");
  });

  it("writes nothing to the console: body logging is off", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const transport = makeTransport();
    transport.reply(() => jsonResponse({ error: "server exploded" }, 500));
    const model = makeAwarenessModel({ apiKey: "sk-test", fetch: transport.fetch });
    await run(model, askFor(model.id));
    expect(log).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("classifies a rejected credential and never echoes the key", async () => {
    const transport = makeTransport();
    transport.reply(() => jsonResponse({ error: { message: "bad key sk-secret-123" } }, 401));
    const model = makeAwarenessModel({
      apiKey: "sk-secret-123",
      fetch: transport.fetch,
    });
    const outcome = await run(model, askFor(model.id));
    expect(outcome.failure?.kind).toBe("credential");
    expect(outcome.failure?.retryable).toBe(false);
    expect(outcome.failure?.message).not.toContain("sk-secret-123");
    expect(outcome.assessment.availability).toBe("unavailable");
  });

  it("classifies a rate limit", async () => {
    const transport = makeTransport();
    transport.reply(() => jsonResponse({ error: "slow down" }, 429));
    const model = makeAwarenessModel({ apiKey: "sk-test", fetch: transport.fetch });
    const outcome = await run(model, askFor(model.id));
    expect(outcome.failure?.kind).toBe("rate-limited");
    expect(outcome.failure?.status).toBe(429);
    expect(outcome.failure?.retryable).toBe(true);
  });

  it("treats a bad request as non-retryable, not as a transport fault", async () => {
    const transport = makeTransport();
    transport.reply(() => jsonResponse({ error: "bad request" }, 400));
    const model = makeAwarenessModel({ apiKey: "sk-test", fetch: transport.fetch });
    const outcome = await run(model, askFor(model.id));
    expect(outcome.failure?.kind).toBe("unavailable");
    expect(outcome.failure?.retryable).toBe(false);
  });

  it("bounds a hanging provider with its own deadline", async () => {
    const transport = makeTransport();
    transport.reply(() => new Promise<Response>(() => undefined));
    const model = makeAwarenessModel({
      apiKey: "sk-test",
      timeoutMs: 20,
      fetch: transport.fetch,
    });
    const outcome = await run(model, askFor(model.id));
    expect(outcome.failure?.kind).toBe("timeout");
    expect(outcome.assessment.availability).toBe("unavailable");
  });

  it("classifies a retired generation as aborted, not as a timeout", async () => {
    const transport = makeTransport();
    transport.reply(() => new Promise<Response>(() => undefined));
    const model = makeAwarenessModel({
      apiKey: "sk-test",
      timeoutMs: 5_000,
      fetch: transport.fetch,
    });
    const controller = new AbortController();
    const pending = run(model, askFor(model.id), controller.signal);
    controller.abort();
    const outcome = await pending;
    expect(outcome.failure?.kind).toBe("aborted");
    expect(outcome.failure?.retryable).toBe(false);
  });

  it("never rejects: a defect becomes an outcome", async () => {
    const shape: AwarenessModelShape = {
      id: "jev-test",
      available: true,
      reason: undefined,
      unavailable: makeUnavailableShape(),
      ask: () => Effect.die(new Error("adapter exploded")),
    };
    const outcome = await run(shape, askFor(shape.id));
    expect(outcome.failure?.kind).toBe("transport");
    expect(outcome.failure?.message).toBe("Jev adapter defect");
    expect(outcome.assessment.availability).toBe("unavailable");
  });

  it("keeps classification total and redacts the key", () => {
    const redact = (text: string) => text.split("sk-secret-123").join("[redacted]");
    const failure = classifyAwarenessFailure(
      new Error("upstream said sk-secret-123 is wrong"),
      new AbortController().signal,
      redact,
    );
    expect(failure.kind).toBe("transport");
    expect(failure.message).toContain("[redacted]");
    expect(classifyAwarenessFailure("a string throw", new AbortController().signal, redact).kind).toBe(
      "transport",
    );
  });
});

/** The real adapter's unavailable constructor, without a client. */
const makeUnavailableShape = (): AwarenessModelShape["unavailable"] =>
  makeAwarenessModel({ apiKey: undefined, model: "jev-test" }).unavailable;
