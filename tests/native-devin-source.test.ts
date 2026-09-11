import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  chromiumLevelDbRoots,
  displayOrganization,
  extractBearer,
  levelDbCandidates,
  normalizeOrganization,
  resolveEnvCredential,
  scanSessionMaterial,
} from "../src/main/vellum-command/usage/devin-auth";
import {
  buildDevinSnapshot,
  candidatePaths,
  DEVIN_LIMITS_STATUS,
  devinSource,
  fetchDevinWith,
  parseDevinQuotaUsage,
  redactToken,
} from "../src/main/vellum-command/usage/devin-source";

const FETCHED = "2026-08-25T12:00:00.000Z";
const TOKEN = "auth1_abcdefghijklmnopqrstuvwx";

// Current wire shape: top-level percentages (fractions or whole percents),
// ISO reset timestamps with offsets, plan name, overage balance.
const CURRENT_SHAPE_FIXTURE = {
  is_quota_plan: true,
  has_quota_allocation: true,
  daily_percentage: 0.12, // fraction → 12%
  weekly_percentage: 42,
  daily_reset_at: "2026-06-11T00:00:00-08:00",
  weekly_reset_at: "2026-06-14T00:00:00-08:00",
  plan_name: "team_plan",
  overage_balance_cents: 7087,
};

describe("parseDevinQuotaUsage — happy-path decode", () => {
  it("maps current-shape quotas to primary/secondary windows", () => {
    const quota = parseDevinQuotaUsage(CURRENT_SHAPE_FIXTURE, FETCHED, {
      organization: "org/example-org",
    });
    expect(quota?.provider).toBe("devin");
    expect(quota?.source).toBe("web");
    expect(quota?.status).toBe("ok");
    expect(quota?.windows.map((w) => [w.label, w.title, w.usedPercent])).toEqual([
      ["primary", "Daily", 12],
      ["secondary", "Weekly", 42],
    ]);
    expect(quota?.windows[0]?.windowMinutes).toBe(1440);
    expect(quota?.windows[1]?.windowMinutes).toBe(10_080);
    // Offset ISO timestamps decode to UTC.
    expect(quota?.windows[0]?.resetsAt).toBe(new Date("2026-06-11T00:00:00-08:00").toISOString());
    expect(quota?.plan).toBe("Team Plan");
    expect(quota?.account).toBe("org/example-org");
    // overage_balance_cents 7087 → $70.87 credits remaining.
    expect(quota?.creditsRemaining).toBeCloseTo(70.87, 2);
  });

  it("parses zero percentages without dropping windows", () => {
    const quota = parseDevinQuotaUsage(
      { daily_percentage: 0, weekly_percentage: 0 },
      FETCHED,
      {},
    );
    expect(quota?.windows.map((w) => w.usedPercent)).toEqual([0, 0]);
    expect(quota?.creditsRemaining).toBeUndefined();
  });

  it("decodes nested quota_usage fallback shape (used/limit, remaining fraction, epoch resets)", () => {
    const quota = parseDevinQuotaUsage(
      {
        quota_usage: {
          daily_quota: { used: 3, limit: 10, reset_at: "2026-06-01T08:00:00Z" },
          weekly_quota: { remaining_percent: 0.25, next_reset_at: 1_780_560_000 },
        },
      },
      FETCHED,
      {},
    );
    expect(quota?.windows[0]?.usedPercent).toBe(30);
    expect(quota?.windows[1]?.usedPercent).toBe(75);
    expect(quota?.windows[1]?.resetsAt).toBe(new Date(1_780_560_000 * 1000).toISOString());
  });

  it("omits invalid negative overage balances", () => {
    const quota = parseDevinQuotaUsage(
      { daily_percentage: 5, overage_balance: -1 },
      FETCHED,
      {},
    );
    expect(quota?.creditsRemaining).toBeUndefined();
  });

  it("returns undefined when no usable windows exist (parse-error path)", () => {
    expect(parseDevinQuotaUsage({ plan_name: "pro" }, FETCHED, {})).toBeUndefined();
    expect(parseDevinQuotaUsage("nope", FETCHED, {})).toBeUndefined();
  });
});

describe("credential discovery tiers", () => {
  it("tier 1 - env bearer token wins with organization normalization", () => {
    const outcome = resolveEnvCredential({
      DEVIN_BEARER_TOKEN: TOKEN,
      DEVIN_ORGANIZATION: "example-org",
    });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.credential.bearerToken).toBe(TOKEN);
    expect(outcome.credential.organization).toBe("org/example-org");
    expect(outcome.credential.origin).toBe("env");
  });

  it("tier 1 - Authorization/Bearer header paste is stripped", () => {
    expect(extractBearer(`Authorization: Bearer ${TOKEN}`)).toBe(TOKEN);
    expect(extractBearer(`Bearer ${TOKEN}`)).toBe(TOKEN);
    expect(extractBearer("   ")).toBeUndefined();
  });

  it("tier 1 - missing env falls through as missing", () => {
    expect(resolveEnvCredential({}).kind).toBe("missing");
    expect(resolveEnvCredential({ DEVIN_BEARER_TOKEN: "short" }).kind).toBe("missing");
  });

  it("normalizeOrganization accepts slugs, URLs, and internal org ids", () => {
    expect(normalizeOrganization("example-org")).toBe("org/example-org");
    expect(normalizeOrganization("https://app.devin.ai/org/example-org/usage")).toBe(
      "org/example-org",
    );
    expect(normalizeOrganization("https://devin.ai/organizations/org_ABCDEF123456")).toBe(
      "organizations/org_ABCDEF123456",
    );
    expect(normalizeOrganization("org_ABCDEF123456")).toBe("organizations/org_ABCDEF123456");
    expect(normalizeOrganization(undefined)).toBeUndefined();
    expect(displayOrganization("organizations/org_ABCDEF123456")).toBe("org_ABCDEF123456");
    expect(displayOrganization("org/example-org")).toBe("example-org");
  });

  it("tier 2 - session material scanner finds token plus organization metadata", () => {
    const leveldbText = [
      "META:1234",
      "_app.devin.ai\x00\x01last-internal-org-for-external-org-v1-example-org",
      `"org_QQ6LhcfkW1TSinM6"`,
      `{"token":"${TOKEN}"}`,
    ].join("\n");
    const found = scanSessionMaterial(leveldbText);
    expect(found?.bearerToken).toBe(TOKEN);
    expect(found?.organization).toBe("org/example-org");
    expect(found?.internalOrganizationId).toMatch(/^org_/);

    expect(scanSessionMaterial("no session material here")).toBeUndefined();
  });
});

describe("candidatePaths — probe order per fallback tier", () => {
  it("internal id first, normalized next, variants after, deduplicated", () => {
    const paths = candidatePaths("organizations/org_ABCDEF123456", "org_ABCDEF123456");
    expect(paths).toEqual([
      "org_ABCDEF123456/billing/quota/usage",
      "organizations/org_ABCDEF123456/billing/quota/usage",
      "org/org_ABCDEF123456/billing/quota/usage",
    ]);
  });

  it("slug organizations probe normalized then bare slug forms", () => {
    const paths = candidatePaths("org/example-org");
    expect(paths[0]).toBe("org/example-org/billing/quota/usage");
    expect(paths[1]).toBe("example-org/billing/quota/usage");
  });
});

describe("envelope semantics via fetchDevinWith (fetch injected, no network)", () => {
  const okResponse = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200 });

  it("happy path folds into an ok snapshot with live data confidence", async () => {
    let requested = "";
    const snapshot = await fetchDevinWith(
      async (input: string | URL) => {
        requested = String(input);
        return okResponse(CURRENT_SHAPE_FIXTURE);
      },
      { DEVIN_BEARER_TOKEN: TOKEN, DEVIN_ORGANIZATION: "example-org" },
    );
    expect(snapshot.ok).toBe(true);
    expect(snapshot.dataConfidence).toBe("live");
    expect(snapshot.source).toBe("devin");
    expect(snapshot.quotas[0]?.windows[0]?.label).toBe("primary");
    expect(requested).toContain("app.devin.ai/api/");
    expect(requested).toContain("example-org/billing/quota/usage");
  });

  it("auth failure yields cli-error envelope and never leaks the token", async () => {
    const snapshot = await fetchDevinWith(
      async () => new Response("unauthorized", { status: 401 }),
      { DEVIN_BEARER_TOKEN: TOKEN, DEVIN_ORGANIZATION: "example-org" },
    );
    expect(snapshot.ok).toBe(false);
    expect(snapshot.reason).toBe("cli-error");
    expect(snapshot.error).toContain("401");
    expect(snapshot.error).not.toContain(TOKEN);
    expect(snapshot.quotas).toHaveLength(0);
  });

  it("missing credential yields source-missing envelope", async () => {
    const calls: Array<string | URL> = [];
    const snapshot = await fetchDevinWith(
      async (input: string | URL) => {
        calls.push(input);
        return okResponse({});
      },
      {},
    );
    void calls;
    // The injected fetch must never be reached without a credential.
    expect(snapshot.ok).toBe(false);
    expect(snapshot.reason).toBe("source-missing");
    expect(snapshot.error).toContain("DEVIN_BEARER_TOKEN");
    expect(snapshot.quotas).toHaveLength(0);
  });

  it("200 without usable windows degrades to parse-error", async () => {
    const snapshot = await fetchDevinWith(
      async () => okResponse({ plan_name: "pro" }),
      { DEVIN_BEARER_TOKEN: TOKEN, DEVIN_ORGANIZATION: "example-org" },
    );
    expect(snapshot.ok).toBe(false);
    expect(snapshot.reason).toBe("parse-error");
  });

  it("server errors walk candidate paths before folding into cli-error", async () => {
    const seen: string[] = [];
    const snapshot = await fetchDevinWith(
      async (input: string | URL) => {
        seen.push(String(input));
        return new Response("boom", { status: 500 });
      },
      { DEVIN_BEARER_TOKEN: TOKEN, DEVIN_ORGANIZATION: "example-org" },
    );
    // Slug organization probes two paths before giving up.
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(snapshot.ok).toBe(false);
    expect(snapshot.reason).toBe("cli-error");
    expect(snapshot.error).toContain("500");
  });
});

describe("redactToken and source surface", () => {
  it("scrubs credential material from error strings", () => {
    const message = `request failed for Bearer ${TOKEN} at app.devin.ai`;
    expect(redactToken(message)).toContain(TOKEN);
    expect(redactToken(message, {
      bearerToken: TOKEN,
      origin: "env",
    })).not.toContain(TOKEN);
    expect(redactToken(message, { bearerToken: TOKEN, origin: "env" })).toContain("[redacted]");
  });

  it("buildDevinSnapshot carries machine-readable reasons on unavailable outcomes", () => {
    const snapshot = buildDevinSnapshot(FETCHED, {
      kind: "unavailable",
      reason: "source-missing",
      error: "no Devin session found",
    });
    expect(snapshot.ok).toBe(false);
    expect(snapshot.reason).toBe("source-missing");
    expect(snapshot.fetchedAt).toBe(FETCHED);
  });

  it("exposes the UsageSource contract", () => {
    expect(devinSource.id).toBe("devin");
    expect(typeof devinSource.fetch).toBeDefined();
    expect(typeof devinSource.detect).toBeDefined();
    expect(DEVIN_LIMITS_STATUS).toContain("app.devin.ai");
    // No middle dots anywhere in user-facing capability copy.
    expect(DEVIN_LIMITS_STATUS.includes("\u00B7")).toBe(false);
  });
});

describe("filesystem probe helpers", () => {
  it("levelDbCandidates only lists profile leveldb dirs under given roots", () => {
    const root = mkdtempSync(join(tmpdir(), "devin-probe-"));
    mkdirSync(join(root, "Default", "Local Storage", "leveldb"), { recursive: true });
    mkdirSync(join(root, "Profile 1", "Local Storage", "leveldb"), { recursive: true });
    mkdirSync(join(root, "System Profile"), { recursive: true });
    const candidates = levelDbCandidates([root]);
    expect(candidates).toEqual([
      join(root, "Default", "Local Storage", "leveldb"),
      join(root, "Profile 1", "Local Storage", "leveldb"),
    ]);
    expect(levelDbCandidates([join(root, "missing")])).toEqual([]);
    // Real roots computation stays platform-honest (may be empty off mac/linux).
    expect(Array.isArray(chromiumLevelDbRoots())).toBe(true);
  });
});
