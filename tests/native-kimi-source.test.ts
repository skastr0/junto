import { describe, expect, it } from "vitest";
import {
  buildKimiSnapshot,
  countsOfDetail,
  decodeUsageDetail,
  detailValue,
  extractKimiCodeAccessToken,
  kimiCodeCredentialFresh,
  parseCodeApiUsage,
  parseSubscriptionStats,
  parseWebUsage,
  resolveKimiCredential,
  suppressDuplicateCodeWeekly,
  windowDurationMinutes,
} from "../src/main/vellum-command/usage/kimi-source";

const FETCHED = "2026-08-17T12:00:00.000Z";

// GetUsages web response shape (Kimi models): usages[] scoped to
// FEATURE_CODING with a string-counter detail and optional limits[].
const WEB_USAGE_FIXTURE = {
  usages: [
    {
      scope: "FEATURE_CODING",
      detail: {
        limit: "1000",
        used: "420",
        remaining: 580,
        reset_time: "2026-08-24T12:00:00Z",
      },
      limits: [
        {
          window: { duration: 5, timeUnit: "TIME_UNIT_HOUR" },
          detail: { limit: "200", used: "50", resetTime: "2026-08-17T16:30:00Z" },
        },
      ],
    },
    { scope: "FEATURE_OTHER", detail: { limit: "1" } },
  ],
};

const SUBSCRIPTION_FIXTURE = {
  subscriptionBalance: {
    feature: "FEATURE_OMNI",
    type: "SUBSCRIPTION",
    amountUsedRatio: 0.31,
    expireTime: "2026-09-01T00:00:00Z",
  },
  ratelimitCode7d: { ratio: 0.42, enabled: true, resetTime: "2026-08-24T12:00:00Z" },
};

describe("detail decode", () => {
  it("tolerates string and numeric counters and all reset-time key spellings", () => {
    const detail = decodeUsageDetail({
      limit: 500,
      remaining: "125",
      reset_at: "2026-08-20T00:00:00Z",
    });
    expect(detail).toEqual({
      limit: 500,
      remaining: 125,
      resetTime: "2026-08-20T00:00:00Z",
    });
    expect(detailValue("12.5")).toBe(12.5);
    expect(detailValue("nope")).toBeUndefined();
  });

  it("rejects details without a positive limit", () => {
    expect(decodeUsageDetail({ used: 3 })).toBeUndefined();
    expect(decodeUsageDetail({ limit: "0" })).toBeUndefined();
    expect(decodeUsageDetail("nope")).toBeUndefined();
  });

  it("derives counts - used authoritative, remaining must balance", () => {
    // Used wins even in overage.
    expect(countsOfDetail({ limit: 100, used: 120 })).toEqual({
      usedPercent: 100,
      reliable: true,
      used: 120,
    });
    // Remaining folds into used only inside the valid range.
    expect(countsOfDetail({ limit: 100, remaining: 25 })).toEqual({
      usedPercent: 75,
      reliable: true,
      used: 75,
    });
    // Invalid remaining keeps a 0 gauge but withholds pacing reliability.
    expect(countsOfDetail({ limit: 100, remaining: 999 })).toEqual({
      usedPercent: 0,
      reliable: false,
      used: 0,
    });
  });

  it("maps TIME_UNIT windows to minutes", () => {
    expect(windowDurationMinutes({ duration: 5, timeUnit: "TIME_UNIT_HOUR" })).toBe(300);
    expect(windowDurationMinutes({ duration: 7, timeUnit: "TIME_UNIT_DAY" })).toBe(10_080);
    expect(windowDurationMinutes({ duration: 15, timeUnit: "TIME_UNIT_MINUTE" })).toBe(15);
    expect(windowDurationMinutes({ duration: 5, timeUnit: "TIME_UNIT_BOGUS" })).toBeUndefined();
  });
});

describe("parseWebUsage (GetUsages)", () => {
  it("decodes the FEATURE_CODING scope into primary weekly + secondary rate-limit lanes", () => {
    const quota = parseWebUsage(WEB_USAGE_FIXTURE, FETCHED);
    expect(quota?.provider).toBe("kimi");
    expect(quota?.source).toBe("web");
    expect(quota?.status).toBe("ok");
    const [primary, secondary] = quota?.windows ?? [];
    expect(primary).toMatchObject({
      label: "primary",
      title: "7d coding",
      usedPercent: 42,
      windowMinutes: 10_080,
      resetsAt: "2026-08-24T12:00:00.000Z",
      resetDescription: "420/1000 requests",
    });
    expect(secondary).toMatchObject({
      label: "secondary",
      title: "rate limit",
      usedPercent: 25,
      windowMinutes: 300,
      resetsAt: "2026-08-17T16:30:00.000Z",
      resetDescription: "Rate: 50/200 per 5 hour(s)",
    });
  });

  it("returns undefined when FEATURE_CODING is missing or malformed", () => {
    expect(parseWebUsage({ usages: [] }, FETCHED)).toBeUndefined();
    expect(parseWebUsage({}, FETCHED)).toBeUndefined();
    expect(parseWebUsage(null, FETCHED)).toBeUndefined();
  });
});

describe("parseCodeApiUsage (<base>/coding/v1/usages)", () => {
  it("decodes usage + first limit into labeled lanes", () => {
    const quota = parseCodeApiUsage(
      {
        usage: { limit: 800, used: 200, resetTime: "2026-08-24T00:00:00Z" },
        limits: [
          {
            window: { duration: 2, timeUnit: "TIME_UNIT_DAY" },
            detail: { limit: 400, remaining: 100 },
          },
          { broken: true },
        ],
      },
      FETCHED,
    );
    expect(quota?.source).toBe("code-api");
    const [primary, secondary] = quota?.windows ?? [];
    expect(primary).toMatchObject({ label: "primary", usedPercent: 25, windowMinutes: 10_080 });
    // Remaining-derived secondary: 400-100=300 used, window from TIME_UNIT_DAY.
    expect(secondary).toMatchObject({
      label: "secondary",
      usedPercent: 75,
      windowMinutes: 2_880,
      resetDescription: "Rate: 300/400 per 48 hour(s)",
    });
  });

  it("withholds windowMinutes when counters are unreliable but still paints the percent", () => {
    const quota = parseCodeApiUsage(
      {
        usage: { limit: 800, remaining: 9999 },
        limits: [
          { window: { duration: 1, timeUnit: "TIME_UNIT_HOUR" }, detail: { limit: 10 } },
        ],
      },
      FETCHED,
    );
    expect(quota?.windows[0]).toMatchObject({ usedPercent: 0 });
    expect(quota?.windows[0]?.windowMinutes).toBeUndefined();
    expect(quota?.windows[1]?.windowMinutes).toBeUndefined();
  });

  it("returns undefined without a usable weekly usage block", () => {
    expect(parseCodeApiUsage({ limits: [] }, FETCHED)).toBeUndefined();
  });
});

describe("parseSubscriptionStats (GetSubscriptionStats)", () => {
  it("emits the shared-pool monthly lane and the Code 7-day lane", () => {
    const extras = parseSubscriptionStats(SUBSCRIPTION_FIXTURE);
    expect(extras.map((w) => [w.id, w.title, w.usedPercent])).toEqual([
      ["kimi-monthly", "Total usage", 31],
      ["kimi-code-7d", "Code 7-day", 42],
    ]);
    expect(extras[0]?.windowMinutes).toBe(30 * 24 * 60);
    expect(extras[1]?.resetsAt).toBe("2026-08-24T12:00:00.000Z");
  });

  it("skips disabled or non-subscription balances", () => {
    expect(
      parseSubscriptionStats({
        subscriptionBalance: { feature: "FEATURE_OMNI", type: "PAYG", amountUsedRatio: 0.9 },
        ratelimitCode7d: { ratio: 0.5, enabled: false },
      }),
    ).toEqual([]);
  });

  it("suppresses the Code 7-day extra when it duplicates the weekly primary", () => {
    const primary = {
      label: "primary" as const,
      title: "7d coding",
      usedPercent: 42,
      windowMinutes: 10_080,
      resetsAt: "2026-08-24T12:01:00.000Z",
    };
    const duplicate = {
      label: "extra" as const,
      id: "kimi-code-7d",
      title: "Code 7-day",
      usedPercent: 42.5,
      windowMinutes: 10_080,
      resetsAt: "2026-08-24T12:02:00.000Z",
    };
    const monthly = {
      label: "extra" as const,
      id: "kimi-monthly",
      title: "Total usage",
      usedPercent: 31,
      windowMinutes: 43_200,
    };
    expect(suppressDuplicateCodeWeekly([monthly, duplicate], primary)).toEqual([monthly]);
    // No positive evidence of duplication (no resets) keeps both.
    expect(
      suppressDuplicateCodeWeekly([{ ...duplicate, resetsAt: undefined }, monthly], primary),
    ).toHaveLength(2);
  });
});

describe("credential resolution", () => {
  it("extracts the CLI oauth access token from kimi-code.json shapes", () => {
    expect(extractKimiCodeAccessToken({ access_token: " tok " })).toBe("tok");
    expect(extractKimiCodeAccessToken({})).toBeUndefined();
    expect(extractKimiCodeAccessToken("nope")).toBeUndefined();
  });

  it("treats missing expiry as fresh and stale past-expiry as expired", () => {
    expect(kimiCodeCredentialFresh({ expiresAt: undefined }, 1_000)).toBe(true);
    expect(kimiCodeCredentialFresh({ expiresAt: 3 }, 1_000)).toBe(false);
    // Grace boundary: must expire more than 60s from now.
    expect(kimiCodeCredentialFresh({ expiresAt: 62 }, 1_000)).toBe(true);
    expect(kimiCodeCredentialFresh({ expiresAt: 61 }, 1_000)).toBe(false);
  });

  it("prefers web token over api key over file credential, honoring endpoint overrides", () => {
    const base = { KIMI_CODE_HOME: "/nonexistent-kimi-home-for-tests" };
    expect(resolveKimiCredential({ ...base, KIMI_AUTH_TOKEN: "web-tok" })?.kind).toBe("web-token");
    expect(resolveKimiCredential({ ...base, KIMI_CODE_API_KEY: "api-key" })?.kind).toBe("api-key");
    expect(resolveKimiCredential(base)).toBeUndefined();
    // Endpoint overrides disable the file tier.
    expect(
      resolveKimiCredential({ KIMI_CODE_HOME: "/nonexistent-kimi-home-for-tests", KIMI_CODE_OAUTH_HOST: "x" })
        ?.kind,
    ).toBeUndefined();
  });
});

describe("buildKimiSnapshot envelope", () => {
  it("folds success into an ok snapshot with live dataConfidence", () => {
    const quota = parseWebUsage(WEB_USAGE_FIXTURE, FETCHED);
    const snapshot = buildKimiSnapshot(FETCHED, {
      kind: "ok",
      quota: quota!,
      dataConfidence: "live",
    });
    expect(snapshot.ok).toBe(true);
    expect(snapshot.source).toBe("kimi");
    expect(snapshot.dataConfidence).toBe("live");
    expect(snapshot.quotas).toHaveLength(1);
  });

  it("folds every failure mode into ok:false envelopes that never throw", () => {
    for (const reason of ["source-missing", "cli-error", "parse-error"] as const) {
      const snapshot = buildKimiSnapshot(FETCHED, {
        kind: "unavailable",
        reason,
        error: `failure: ${reason}`,
      });
      expect(snapshot.ok).toBe(false);
      expect(snapshot.reason).toBe(reason);
      expect(snapshot.quotas).toEqual([]);
    }
  });
});

describe("redaction", () => {
  it("never carries the bearer token in the failure envelope", async () => {
    const secret = "super-secret-kimi-token-abc123";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof globalThis.fetch;
    process.env.KIMI_AUTH_TOKEN = secret;
    try {
      const { Effect } = await import("effect");
      const mod = await import("../src/main/vellum-command/usage/kimi-source");
      const snapshot = await Effect.runPromise(mod.kimiSource.fetch);
      expect(snapshot.ok).toBe(false);
      // The whole serialized envelope - error copy included - stays clean.
      expect(JSON.stringify(snapshot)).not.toContain(secret);
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.KIMI_AUTH_TOKEN;
    }
  });

  it("keeps tokens out of success envelopes too", async () => {
    const secret = "success-secret-kimi-token-xyz789";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json(WEB_USAGE_FIXTURE, { status: 200 })) as unknown as typeof globalThis.fetch;
    process.env.KIMI_AUTH_TOKEN = secret;
    try {
      const { Effect } = await import("effect");
      const mod = await import("../src/main/vellum-command/usage/kimi-source");
      const snapshot = await Effect.runPromise(mod.kimiSource.fetch);
      expect(snapshot.ok).toBe(true);
      expect(JSON.stringify(snapshot)).not.toContain(secret);
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.KIMI_AUTH_TOKEN;
    }
  });
});
