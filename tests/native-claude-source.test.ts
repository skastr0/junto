import { describe, expect, it } from "vitest";
import {
  extractClaudeAccessToken,
  fetchClaudeUsageApi,
  parseClaudeOAuthUsage,
  type ClaudeLiveOutcome,
} from "../src/main/vellum/usage/claude-oauth";
import {
  assembleClaudeSnapshot,
  parseClaudeCachedUsage,
} from "../src/main/vellum/usage/claude-source";

const FETCHED = "2026-07-26T12:00:00.000Z";

const LIVE_USAGE_PAYLOAD = {
  five_hour: { utilization: 42, resets_at: "2026-07-26T15:50:00.000Z" },
  seven_day: { utilization: 12, resets_at: "2026-08-01T21:59:59.000Z" },
  seven_day_oauth_apps: { utilization: 8, resets_at: "2026-08-01T21:59:59.000Z" },
  seven_day_opus: { utilization: 55, resets_at: "2026-08-01T21:59:59.000Z" },
  limits: [
    {
      kind: "weekly_scoped",
      percent: 90,
      resets_at: "2026-08-01T21:59:59.000Z",
      scope: { model: { display_name: "Fable" } },
    },
  ],
  extra_usage: {
    is_enabled: true,
    used_credits: 1.25,
    monthly_limit: 20,
    currency: "USD",
    utilization: 6.25,
  },
};

const STALE_CACHE_PAYLOAD = {
  oauthAccount: { emailAddress: "ops@example.com" },
  cachedUsageUtilization: {
    fetchedAtMs: Date.parse(FETCHED),
    accountUuid: "acct-1",
    utilization: {
      five_hour: { utilization: 13, resets_at: "2026-07-26T15:50:00.000Z" },
      seven_day: { utilization: 71, resets_at: "2026-07-27T21:59:59.000Z" },
    },
  },
};

describe("parseClaudeCachedUsage (stale path)", () => {
  it("maps five_hour / seven_day into primary and secondary windows", () => {
    const quota = parseClaudeCachedUsage(STALE_CACHE_PAYLOAD, FETCHED);
    expect(quota?.provider).toBe("claude");
    expect(quota?.source).toBe("claude.json");
    expect(quota?.account).toBe("ops@example.com");
    expect(quota?.windows.map((w) => [w.label, w.usedPercent])).toEqual([
      ["primary", 13],
      ["secondary", 71],
    ]);
    expect(quota?.extras?.sourcePath).toBe("cachedUsageUtilization");
  });

  it("returns undefined when the cache is absent", () => {
    expect(parseClaudeCachedUsage({ numStartups: 1 }, FETCHED)).toBeUndefined();
  });
});

describe("parseClaudeOAuthUsage (live path)", () => {
  it("maps the live payload into plan windows", () => {
    const quota = parseClaudeOAuthUsage(LIVE_USAGE_PAYLOAD, FETCHED);
    expect(quota?.provider).toBe("claude");
    expect(quota?.source).toBe("oauth");
    expect(quota?.windows.map((w) => [w.label, w.id ?? w.title, w.usedPercent])).toEqual([
      ["primary", "5h", 42],
      ["secondary", "7d", 12],
      ["extra", "seven_day_oauth_apps", 8],
      ["extra", "seven_day_opus", 55],
      ["extra", "weekly_scoped:Fable", 90],
      ["extra", "extra-usage-spend", 6.25],
    ]);
    const primary = quota?.windows[0];
    expect(primary?.windowMinutes).toBe(300);
    expect(primary?.resetsAt).toBe("2026-07-26T15:50:00.000Z");
    expect(quota?.windows[1]?.windowMinutes).toBe(10_080);
    expect(quota?.extras?.capability).toBe("live");
  });

  it("never fabricates percentages for absent or malformed windows", () => {
    const quota = parseClaudeOAuthUsage(
      { five_hour: {}, extra_usage: { is_enabled: true } },
      FETCHED,
    );
    expect(quota).toBeUndefined();
  });

  it("returns undefined for non-object payloads", () => {
    expect(parseClaudeOAuthUsage(null, FETCHED)).toBeUndefined();
    expect(parseClaudeOAuthUsage("nope", FETCHED)).toBeUndefined();
  });
});

describe("extractClaudeAccessToken", () => {
  it("reads the claudeAiOauth credentials-file shape", () => {
    const token = extractClaudeAccessToken({
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-test",
        refreshToken: "sk-ant-ort01-test",
        expiresAt: 9999999999999,
        scopes: ["user:profile"],
      },
    });
    expect(token).toBe("sk-ant-oat01-test");
  });

  it("reads nested oauthAccount and flat shapes defensively", () => {
    expect(
      extractClaudeAccessToken({ oauthAccount: { accessToken: "tok-nested" } }),
    ).toBe("tok-nested");
    expect(extractClaudeAccessToken({ accessToken: "tok-flat" })).toBe("tok-flat");
    expect(extractClaudeAccessToken({ access_token: "tok-snake" })).toBe("tok-snake");
  });

  it("rejects garbage payloads", () => {
    expect(extractClaudeAccessToken(undefined)).toBeUndefined();
    expect(extractClaudeAccessToken({ claudeAiOauth: {} })).toBeUndefined();
    expect(extractClaudeAccessToken("not-json")).toBeUndefined();
  });
});

describe("assembleClaudeSnapshot fallback behavior", () => {
  it("prefers a live ok outcome when it decodes", () => {
    const snapshot = assembleClaudeSnapshot(
      { kind: "ok", payload: LIVE_USAGE_PAYLOAD },
      STALE_CACHE_PAYLOAD,
      FETCHED,
    );
    expect(snapshot.ok).toBe(true);
    expect(snapshot.quotas[0]?.source).toBe("oauth");
    expect(snapshot.reason).toBeUndefined();
    // Fresh provider payload is tagged live at snapshot level.
    expect(snapshot.dataConfidence).toBe("live");
  });

  it("falls back to stale data on 401 in the same call", () => {
    const snapshot = assembleClaudeSnapshot(
      { kind: "unauthorized", status: 401 },
      STALE_CACHE_PAYLOAD,
      FETCHED,
    );
    expect(snapshot.ok).toBe(true);
    expect(snapshot.quotas[0]?.source).toBe("claude.json");
    expect(snapshot.quotas[0]?.extras?.sourcePath).toBe("cachedUsageUtilization");
    // Stale fallback paints honestly as stale-cache, never as live.
    expect(snapshot.dataConfidence).toBe("stale-cache");
  });

  it("reports cli-error with no quotas when live fails and no stale cache exists", () => {
    const snapshot = assembleClaudeSnapshot(
      { kind: "unauthorized", status: 403 },
      undefined,
      FETCHED,
    );
    expect(snapshot.ok).toBe(false);
    expect(snapshot.reason).toBe("cli-error");
    expect(snapshot.quotas).toEqual([]);
    // The error copy names the status, never any credential material.
    expect(snapshot.error).toContain("403");
  });

  it("reports source-missing when no credentials were available at all", () => {
    const snapshot = assembleClaudeSnapshot(undefined, undefined, FETCHED);
    expect(snapshot.ok).toBe(false);
    expect(snapshot.reason).toBe("source-missing");
    expect(snapshot.quotas).toEqual([]);
  });

  it("degrades an unusable live payload to parse-error only when stale is also gone", () => {
    const snapshot = assembleClaudeSnapshot(
      { kind: "ok", payload: { unexpected: true } },
      undefined,
      FETCHED,
    );
    expect(snapshot.ok).toBe(false);
    expect(snapshot.reason).toBe("parse-error");
  });

  it("falls back to stale on network failure", () => {
    const snapshot = assembleClaudeSnapshot(
      { kind: "failed", error: "network unreachable" },
      STALE_CACHE_PAYLOAD,
      FETCHED,
    );
    expect(snapshot.ok).toBe(true);
    expect(snapshot.quotas[0]?.source).toBe("claude.json");
  });
});

describe("fetchClaudeUsageApi (injected fetch)", () => {
  const makeFetch = (status: number, body: unknown): typeof fetch =>
    (async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
      })) as unknown as typeof fetch;

  it("decodes a successful usage payload", async () => {
    const outcome: ClaudeLiveOutcome = await fetchClaudeUsageApi(
      "token-in-memory-only",
      makeFetch(200, LIVE_USAGE_PAYLOAD),
    );
    expect(outcome.kind).toBe("ok");
  });

  it("folds 401 into the unauthorized outcome without echoing secrets", async () => {
    const outcome = await fetchClaudeUsageApi(
      "token-in-memory-only",
      makeFetch(401, { error: "bad token" }),
    );
    expect(outcome.kind).toBe("unauthorized");
    if (outcome.kind === "unauthorized") expect(outcome.status).toBe(401);
  });

  it("folds transport failure into a failed outcome", async () => {
    const broken = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const outcome = await fetchClaudeUsageApi("token-in-memory-only", broken);
    expect(outcome.kind).toBe("failed");
  });

  it("folds a non-JSON 200 body into a failed outcome", async () => {
    const outcome = await fetchClaudeUsageApi(
      "token-in-memory-only",
      makeFetch(200, "<html>not json</html>"),
    );
    expect(outcome.kind).toBe("failed");
  });
});
