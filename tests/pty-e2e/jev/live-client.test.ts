/**
 * System One client + acceptance policy contract.
 *
 * Every leg injects a fake `fetch`, so this file proves the request and
 * response shapes without a key and without a network call. The shapes are the
 * documented ones (`POST /v1/systemone`, `{ state, model, questions }`,
 * `{ model, answers, usage }`), which is what makes the paid run reproducible.
 */

import { describe, expect, it } from "vitest";
import { applyAcceptance, askSystemOne, SystemOneError } from "./live-client";
import {
  ACTIVITY_OPTIONS,
  CHOICE_CONFIDENCE_MIN,
  CHOICE_TOP_PROBABILITY_MIN,
  NOUL_ACCEPT_MIN,
  PACK_IDS,
  questionPack,
  REPETITION_OPTIONS,
} from "./pack";

const IDS = ["L000", "L001", "L002"];

type Captured = {
  readonly url: string;
  readonly init: RequestInit;
  readonly body: { readonly state: unknown; readonly model: string; readonly questions: Record<string, { type: string; criteria?: unknown }> };
};

const fakeFetch = (
  responses: ReadonlyArray<{ readonly status: number; readonly body: unknown }>,
  captured: Captured[] = [],
): { readonly fetchImpl: typeof fetch; readonly captured: Captured[] } => {
  let index = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Captured["body"];
    captured.push({ url: String(input), init: init ?? {}, body });
    const next = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, captured };
};

describe("JLC — question pack shape", () => {
  it("JLC-pack: the pack carries exactly the nine frozen question ids", () => {
    const pack = questionPack(IDS);
    expect(Object.keys(pack).sort()).toEqual([...PACK_IDS].sort());
    expect(pack.turn_in_progress?.type).toBe("noul");
    expect(pack.approval_requested?.type).toBe("noul");
    expect(pack.answer_requested?.type).toBe("noul");
    expect(pack.access_problem?.type).toBe("noul");
    expect(pack.execution_error?.type).toBe("noul");
    expect(pack.highlight_exists?.type).toBe("noul");
    expect(pack.activity?.type).toBe("choice");
    expect(pack.repetition?.type).toBe("choice");
    expect(pack.highlight_line?.type).toBe("choice");
  });

  it("JLC-pack: activity offers the seven frozen options and repetition its three", () => {
    const pack = questionPack(IDS);
    expect(Object.keys(pack.activity?.criteria ?? {}).sort()).toEqual(Object.keys(ACTIVITY_OPTIONS).sort());
    expect(Object.keys(pack.repetition?.criteria ?? {}).sort()).toEqual(Object.keys(REPETITION_OPTIONS).sort());
    expect(Object.keys(pack.repetition?.criteria ?? {})).toContain("insufficient_evidence");
  });

  it("JLC-pack: highlight_line offers the window ids plus NONE, and nothing else", () => {
    const pack = questionPack(IDS);
    const highlight = pack.highlight_line;
    expect(highlight?.type).toBe("choice");
    if (highlight?.type !== "choice") throw new Error("highlight_line must be a choice question");
    expect(Object.keys(highlight.criteria)).toEqual([...IDS, "NONE"]);
    for (const id of IDS) expect(highlight.criteria[id]).toBeNull();
    expect(highlight.criteria.NONE).toBe("No line is worth surfacing");
  });
});

describe("JLC — request and response", () => {
  it("JLC-request: the call posts to /v1/systemone with a bearer key and the pack", async () => {
    const { fetchImpl, captured } = fakeFetch([
      { status: 200, body: { model: "jev-1.13.0", answers: { turn_in_progress: { type: "noul", noul: 0.97 } }, usage: { input_tokens: 120, output_tokens: 9 } } },
    ]);
    const result = await askSystemOne(
      { state: { harness: "claude", screen: "L000| hi" }, questions: questionPack(IDS) },
      { apiKey: "test-key", baseUrl: "https://example.test/", fetchImpl, sleepImpl: async () => {} },
    );
    expect(captured.length).toBe(1);
    expect(captured[0]?.url).toBe("https://example.test/v1/systemone");
    expect(captured[0]?.init.method).toBe("POST");
    const headers = captured[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer test-key");
    expect(headers["content-type"]).toBe("application/json");
    expect(captured[0]?.body.model).toBe("jev-latest");
    expect(Object.keys(captured[0]?.body.questions ?? {}).length).toBe(PACK_IDS.length);
    expect(result.model).toBe("jev-1.13.0");
    expect(result.usage?.input_tokens).toBe(120);
  });

  it("JLC-request: an explicit model overrides the default", async () => {
    const { fetchImpl, captured } = fakeFetch([{ status: 200, body: { model: "jev-x", answers: {} } }]);
    await askSystemOne(
      { state: "s", questions: questionPack(IDS) },
      { apiKey: "k", model: "jev-pinned", fetchImpl, sleepImpl: async () => {} },
    );
    expect(captured[0]?.body.model).toBe("jev-pinned");
  });

  it("JLC-response: a response without an answers map is rejected", async () => {
    const { fetchImpl } = fakeFetch([{ status: 200, body: { model: "jev" } }]);
    await expect(
      askSystemOne({ state: "s", questions: questionPack(IDS) }, { apiKey: "k", fetchImpl, sleepImpl: async () => {} }),
    ).rejects.toThrow(/no answers map/u);
  });

  it("JLC-retry: 529 and 429 are retried with backoff, a 4xx is not", async () => {
    const retrying = fakeFetch([
      { status: 529, body: { error: "overloaded" } },
      { status: 429, body: { error: "slow down" } },
      { status: 200, body: { model: "jev", answers: {} } },
    ]);
    const result = await askSystemOne(
      { state: "s", questions: questionPack(IDS) },
      { apiKey: "k", fetchImpl: retrying.fetchImpl, sleepImpl: async () => {}, maxRetries: 3 },
    );
    expect(result.model).toBe("jev");
    expect(retrying.captured.length).toBe(3);

    const unauthorized = fakeFetch([{ status: 401, body: { error: "bad key" } }]);
    await expect(
      askSystemOne(
        { state: "s", questions: questionPack(IDS) },
        { apiKey: "k", fetchImpl: unauthorized.fetchImpl, sleepImpl: async () => {} },
      ),
    ).rejects.toBeInstanceOf(SystemOneError);
    expect(unauthorized.captured.length).toBe(1);
  });
});

describe("JLC — acceptance policy", () => {
  it("JLC-accept-noul: the 0.9 threshold accepts a yes and a no, and abstains between", () => {
    expect(applyAcceptance("x", { type: "noul", noul: NOUL_ACCEPT_MIN }).verdict).toBe("accepted");
    expect(applyAcceptance("x", { type: "noul", noul: 0.99 }).value).toBe("yes");
    expect(applyAcceptance("x", { type: "noul", noul: 1 - NOUL_ACCEPT_MIN }).value).toBe("no");
    expect(applyAcceptance("x", { type: "noul", noul: 0.5 }).verdict).toBe("abstained");
    expect(applyAcceptance("x", { type: "noul", noul: 0.5 }).value).toBeUndefined();
  });

  it("JLC-accept-choice: confidence and top probability must both clear the bar", () => {
    const answer = (choice: string, confidence: number, probabilities: Record<string, number>) =>
      ({ type: "choice", choice, confidence, probabilities }) as const;
    const ok = applyAcceptance(
      "activity",
      answer("editing", CHOICE_CONFIDENCE_MIN, { editing: CHOICE_TOP_PROBABILITY_MIN, idle: 0.2 }),
    );
    expect(ok.verdict).toBe("accepted");
    expect(ok.value).toBe("editing");
    // Confidence clears, the distribution does not.
    expect(applyAcceptance("activity", answer("editing", 0.9, { editing: 0.7, idle: 0.3 })).verdict).toBe("abstained");
    // Distribution clears, confidence does not.
    expect(applyAcceptance("activity", answer("editing", 0.5, { editing: 0.95, idle: 0.05 })).verdict).toBe("abstained");
    // Top probability is computed from the returned distribution, never trusted
    // from the option the service named.
    const wrong = applyAcceptance("activity", answer("editing", 0.9, { editing: 0.1, idle: 0.9 }));
    expect(wrong.verdict).toBe("abstained");
    expect(wrong.topProbability).toBe(0.9);
  });

  it("JLC-accept-choice: highlight_line may only answer inside the offered window", () => {
    const answer = (choice: string) =>
      ({ type: "choice", choice, confidence: 0.95, probabilities: { [choice]: 0.95 } }) as const;
    const allowed = { allowedChoices: [...IDS, "NONE"] };
    expect(applyAcceptance("highlight_line", answer("L001"), allowed).value).toBe("L001");
    expect(applyAcceptance("highlight_line", answer("NONE"), allowed).value).toBe("NONE");
    const outside = applyAcceptance("highlight_line", answer("L900"), allowed);
    expect(outside.verdict).toBe("abstained");
    expect(outside.reason).toMatch(/outside the offered option set/u);
  });
});
