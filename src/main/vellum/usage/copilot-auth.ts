import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runCli } from "../adapters/exec";

// Copilot token discovery (read-only) for the native GitHub Copilot usage
// source. Ordered discovery:
//   1. environment tokens (COPILOT_API_TOKEN, GH_*, GITHUB_TOKEN),
//   2. the GitHub CLI (`gh auth token`) — read probe with a timeout,
//   3. ~/.config/gh/hosts.yml oauth_token entries.
//
// OAuth Device Flow is deliberately OUT of scope for v1 — the VS Code client
// id `Iv1.b507a08c87ecfe98` would drive it; documented as future work.
// Tokens never leave this module in logs or error text.

export const GH_HOSTS_PATH = (): string => join(homedir(), ".config", "gh", "hosts.yml");
/** Future work only — do not wire up until device flow ships. */
export const COPILOT_DEVICE_FLOW_CLIENT_ID = "Iv1.b507a08c87ecfe98";

export type CopilotTokenOrigin = "env" | "cli" | "hosts-file";

export type CopilotAuthOutcome =
  | { readonly kind: "ok"; readonly token: string; readonly origin: CopilotTokenOrigin }
  | { readonly kind: "missing"; readonly error: string };

const plausibleToken = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.length >= 8 && !/\s/.test(trimmed);
};

/**
 * Pure env scan over an explicit environment object — exported for unit
 * tests. Priority: COPILOT_API_TOKEN first (most specific), then the GitHub
 * CLI family (GH_TOKEN, GH_ENTERPRISE_TOKEN), then GITHUB_TOKEN.
 */
export const pickEnvToken = (env: Record<string, string | undefined>): string | undefined =>
  [env.COPILOT_API_TOKEN, env.GH_TOKEN, env.GH_ENTERPRISE_TOKEN, env.GITHUB_TOKEN].find(plausibleToken);

/**
 * Pure parse of a gh hosts.yml body — exported for unit tests. Returns oauth
 * tokens with github.com-hosted entries first, then any other host's tokens
 * in file order. Deliberately NOT a YAML parser: hosts.yml is flat enough
 * that a line scan stays correct for the oauth_token field we need.
 */
export const parseHostsTokens = (text: string): ReadonlyArray<string> => {
  const underGithubCom: string[] = [];
  const elsewhere: string[] = [];
  let currentHost = "";
  let inGithubUsers = false;
  for (const line of text.split(/\r?\n/)) {
    if (/\S/.test(line) && !/^[ \t]/.test(line)) {
      // Top-level key — the host name (or something we do not care about).
      currentHost = line.replace(/:.*$/, "").trim();
      inGithubUsers = false;
      continue;
    }
    const usersMatch = line.match(/^\s+users:\s*$/);
    if (usersMatch !== null && currentHost === "github.com") {
      inGithubUsers = true;
      continue;
    }
    const tokenMatch = line.match(/^\s+oauth_token:\s*(\S+)\s*$/);
    if (tokenMatch === null) continue;
    const token = tokenMatch[1];
    if (!plausibleToken(token)) continue;
    if (currentHost === "github.com" || (inGithubUsers && currentHost === "")) {
      underGithubCom.push(token);
    } else {
      elsewhere.push(token);
    }
  }
  return [...new Set([...underGithubCom, ...elsewhere])];
};

const readHostsFileTokens = (): string | undefined => {
  try {
    const path = GH_HOSTS_PATH();
    if (!existsSync(path)) return undefined;
    return parseHostsTokens(readFileSync(path, "utf8"))[0];
  } catch {
    return undefined;
  }
};

const GH_CLI_TIMEOUT_MS = 10_000;

const readGhCliToken = async (): Promise<string | undefined> => {
  try {
    // Read-only credential probe — `gh auth token` prints the stored token
    // without network access. Fails soft on missing CLI or bad exit.
    const result = await runCli("gh", ["auth", "token"], GH_CLI_TIMEOUT_MS);
    const token = result.ok ? result.stdout.trim() : "";
    return plausibleToken(token) ? token : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Ordered token resolution. Never throws; every failure folds into a
 * `missing` outcome whose copy tells the operator how to fix it.
 */
export const resolveCopilotToken = async (): Promise<CopilotAuthOutcome> => {
  const envToken = pickEnvToken(process.env);
  if (envToken !== undefined) {
    return { kind: "ok", token: envToken.trim(), origin: "env" };
  }
  const cliToken = await readGhCliToken();
  if (cliToken !== undefined) {
    return { kind: "ok", token: cliToken.trim(), origin: "cli" };
  }
  const fileToken = readHostsFileTokens();
  if (fileToken !== undefined) {
    return { kind: "ok", token: fileToken.trim(), origin: "hosts-file" };
  }
  return {
    kind: "missing",
    error:
      "no GitHub credential found — set COPILOT_API_TOKEN, run `gh auth login`, or add an oauth_token to ~/.config/gh/hosts.yml",
  };
};
