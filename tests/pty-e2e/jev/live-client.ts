/**
 * Minimal System One HTTP client and the acceptance policy.
 *
 * Dependency-free on purpose: the parent's proof-of-concept pulled in
 * `@typesafe-ai/sdk`, which is not a dependency of this checkout and must not
 * become one. The documented endpoint is
 * `POST https://api.typesafe.ai/v1/systemone` with `Authorization: Bearer …`,
 * so a plain `fetch` is the whole client.
 *
 * Nothing in this file runs without a key. Every unit test here injects a
 * `fetchImpl`, so the suite proves the request and response contract without a
 * network call.
 */

import {
  CHOICE_CONFIDENCE_MIN,
  CHOICE_TOP_PROBABILITY_MIN,
  NOUL_ACCEPT_MIN,
  type QuestionMap,
} from "./pack";

export type NoulAnswer = { readonly type: "noul"; readonly noul: number };
export type ChoiceAnswer = {
  readonly type: "choice";
  readonly choice: string;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
};
export type ScoreAnswer = {
  readonly type: "score";
  readonly score: number;
  readonly legend: Readonly<Record<string, string>>;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
};
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export type SystemOneResult = {
  readonly model: string;
  readonly answers: Readonly<Record<string, Answer>>;
  readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number };
};

export class SystemOneError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`systemone request failed: HTTP ${status} ${body.slice(0, 300)}`);
    this.name = "SystemOneError";
    this.status = status;
    this.body = body;
  }
}

export type AskOptions = {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly fetchImpl?: typeof fetch;
  readonly sleepImpl?: (ms: number) => Promise<void>;
};

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const RETRYABLE = new Set([429, 529]);

/** One call to `POST /v1/systemone`, with the documented retry policy. */
export const askSystemOne = async (
  request: { readonly state: unknown; readonly questions: QuestionMap },
  opts: AskOptions,
): Promise<SystemOneResult> => {
  const baseUrl = (opts.baseUrl ?? "https://api.typesafe.ai").replace(/\/+$/u, "");
  const model = opts.model ?? "jev-latest";
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const maxRetries = opts.maxRetries ?? 2;
  const doFetch = opts.fetchImpl ?? fetch;
  const doSleep = opts.sleepImpl ?? sleep;
  const body = JSON.stringify({ state: request.state, model, questions: request.questions });

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(`${baseUrl}/v1/systemone`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${opts.apiKey}`,
          "content-type": "application/json",
        },
        body,
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        if (RETRYABLE.has(response.status) && attempt < maxRetries) {
          lastError = new SystemOneError(response.status, text);
          await doSleep(250 * 2 ** attempt);
          continue;
        }
        throw new SystemOneError(response.status, text);
      }
      const parsed = JSON.parse(text) as SystemOneResult;
      if (typeof parsed !== "object" || parsed === null || typeof parsed.answers !== "object") {
        throw new Error(`systemone response carried no answers map: ${text.slice(0, 300)}`);
      }
      return parsed;
    } catch (error) {
      lastError = error;
      if (error instanceof SystemOneError && !RETRYABLE.has(error.status)) throw error;
      if (attempt >= maxRetries) throw error;
      await doSleep(250 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

export type Verdict = {
  readonly id: string;
  readonly verdict: "accepted" | "abstained";
  /** The accepted answer, when accepted. */
  readonly value?: string;
  readonly confidence?: number;
  readonly topProbability?: number;
  readonly noul?: number;
  readonly reason: string;
};

/**
 * The starting acceptance policy, applied to one answer.
 *
 * `choice` is accepted only at `confidence >= 0.8` AND top probability
 * `>= 0.8`. Noul has no separate confidence, so the policy's `>= 0.9` is the
 * yes side; this harness also treats `<= 0.1` as an accepted `no`, because a
 * comparison report that can only ever record `yes` measures half the
 * question. That symmetry is this harness's addition, not the parent's
 * constant, and the report labels it as such.
 */
export const applyAcceptance = (
  id: string,
  answer: Answer,
  opts: { readonly allowedChoices?: readonly string[] } = {},
): Verdict => {
  if (answer.type === "noul") {
    if (answer.noul >= NOUL_ACCEPT_MIN) {
      return { id, verdict: "accepted", value: "yes", noul: answer.noul, reason: `noul ${answer.noul} >= ${NOUL_ACCEPT_MIN}` };
    }
    if (answer.noul <= 1 - NOUL_ACCEPT_MIN) {
      return { id, verdict: "accepted", value: "no", noul: answer.noul, reason: `noul ${answer.noul} <= ${1 - NOUL_ACCEPT_MIN}` };
    }
    return { id, verdict: "abstained", noul: answer.noul, reason: `noul ${answer.noul} inside the abstention band` };
  }
  if (answer.type === "choice") {
    const entries = Object.entries(answer.probabilities);
    const top = entries.length > 0 ? Math.max(...entries.map(([, value]) => value)) : 0;
    const argmax = entries.sort((a, b) => b[1] - a[1])[0]?.[0];
    if (opts.allowedChoices && !opts.allowedChoices.includes(answer.choice)) {
      return {
        id,
        verdict: "abstained",
        confidence: answer.confidence,
        topProbability: top,
        reason: `choice ${answer.choice} is outside the offered option set`,
      };
    }
    if (argmax !== answer.choice) {
      // The service names `choice` as the highest-probability option. When the
      // distribution disagrees the response is internally inconsistent, and an
      // inconsistent answer is not an answer.
      return {
        id,
        verdict: "abstained",
        confidence: answer.confidence,
        topProbability: top,
        reason: `named choice ${answer.choice} is not the highest-probability option (${String(argmax)})`,
      };
    }
    if (answer.confidence < CHOICE_CONFIDENCE_MIN) {
      return {
        id,
        verdict: "abstained",
        confidence: answer.confidence,
        topProbability: top,
        reason: `confidence ${answer.confidence} < ${CHOICE_CONFIDENCE_MIN}`,
      };
    }
    if (top < CHOICE_TOP_PROBABILITY_MIN) {
      return {
        id,
        verdict: "abstained",
        confidence: answer.confidence,
        topProbability: top,
        reason: `top probability ${top} < ${CHOICE_TOP_PROBABILITY_MIN}`,
      };
    }
    return {
      id,
      verdict: "accepted",
      value: answer.choice,
      confidence: answer.confidence,
      topProbability: top,
      reason: `confidence ${answer.confidence} and top probability ${top} both clear the bar`,
    };
  }
  return { id, verdict: "abstained", reason: `score answers are outside the frozen pack` };
};
