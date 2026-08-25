import { describe, expect, it } from "vitest";
import {
  assembleOllamaSnapshot,
  classifyOllamaSettingsHtml,
  fetchOllamaApiKeyUsage,
  fetchOllamaSettingsPage,
  normalizeOllamaCookie,
  redactSecrets,
  type OllamaApiOutcome,
  type OllamaWebOutcome,
} from "../src/main/vellum/usage/ollama-source";

const FETCHED = "2026-08-18T12:00:00.000Z";
const SECRET_COOKIE = "s3cr3t-session-token-value-0001";
const SECRET_KEY = "sk-ollama-super-secret-key-4242";

/** Fixture modeled on the ollama.com/settings HTML page. */
const SETTINGS_HTML = `
<html><body>
<div id="header-email" class="truncate">dev@example.com</div>
<section>
  <span>Cloud Usage</span>
  <span>Plus</span>
</section>
<section>
  <h3>Session usage</h3>
  <div class="bar"><div style="width: 42%"></div></div>
  <span>42% used</span>
  <span data-time="2026-08-18T15:00:00.000Z">resets in 3h</span>
</section>
<section>
  <h3>Weekly usage</h3>
  <div class="bar"><div style="width: 12%"></div></div>
  <span>12% used</span>
  <span data-time="2026-08-24T00:00:00.000Z">resets Monday</span>
</section>
</body></html>`;

const SIGNED_OUT_HTML = `
<html><body>
<h1>Sign in to Ollama</h1>
<form action="/login" method="post">
  <input type="email" name="email">
  <input type="password" name="password">
</form>
</body></html>`;

const PLAIN_HTML = `<html><body><p>Welcome to ollama.com</p></body></html>`;

describe("classifyOllamaSettingsHtml (pure decode)", () => {
  it("decodes plan, account, and both usage windows from the settings page", () => {
    const result = classifyOllamaSettingsHtml(SETTINGS_HTML);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.parsed.planName).toBe("Plus");
    expect(result.parsed.accountEmail).toBe("dev@example.com");
    expect(result.parsed.sessionUsedPercent).toBe(42);
    expect(result.parsed.sessionResetsAt).toBe("2026-08-18T15:00:00.000Z");
    expect(result.parsed.weeklyUsedPercent).toBe(12);
    expect(result.parsed.weeklyResetsAt).toBe("2026-08-24T00:00:00.000Z");
  });

  it("accepts the Hourly usage label as the primary window", () => {
    const html = SETTINGS_HTML.replace("Session usage", "Hourly usage");
    const result = classifyOllamaSettingsHtml(html);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.parsed.sessionUsedPercent).toBe(42);
  });

  it("falls back to the bar width when no N% used text exists", () => {
    const html = SETTINGS_HTML
      .replace("<span>42% used</span>", "")
      .replace("<span>12% used</span>", "");
    const result = classifyOllamaSettingsHtml(html);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.parsed.sessionUsedPercent).toBe(42);
    expect(result.parsed.weeklyUsedPercent).toBe(12);
  });

  it("clamps out-of-range percents into [0, 100]", () => {
    const html = SETTINGS_HTML.replace('width: 42%', 'width: 140%').replace(
      "42% used",
      "140% used",
    );
    const result = classifyOllamaSettingsHtml(html);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.parsed.sessionUsedPercent).toBe(100);
  });

  it("classifies a sign-in page as signed-out", () => {
    expect(classifyOllamaSettingsHtml(SIGNED_OUT_HTML)).toEqual({ kind: "signed-out" });
  });

  it("classifies a usage-free page as no-usage", () => {
    expect(classifyOllamaSettingsHtml(PLAIN_HTML)).toEqual({ kind: "no-usage" });
  });
});

describe("normalizeOllamaCookie", () => {
  it("wraps a bare session token under the default cookie name", () => {
    expect(normalizeOllamaCookie("tok-abc123")).toBe("__Secure-session=tok-abc123");
  });

  it("passes a full recognized header through and strips quotes and newlines", () => {
    expect(normalizeOllamaCookie(`"__Secure-session=tok-abc123"`)).toBe(
      "__Secure-session=tok-abc123",
    );
    expect(normalizeOllamaCookie("session=abc\n")).toBe("session=abc");
    expect(normalizeOllamaCookie(`cookie: session=abc; other=def`)).toBe(
      "session=abc; other=def",
    );
  });

  it("returns undefined for empty or multiline values", () => {
    expect(normalizeOllamaCookie(undefined)).toBeUndefined();
    expect(normalizeOllamaCookie("   ")).toBeUndefined();
    expect(normalizeOllamaCookie("a=b\nc=d")).toBeUndefined();
  });
});

describe("assembleOllamaSnapshot (tier fold)", () => {
  const webOk = (): Extract<OllamaWebOutcome, { kind: "ok" }> => {
    const classified = classifyOllamaSettingsHtml(SETTINGS_HTML);
    if (classified.kind !== "ok") throw new Error("fixture must decode");
    return { kind: "ok", parsed: classified.parsed };
  };

  it("prefers a live web quota snapshot with primary + secondary windows", () => {
    const snapshot = assembleOllamaSnapshot(webOk(), undefined, FETCHED, []);
    expect(snapshot.ok).toBe(true);
    expect(snapshot.dataConfidence).toBe("live");
    const quota = snapshot.quotas[0]!;
    expect(quota.provider).toBe("ollama");
    expect(quota.source).toBe("web");
    expect(quota.status).toBe("ok");
    expect(quota.account).toBe("dev@example.com");
    expect(quota.plan).toBe("Plus");
    expect(quota.windows.map((w) => [w.label, w.title, w.usedPercent, w.windowMinutes])).toEqual([
      ["primary", "Session", 42, 300],
      ["secondary", "Weekly", 12, 10_080],
    ]);
    expect(quota.creditsRemaining).toBeUndefined();
  });

  it("falls back to the API-key identity tier when the web page has no usage blocks", () => {
    const apiOk: OllamaApiOutcome = { kind: "ok", modelCount: 37 };
    const snapshot = assembleOllamaSnapshot({ kind: "signed-out" }, apiOk, FETCHED, []);
    expect(snapshot.ok).toBe(true);
    expect(snapshot.dataConfidence).toBe("live");
    const quota = snapshot.quotas[0]!;
    expect(quota.source).toBe("api");
    expect(quota.windows).toEqual([]);
    expect(quota.extras?.capability).toBe("identity");
    expect(quota.extras?.partial).toBe(true);
    expect(quota.extras?.modelCount).toBe(37);
  });

  it("reports parse-error when the page decoded but carried no usage and no api tier exists", () => {
    const emptyOk = { kind: "ok", parsed: {} } as OllamaWebOutcome;
    const snapshot = assembleOllamaSnapshot(emptyOk, undefined, FETCHED, []);
    expect(snapshot.ok).toBe(false);
    expect(snapshot.reason).toBe("parse-error");
  });

  it("reports an auth-failure envelope when the key is rejected, with secrets redacted", () => {
    const snapshot = assembleOllamaSnapshot(
      { kind: "failed", error: `fetch failed with ${SECRET_COOKIE}` },
      { kind: "unauthorized", status: 401 },
      FETCHED,
      [SECRET_COOKIE, SECRET_KEY],
    );
    expect(snapshot.ok).toBe(false);
    expect(snapshot.reason).toBe("cli-error");
    expect(snapshot.error).toContain("rejected");
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(SECRET_COOKIE);
    expect(serialized).not.toContain(SECRET_KEY);
  });

  it("redacts leaked credentials from web failure errors", () => {
    const snapshot = assembleOllamaSnapshot(
      { kind: "failed", error: `network down while sending ${SECRET_COOKIE}` },
      undefined,
      FETCHED,
      [SECRET_COOKIE],
    );
    expect(snapshot.ok).toBe(false);
    expect(snapshot.error).toContain("[redacted]");
    expect(JSON.stringify(snapshot)).not.toContain(SECRET_COOKIE);
  });

  it("reports source-missing when neither credential resolved", () => {
    const snapshot = assembleOllamaSnapshot(undefined, undefined, FETCHED, []);
    expect(snapshot.ok).toBe(false);
    expect(snapshot.reason).toBe("source-missing");
    expect(snapshot.quotas).toEqual([]);
  });
});

describe("redactSecrets", () => {
  it("replaces known secret values but leaves short strings alone", () => {
    expect(redactSecrets(`token=${SECRET_KEY} ok`, [SECRET_KEY])).toBe("token=[redacted] ok");
    expect(redactSecrets("tiny=abc ok", ["abc"])).toBe("tiny=abc ok");
  });
});

describe("network outcome folds (injected transport, no real network)", () => {
  const makeJsonResponse = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status });

  it("fetchOllamaApiKeyUsage counts the model catalog on success", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/web_search")) {
        return makeJsonResponse(400, { error: "query required" });
      }
      return makeJsonResponse(200, { models: [{ name: "gpt-oss" }, { name: "qwen3" }] });
    }) as unknown as typeof fetch;

    const outcome = await fetchOllamaApiKeyUsage(SECRET_KEY, fetchImpl);
    expect(outcome).toEqual({ kind: "ok", modelCount: 2 });
    expect(calls.length).toBe(2);
    const authHeader = new Headers(calls[0]!.init?.headers).get("Authorization");
    expect(authHeader).toBe(`Bearer ${SECRET_KEY}`);
  });

  it("fetchOllamaApiKeyUsage reports unauthorized without echoing the key", async () => {
    const fetchImpl = (async (): Promise<Response> =>
      makeJsonResponse(401, { error: "invalid api key" })) as unknown as typeof fetch;
    const outcome = await fetchOllamaApiKeyUsage(SECRET_KEY, fetchImpl);
    expect(outcome).toEqual({ kind: "unauthorized", status: 401 });
    expect(JSON.stringify(outcome)).not.toContain(SECRET_KEY);
  });

  it("fetchOllamaSettingsPage decodes a live settings response", async () => {
    const fetchImpl = (async (): Promise<Response> =>
      new Response(SETTINGS_HTML, { status: 200 })) as unknown as typeof fetch;
    const outcome = await fetchOllamaSettingsPage(`__Secure-session=${SECRET_COOKIE}`, fetchImpl);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      expect(outcome.parsed.weeklyUsedPercent).toBe(12);
    }
    expect(JSON.stringify(outcome)).not.toContain(SECRET_COOKIE);
  });

  it("fetchOllamaSettingsPage treats a redirect to signin as signed-out", async () => {
    const fetchImpl = (async (): Promise<Response> =>
      new Response(null, {
        status: 302,
        headers: { location: "https://signin.ollama.com/authorize" },
      })) as unknown as typeof fetch;
    const outcome = await fetchOllamaSettingsPage(`__Secure-session=${SECRET_COOKIE}`, fetchImpl);
    expect(outcome).toEqual({ kind: "signed-out" });
  });

  it("fetchOllamaSettingsPage folds network failures into a typed outcome", async () => {
    const fetchImpl = (async (): Promise<Response> => {
      throw new Error(`socket hang up with ${SECRET_COOKIE}`);
    }) as unknown as typeof fetch;
    const outcome = await fetchOllamaSettingsPage(SECRET_COOKIE, fetchImpl);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      // The raw error may carry the secret only until assembly scrubs it.
      expect(typeof outcome.error).toBe("string");
    }
  });
});
