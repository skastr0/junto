import { describe, expect, it } from "vitest";
import { resolveOpenRouterCredentials } from "../src/main/vellum-command/usage/openrouter-source";
import {
  resolveSyntheticApiKey,
  makeSyntheticSource,
} from "../src/main/vellum-command/usage/synthetic-source";
import {
  resolveKimiCredential,
  detectKimiPresence,
} from "../src/main/vellum-command/usage/kimi-source";
import {
  resolveDevinCredential,
  detectDevinCredential,
} from "../src/main/vellum-command/usage/devin-auth";
import {
  resolveGoApiKey,
  makeOpencodeGoSource,
} from "../src/main/vellum-command/usage/opencodego-source";
import { resolveCopilotToken } from "../src/main/vellum-command/usage/copilot-auth";
import {
  resolveSessionCookie as resolveOllamaSessionCookie,
  resolveApiKey as resolveOllamaApiKey,
  makeOllamaSource,
} from "../src/main/vellum-command/usage/ollama-source";
import {
  resolveCursorCredential,
} from "../src/main/vellum-command/usage/cursor-auth";
import {
  makeNativeUsageSources,
} from "../src/main/vellum-command/usage/native-sources";

// Every configurable usage source resolves credentials in ONE order:
//   operator settings (Settings > Providers) -> env var -> local files.
// These tests inject fakes the way the existing native-*-source tests do and
// pin that order per source.

const OPERATOR_KEY = "operator-settings-key";
const ENV_KEY = "env-fallback-key";
const FILE_KEY = "credential-file-key";

const envWith = (vars: Record<string, string>): NodeJS.ProcessEnv => vars;

describe("operator settings tier sits ahead of env and files", () => {
  it("openrouter: operator -> env -> file", () => {
    const readFile = () => FILE_KEY;
    expect(
      resolveOpenRouterCredentials(
        envWith({ OPENROUTER_API_KEY: ENV_KEY }),
        readFile,
        { apiKey: OPERATOR_KEY },
      )?.apiKey,
    ).toBe(OPERATOR_KEY);
    expect(
      resolveOpenRouterCredentials(envWith({ OPENROUTER_API_KEY: ENV_KEY }), readFile)
      ?.apiKey,
    ).toBe(ENV_KEY);
    expect(resolveOpenRouterCredentials(envWith({}), readFile)?.apiKey).toBe(FILE_KEY);
    // Management key follows the same operator-first rule.
    expect(
      resolveOpenRouterCredentials(
        envWith({ OPENROUTER_MANAGEMENT_API_KEY: ENV_KEY }),
        () => undefined,
        { apiKey: "k", managementApiKey: OPERATOR_KEY },
      )?.managementApiKey,
    ).toBe(OPERATOR_KEY);
  });

  it("synthetic: operator -> env", () => {
    expect(
      resolveSyntheticApiKey(envWith({ SYNTHETIC_API_KEY: ENV_KEY }), {
        apiKey: OPERATOR_KEY,
      }),
    ).toBe(OPERATOR_KEY);
    expect(resolveSyntheticApiKey(envWith({ SYNTHETIC_API_KEY: ENV_KEY }))).toBe(ENV_KEY);
    // The factory wires the reader ahead of the env lookup.
    const source = makeSyntheticSource({
      readOperator: () => ({ apiKey: OPERATOR_KEY }),
    });
    expect(source.id).toBe("synthetic");
    expect(source.detect !== undefined).toBe(true);
  });

  it("kimi: operator auth token -> operator API key -> env token -> env API key", async () => {
    const env = envWith({ KIMI_AUTH_TOKEN: ENV_KEY, KIMI_CODE_API_KEY: ENV_KEY });
    expect(resolveKimiCredential(env, 0, { authToken: OPERATOR_KEY })?.token).toBe(
      OPERATOR_KEY,
    );
    expect(resolveKimiCredential(env, 0, { apiKey: OPERATOR_KEY })).toMatchObject({
      token: OPERATOR_KEY,
      kind: "api-key",
    });
    expect(resolveKimiCredential(env, 0)?.token).toBe(ENV_KEY);
    expect(await detectKimiPresence({ authToken: OPERATOR_KEY })).toBe(true);
  });

  it("devin: operator bearer + organization -> env overrides", async () => {
    // plausibleToken requires at least 20 characters.
    const envBearer = `${ENV_KEY}-0123456789`;
    const env = envWith({
      DEVIN_BEARER_TOKEN: `Bearer ${envBearer}`,
      DEVIN_ORGANIZATION: "org/env",
    });
    const outcome = resolveDevinCredential(env, {
      bearerToken: OPERATOR_KEY,
      organizationId: "org/operator",
    });
    if (outcome.kind !== "ok") throw new Error("expected ok outcome");
    expect(outcome.credential.bearerToken).toBe(OPERATOR_KEY);
    expect(outcome.credential.organization).toBe("org/operator");
    // Without an operator tier the env override still works.
    const envOutcome = resolveDevinCredential(env);
    if (envOutcome.kind !== "ok") throw new Error("expected ok outcome");
    expect(envOutcome.credential.bearerToken).toBe(envBearer);
    expect(await detectDevinCredential({ bearerToken: OPERATOR_KEY })).toBe(true);
  });

  it("opencode go: operator -> env (auth.json last)", () => {
    const fakeHome = "/nonexistent-opencode-home";
    expect(
      resolveGoApiKey(envWith({ OPENCODE_API_KEY: ENV_KEY }), fakeHome, {
        apiKey: OPERATOR_KEY,
      }),
    ).toBe(OPERATOR_KEY);
    expect(resolveGoApiKey(envWith({ OPENCODE_API_KEY: ENV_KEY }), fakeHome)).toBe(
      ENV_KEY,
    );
    const source = makeOpencodeGoSource(() => ({ apiKey: OPERATOR_KEY }));
    expect(source.id).toBe("opencode-go");
  });

  it("copilot: operator token wins even when env tokens exist", () => {
    return (async () => {
      const previous = process.env.COPILOT_API_TOKEN;
      process.env.COPILOT_API_TOKEN = ENV_KEY;
      try {
        const outcome = await resolveCopilotToken({ token: OPERATOR_KEY });
        expect(outcome).toMatchObject({
          kind: "ok",
          token: OPERATOR_KEY,
          origin: "operator-settings",
        });
      } finally {
        if (previous === undefined) delete process.env.COPILOT_API_TOKEN;
        else process.env.COPILOT_API_TOKEN = previous;
      }
    })();
  });

  it("ollama: operator cookie / key -> env", () => {
    const env = envWith({
      OLLAMA_SESSION_COOKIE: ENV_KEY,
      OLLAMA_API_KEY: ENV_KEY,
    });
    // Bare tokens normalize into a full Cookie header - containment is the pin.
    expect(
      resolveOllamaSessionCookie({ sessionCookie: OPERATOR_KEY }, env),
    ).toContain(OPERATOR_KEY);
    expect(resolveOllamaSessionCookie(undefined, env)).toContain(ENV_KEY);
    expect(resolveOllamaApiKey({ apiKey: OPERATOR_KEY }, env)).toBe(OPERATOR_KEY);
    expect(resolveOllamaApiKey(undefined, env)).toBe(ENV_KEY);
    const source = makeOllamaSource(() => ({ sessionCookie: OPERATOR_KEY }));
    expect(source.id).toBe("ollama");
  });

  it("cursor: operator cookie header -> CURSOR_COOKIE", () => {
    const outcome = resolveCursorCredential({
      env: envWith({ CURSOR_COOKIE: ENV_KEY }),
      operatorCookieHeader: OPERATOR_KEY,
    });
    if (outcome.kind !== "ok") throw new Error("expected ok outcome");
    expect(outcome.credential.cookieHeader).toBe(OPERATOR_KEY);
    expect(outcome.credential.origin).toBe("operator-settings");
  });

  it("the production registry builds one wired source per provider id", () => {
    const sources = makeNativeUsageSources({
      read: () => ({
        openrouter: { apiKey: OPERATOR_KEY },
        synthetic: { apiKey: OPERATOR_KEY },
        kimi: { authToken: OPERATOR_KEY },
        devin: { bearerToken: OPERATOR_KEY },
        opencodeGo: { apiKey: OPERATOR_KEY },
        copilot: { token: OPERATOR_KEY },
        ollama: { sessionCookie: OPERATOR_KEY },
        cursor: { cookieHeader: OPERATOR_KEY },
      }),
      enabledSources: () => new Set(),
      subscribeEnabledSources: () => () => undefined,
      hermesHostSnapshots: () => false,
      subscribeHermesHostSnapshots: () => () => undefined,
    });
    const ids = sources.map((source) => source.id).sort();
    for (const expected of [
      "copilot",
      "cursor",
      "devin",
      "kimi",
      "ollama",
      "opencode-go",
      "openrouter",
      "synthetic",
    ]) {
      expect(ids).toContain(expected);
    }
  });
});
