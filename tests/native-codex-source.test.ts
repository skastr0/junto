import { describe, expect, it } from "vitest";
import {
  decodeCodexAuth,
  type CodexAuthOutcome,
} from "../src/main/vellum-command/usage/codex-auth";
import {
  buildCodexSnapshot,
  deriveWindowTitle,
  parseWhamUsage,
  type CodexOutcome,
} from "../src/main/vellum-command/usage/codex-source";

const FETCHED = "2026-07-26T12:00:00.000Z";

// wham/usage response shape: rate_limit windows with
// used_percent / reset_at epoch seconds / limit_window_seconds.
const WHAM_FIXTURE = {
  rate_limit: {
    primary_window: {
      used_percent: 42,
      reset_at: 1_785_078_000, // epoch seconds → 2026-07-26T15:00:00.000Z
      limit_window_seconds: 18_000, // 5h session lane
    },
    secondary_window: {
      used_percent: 77,
      reset_at: 1_785_594_400, // 2026-08-01T04:00:00.000Z
      limit_window_seconds: 604_800, // weekly lane
    },
    additional_rate_limits: [
      {
        limit_id: "codex-spark-weekly",
        used_percent: 12,
        reset_at: 1_785_594_400,
        limit_window_seconds: 604_800,
      },
      { broken: true },
    ],
    credits: { has_credits: true, balance: "31.5" },
    plan_type: "pro",
  },
};

describe("parseWhamUsage", () => {
  it("maps primary / secondary / additional_rate_limits into labeled windows", () => {
    const quota = parseWhamUsage(WHAM_FIXTURE, FETCHED);
    expect(quota?.provider).toBe("codex");
    expect(quota?.source).toBe("wham");
    expect(quota?.status).toBe("ok");
    expect(quota?.windows.map((w) => [w.label, w.usedPercent, w.title])).toEqual([
      ["primary", 42, "session"],
      ["secondary", 77, "weekly"],
      ["extra", 12, "weekly"],
    ]);
    expect(quota?.windows[0]?.windowMinutes).toBe(300);
    expect(quota?.windows[0]?.resetsAt).toBe("2026-07-26T15:00:00.000Z");
    expect(quota?.windows[2]?.id).toBe("codex-spark-weekly");
    // One malformed additional entry never drops its siblings (2 survive of 2 decodable).
    expect(quota?.windows).toHaveLength(3);
  });

  it("carries credits, plan and identity when present", () => {
    const quota = parseWhamUsage(WHAM_FIXTURE, FETCHED, {
      accountId: "acct-123",
      email: "ops@example.com",
    });
    expect(quota?.creditsRemaining).toBe(31.5);
    expect(quota?.plan).toBe("pro");
    expect(quota?.account).toBe("acct-123");
  });

  it("omits credits for unlimited plans", () => {
    const quota = parseWhamUsage(
      {
        rate_limit: {
          primary_window: { used_percent: 5, limit_window_seconds: 18_000 },
          credits: { unlimited: true },
        },
      },
      FETCHED,
    );
    expect(quota?.creditsRemaining).toBeUndefined();
  });

  it("returns undefined with no usable windows", () => {
    expect(parseWhamUsage({ rate_limit: {} }, FETCHED)).toBeUndefined();
    expect(parseWhamUsage("nope", FETCHED)).toBeUndefined();
  });
});

describe("deriveWindowTitle — lane table from limit_window_seconds", () => {
  it.each([
    [300, "session"], // 5m — anything up to ~6h folds into the session lane
    [1_800, "session"], // 30m
    [18_000, "session"], // 5h session lane
    [21_600, "session"], // exactly 6h boundary
    [86_400, "weekly"], // 1 day
    [604_800, "weekly"], // 7d weekly lane
    [1_209_600, "weekly"], // 14d boundary
    [2_592_000, "monthly"], // 30d monthly lane
    [31_536_000, "monthly"], // a year still folds into monthly
  ])("%is → %s", (seconds, expected) => {
    expect(deriveWindowTitle(seconds)).toBe(expected);
  });

  it("treats non-positive and non-finite as unknown lane", () => {
    expect(deriveWindowTitle(0)).toBe("");
    expect(deriveWindowTitle(-5)).toBe("");
    expect(deriveWindowTitle(Number.NaN)).toBe("");
  });
});

describe("buildCodexSnapshot — envelope semantics", () => {
  const ok: CodexOutcome = { kind: "ok", quotas: [] };

  it("401/403 outcome names Codex CLI re-login and never carries tokens", () => {
    const snapshot = buildCodexSnapshot(FETCHED, {
      kind: "unavailable",
      reason: "cli-error",
      error:
        "ChatGPT backend rejected credentials (401) — run codex CLI login to refresh authentication",
    });
    expect(snapshot.ok).toBe(false);
    expect(snapshot.reason).toBe("cli-error");
    expect(snapshot.error).toContain("codex CLI login");
    expect(snapshot.quotas).toEqual([]);
    expect(JSON.stringify(snapshot)).not.toMatch(/sk-|Bearer|access_token|refresh_token|id_token/i);
  });

  it("missing auth.json degrades to source-missing with honest copy", () => {
    const snapshot = buildCodexSnapshot(FETCHED, {
      kind: "unavailable",
      reason: "source-missing",
      error: "~/.codex/auth.json not found — run codex CLI login to enable live Codex usage",
    });
    expect(snapshot.ok).toBe(false);
    expect(snapshot.reason).toBe("source-missing");
    expect(snapshot.quotas).toEqual([]);
  });

  it("ok outcomes pass quotas through untouched", () => {
    const quota = parseWhamUsage(WHAM_FIXTURE, FETCHED)!;
    const snapshot = buildCodexSnapshot(FETCHED, { ...ok, quotas: [quota] });
    expect(snapshot.source).toBe("codex");
    expect(snapshot.ok).toBe(true);
    expect(snapshot.quotas).toHaveLength(1);
  });
});

describe("decodeCodexAuth — credential selection (read-only, never refreshed)", () => {
  it("prefers tokens.access_token over id_token and API key", () => {
    const outcome = decodeCodexAuth({
      OPENAI_API_KEY: "sk-pat-fallback-key-123456",
      tokens: {
        access_token: "eyJaccess".padEnd(24, "x"),
        id_token: "not-a-jwt-but-long-enough",
        account_id: "acct-flat",
      },
    }) as Extract<CodexAuthOutcome, { kind: "ok" }>;
    expect(outcome.kind).toBe("ok");
    expect(outcome.bearerToken.startsWith("eyJaccess")).toBe(true);
    expect(outcome.accountId).toBe("acct-flat");
  });

  it("falls back to OPENAI_API_KEY bearer", () => {
    const outcome = decodeCodexAuth({
      OPENAI_API_KEY: "sk-pat-fallback-key-123456",
    }) as Extract<CodexAuthOutcome, { kind: "ok" }>;
    expect(outcome.kind).toBe("ok");
    expect(outcome.bearerToken).toBe("sk-pat-fallback-key-123456");
  });

  it("derives account id + email from the id_token JWT claim", () => {
    const claims = Buffer.from(
      JSON.stringify({
        email: "ops@example.com",
        "https://api.openai.com/auth": { chat_account_id: "acct-from-jwt" },
      }),
    ).toString("base64url");
    const idToken = `abc.${claims}.sig`;
    const outcome = decodeCodexAuth({
      tokens: { access_token: `${idToken}-access`, id_token: idToken },
    }) as Extract<CodexAuthOutcome, { kind: "ok" }>;
    expect(outcome.kind).toBe("ok");
    expect(outcome.email).toBe("ops@example.com");
    expect(outcome.accountId).toBe("acct-from-jwt");
  });

  it("fails closed on empty or missing token fields", () => {
    expect(decodeCodexAuth({}).kind).toBe("invalid");
    expect(decodeCodexAuth({ tokens: { access_token: "" } }).kind).toBe("invalid");
    expect(decodeCodexAuth(null).kind).toBe("invalid");
  });
});
