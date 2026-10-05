/**
 * Where a region's environment values come from.
 *
 * One resolver per source kind, behind one function. Each reads a value from
 * where the operator already keeps it (a Keychain item, a keyring item, a
 * 1Password reference, a dotenv file, a folder of secret files, a command)
 * and never copies it into Junto. Only `secret` reads Junto's own store.
 *
 * The law for every kind:
 * - it answers with names and values, or with a reason in plain words;
 * - it never throws and never rejects into a launch;
 * - every call to another program is bounded by a timeout;
 * - a value never appears in a reason, a log, or an error.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { EnvSource } from "@shared/canvas";
import type {
  EnvSourceResolver,
  SourceContext,
  SourceResolution,
} from "@shared/region-environment";
import { resolvedSpawnEnv } from "../adapters/exec";
import { redactSecretValues } from "../credentials/redact";
import { ENV_NAME, parseDotenv } from "./dotenv";
import { regionSecrets, type RegionSecrets } from "./secret-store";
import { runTool, type ToolResult, type ToolRunner } from "./tool";

export type { SourceContext, SourceResolution };

export type SourceDeps = {
  readonly run: ToolRunner;
  readonly platform: NodeJS.Platform;
  /** The operator's home, for `~/` paths. */
  readonly home: string;
  readonly secrets: Pick<RegionSecrets, "read" | "backend" | "description">;
  /** Environment external tools run with (the app's resolved PATH). */
  readonly toolEnv: () => Promise<Readonly<Record<string, string | undefined>>>;
  readonly timeouts?: Partial<typeof DEFAULT_TIMEOUTS>;
};

/** How long each store may take before the launch goes on without it. */
export const DEFAULT_TIMEOUTS = {
  keychainMs: 5_000,
  keyringMs: 5_000,
  /** With a service account token `op` talks to the network and nobody else. */
  onePasswordTokenMs: 15_000,
  /** Without one it may be waiting on the desktop app, so on the operator. */
  onePasswordAppMs: 8_000,
  commandMs: 10_000,
} as const;

/** The 1Password CLI reads its service account token from this name. */
export const OP_TOKEN_NAME = "OP_SERVICE_ACCOUNT_TOKEN";

const SECURITY_TOOL = "/usr/bin/security";
/** `security` exits 44 when no item matches. */
const SECURITY_NOT_FOUND = 44;

const FILE_MAX_BYTES = 1024 * 1024;
const SECRET_FILE_MAX_BYTES = 64 * 1024;
const SECRETS_DIR_MAX_FILES = 500;

type Named = Extract<EnvSource, { name: string }>;

const ok = (values: Record<string, string>): SourceResolution => ({ status: "ok", values });
const missing = (names: string[], reason: string): SourceResolution => ({
  status: "missing",
  names,
  reason,
});
const failed = (names: string[], reason: string): SourceResolution => ({
  status: "error",
  names,
  reason,
});

/** A store hands a value back as a line; the line break is not part of it. */
const stripLineEnd = (text: string): string => text.replace(/\r?\n$/u, "");

const isEnoent = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  ["ENOENT", "ENOTDIR"].includes(String((error as { code?: unknown }).code));

/** `~/x` and `~` are the operator's home. Anything else must be absolute. */
export const expandHome = (path: string, home: string): string | undefined => {
  const trimmed = path.trim();
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/")) return join(home, trimmed.slice(2));
  return isAbsolute(trimmed) ? trimmed : undefined;
};

/** Names a source provides that are known without resolving it. */
export const staticNamesOf = (source: EnvSource): string[] =>
  "name" in source ? [source.name] : [];

export const makeEnvSourceResolver = (deps: SourceDeps): EnvSourceResolver => {
  const timeouts = { ...DEFAULT_TIMEOUTS, ...deps.timeouts };

  const named = (source: Named, value: string): SourceResolution =>
    ok({ [source.name]: value });

  /** What a tool that did not produce a value means, in the store's words. */
  const toolProblem = (
    result: Exclude<ToolResult, { kind: "ok" }>,
    words: { readonly tool: string; readonly waiting: string },
  ): string => {
    switch (result.kind) {
      case "not-installed":
        return `${words.tool} is not installed on this machine.`;
      case "timeout":
        return words.waiting;
      case "exit":
        return `${words.tool} exited with code ${String(result.code)}.`;
      case "failed":
        return `${words.tool} could not be run.`;
    }
  };

  const secret = (source: Extract<EnvSource, { kind: "secret" }>): SourceResolution => {
    if (deps.secrets.backend === "unavailable") {
      return failed([source.name], deps.secrets.description);
    }
    const value = deps.secrets.read(source.secretId);
    return value === undefined
      ? missing([source.name], "This secret is not saved on this machine.")
      : named(source, value);
  };

  const keychain = async (
    source: Extract<EnvSource, { kind: "keychain" }>,
  ): Promise<SourceResolution> => {
    if (deps.platform !== "darwin") {
      return failed([source.name], "Keychain items exist only on macOS.");
    }
    const account = source.account?.trim();
    const result = await deps.run({
      command: SECURITY_TOOL,
      args: [
        "find-generic-password",
        "-s",
        source.service,
        ...(account ? ["-a", account] : []),
        "-w",
      ],
      timeoutMs: timeouts.keychainMs,
      env: await deps.toolEnv(),
    });
    if (result.kind === "ok") return named(source, stripLineEnd(result.stdout));
    const item = account
      ? `service "${source.service}" and account "${account}"`
      : `service "${source.service}"`;
    if (result.kind === "exit" && result.code === SECURITY_NOT_FOUND) {
      return missing([source.name], `No Keychain item with ${item}.`);
    }
    return failed(
      [source.name],
      toolProblem(result, {
        tool: "The macOS security tool",
        waiting:
          "The Keychain did not answer in time. It may be waiting for you to unlock it or allow access.",
      }),
    );
  };

  const keyring = async (
    source: Extract<EnvSource, { kind: "keyring" }>,
  ): Promise<SourceResolution> => {
    const pairs = Object.entries(source.attributes);
    if (pairs.length === 0) {
      return failed([source.name], "A keyring item needs at least one attribute to look it up by.");
    }
    const result = await deps.run({
      command: "secret-tool",
      args: ["lookup", ...pairs.flat()],
      timeoutMs: timeouts.keyringMs,
      env: await deps.toolEnv(),
    });
    if (result.kind === "ok") {
      return result.stdout.length > 0
        ? named(source, stripLineEnd(result.stdout))
        : missing([source.name], "No keyring item has these attributes.");
    }
    // secret-tool exits 1 with nothing to say when no item matches.
    if (result.kind === "exit" && result.code === 1 && result.stderr.trim() === "") {
      return missing([source.name], "No keyring item has these attributes.");
    }
    return failed(
      [source.name],
      toolProblem(result, {
        tool: "secret-tool",
        waiting:
          "The keyring did not answer in time. It may be waiting for you to unlock it.",
      }),
    );
  };

  const onePassword = async (
    source: Extract<EnvSource, { kind: "onepassword" }>,
    context: SourceContext,
  ): Promise<SourceResolution> => {
    const names = [source.name];
    if (!source.ref.startsWith("op://")) {
      return failed(names, "A 1Password reference starts with op://.");
    }
    let token: string | undefined;
    if (source.tokenFrom !== undefined) {
      const from = context.resolved(source.tokenFrom);
      const produced = from ? Object.entries(from) : [];
      token =
        produced.length === 1 ? produced[0]![1] : from?.[OP_TOKEN_NAME];
      if (token === undefined || token.length === 0) {
        return failed(
          names,
          "The source this reference takes its 1Password token from did not provide one.",
        );
      }
    }
    const base = await deps.toolEnv();
    const result = await deps.run({
      command: "op",
      args: ["read", "--no-newline", source.ref],
      timeoutMs: token ? timeouts.onePasswordTokenMs : timeouts.onePasswordAppMs,
      // The token reaches this one `op` process through its environment and
      // nothing else: not argv, not the app's own environment.
      env: token ? { ...base, [OP_TOKEN_NAME]: token } : base,
    });
    if (result.kind === "ok") return named(source, result.stdout);
    if (result.kind === "not-installed") {
      return failed(names, "The 1Password CLI (op) is not installed on this machine.");
    }
    if (result.kind === "timeout") {
      return failed(
        names,
        token
          ? "1Password did not answer in time."
          : "This needs you to unlock 1Password.",
      );
    }
    if (result.kind === "exit") {
      const said = result.stderr.toLowerCase();
      if (/isn't an item|is not an item|isn't a vault|could not find|not found|no item|does not have a field/u.test(said)) {
        return missing(names, "1Password has no item, vault or field at this reference.");
      }
      if (!token && /not (currently )?signed in|sign in|authoriz|unlock|biometric|connect to .*app|session expired/u.test(said)) {
        return failed(names, "This needs you to unlock 1Password.");
      }
      if (token && /token|unauthorized|authentication|invalid/u.test(said)) {
        return failed(names, "1Password refused the service account token.");
      }
    }
    return failed(names, toolProblem(result, { tool: "The 1Password CLI", waiting: "" }));
  };

  const envFile = async (
    source: Extract<EnvSource, { kind: "envFile" }>,
  ): Promise<SourceResolution> => {
    const path = expandHome(source.path, deps.home);
    if (path === undefined) {
      return failed([], `"${source.path}" must be an absolute path or start with ~/.`);
    }
    try {
      const info = await stat(path);
      if (!info.isFile()) return failed([], `${source.path} is not a file.`);
      if (info.size > FILE_MAX_BYTES) return failed([], `${source.path} is too large to be an env file.`);
      return ok(parseDotenv(await readFile(path, "utf8")).values);
    } catch (error) {
      return isEnoent(error)
        ? missing([], `${source.path} does not exist.`)
        : failed([], `${source.path} could not be read.`);
    }
  };

  const secretsDir = async (
    source: Extract<EnvSource, { kind: "secretsDir" }>,
  ): Promise<SourceResolution> => {
    const directory = expandHome(source.path, deps.home);
    if (directory === undefined) {
      return failed([], `"${source.path}" must be an absolute path or start with ~/.`);
    }
    const prefix = source.prefix ?? "";
    try {
      const entries = (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => !entry.name.startsWith("."))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, SECRETS_DIR_MAX_FILES);
      const values: Record<string, string> = {};
      for (const entry of entries) {
        // The file name is the variable name, as written: no case folding.
        const name = `${prefix}${entry.name}`;
        if (!ENV_NAME.test(name)) continue;
        const file = join(directory, entry.name);
        // stat, not the dirent: a mounted secret is usually a symlink.
        const info = await stat(file).catch(() => undefined);
        if (!info?.isFile() || info.size > SECRET_FILE_MAX_BYTES) continue;
        const content = await readFile(file, "utf8").catch(() => undefined);
        if (content !== undefined) values[name] = stripLineEnd(content);
      }
      return ok(values);
    } catch (error) {
      return isEnoent(error)
        ? missing([], `${source.path} does not exist.`)
        : failed([], `${source.path} could not be read.`);
    }
  };

  const command = async (
    source: Extract<EnvSource, { kind: "command" }>,
  ): Promise<SourceResolution> => {
    const [program, ...args] = source.argv;
    if (!program) return failed([source.name], "The command is empty.");
    const result = await deps.run({
      command: program,
      args,
      timeoutMs: timeouts.commandMs,
      env: await deps.toolEnv(),
    });
    if (result.kind === "ok") return named(source, stripLineEnd(result.stdout));
    const reason = toolProblem(result, {
      tool: `The command "${program}"`,
      waiting: `The command "${program}" did not finish in time.`,
    });
    // The command is the operator's own, so its first words of complaint are
    // worth showing. Whatever it printed on stdout is treated as the value it
    // failed to deliver and is removed from them.
    const said =
      result.kind === "exit"
        ? redactSecretValues(result.stderr.trim().split("\n")[0] ?? "", [
            result.stdout,
            stripLineEnd(result.stdout),
          ]).slice(0, 160)
        : "";
    return failed([source.name], said ? `${reason} It said: ${said}` : reason);
  };

  const resolve = async (
    source: EnvSource,
    context: SourceContext,
  ): Promise<SourceResolution> => {
    const names = staticNamesOf(source);
    try {
      if ("name" in source && !ENV_NAME.test(source.name)) {
        return failed(names, `"${source.name}" is not a valid variable name.`);
      }
      switch (source.kind) {
        case "value":
          return named(source, source.value);
        case "secret":
          return secret(source);
        case "keychain":
          return await keychain(source);
        case "keyring":
          return await keyring(source);
        case "onepassword":
          return await onePassword(source, context);
        case "envFile":
          return await envFile(source);
        case "secretsDir":
          return await secretsDir(source);
        case "command":
          return await command(source);
      }
    } catch {
      // Nothing above is meant to throw. If something does, the launch still
      // goes on, and the reason says nothing about what was being read.
      return failed(names, "This source could not be read.");
    }
  };

  return { resolve, staticNamesOf };
};

let live: EnvSourceResolver | undefined;

/**
 * Resolve one source against this machine's real stores. Never rejects.
 * Tests build their own resolver with `makeEnvSourceResolver` and fakes.
 */
export const resolveEnvSource = (
  source: EnvSource,
  context: SourceContext,
): Promise<SourceResolution> => {
  live ??= makeEnvSourceResolver({
    run: runTool,
    platform: process.platform,
    home: homedir(),
    secrets: {
      get backend() {
        return regionSecrets().backend;
      },
      get description() {
        return regionSecrets().description;
      },
      read: (secretId) => regionSecrets().read(secretId),
    },
    toolEnv: () => resolvedSpawnEnv(),
  });
  return live.resolve(source, context);
};
