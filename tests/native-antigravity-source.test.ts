import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assignPoolLabels,
  buildAntigravitySnapshot,
  classifyAntigravityProcess,
  countOfflineConversations,
  decodeCommandModelConfigs,
  decodeQuotaSummary,
  decodeUserStatus,
  endpointsForPorts,
  extractFlagValue,
  parseAntigravityProcesses,
  parseListeningPorts,
  parseResetTime,
  probeEndpoints,
  quotaBucketKind,
  quotaFromModelQuotas,
  redactSecrets,
  resolveProcessCsrfToken,
  windowsFromQuotaSummary,
  type LocalEndpoint,
} from "../src/main/vellum-command/usage/antigravity-source";

const FETCHED = "2026-08-24T12:00:00.000Z";

// RetrieveUserQuotaSummary response shape: payload under
// `response`, buckets with direct remainingFraction or protobuf-oneof
// {case:"remainingFraction", value}, ISO8601 / epoch resetTime.
const QUOTA_SUMMARY_FIXTURE = {
  code: 0,
  response: {
    description: "Plan usage",
    groups: [
      {
        displayName: "Gemini 3 Pro",
        buckets: [
          {
            bucketId: "gemini-5h",
            displayName: "Gemini Pro 5-hour limit",
            remainingFraction: 0.42,
            resetTime: 1_785_078_000,
          },
          {
            bucketId: "gemini-weekly",
            displayName: "Gemini Pro weekly limit",
            remaining: { case: "remainingFraction", value: 0.9 },
            resetTime: "2026-08-31T00:00:00Z",
          },
        ],
      },
      {
        displayName: "Claude and GPT",
        buckets: [
          {
            bucketId: "3p-5h",
            displayName: "Claude 5-hour limit",
            remainingFraction: 0.05,
            disabled: false,
          },
        ],
      },
      {
        displayName: "Legacy group",
        buckets: [
          { bucketId: "unknown_bucket", displayName: "Unknown", disabled: true },
          { bucketId: "no_fraction", displayName: "No fraction" },
        ],
      },
    ],
  },
};

const USER_STATUS_IDENTITY_FIXTURE = {
  userStatus: {
    email: "dev@example.com",
    userTier: { name: "Ultra" },
    planStatus: { planInfo: { planName: "Pro" } },
  },
};

const endpoint: LocalEndpoint = {
  scheme: "http",
  port: 41_000,
  csrfToken: "",
  requiresCsrf: false,
};

describe("process + port discovery parsing", () => {
  it("classifies app, IDE and CLI language server command lines", () => {
    expect(classifyAntigravityProcess("/Applications/Antigravity.app/x/language_server_macos --app_data_dir antigravity")).toBe("app");
    expect(classifyAntigravityProcess("/ext/extensions/antigravity/bin/language_server --csrf_token abc")).toBe("ide");
    expect(classifyAntigravityProcess("/usr/local/bin/agy")).toBe("cli");
    expect(classifyAntigravityProcess("/usr/local/bin/antigravity-cli serve")).toBe("cli");
    expect(classifyAntigravityProcess("/Applications/Safari.app/Contents/MacOS/Safari")).toBeUndefined();
    // The renamed Gemini desktop app still classifies.
    expect(classifyAntigravityProcess("/Applications/Gemini.app/Contents/x/language_server --app_data_dir gemini")).toBe("app");
  });

  it("requires --csrf_token for desktop matches and allows tokenless CLI", () => {
    const cmd = "language_server --csrf_token s3cret-token-xyz";
    expect(resolveProcessCsrfToken("app", cmd)).toBe("s3cret-token-xyz");
    expect(resolveProcessCsrfToken("ide", "language_server --no-token")).toBeUndefined();
    expect(resolveProcessCsrfToken("cli", "/bin/agy")).toBe("");
  });

  it("extracts flags with space and equals forms", () => {
    expect(extractFlagValue("--csrf_token", "srv --csrf_token tok123")).toBe("tok123");
    expect(extractFlagValue("--extension_server_port", "srv --extension_server_port=51000")).toBe("51000");
    expect(extractFlagValue("--missing", "srv x")).toBeUndefined();
  });

  it("parses ps output into candidates, ranking desktop ahead of CLI, skipping tokenless IDE", () => {
    const ps = [
      "  101 /usr/local/bin/agy serve",
      "  102 /Applications/Antigravity.app/C/language_server_macos --csrf_token desk-token-abcd",
      "  103 /ext/extensions/antigravity/bin/language_server --no-token-flag",
      "  not-a-pid line",
    ].join("\n");
    const infos = parseAntigravityProcesses(ps);
    expect(infos.map((i) => [i.pid, i.kind])).toEqual([
      [102, "app"],
      [101, "cli"],
    ]);
  });

  it("parses lsof LISTEN ports sorted", () => {
    const out = `
com.apple 42001 user   12u  IPv4 0xtt      0t0  TCP 127.0.0.1:51000 (LISTEN)
com.apple 42001 user   13u  IPv4 0xuu      0t0  TCP 127.0.0.1:24000 (LISTEN)
com.apple 42001 user   14u  IPv4 0xvv      0t0  TCP *:* (CLOSED)`;
    expect(parseListeningPorts(out)).toEqual([24_000, 51_000]);
  });
});

describe("reset time + bucket cadence", () => {
  it("accepts epoch seconds, epoch millis, numeric strings and ISO8601", () => {
    expect(parseResetTime(1_785_078_000)).toBe("2026-07-26T15:00:00.000Z");
    expect(parseResetTime(1_785_078_000_000)).toBe("2026-07-26T15:00:00.000Z");
    expect(parseResetTime("1785078000")).toBe("2026-07-26T15:00:00.000Z");
    expect(parseResetTime("2026-08-31T00:00:00Z")).toBe("2026-08-31T00:00:00.000Z");
    expect(parseResetTime("garbage")).toBeUndefined();
    expect(parseResetTime(undefined)).toBeUndefined();
  });

  it("maps 5-hour and weekly cadence aliases", () => {
    expect(quotaBucketKind("gemini-5h")).toBe("session");
    expect(quotaBucketKind("gemini_session")).toBe("session");
    expect(quotaBucketKind("3p-5h")).toBe("session");
    expect(quotaBucketKind("claude-5h limit")).toBe("session");
    expect(quotaBucketKind("gemini-weekly")).toBe("weekly");
    expect(quotaBucketKind("3p-weekly")).toBe("weekly");
    expect(quotaBucketKind("misc_bucket", "Some Other Thing")).toBe("other");
  });
});

describe("decodeQuotaSummary", () => {
  it("decodes happy-path groups and buckets including the oneof remaining form", () => {
    const decoded = decodeQuotaSummary(QUOTA_SUMMARY_FIXTURE);
    expect(decoded).toBeDefined();
    expect(decoded?.groups).toHaveLength(3);
    const gemini = decoded?.groups[0];
    expect(gemini?.buckets[0]?.remainingFraction).toBe(0.42);
    expect(gemini?.buckets[1]?.remainingFraction).toBe(0.9); // oneof decode
    expect(gemini?.buckets[1]?.resetTime).toBe("2026-08-31T00:00:00.000Z");
  });

  it("rejects non-ok codes and empty payloads", () => {
    expect(decodeQuotaSummary({ code: 7, message: "denied" })).toBeUndefined();
    expect(decodeQuotaSummary({ code: 0, response: { groups: [] } })).toBeUndefined();
    expect(decodeQuotaSummary(null)).toBeUndefined();
  });

  it("builds extra windows with ids, titles, windowMinutes and skips unknown fractions", () => {
    const decoded = decodeQuotaSummary(QUOTA_SUMMARY_FIXTURE);
    const windows = decoded === undefined ? [] : windowsFromQuotaSummary(decoded);
    expect(windows.map((w) => [w.id, w.title, w.usedPercent, w.label])).toEqual([
      ["antigravity-quota-summary-gemini-5h", "Gemini 5-hour", 58, "extra"],
      ["antigravity-quota-summary-gemini-weekly", "Gemini weekly", 10, "extra"],
      ["antigravity-quota-summary-3p-5h", "Claude/GPT 5-hour", 95, "extra"],
    ]);
    expect(windows[0]?.windowMinutes).toBe(300);
    expect(windows[1]?.windowMinutes).toBe(10080);
    expect(windows[0]?.resetsAt).toBe("2026-07-26T15:00:00.000Z");
  });

  it("promotes worst Gemini to primary and worst Claude/GPT to secondary", () => {
    const decoded = decodeQuotaSummary(QUOTA_SUMMARY_FIXTURE);
    const labeled = assignPoolLabels(windowsFromQuotaSummary(decoded!));
    const byLabel = (label: string) => labeled.find((w) => w.label === label);
    // Worst Gemini (session, 58% used) becomes primary; worst Claude/GPT
    // (95% used) becomes secondary.
    expect(byLabel("primary")?.id).toBe("antigravity-quota-summary-gemini-5h");
    expect(byLabel("secondary")?.id).toBe("antigravity-quota-summary-3p-5h");
  });
});

describe("decodeUserStatus / legacy model quotas", () => {
  it("extracts email, tier-preferred plan and cascade model quotas", () => {
    const status = decodeUserStatus({
      userStatus: {
        email: "dev@example.com",
        userTier: { name: "Ultra" },
        planStatus: { planInfo: { planName: "Pro" } }, // mislabels Ultra as Pro; tier wins
        cascadeModelConfigData: {
          clientModelConfigs: [
            { label: "Claude Sonnet", modelOrAlias: { model: "claude-sonnet-4" }, quotaInfo: { remainingFraction: 0.2, resetTime: 1_785_078_000 } },
            { label: "Gemini Pro", modelOrAlias: { model: "gemini-3-pro-high" }, quotaInfo: { remainingFraction: 0.6 } },
            { label: "GPT", modelOrAlias: { model: "gpt-oss" }, quotaInfo: { remainingFraction: 0.8 } },
            { broken: true },
          ],
        },
      },
    });
    expect(status?.email).toBe("dev@example.com");
    expect(status?.plan).toBe("Ultra");
    expect(status?.modelQuotas).toHaveLength(3);
  });

  it("pools most-constrained Gemini as primary and Claude/GPT as secondary", () => {
    const rows = [
      { model: "gemini-3-flash", label: "Gemini Flash", remainingFraction: 0.7 },
      { model: "gemini-3-pro", label: "Gemini Pro", remainingFraction: 0.3 },
      { model: "claude-sonnet-4", label: "Claude Sonnet", remainingFraction: 0.2 },
      { model: "gpt-oss", label: "GPT", remainingFraction: 0.55 },
    ];
    const quota = quotaFromModelQuotas(rows, FETCHED, "local-server", { email: "dev@example.com", plan: "Ultra" });
    expect(quota?.windows.map((w) => [w.label, w.usedPercent])).toEqual([
      ["primary", 70],
      ["secondary", 80],
      ["extra", 30],
      ["extra", 70],
      ["extra", 80],
      ["extra", 45],
    ]);
    expect(quota?.account).toBe("dev@example.com");
    expect(quota?.plan).toBe("Ultra");
  });

  it("decodes GetCommandModelConfigs fallback shape", () => {
    const rows = decodeCommandModelConfigs({
      clientModelConfigs: [
        { label: "Gemini Pro", modelOrAlias: { model: "gemini-3-pro" }, quotaInfo: { remainingFraction: 0.4 } },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows?.[0]?.model).toBe("gemini-3-pro");
    expect(decodeCommandModelConfigs({ clientModelConfigs: [] })).toBeUndefined();
  });
});

describe("probeEndpoints fallback tiers", () => {
  it("tier 1 happy path: quota summary paints bars and merges identity best-effort", async () => {
    const calls: string[] = [];
    const send = async (_e: LocalEndpoint, path: string) => {
      calls.push(path);
      if (path.endsWith("RetrieveUserQuotaSummary")) return QUOTA_SUMMARY_FIXTURE;
      if (path.endsWith("GetUserStatus")) return USER_STATUS_IDENTITY_FIXTURE;
      throw new Error(`unexpected ${path}`);
    };
    const outcome = await probeEndpoints(send, [endpoint], FETCHED, "local-server");
    if (outcome.kind !== "ok") throw new Error(outcome.error);
    expect(calls).toEqual([
      "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary",
      "/exa.language_server_pb.LanguageServerService/GetUserStatus",
    ]);
    expect(outcome.quota.account).toBe("dev@example.com");
    expect(outcome.quota.plan).toBe("Ultra");
    expect(outcome.quota.extras).toMatchObject({ capability: "quota-summary" });
  });

  it("falls back to GetUserStatus model quotas when quota summary fails", async () => {
    const send = async (_e: LocalEndpoint, path: string) => {
      if (path.endsWith("RetrieveUserQuotaSummary")) throw new Error("HTTP 404");
      if (path.endsWith("GetUserStatus"))
        return {
          userStatus: {
            cascadeModelConfigData: {
              clientModelConfigs: [
                { label: "Gemini Pro", modelOrAlias: { model: "gemini-3-pro" }, quotaInfo: { remainingFraction: 0.25 } },
              ],
            },
          },
        };
      throw new Error(`unexpected ${path}`);
    };
    const outcome = await probeEndpoints(send, [endpoint], FETCHED, "cli");
    if (outcome.kind !== "ok") throw new Error(outcome.error);
    expect(outcome.quota.source).toBe("cli");
    expect(outcome.quota.windows[0]?.label).toBe("primary");
  });

  it("falls back to GetCommandModelConfigs when both earlier tiers fail", async () => {
    const send = async (_e: LocalEndpoint, path: string) => {
      if (path.endsWith("GetCommandModelConfigs"))
        return {
          clientModelConfigs: [
            { label: "Claude", modelOrAlias: { model: "claude-opus-4" }, quotaInfo: { remainingFraction: 0.15 } },
          ],
        };
      throw new Error("HTTP 500");
    };
    const outcome = await probeEndpoints(send, [endpoint], FETCHED, "cli");
    if (outcome.kind !== "ok") throw new Error(outcome.error);
    expect(outcome.quota.windows[0]).toMatchObject({ label: "secondary", usedPercent: 85 });
  });

  it("folds every-endpoint failure into an error outcome naming the last failure", async () => {
    const send = async () => {
      throw new Error("HTTP 500: upstream exploded");
    };
    const outcome = await probeEndpoints(send, [endpoint], FETCHED, "cli");
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") expect(outcome.error).toContain("HTTP 500");
  });

  it("auth-flavored HTTP failures surface in the last error without leaking tokens", async () => {
    const secret = "csrf-super-secret-value-99";
    const authedEndpoint: LocalEndpoint = {
      scheme: "https",
      port: 41_001,
      csrfToken: secret,
      requiresCsrf: true,
    };
    const seenHeaders: Array<Record<string, string>> = [];
    const send = async () => {
      throw new Error(`HTTP 401: rejected token ${secret}`);
    };
    void seenHeaders;
    const outcome = await probeEndpoints(send, [authedEndpoint], FETCHED, "local-server");
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(redactSecrets(outcome.error, [secret])).not.toContain(secret);
      expect(redactSecrets(outcome.error, [secret])).toContain("***");
    }
  });

  it("empty endpoint list errors immediately", async () => {
    const outcome = await probeEndpoints(async () => ({}), [], FETCHED, "cli");
    expect(outcome.kind).toBe("error");
  });
});

describe("redaction", () => {
  it("replaces secrets but leaves short harmless strings alone", () => {
    const secret = "long-csrf-token-value-abcdef";
    expect(redactSecrets(`probe failed near token ${secret}`, [secret])).toBe(
      "probe failed near token ***",
    );
    expect(redactSecrets("plain failure", [])).toBe("plain failure");
    expect(redactSecrets("abc and abc again", ["abc"])).toBe("abc and abc again"); // too short to touch
  });
});

describe("offline conversation fallback", () => {
  it("counts .db files under antigravity-cli/conversations only as an extras signal", () => {
    const home = mkdtempSync(join(tmpdir(), "vellum-agy-"));
    try {
      const conv = join(home, ".gemini", "antigravity-cli", "conversations");
      mkdirSync(conv, { recursive: true });
      writeFileSync(join(conv, "one.db"), "");
      writeFileSync(join(conv, "two.db"), "");
      writeFileSync(join(conv, "notes.txt"), "");
      mkdirSync(join(home, ".gemini", "antigravity", "conversations"), { recursive: true });
      writeFileSync(join(home, ".gemini", "antigravity", "conversations", "three.db"), "");
      expect(countOfflineConversations(home, {})).toBe(3);
      expect(countOfflineConversations(home, { GEMINI_CLI_HOME: join(home, ".gemini") })).toBe(3);
      expect(countOfflineConversations(home, { GEMINI_CLI_HOME: join(home, "nowhere") })).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("envelope building", () => {
  it("ok envelopes carry dataConfidence live or derived honestly", () => {
    const live = buildAntigravitySnapshot(FETCHED, {
      kind: "ok",
      confidence: "live",
      quotas: [{ provider: "antigravity", source: "local-server", status: "ok", windows: [], updatedAt: FETCHED }],
    });
    expect(live.ok).toBe(true);
    expect(live.dataConfidence).toBe("live");
    const derived = buildAntigravitySnapshot(FETCHED, {
      kind: "ok",
      confidence: "derived",
      quotas: [{ provider: "antigravity", source: "local-file", status: "ok", windows: [], updatedAt: FETCHED }],
    });
    expect(derived.dataConfidence).toBe("derived");
  });

  it("unavailable envelopes fold failures with reasons and never carry fake confidence", () => {
    const missing = buildAntigravitySnapshot(FETCHED, {
      kind: "unavailable",
      reason: "source-missing",
      error: "no Antigravity language server running - open Antigravity or run the agy CLI to enable live quota reads",
    });
    expect(missing.ok).toBe(false);
    expect(missing.reason).toBe("source-missing");
    expect(missing.quotas).toEqual([]);
  });
});

describe("endpointsForPorts", () => {
  it("expands https then http candidates per port with CSRF policy", () => {
    const endpoints = endpointsForPorts([51_000], "token-xyz", true);
    expect(endpoints.map((e) => [e.scheme, e.port, e.requiresCsrf])).toEqual([
      ["https", 51_000, true],
      ["http", 51_000, true],
    ]);
    expect(endpoints[0]?.csrfToken).toBe("token-xyz");
  });
});
