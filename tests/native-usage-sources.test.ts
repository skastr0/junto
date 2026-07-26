import { describe, expect, it } from "vitest";
import { parseClaudeCachedUsage } from "../src/main/vellum/usage/claude-source";
import {
  buildGrokQuota,
  parseGrokUpdateLine,
} from "../src/main/vellum/usage/grok-source";
import {
  buildHermesQuota,
  mergeHermesPartials,
  parseHermesSqlRow,
} from "../src/main/vellum/usage/hermes-source";
import {
  preferNativeUsageSnapshots,
  usageStateIsPartial,
  type UsageSnapshot,
} from "../src/shared/usage";

const FETCHED = "2026-07-26T12:00:00.000Z";

describe("parseClaudeCachedUsage", () => {
  it("maps five_hour / seven_day / weekly_scoped into windows", () => {
    const quota = parseClaudeCachedUsage(
      {
        oauthAccount: { emailAddress: "ops@example.com" },
        cachedUsageUtilization: {
          fetchedAtMs: Date.parse(FETCHED),
          accountUuid: "acct-1",
          utilization: {
            five_hour: {
              utilization: 13,
              resets_at: "2026-07-26T15:50:00.000Z",
            },
            seven_day: {
              utilization: 71,
              resets_at: "2026-07-27T21:59:59.000Z",
            },
            limits: [
              {
                kind: "session",
                percent: 13,
                resets_at: "2026-07-26T15:50:00.000Z",
              },
              {
                kind: "weekly_all",
                percent: 71,
                resets_at: "2026-07-27T21:59:59.000Z",
              },
              {
                kind: "weekly_scoped",
                percent: 86,
                resets_at: "2026-07-27T21:59:59.000Z",
                scope: { model: { display_name: "Fable" } },
              },
            ],
            spend: {
              used: { amount_minor: 0, currency: "USD", exponent: 2 },
              enabled: false,
            },
          },
        },
      },
      FETCHED,
    );
    expect(quota?.provider).toBe("claude");
    expect(quota?.account).toBe("ops@example.com");
    expect(quota?.windows.map((w) => [w.label, w.usedPercent, w.title])).toEqual([
      ["primary", 13, "5h"],
      ["secondary", 71, "7d"],
      ["extra", 86, "Fable"],
    ]);
    expect(quota?.extras?.capability).toBe("limits");
  });

  it("returns undefined when cache is absent", () => {
    expect(parseClaudeCachedUsage({ numStartups: 1 }, FETCHED)).toBeUndefined();
  });
});

describe("parseGrokUpdateLine / buildGrokQuota", () => {
  it("extracts turn_completed usage from updates.jsonl shape", () => {
    const line = JSON.stringify({
      method: "_x.ai/session/update",
      params: {
        update: {
          sessionUpdate: "turn_completed",
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 120,
            costUsdTicks: 1_000_000,
          },
        },
      },
    });
    expect(parseGrokUpdateLine(line)).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      costUsdTicks: 1_000_000,
    });
  });

  it("builds a tokens-only partial quota", () => {
    const quota = buildGrokQuota(
      {
        inputTokens: 1000,
        outputTokens: 50,
        totalTokens: 1050,
        costUsdTicks: 9,
        turns: 2,
        sessions: 1,
      },
      FETCHED,
    );
    expect(quota?.provider).toBe("grok");
    expect(quota?.windows).toEqual([]);
    expect(quota?.extras?.partial).toBe(true);
    expect(quota?.extras?.totalTokens).toBe(1050);
  });
});

describe("hermes aggregate builders", () => {
  it("parses sqlite -json rows and merges profiles", () => {
    const a = parseHermesSqlRow({
      sessions: 2,
      input_tokens: 100,
      output_tokens: 10,
      cache_read_tokens: 5,
      reasoning_tokens: 1,
      estimated_cost_usd: 0,
      billing_mode: "subscription_included",
    });
    const b = parseHermesSqlRow({
      sessions: 1,
      input_tokens: 50,
      output_tokens: 5,
      cache_read_tokens: 0,
      reasoning_tokens: 0,
      estimated_cost_usd: 0.12,
      billing_mode: "subscription_included",
    });
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    const merged = mergeHermesPartials([a!, b!]);
    expect(merged.sessions).toBe(3);
    expect(merged.inputTokens).toBe(150);
    expect(merged.estimatedCostUsd).toBeCloseTo(0.12);
    expect(merged.databases).toBe(2);
    const quota = buildHermesQuota(merged, FETCHED);
    expect(quota?.provider).toBe("hermes");
    expect(quota?.extras?.billingMode).toBe("subscription_included");
    expect(quota?.extras?.partial).toBe(true);
  });
});

describe("preferNativeUsageSnapshots", () => {
  it("drops codexbar rows for providers already painted natively", () => {
    const snapshots: UsageSnapshot[] = [
      {
        source: "claude",
        fetchedAt: FETCHED,
        ok: true,
        quotas: [
          {
            provider: "claude",
            source: "claude.json",
            status: "ok",
            windows: [{ label: "primary", usedPercent: 10 }],
            updatedAt: FETCHED,
          },
        ],
      },
      {
        source: "codexbar",
        fetchedAt: FETCHED,
        ok: true,
        quotas: [
          {
            provider: "claude",
            source: "cli",
            status: "ok",
            windows: [{ label: "primary", usedPercent: 99 }],
            updatedAt: FETCHED,
          },
          {
            provider: "cursor",
            source: "cli",
            status: "ok",
            windows: [{ label: "primary", usedPercent: 5 }],
            updatedAt: FETCHED,
          },
        ],
      },
    ];
    const ranked = preferNativeUsageSnapshots(snapshots);
    const codexbar = ranked.find((s) => s.source === "codexbar");
    expect(codexbar?.quotas.map((q) => q.provider)).toEqual(["cursor"]);
    expect(ranked.find((s) => s.source === "claude")?.quotas[0]?.windows[0]?.usedPercent).toBe(10);
  });
});

describe("usageStateIsPartial", () => {
  it("flags token-only extras", () => {
    expect(
      usageStateIsPartial({
        snapshots: [
          {
            source: "grok",
            fetchedAt: FETCHED,
            ok: true,
            quotas: [
              {
                provider: "grok",
                source: "updates.jsonl",
                status: "ok",
                windows: [],
                updatedAt: FETCHED,
                extras: { partial: true, totalTokens: 1 },
              },
            ],
          },
        ],
      }),
    ).toBe(true);
  });
});
