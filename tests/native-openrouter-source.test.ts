import { describe, expect, it } from "vitest";
import {
  assembleOpenRouterSnapshot,
  buildOpenRouterQuota,
  buildSpendHistory,
  cleanCredentialValue,
  parseActivityPayload,
  parseCreditsPayload,
  parseKeyPayload,
  redactSecret,
  resolveOpenRouterCredentials,
  type OpenRouterEndpointOutcome,
} from "../src/main/vellum-command/usage/openrouter-source";

const FETCHED = "2026-07-26T12:00:00.000Z";
const KEY = "sk-or-v1-secret-value-do-not-leak";

// Real response shapes per OpenRouter docs.
const CREDITS_FIXTURE = {
  data: { total_credits: 150.0, total_usage: 97.25 },
};
const KEY_FIXTURE = {
  data: {
    label: "vellum-key",
    limit: 50,
    limit_remaining: 32.5,
    usage: 17.5,
    usage_daily: 3.25,
    usage_weekly: 11.0,
    usage_monthly: 42.75,
    limit_reset: "monthly",
    rate_limit: { requests: 1000, interval: "60s" },
  },
};

describe("cleanCredentialValue", () => {
  it("trims whitespace and strips one layer of matching quotes", () => {
    expect(cleanCredentialValue('  "sk-or-v1-x"  ')).toBe("sk-or-v1-x");
    expect(cleanCredentialValue("'sk-or-v1-y'\n")).toBe("sk-or-v1-y");
    expect(cleanCredentialValue("sk-or-v1-z")).toBe("sk-or-v1-z");
  });

  it("returns undefined for empty or quote-only values", () => {
    expect(cleanCredentialValue("   ")).toBeUndefined();
    expect(cleanCredentialValue('""')).toBeUndefined();
    expect(cleanCredentialValue(undefined)).toBeUndefined();
  });
});

describe("resolveOpenRouterCredentials", () => {
  it("prefers the environment variable over key files", () => {
    const creds = resolveOpenRouterCredentials(
      { OPENROUTER_API_KEY: KEY },
      () => "sk-or-v1-from-file",
    );
    expect(creds?.apiKey).toBe(KEY);
    expect(creds?.baseUrl).toBe("https://openrouter.ai/api/v1");
  });

  it("falls back to a conventional key file when env is unset", () => {
    const creds = resolveOpenRouterCredentials({}, (path) =>
      path.endsWith(".openrouter/apikey") ? `  ${KEY}\n` : undefined,
    );
    expect(creds?.apiKey).toBe(KEY);
  });

  it("returns undefined with no credential anywhere", () => {
    expect(resolveOpenRouterCredentials({}, () => undefined)).toBeUndefined();
  });

  it("carries an optional management key and honors only HTTPS base overrides", () => {
    const good = resolveOpenRouterCredentials({
      OPENROUTER_API_KEY: KEY,
      OPENROUTER_MANAGEMENT_API_KEY: "mgmt",
      OPENROUTER_API_URL: "https://proxy.example.com/api/v1/",
    });
    expect(good?.managementApiKey).toBe("mgmt");
    expect(good?.baseUrl).toBe("https://proxy.example.com/api/v1");
    const bad = resolveOpenRouterCredentials({
      OPENROUTER_API_KEY: KEY,
      OPENROUTER_API_URL: "http://insecure.example.com/api/v1",
    });
    expect(bad?.baseUrl).toBe("https://openrouter.ai/api/v1");
  });
});

describe("parseCreditsPayload", () => {
  it("decodes totals and clamps balance at zero", () => {
    expect(parseCreditsPayload(CREDITS_FIXTURE)).toEqual({
      totalCredits: 150.0,
      totalUsage: 97.25,
      balance: 52.75,
    });
    expect(parseCreditsPayload({ data: { total_credits: 5, total_usage: 9 } })?.balance).toBe(0);
  });

  it("rejects malformed payloads", () => {
    expect(parseCreditsPayload({ data: { total_credits: "x", total_usage: 1 } })).toBeUndefined();
    expect(parseCreditsPayload({ nope: true })).toBeUndefined();
    expect(parseCreditsPayload(null)).toBeUndefined();
  });
});

describe("parseKeyPayload", () => {
  it("decodes every optional field with correct types", () => {
    const key = parseKeyPayload(KEY_FIXTURE);
    expect(key?.label).toBe("vellum-key");
    expect(key?.limit).toBe(50);
    expect(key?.limitRemaining).toBe(32.5);
    expect(key?.limitReset).toBe("monthly");
    expect(key?.rateLimit).toEqual({ requests: 1000, interval: "60s" });
  });

  it("accepts a minimal unlimited key payload and rejects garbage", () => {
    expect(parseKeyPayload({ data: { label: "free" } })).toEqual({ label: "free" });
    expect(parseKeyPayload({ data: "nope" })).toBeUndefined();
    expect(parseKeyPayload(undefined)).toBeUndefined();
  });
});

describe("parseActivityPayload + buildSpendHistory — per-model metered spend", () => {
  const bounds = { latestCompleted: "2026-07-25", cutoff: "2026-06-26" };

  it("keeps completed rows inside the 30-day window and sums by model", () => {
    const rows = parseActivityPayload(
      {
        data: [
          { date: "2026-07-24 00:00:00", model_permaslug: "openai/gpt-5", prompt_tokens: 10, completion_tokens: 5, requests: 2, usage: 0.4 },
          { date: "2026-07-25", model: "anthropic/claude", prompt_tokens: 7, completion_tokens: 3, requests: 1, usage: 0.6, byok_usage_inference: 0.1 },
          { date: "2026-07-26", prompt_tokens: 1, completion_tokens: 1, requests: 1, usage: 0.01 }, // future day dropped
          { date: "2026-06-01", prompt_tokens: 1, completion_tokens: 1, requests: 1, usage: 99 }, // before cutoff dropped
        ],
      },
      bounds,
    );
    expect(rows).toHaveLength(2);
    const history = buildSpendHistory(rows);
    expect(history.totalUsd).toBeCloseTo(1.1);
    expect(history.byModel[0]).toEqual({ model: "anthropic/claude", costUsd: 0.7 });
    expect(history.windowEnd).toBe("2026-07-25");
  });

  it("rejects the whole payload on any malformed row", () => {
    expect(() =>
      parseActivityPayload(
        { data: [{ date: "not-a-date", prompt_tokens: 1, completion_tokens: 1, requests: 1, usage: 1 }] },
        bounds,
      ),
    ).toThrow(TypeError);
    expect(() => parseActivityPayload({ data: "nope" }, bounds)).toThrow(TypeError);
  });
});

describe("buildOpenRouterQuota — window mapping", () => {
  it("maps key limit + remaining into the primary window and credits into creditsRemaining", () => {
    const quota = buildOpenRouterQuota(
      { credits: parseCreditsPayload(CREDITS_FIXTURE)!, key: parseKeyPayload(KEY_FIXTURE)! },
      FETCHED,
    );
    expect(quota?.provider).toBe("openrouter");
    expect(quota?.source).toBe("api-key");
    expect(quota?.status).toBe("ok");
    expect(quota?.creditsRemaining).toBe(52.75);
    expect(quota?.windows).toHaveLength(1);
    expect(quota?.windows[0]?.label).toBe("primary");
    expect(quota?.windows[0]?.title).toBe("API key budget");
    // used = limit - clamp(limit_remaining) = 50 - 32.5 → 35%
    expect(quota?.windows[0]?.usedPercent).toBeCloseTo(35);
    expect(quota?.windows[0]?.resetDescription).toBe("resets monthly");
  });

  it("prefers limit_remaining over cumulative usage and clamps over-reporting", () => {
    const quota = buildOpenRouterQuota(
      { key: { ...parseKeyPayload(KEY_FIXTURE)!, limitRemaining: 60 } },
      FETCHED,
    );
    // remaining above limit renders 0% used, not negative
    expect(quota?.windows[0]?.usedPercent).toBe(0);
  });

  it("falls back to reset-window spend, then cumulative usage, when remaining is absent", () => {
    const weekly = buildOpenRouterQuota(
      { key: { limit: 100, limitReset: "weekly", usageWeekly: 40, usage: 90 } },
      FETCHED,
    );
    expect(weekly?.windows[0]?.usedPercent).toBeCloseTo(40);
    const cumulative = buildOpenRouterQuota({ key: { limit: 200, usage: 50 } }, FETCHED);
    expect(cumulative?.windows[0]?.usedPercent).toBeCloseTo(25);
  });

  it("emits no window for unlimited keys but keeps extras provenance vendorMetered", () => {
    const quota = buildOpenRouterQuota(
      { credits: parseCreditsPayload(CREDITS_FIXTURE)!, key: { label: "unlimited" } },
      FETCHED,
    );
    expect(quota?.windows).toHaveLength(0);
    expect(quota?.extras?.provenance).toBe("vendorMetered");
    expect(String(quota?.extras?.note)).toMatch(/metered/);
  });

  it("records degraded key budget and spend history notes in extras", () => {
    const quota = buildOpenRouterQuota(
      {
        credits: parseCreditsPayload(CREDITS_FIXTURE)!,
        keyDegradedReason: "key info returned HTTP 500",
        spendHistoryNote: "management key not configured (OPENROUTER_MANAGEMENT_API_KEY)",
      },
      FETCHED,
    );
    expect(quota?.extras?.keyBudgetAvailable).toBe(false);
    expect(quota?.extras?.spendHistoryAvailable).toBe(false);
  });

  it("returns undefined when neither endpoint decoded", () => {
    expect(buildOpenRouterQuota({}, FETCHED)).toBeUndefined();
  });
});

const okOutcome = (payload: unknown): OpenRouterEndpointOutcome => ({ kind: "ok", payload });

describe("assembleOpenRouterSnapshot — envelope tiers", () => {
  it("ships a live ok snapshot when both endpoints decode", () => {
    const snapshot = assembleOpenRouterSnapshot(
      {
        credentialsPresent: true,
        managementConfigured: false,
        secrets: [KEY],
        creditsOutcome: okOutcome(CREDITS_FIXTURE),
        keyOutcome: okOutcome(KEY_FIXTURE),
      },
      FETCHED,
    );
    expect(snapshot.ok).toBe(true);
    expect(snapshot.source).toBe("openrouter");
    expect(snapshot.dataConfidence).toBe("live");
    expect(snapshot.quotas).toHaveLength(1);
    expect(snapshot.error).toBeUndefined();
  });

  it("stays ok with credits alone when the key endpoint fails (fallback tier)", () => {
    const snapshot = assembleOpenRouterSnapshot(
      {
        credentialsPresent: true,
        managementConfigured: false,
        secrets: [KEY],
        creditsOutcome: okOutcome(CREDITS_FIXTURE),
        keyOutcome: { kind: "http-error", status: 500 },
      },
      FETCHED,
    );
    expect(snapshot.ok).toBe(true);
    expect(snapshot.dataConfidence).toBe("live");
    expect(snapshot.quotas[0]?.creditsRemaining).toBe(52.75);
    expect(snapshot.quotas[0]?.windows).toHaveLength(0);
    expect(String(snapshot.quotas[0]?.extras?.keyBudgetAvailable)).toBe("false");
    expect(String(snapshot.quotas[0]?.extras?.keyBudgetNote)).toMatch(/HTTP 500/);
  });

  it("stays ok with key info alone when credits fail (fallback tier)", () => {
    const snapshot = assembleOpenRouterSnapshot(
      {
        credentialsPresent: true,
        managementConfigured: false,
        secrets: [KEY],
        creditsOutcome: { kind: "failed", error: `fetch failed for ${KEY}` },
        keyOutcome: okOutcome(KEY_FIXTURE),
      },
      FETCHED,
    );
    expect(snapshot.ok).toBe(true);
    expect(snapshot.quotas[0]?.windows[0]?.usedPercent).toBeCloseTo(35);
    expect(JSON.stringify(snapshot)).not.toContain(KEY);
  });

  it("degrades to source-missing with no credentials anywhere", () => {
    const snapshot = assembleOpenRouterSnapshot(
      { credentialsPresent: false, managementConfigured: false },
      FETCHED,
    );
    expect(snapshot.ok).toBe(false);
    expect(snapshot.reason).toBe("source-missing");
    expect(snapshot.quotas).toHaveLength(0);
  });

  it("folds auth failure into cli-error and redacts the secret from every string", () => {
    const snapshot = assembleOpenRouterSnapshot(
      {
        credentialsPresent: true,
        managementConfigured: false,
        secrets: [KEY],
        creditsOutcome: { kind: "unauthorized", status: 401 },
        keyOutcome: { kind: "unauthorized", status: 403 },
      },
      FETCHED,
    );
    expect(snapshot.ok).toBe(false);
    expect(snapshot.reason).toBe("cli-error");
    expect(snapshot.error).toMatch(/rejected credentials \(HTTP 401\)/);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(KEY);
    expect(serialized).not.toContain("sk-or-v1-secret");
  });

  it("folds network failure into cli-error with redaction applied", () => {
    const snapshot = assembleOpenRouterSnapshot(
      {
        credentialsPresent: true,
        managementConfigured: false,
        secrets: [KEY],
        creditsOutcome: { kind: "failed", error: `timeout while sending ${KEY}` },
        keyOutcome: { kind: "failed", error: `timeout while sending ${KEY}` },
      },
      FETCHED,
    );
    expect(snapshot.ok).toBe(false);
    expect(snapshot.reason).toBe("cli-error");
    expect(snapshot.error).not.toContain(KEY);
  });

  it("folds undecodable payloads into parse-error", () => {
    const snapshot = assembleOpenRouterSnapshot(
      {
        credentialsPresent: true,
        managementConfigured: false,
        secrets: [KEY],
        creditsOutcome: okOutcome({ surprise: true }),
        keyOutcome: okOutcome({ also: "wrong" }),
      },
      FETCHED,
    );
    expect(snapshot.ok).toBe(false);
    expect(snapshot.reason).toBe("parse-error");
  });

  it("includes per-model metered spend in extras when activity succeeds", () => {
    const snapshot = assembleOpenRouterSnapshot(
      {
        credentialsPresent: true,
        managementConfigured: true,
        secrets: [KEY],
        creditsOutcome: okOutcome(CREDITS_FIXTURE),
        now: new Date("2026-07-26T12:00:00.000Z"),
        historyOutcomes: [
          okOutcome({
            data: [
              { date: "2026-07-25", model_permaslug: "openai/gpt-5", prompt_tokens: 10, completion_tokens: 5, requests: 2, usage: 1.25 },
            ],
          }),
          okOutcome({ data: [] }),
        ],
      },
      FETCHED,
    );
    expect(snapshot.ok).toBe(true);
    const extras = snapshot.quotas[0]?.extras;
    expect(extras?.provenance).toBe("vendorMetered");
    expect(extras?.spendHistoryTotalUsd).toBeCloseTo(1.25);
    expect(Array.isArray(extras?.spendHistoryByModel)).toBe(true);
  });

  it("notes missing management key without failing the snapshot", () => {
    const snapshot = assembleOpenRouterSnapshot(
      {
        credentialsPresent: true,
        managementConfigured: false,
        secrets: [KEY],
        creditsOutcome: okOutcome(CREDITS_FIXTURE),
      },
      FETCHED,
    );
    expect(snapshot.ok).toBe(true);
    expect(String(snapshot.quotas[0]?.extras?.spendHistoryNote)).toMatch(/management key not configured/);
  });
});

describe("redactSecret", () => {
  it("replaces any string containing a secret wholesale", () => {
    expect(redactSecret(`Bearer ${KEY} failed`, [KEY])).toBe("[redacted]");
    expect(redactSecret("harmless message", [KEY])).toBe("harmless message");
  });
});
