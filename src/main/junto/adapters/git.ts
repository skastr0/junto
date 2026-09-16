import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { realpath, stat } from "node:fs/promises";
import {
  GIT_LOG_FORMAT,
  GIT_LOG_LIMIT_DEFAULT,
  GIT_LOG_LIMIT_MAX,
  GIT_PATCH_MAX_BYTES,
  isGitSha,
  parseGitLog,
  parsePorcelainV2Branch,
  type GitCommit,
  type GitLogResult,
  type GitShowResult,
  type GitStatus,
  type GitStatusResult,
} from "@shared/git";
import { runCli } from "./exec";

const expandHome = (input: string): string => {
  const requested = input.trim();
  if (!requested || requested === "~") return homedir();
  if (requested.startsWith("~/")) return join(homedir(), requested.slice(2));
  return requested;
};

const resolveRepoCwd = async (input: string): Promise<string> => {
  const requested = input.trim();
  if (requested.length === 0) {
    throw new Error("git path is empty");
  }
  if (requested.includes("\0")) {
    throw new Error("git path is invalid");
  }
  const expanded = expandHome(requested);
  if (!isAbsolute(expanded)) {
    throw new Error("git path must be absolute or start with ~");
  }
  const root = await realpath(expanded);
  const info = await stat(root);
  if (!info.isDirectory()) {
    throw new Error("git path does not name a directory");
  }
  return root;
};

const git = (cwd: string, args: ReadonlyArray<string>, timeoutMs?: number) =>
  runCli("git", ["-C", cwd, ...args], timeoutMs);

const fail = (error: string): { readonly ok: false; readonly error: string } => ({
  ok: false,
  error,
});

export const readGitStatus = async (cwdInput: string): Promise<GitStatusResult> => {
  let cwd: string;
  try {
    cwd = await resolveRepoCwd(cwdInput);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "git path is invalid");
  }
  const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout.trim() !== "true") {
    return fail("not a git repository");
  }
  const porcelain = await git(cwd, [
    "status",
    "--porcelain=v2",
    "--branch",
    "--untracked-files=no",
  ]);
  if (!porcelain.ok) {
    return fail(porcelain.error ?? "git status failed");
  }
  const branch = parsePorcelainV2Branch(porcelain.stdout);
  const headLog = await git(cwd, [
    "log",
    "-1",
    `--format=${GIT_LOG_FORMAT}`,
    "--shortstat",
  ]);
  const head = headLog.ok ? parseGitLog(headLog.stdout)[0] : undefined;
  const status: GitStatus = {
    cwd,
    branch: branch.head ?? "HEAD",
    detached: branch.detached,
    ...(branch.upstream ? { upstream: branch.upstream } : {}),
    ...(branch.ahead !== undefined ? { ahead: branch.ahead } : {}),
    ...(branch.behind !== undefined ? { behind: branch.behind } : {}),
    ...(head ? { head } : {}),
  };
  return { ok: true, status };
};

export const readGitLog = async (
  cwdInput: string,
  limit: number = GIT_LOG_LIMIT_DEFAULT,
): Promise<GitLogResult> => {
  let cwd: string;
  try {
    cwd = await resolveRepoCwd(cwdInput);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "git path is invalid");
  }
  const capped = Math.min(GIT_LOG_LIMIT_MAX, Math.max(1, Math.floor(limit)));
  const result = await git(cwd, [
    "log",
    `-${capped}`,
    `--format=${GIT_LOG_FORMAT}`,
    "--shortstat",
  ]);
  if (!result.ok) {
    return fail(result.error ?? "git log failed");
  }
  return { ok: true, commits: parseGitLog(result.stdout) };
};

export const readGitShow = async (
  cwdInput: string,
  shaInput: string,
): Promise<GitShowResult> => {
  const sha = shaInput.trim();
  if (!isGitSha(sha)) {
    return fail("invalid commit");
  }
  let cwd: string;
  try {
    cwd = await resolveRepoCwd(cwdInput);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "git path is invalid");
  }
  const result = await git(cwd, [
    "show",
    "--pretty=format:",
    "--patch",
    "--no-color",
    "--",
    sha,
  ]);
  if (!result.ok) {
    return fail(result.error ?? "git show failed");
  }
  const patch =
    result.stdout.length > GIT_PATCH_MAX_BYTES
      ? `${result.stdout.slice(0, GIT_PATCH_MAX_BYTES)}\n[truncated]`
      : result.stdout;
  return { ok: true, sha, patch };
};

export type { GitCommit };
