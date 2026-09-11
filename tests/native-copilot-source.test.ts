import { describe, expect, it } from "vitest";
import {
  parseHostsTokens,
  pickEnvToken,
  COPILOT_DEVICE_FLOW_CLIENT_ID,
} from "../src/main/vellum-command/usage/copilot-auth";
import {
  buildCopilotSnapshot,
  parseQuotaResetDate,
  redactSecret,
  selectQuotaSnapshots,
  parseCopilotUsage,
  type CopilotOutcome,
} from "../src/main/vellum-command/usage/copilot-source";

const FETCHED = "2026-08-17T12:00:00.000Z";

// copilot_internal/user response shape: quota_snapshots
// with premium_interactions / chat, lenient number|string fields.
const USAGE_FIXTURE = {
  copilot_plan: "business",
  access_type_sku: "copilot_business",
  assigned_date: "2026-01-15",
  quota_reset_date: "2026-09-01",
  quota_snapshots: {
    premium_interactions: {
      entitlement: 300,
      remaining: 210.5,
      percent_remaining: 70,
      quota_id: "copilot_premium_requests",
      unlimited: false,
    },
    chat: {
      entitlement: 0,
      remaining: 0,
      percent_remaining: 100,
      quota_id: "chat",
      unlimited: true,
    },
  },
};

describe("parseCopilotUsage — happy path", () => {
  it("maps premium_interactions → primary and drops unlimited chat from the bars", () => {
    const quota = parseCopilotUsage(USAGE_FIXTURE, FETCHED, {
      account: "octocat",
      tokenOrigin: "env",
    });
    expect(quota?.provider).toBe("copilot");
    expect(quota?.source).toBe("oauth");
    expect(quota?.status).toBe("ok");
    expect(quota?.plan).toBe("business");
    expect(quota?.account).toBe("octocat");
    // Only the metered window paints; unlimited chat never becomes a bar.
    expect(quota?.windows.map((w) => [w.label, w.title, w.usedPercent])).toEqual([
      ["primary", "Premium", 30],
    ]);
    expect(quota?.windows[0]?.resetsAt).toBe("2026-09-01T00:00:00.000Z");
    expect(quota?.windows[0]?.resetDescription).toBe("resets 2026-09-01T00:00:00.000Z");
    expect(quota?.creditsRemaining).toBe(210.5);
  });

  it("keeps chat as secondary when it is a real metered snapshot", () => {
    const quota = parseCopilotUsage(
      {
        copilot_plan: "pro",
        quota_reset_date: "2026-09-01T12:30:00Z",
        quota_snapshots: {
          premium_interactions: { entitlement: 300, remaining: 150 }, // derived percent
          chat: { entitlement: 50, remaining: "10", percent_remaining: 20 },
        },
      },
      FETCHED,
      { tokenOrigin: "cli" },
    );
    expect(quota?.windows.map((w) => [w.label, w.usedPercent])).toEqual([
      ["primary", 50],
      ["secondary", 80],
    ]);
    expect(quota?.source).toBe("cli");
    expect(quota?.windows[1]?.resetsAt).toBe("2026-09-01T12:30:00.000Z");
  });

  it("decodes numeric-string fields and derives percent from entitlement/remaining", () => {
    const quota = parseCopilotUsage(
      {
        quota_snapshots: {
          premium_interactions: { entitlement: "300", remaining: "75" },
        },
      },
      FETCHED,
    );
    expect(quota?.windows[0]?.usedPercent).toBe(75);
  });

  it("surfaces over-quota usage with an honest resetDescription", () => {
    const quota = parseCopilotUsage(
      {
        quota_reset_date: "2026-09-01",
        quota_snapshots: {
          premium_interactions: { entitlement: 300, remaining: -10, percent_remaining: -5 },
        },
      },
      FETCHED,
    );
    expect(quota?.windows[0]?.usedPercent).toBe(105);
    expect(quota?.windows[0]?.resetDescription).toBe("105% used");
  });
});

describe("parseCopilotUsage — fallback tiers", () => {
  it("tier 2: legacy monthly_quotas/limited_user_quotas counts become synthetic windows", () => {
    const quota = parseCopilotUsage(
      {
        copilot_plan: "individual",
        monthly_quotas: { chat: 50, completions: 200 },
        limited_user_quotas: { chat: 25, completions: 50 },
      },
      FETCHED,
    );
    expect(quota?.windows.map((w) => [w.label, w.usedPercent])).toEqual([
      ["primary", 75],
      ["secondary", 50],
    ]);
    expect(quota?.extras?.note).toContain("legacy");
  });

  it("tier 3: unknown dynamic snapshot keys match by name (chat / premium / completion / code)", () => {
    const quota = parseCopilotUsage(
      {
        quota_snapshots: {
          agent_premium_requests: { entitlement: 100, remaining: 40 },
          some_chat_thing: { entitlement: 80, remaining: 60 },
        },
      },
      FETCHED,
    );
    expect(quota?.windows.map((w) => [w.label, w.usedPercent])).toEqual([
      ["primary", 60],
      ["secondary", 25],
    ]);
  });

  it("drops zero-everything placeholder snapshots instead of painting a fake 0% bar", () => {
    const selected = selectQuotaSnapshots({
      quota_snapshots: {
        premium_interactions: { entitlement: 0, remaining: 0, percent_remaining: 100, quota_id: "x" },
      },
    });
    expect(selected.premium).toBeUndefined();
    expect(parseCopilotUsage({ quota_snapshots: {} }, FETCHED)).toBeUndefined();
  });

  it("token-based billing plans surface a plan-only row with no invented windows", () => {
    const quota = parseCopilotUsage(
      { copilot_plan: "business", token_based_billing: true, quota_snapshots: {} },
      FETCHED,
    );
    expect(quota).toBeDefined();
    expect(quota?.windows).toHaveLength(0);
    expect(quota?.plan).toBe("business");
    expect(quota?.extras?.tokenBasedBilling).toBe(true);
  });

  it("returns undefined when nothing honest can be shown at all", () => {
    expect(parseCopilotUsage({}, FETCHED)).toBeUndefined();
    expect(parseCopilotUsage("nope", FETCHED)).toBeUndefined();
  });
});

describe("parseQuotaResetDate — accepted formats", () => {
  it.each([
    ["2026-09-01T12:30:45Z", "2026-09-01T12:30:45.000Z"],
    ["2026-09-01T12:30:45.123Z", "2026-09-01T12:30:45.123Z"],
    ["2026-09-01", "2026-09-01T00:00:00.000Z"], // bare date → UTC midnight
  ])("%s → %s", (input, expected) => {
    expect(parseQuotaResetDate(input)).toBe(expected);
  });

  it("rejects garbage and non-date shapes", () => {
    expect(parseQuotaResetDate("not-a-date")).toBeUndefined();
    expect(parseQuotaResetDate(1234)).toBeUndefined();
    expect(parseQuotaResetDate(undefined)).toBeUndefined();
  });
});

describe("token discovery tiers (pure parts)", () => {
  it("pickEnvToken prefers COPILOT_API_TOKEN over GH_* over GITHUB_TOKEN", () => {
    expect(
      pickEnvToken({
        COPILOT_API_TOKEN: "gho_copilot_first1",
        GH_TOKEN: "gho_cli_second22",
        GITHUB_TOKEN: "ghp_third_token3",
      }),
    ).toBe("gho_copilot_first1");
    expect(pickEnvToken({ GITHUB_TOKEN: "ghp_only_one_here" })).toBe("ghp_only_one_here");
  });

  it("pickEnvToken ignores short or whitespace-laden values", () => {
    expect(pickEnvToken({ COPILOT_API_TOKEN: "short" })).toBeUndefined();
    expect(pickEnvToken({ GH_TOKEN: "has space inside" })).toBeUndefined();
    expect(pickEnvToken({})).toBeUndefined();
  });

  it("parseHostsTokens ranks github.com tokens before enterprise hosts", () => {
    const hosts = [
      "github.com:",
      "    users:",
      "        octocat:",
      "            oauth_token: gho_dotcom_token1",
      "enterprise.example.com:",
      "    users:",
      "        corp:",
      "            oauth_token: gho_enterprise2",
    ].join("\n");
    expect(parseHostsTokens(hosts)).toEqual(["gho_dotcom_token1", "gho_enterprise2"]);
  });

  it("parseHostsTokens skips malformed entries and dedupes", () => {
    const hosts = [
      "github.com:",
      "    user1:",
      "        oauth_token: gho_real_token1",
      "        other_field: gho_decoy000",
      "    user2:",
      "        oauth_token: gho_real_token1",
    ].join("\n");
    expect(parseHostsTokens(hosts)).toEqual(["gho_real_token1"]);
  });

  it("documents the future device-flow client id without wiring it up", () => {
    expect(COPILOT_DEVICE_FLOW_CLIENT_ID).toBe("Iv1.b507a08c87ecfe98");
  });
});

describe("buildCopilotSnapshot — envelope semantics", () => {
  it("auth failure names the fix and never carries the token", () => {
    const secret = "gho_SUPERSECRET123";
    const snapshot = buildCopilotSnapshot(FETCHED, {
      kind: "unavailable",
      reason: "cli-error",
      error: redactSecret(
        `GitHub rejected credentials (${secret}) — run \`gh auth login\` or refresh COPILOT_API_TOKEN`,
        secret,
      ),
    });
    expect(snapshot.ok).toBe(false);
    expect(snapshot.reason).toBe("cli-error");
    expect(snapshot.error).toContain("gh auth login");
    expect(JSON.stringify(snapshot)).not.toContain(secret);
    expect(snapshot.quotas).toEqual([]);
  });

  it("network failure folds into cli-error with the token redacted", () => {
    const snapshot = buildCopilotSnapshot(FETCHED, {
      kind: "unavailable",
      reason: "cli-error",
      error: redactSecret("fetch failed for token gho_ABBACABBA123", "gho_ABBACABBA123"),
    });
    expect(snapshot.error).not.toContain("gho_ABBACABBA123");
    expect(snapshot.error).toContain("[redacted]");
  });

  it("missing credential degrades to source-missing with actionable copy", () => {
    const snapshot = buildCopilotSnapshot(FETCHED, {
      kind: "unavailable",
      reason: "source-missing",
      error:
        "no GitHub credential found — set COPILOT_API_TOKEN, run `gh auth login`, or add an oauth_token to ~/.config/gh/hosts.yml",
    });
    expect(snapshot.ok).toBe(false);
    expect(snapshot.reason).toBe("source-missing");
    expect(snapshot.error).toContain("COPILOT_API_TOKEN");
    expect(snapshot.quotas).toEqual([]);
  });

  it("ok outcomes carry live data confidence and pass quotas through", () => {
    const quota = parseCopilotUsage(USAGE_FIXTURE, FETCHED)!;
    const snapshot = buildCopilotSnapshot(FETCHED, { kind: "ok", quotas: [quota] });
    expect(snapshot.source).toBe("copilot");
    expect(snapshot.ok).toBe(true);
    expect(snapshot.dataConfidence).toBe("live");
    expect(snapshot.quotas).toHaveLength(1);
  });
});
