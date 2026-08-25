
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  cleanSyntheticApiKey,
  fetchSyntheticUsageApi,
  makeSyntheticSource,
  parseSyntheticQuota,
  resolveSyntheticApiKey,
} from "../src/main/vellum/usage/synthetic-source";

const FETCHED = "2026-04-17T04:20:00.000Z";
const FAKE_KEY = "sk-synthetic-fixture-abc123";

/** Known-slot payload modeled on the real weekly-credit + search shape. */
const KNOWN_SLOTS_PAYLOAD = {
  plan: "Pro",
  rollingFiveHourLimit: {
    percentUsed: 42,
    reset_at: "2026-04-17T09:00:00Z",
    window_minutes: 300,
  },
  weeklyTokenLimit: {
    nextRegenAt: "2026-04-17T05:19:30.000Z",
    percentRemaining: 98,
    maxCredits: "$36.00",
    remainingCredits: "$35.30",
    nextRegenCredits: "$0.72",
  },
  search: {
    hourly: {
      limit: 250,
      requests: 2,
      renewsAt: "2026-04-17T04:30:01.494Z",
    },
  },
};

const GENERIC_PAYLOAD = {
  plan: "Starter",
  quotas: [
    { name: "Monthly", limit: 1000, used: 250, reset_at: "2025-01-01T00:00:00Z" },
    { name: "Daily", max: 200, remaining: 50, window_minutes: 1440 },
  ],
};

const stubFetch = (
  impl: () => Promise<Response>,
): typeof fetch =>
  ((_input: RequestInfo | URL, _init?: RequestInit) => impl()) as unknown as typeof fetch;

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("credential resolution", () => {
  it("reads the env var and strips quotes and whitespace", () => {
    expect(cleanSyntheticApiKey("  abc123  ")).toBe("abc123");
    expect(cleanSyntheticApiKey('"token-xyz"')).toBe("token-xyz");
    expect(cleanSyntheticApiKey("'quoted'")).toBe("quoted");
    expect(cleanSyntheticApiKey(undefined)).toBeUndefined();
    expect(cleanSyntheticApiKey('""')).toBeUndefined();
  });

  it("prefers the env var when set and returns undefined when it is empty", () => {
    expect(resolveSyntheticApiKey({ SYNTHETIC_API_KEY: '"quoted"' })).toBe("quoted");
    expect(resolveSyntheticApiKey({ SYNTHETIC_API_KEY: "" })).toBeUndefined();
  });
});

describe("parseSyntheticQuota (known slots)", () => {
  it("maps five-hour, weekly credits, and search hourly lanes in order", () => {
    const quota = parseSyntheticQuota(KNOWN_SLOTS_PAYLOAD, FETCHED);
    expect(quota?.provider).toBe("synthetic");
    expect(quota?.source).toBe("api");
    expect(quota?.plan).toBe("Pro");
    expect(quota?.windows.map((w) => [w.label, w.title, Math.round(w.usedPercent)])).toEqual([
      ["primary", "Rolling five-hour limit", 42],
      ["secondary", "Weekly token limit", 2],
      ["tertiary", "Search hourly", 1],
    ]);
  });

  it("derives window minutes and resets for each lane", () => {
    const quota = parseSyntheticQuota(KNOWN_SLOTS_PAYLOAD, FETCHED);
    const primary = quota?.windows[0];
    expect(primary?.windowMinutes).toBe(300);
    expect(primary?.resetsAt).toBe("2026-04-17T09:00:00.000Z");
    const secondary = quota?.windows[1];
    expect(secondary?.resetDescription).toContain("resets");
    expect(secondary?.resetsAt).toBe("2026-04-17T05:19:30.000Z");
  });

  it("maps weekly credit pool to creditsRemaining plus extras detail", () => {
    const quota = parseSyntheticQuota(KNOWN_SLOTS_PAYLOAD, FETCHED);
    expect(quota?.creditsRemaining).toBeCloseTo(35.3, 6);
    const credits = quota?.extras?.weeklyCredits as Record<string, unknown> | undefined;
    expect(credits?.["creditLimit"]).toBe(36);
    expect(credits?.["creditsUsed"]).toBeCloseTo(0.7, 6);
    expect(credits?.["nextRegenAmount"]).toBeCloseTo(0.72, 6);
  });
});

describe("parseSyntheticQuota (generic fallback)", () => {
  it("collects generic quota objects into ordered lanes with the plan", () => {
    const quota = parseSyntheticQuota(GENERIC_PAYLOAD, FETCHED);
    expect(quota?.plan).toBe("Starter");
    expect(quota?.windows.map((w) => [w.label, w.usedPercent])).toEqual([
      ["primary", 25],
      ["secondary", 75],
    ]);
    expect(quota?.windows[0]?.resetsAt).toBe("2025-01-01T00:00:00.000Z");
    expect(quota?.windows[1]?.windowMinutes).toBe(1440);
  });

  it("overflows past three lanes into extra windows", () => {
    const quota = parseSyntheticQuota(
      {
        quotas: [
          { name: "a", percent_used: 10 },
          { name: "b", percent_used: 20 },
          { name: "c", percent_used: 30 },
          { name: "d", percent_used: 40 },
        ],
      },
      FETCHED,
    );
    expect(quota?.windows.map((w) => w.label)).toEqual(["primary", "secondary", "tertiary", "extra"]);
    expect(quota?.windows[3]?.title).toBe("d");
  });

  it("never fabricates percentages for absent or malformed payloads", () => {
    expect(parseSyntheticQuota({}, FETCHED)).toBeUndefined();
    expect(parseSyntheticQuota({ quotas: [{ name: "no numbers here" }] }, FETCHED)).toBeUndefined();
    expect(parseSyntheticQuota(null, FETCHED)).toBeUndefined();
    expect(parseSyntheticQuota("nope", FETCHED)).toBeUndefined();
    expect(parseSyntheticQuota([], FETCHED)).toBeUndefined();
  });
});

describe("fetchSyntheticUsageApi (typed outcomes)", () => {
  it("returns the parsed payload on HTTP 200", async () => {
    const outcome = await fetchSyntheticUsageApi(FAKE_KEY, stubFetch(async () => jsonResponse(GENERIC_PAYLOAD)));
    expect(outcome.kind).toBe("ok");
  });

  it("folds 401 into unauthorized and 503 into failed without leaking the body", async () => {
    const unauthorized = await fetchSyntheticUsageApi(
      FAKE_KEY,
      stubFetch(async () => jsonResponse({ message: "bad key" }, 401)),
    );
    expect(unauthorized.kind).toBe("unauthorized");

    const failed = await fetchSyntheticUsageApi(
      FAKE_KEY,
      stubFetch(async () => jsonResponse({ oops: true }, 503)),
    );
    expect(failed.kind).toBe("failed");
    if (failed.kind === "failed") expect(failed.error).toContain("503");
  });

  it("folds network failures and non-JSON bodies into failed", async () => {
    const network = await fetchSyntheticUsageApi(
      FAKE_KEY,
      stubFetch(async () => {
        throw new Error("socket hang up");
      }),
    );
    expect(network.kind).toBe("failed");

    const nonJson = await fetchSyntheticUsageApi(
      FAKE_KEY,
      stubFetch(async () => new Response("<html>gateway</html>", { status: 200 })),
    );
    expect(nonJson.kind).toBe("failed");
  });
});

describe("syntheticSource total envelopes", () => {
  it("happy path: live snapshot with quotas and dataConfidence", async () => {
    const source = makeSyntheticSource({
      resolveApiKey: () => FAKE_KEY,
      fetchImpl: stubFetch(async () => jsonResponse(KNOWN_SLOTS_PAYLOAD)),
    });
    const snapshot = await Effect.runPromise(source.fetch);
    expect(snapshot.ok).toBe(true);
    expect(snapshot.source).toBe("synthetic");
    expect(snapshot.dataConfidence).toBe("live");
    expect(snapshot.quotas).toHaveLength(1);
    expect(snapshot.quotas[0]?.windows.map((w) => w.label)).toEqual([
      "primary",
      "secondary",
      "tertiary",
    ]);
  });

  it("auth failure folds into a cli-error envelope that redacts the key", async () => {
    const source = makeSyntheticSource({
      resolveApiKey: () => FAKE_KEY,
      fetchImpl: ((_input: RequestInfo | URL, init?: RequestInit) => {
        // Sanity: the key rides only in the Authorization header.
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${FAKE_KEY}`);
        return Promise.resolve(jsonResponse({ error: `invalid token ${FAKE_KEY}` }, 401));
      }) as unknown as typeof fetch,
    });
    const snapshot = await Effect.runPromise(source.fetch);
    expect(snapshot.ok).toBe(false);
    expect(snapshot.reason).toBe("cli-error");
    expect(snapshot.error).not.toContain(FAKE_KEY);
    expect(snapshot.quotas).toHaveLength(0);
  });

  it("missing credential folds into a source-missing envelope without any fetch", async () => {
    let fetched = false;
    const source = makeSyntheticSource({
      resolveApiKey: () => undefined,
      fetchImpl: stubFetch(async () => {
        fetched = true;
        return jsonResponse({});
      }),
    });
    const snapshot = await Effect.runPromise(source.fetch);
    expect(snapshot.ok).toBe(false);
    expect(snapshot.reason).toBe("source-missing");
    expect(fetched).toBe(false);

    const detected = await Effect.runPromise(source.detect);
    expect(detected).toBe(false);
  });

  it("undecodable payloads fold into a parse-error envelope", async () => {
    const source = makeSyntheticSource({
      resolveApiKey: () => FAKE_KEY,
      fetchImpl: stubFetch(async () => jsonResponse({ unexpected: true })),
    });
    const snapshot = await Effect.runPromise(source.fetch);
    expect(snapshot.ok).toBe(false);
    expect(snapshot.reason).toBe("parse-error");
    expect(snapshot.error).not.toContain(FAKE_KEY);
  });

  it("detect is true exactly when the credential resolves", async () => {
    const present = makeSyntheticSource({ resolveApiKey: () => FAKE_KEY });
    expect(await Effect.runPromise(present.detect)).toBe(true);
  });
});
