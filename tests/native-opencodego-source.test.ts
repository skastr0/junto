import { describe, expect, it } from "vitest";
import {
  aggregateLocalRows,
  assembleGoSnapshot,
  buildLocalQuota,
  parseSqliteRows,
  parseZenUsage,
  redactSecrets,
  resolveGoApiKey,
  ZEN_PLAN_LIMITS_USD,
  type GoCostRow,
} from "../src/main/vellum/usage/opencodego-source";

const FETCHED = "2026-07-26T12:00:00.000Z";
const FETCHED_MS = Date.parse(FETCHED);
const SECRET = "oc_zen_super_secret_key_1234567890";

// zen/go/v1/usage response shape: nested usage dict with
// rolling/weekly/monthly groups carrying tolerant percent + reset keys.
const ZEN_FIXTURE = {
  data: {
    plan: "zen",
    renewAt: "2026-08-01T00:00:00.000Z",
    usage: {
      rollingUsage: { usagePercent: 42.5, resetInSec: 3600 },
      weeklyUsage: { usedPercent: 10, reset_at: "2026-07-27T00:00:00.000Z" },
      monthlyUsage: { percent: 0.25 }, // fraction heuristic → 25
    },
  },
};

describe("parseZenUsage — happy-path decode", () => {
  it("maps rolling / weekly / monthly groups into labeled windows", () => {
    const quota = parseZenUsage(ZEN_FIXTURE, FETCHED);
    expect(quota?.provider).toBe("opencode-go");
    expect(quota?.source).toBe("zen-api");
    expect(quota?.status).toBe("ok");
    expect(quota?.windows.map((w) => [w.label, w.title, w.usedPercent])).toEqual([
      ["primary", "5-hour", 42.5],
      ["secondary", "Weekly", 10],
      ["tertiary", "Monthly", 25],
      ["extra", "Renews", 0],
    ]);
    expect(quota?.windows[0]?.windowMinutes).toBe(300);
    expect(quota?.windows[0]?.resetsAt).toBe("2026-07-26T13:00:00.000Z");
    expect(quota?.windows[1]?.windowMinutes).toBe(10_080);
    expect(quota?.windows[1]?.resetDescription).toContain("2026-07-27T00:00:00.000Z");
    // renewal extra window from renewAt
    const renewal = quota?.windows.find((w) => w.label === "extra");
    expect(renewal?.id).toBe("renewal");
    expect(renewal?.title).toBe("Renews");
    expect(renewal?.resetsAt).toBe("2026-08-01T00:00:00.000Z");
  });

  it("derives percent from used/limit when no direct field exists and converts epoch resets", () => {
    const quota = parseZenUsage(
      {
        rollingUsage: { used: 3, limit: 12, resetAt: 1_785_093_600 }, // 2026-07-26T19:20:00Z (epoch seconds)
      },
      FETCHED,
    );
    expect(quota?.windows[0]?.usedPercent).toBe(25);
    expect(quota?.windows[0]?.resetsAt).toBe("2026-07-26T19:20:00.000Z");
  });

  it("returns undefined without a usable rolling group", () => {
    expect(parseZenUsage({ weeklyUsage: { usagePercent: 5 } }, FETCHED)).toBeUndefined();
    expect(parseZenUsage({ rollingUsage: { resetInSec: 60 } }, FETCHED)).toBeUndefined();
    expect(parseZenUsage("nope", FETCHED)).toBeUndefined();
  });
});

describe("parseSqliteRows — sqlite3 -json output decode", () => {
  it("parses rows and skips malformed entries", () => {
    const stdout = JSON.stringify([
      { createdMs: 1_785_078_000_000, cost: 1.25, requestCount: 1, modelID: "claude-sonnet-4-5" },
      { createdMs: 900_000_000, cost: 2, modelID: "gpt-x" }, // seconds → normalized to ms
      { createdMs: -5, cost: 1, modelID: "" }, // dropped
      { createdMs: 1_000, cost: null, modelID: "" }, // dropped
      { broken: true },
    ]);
    const rows = parseSqliteRows(stdout);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ createdMs: 1_785_078_000_000, cost: 1.25, model: "claude-sonnet-4-5" });
    expect(rows[1]!.createdMs).toBe(900_000_000_000);
    expect(rows[1]!.model).toBe("gpt-x");
  });

  it("returns empty for non-array output", () => {
    expect(parseSqliteRows("not json")).toEqual([]);
  });
});

describe("aggregateLocalRows + buildLocalQuota — derived local tier", () => {
  const nowMs = Date.UTC(2026, 6, 26, 12, 0, 0); // Sunday
  const rows: GoCostRow[] = [
    { createdMs: nowMs - 30 * 60 * 1000, cost: 4, model: "qwen3-coder" }, // in session + week + month
    { createdMs: nowMs - 40 * 60 * 60 * 1000, cost: 6, model: "gpt-5.3-codex" }, // week only
    { createdMs: nowMs - 20 * 24 * 60 * 60 * 1000, cost: 30, model: "qwen3-coder" }, // month only
    { createdMs: nowMs - 90 * 24 * 60 * 60 * 1000, cost: 999, model: "old" }, // outside everything
  ];

  it("aggregates session / weekly / monthly spend with daily buckets", () => {
    const agg = aggregateLocalRows(rows, nowMs);
    expect(agg.sessionCost).toBeCloseTo(4);
    expect(agg.weeklyCost).toBeCloseTo(10);
    expect(agg.monthlyCost).toBeCloseTo(40);
    expect(agg.oldestSessionMs).toBe(nowMs - 30 * 60 * 1000);
    expect(agg.daily.length).toBeGreaterThan(0);
  });

  it("builds honest derived windows against the documented Zen caps", () => {
    const agg = aggregateLocalRows(rows, nowMs);
    const quota = buildLocalQuota(agg, nowMs, FETCHED)!;
    expect(quota.provider).toBe("opencode-go");
    expect(quota.source).toBe("local-file");
    expect(quota.windows.map((w) => [w.label, w.usedPercent])).toEqual([
      ["primary", Math.round((4 / ZEN_PLAN_LIMITS_USD.session) * 1000) / 10],
      ["secondary", Math.round((10 / ZEN_PLAN_LIMITS_USD.weekly) * 1000) / 10],
      ["tertiary", Math.round((40 / ZEN_PLAN_LIMITS_USD.monthly) * 1000) / 10],
    ]);
    // Session reset derives from the oldest in-window row.
    expect(quota.windows[0]?.resetsAt).toBeDefined();
    expect(quota.extras?.partial).toBe(true);
    expect(String(quota.extras?.note)).toContain("derived");
  });

  it("returns undefined with no rows at all", () => {
    expect(buildLocalQuota(aggregateLocalRows([], nowMs), nowMs, FETCHED)).toBeUndefined();
  });
});

describe("resolveGoApiKey — credential resolution", () => {
  it("prefers OPENCODE_API_KEY and strips wrapping quotes", () => {
    expect(resolveGoApiKey({ OPENCODE_API_KEY: '  "oc_key_quoted_value_x"  ' })).toBe("oc_key_quoted_value_x");
    expect(resolveGoApiKey({ OPENCODE_API_KEY: "oc_plain_value_123456" })).toBe("oc_plain_value_123456");
    expect(resolveGoApiKey({ OPENCODE_API_KEY: "" })).toBeUndefined();
  });

  it("reads the opencode CLI auth.json entry when env is absent", async () => {
    const os = await import("node:os");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ocgo-test-"));
    fs.mkdirSync(path.join(home, ".local", "share", "opencode"), { recursive: true });
    const authPath = path.join(home, ".local", "share", "opencode", "auth.json");
    fs.writeFileSync(authPath, JSON.stringify({ "opencode-go": { type: "api", key: SECRET } }));
    expect(resolveGoApiKey({}, path.join(home, ".local", "share", "opencode"))).toBe(SECRET);
    // Garbage file degrades to undefined.
    fs.writeFileSync(authPath, "{broken");
    expect(resolveGoApiKey({}, path.join(home, ".local", "share", "opencode"))).toBeUndefined();
  });
});

describe("assembleGoSnapshot — tier fold + envelope semantics", () => {
  const apiOk = parseZenUsage(ZEN_FIXTURE, FETCHED)!;
  const localAgg = aggregateLocalRows(
    [{ createdMs: FETCHED_MS - 60_000, cost: 2, model: "m" }],
    FETCHED_MS,
  );
  const localOk = buildLocalQuota(localAgg, FETCHED_MS, FETCHED)!;

  it("live API wins over local; local daily buckets ride along in extras", () => {
    const snapshot = assembleGoSnapshot({ kind: "ok", quota: apiOk }, { kind: "ok", quota: localOk }, FETCHED);
    expect(snapshot.ok).toBe(true);
    expect(snapshot.dataConfidence).toBe("live");
    expect(snapshot.quotas[0]!.source).toBe("zen-api");
    expect(Array.isArray(snapshot.quotas[0]!.extras?.localDaily)).toBe(true);
  });

  it("falls back to the derived local tier when the API is skipped or rejected", () => {
    for (const api of [{ kind: "skipped" }, { kind: "unauthorized", status: 401 }] as const) {
      const snapshot = assembleGoSnapshot(api, { kind: "ok", quota: localOk }, FETCHED);
      expect(snapshot.ok).toBe(true);
      expect(snapshot.dataConfidence).toBe("derived");
      expect(snapshot.quotas[0]!.source).toBe("local-file");
    }
  });

  it("auth failure folds into cli-error naming re-auth, never throwing", () => {
    const snapshot = assembleGoSnapshot(
      { kind: "unauthorized", status: 403 },
      { kind: "source-missing", error: "opencode.db not found" },
      FETCHED,
    );
    expect(snapshot.ok).toBe(false);
    expect(snapshot.reason).toBe("cli-error");
    expect(snapshot.error).toContain("re-authenticate OpenCode Go");
    expect(snapshot.quotas).toEqual([]);
  });

  it("redacts the API key from every surfaced error string", () => {
    expect(redactSecrets(`HTTP 401 for key ${SECRET}`, [SECRET])).not.toContain(SECRET);
    expect(redactSecrets(`HTTP 401 for key ${SECRET}`, [SECRET])).toContain("[redacted]");
    const snapshot = assembleGoSnapshot(
      { kind: "failed", error: `request failed with Authorization: Bearer ${SECRET}` },
      { kind: "source-missing", error: "db missing" },
      FETCHED,
      [SECRET],
    );
    expect(JSON.stringify(snapshot)).not.toContain(SECRET);
  });

  it("missing credentials and database degrade to source-missing", () => {
    const snapshot = assembleGoSnapshot({ kind: "skipped" }, { kind: "source-missing", error: "~/.local/share/opencode/opencode.db not found - use OpenCode Go locally first" }, FETCHED);
    expect(snapshot.ok).toBe(false);
    expect(snapshot.reason).toBe("source-missing");
    expect(snapshot.error).toContain("use OpenCode Go locally first");
    expect(snapshot.quotas).toEqual([]);
  });

  it("local parse errors surface as parse-error envelopes", () => {
    const snapshot = assembleGoSnapshot({ kind: "skipped" }, { kind: "parse-error", error: "sqlite json unreadable" }, FETCHED);
    expect(snapshot.ok).toBe(false);
    expect(snapshot.reason).toBe("parse-error");
  });
});
