import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildCodexbarSnapshot, parseCodexbarPayload } from "../src/main/vellum/usage/codexbar-source";

// Shaped like a live `codexbar usage --json` capture (12 enabled providers,
// 2026-07-17) with account identifiers sanitized to agent@example.dev /
// example-org, plus one zed-style error entry. Payload drift tolerance is the
// point of the parser, so the fixture stays faithful to the wire shape.
const FIXTURE: unknown = JSON.parse(
  readFileSync(new URL("./fixtures/codexbar-usage.json", import.meta.url), "utf8"),
);

const FETCHED_AT = "2026-07-17T07:10:00Z";

const parse = (payload: unknown) => parseCodexbarPayload(payload, FETCHED_AT);

describe("parseCodexbarPayload", () => {
  const quotas = parse(FIXTURE);
  const byProvider = new Map(quotas.map((quota) => [quota.provider, quota]));

  it("decodes every fixture entry (12 ok + 1 error)", () => {
    expect(quotas).toHaveLength(13);
    expect(quotas.filter((quota) => quota.status === "ok")).toHaveLength(12);
    expect(quotas.filter((quota) => quota.status === "error")).toHaveLength(1);
  });

  it("maps codex windows, pace, credits, account, and plan", () => {
    const codex = byProvider.get("codex");
    expect(codex?.status).toBe("ok");
    expect(codex?.account).toBe("agent@example.dev");
    expect(codex?.plan).toBe("pro");
    expect(codex?.creditsRemaining).toBe(0);

    const secondary = codex?.windows.find((window) => window.label === "secondary");
    expect(secondary?.usedPercent).toBe(0);
    expect(secondary?.windowMinutes).toBe(10080);
    // macOS locale formats the time with a narrow no-break space before AM.
    expect(secondary?.resetDescription).toMatch(/^Jul 23 at 7:01\sAM$/);
    expect(secondary?.pace?.stage).toBe("farBehind");
    expect(secondary?.pace?.deltaPercent).toBe(-13);
    expect(secondary?.pace?.expectedUsedPercent).toBe(13);
    expect(secondary?.pace?.willLastToReset).toBe(true);
    expect(secondary?.pace?.summary).toContain("13% in reserve");

    const extra = codex?.windows.find((window) => window.label === "extra");
    expect(extra?.id).toBe("codex-spark-weekly");
    expect(extra?.title).toBe("Codex Spark Weekly");
    expect(extra?.windowMinutes).toBe(10080);
  });

  it("maps claude session + weekly windows with per-window pace", () => {
    const claude = byProvider.get("claude");
    const primary = claude?.windows.find((window) => window.label === "primary");
    const secondary = claude?.windows.find((window) => window.label === "secondary");
    expect(primary?.usedPercent).toBe(6);
    expect(primary?.windowMinutes).toBe(300);
    expect(primary?.pace?.stage).toBe("behind");
    expect(secondary?.usedPercent).toBe(11);
    expect(secondary?.windowMinutes).toBe(10080);
    expect(secondary?.pace?.summary).toContain("37% in reserve");
    expect(claude?.windows.filter((window) => window.label === "extra").map((window) => window.id)).toEqual([
      "claude-routines",
      "claude-weekly-scoped-fable",
    ]);
    expect(claude?.plan).toBe("Claude Max 20x");
  });

  it("keeps tertiary windows when present (cursor)", () => {
    const cursor = byProvider.get("cursor");
    expect(cursor?.windows.map((window) => window.label)).toEqual(["primary", "secondary", "tertiary"]);
  });

  it("degrades error entries to status:error with the message preserved", () => {
    const zed = byProvider.get("zed");
    expect(zed?.status).toBe("error");
    expect(zed?.error).toBe("Zed credentials are invalid or expired. Sign in to Zed again.");
    expect(zed?.windows).toEqual([]);
    expect(zed?.updatedAt).toBe(FETCHED_AT);
  });

  it("passes provider extras through for the detail view", () => {
    expect(byProvider.get("codex")?.extras?.openaiDashboard).toBeDefined();
    expect(byProvider.get("codex")?.extras?.dataConfidence).toBe("exact");
  });

  it("tolerates malformed entries without dropping the fetch", () => {
    const result = parse([
      { source: "web" }, // no provider name -> skipped
      { provider: "broken", source: "web", usage: "not-an-object" },
      { provider: "partial", source: "cli", usage: { primary: { windowMinutes: 300 }, secondary: { usedPercent: 42 } } },
      "not-even-an-object",
    ]);
    expect(result).toHaveLength(2);
    const broken = result.find((quota) => quota.provider === "broken");
    expect(broken?.status).toBe("error");
    expect(broken?.error).toContain("no usage payload");
    const partial = result.find((quota) => quota.provider === "partial");
    expect(partial?.status).toBe("ok");
    // Window without usedPercent is dropped; the valid one is kept.
    expect(partial?.windows.map((window) => window.label)).toEqual(["secondary"]);
  });

  it("returns an empty list for non-array payloads", () => {
    expect(parse({ not: "an array" })).toEqual([]);
    expect(parse(null)).toEqual([]);
  });
});

describe("buildCodexbarSnapshot", () => {
  it("wraps a successful fetch in an ok envelope", () => {
    const quotas = parse(FIXTURE);
    const snapshot = buildCodexbarSnapshot(FETCHED_AT, { kind: "ok", quotas });
    expect(snapshot).toEqual({ source: "codexbar", fetchedAt: FETCHED_AT, ok: true, quotas });
  });

  it.each(["cli-missing", "cli-error", "parse-error"] as const)(
    "folds %s into an ok:false envelope with empty quotas",
    (reason) => {
      const snapshot = buildCodexbarSnapshot(FETCHED_AT, { kind: "unavailable", reason, error: "boom" });
      expect(snapshot).toEqual({
        source: "codexbar",
        fetchedAt: FETCHED_AT,
        ok: false,
        reason,
        error: "boom",
        quotas: [],
      });
    },
  );
});
