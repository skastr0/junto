import { afterAll, describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  SEAT_GIT_HOOK_NAMES,
  installSeatGitHooks,
  seatGitHooksDir,
  withSeatGitHooks,
} from "../src/main/junto/git/seat-hooks";

const root = realpathSync(mkdtempSync(join(tmpdir(), "junto-seat-git-hooks-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const home = join(root, "home");
let counter = 0;
const fresh = (name: string): string => {
  const dir = join(root, `${name}-${counter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const hook = (path: string, body: string): void => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
};

/** A fake `junto` that records each call, or does what the body says. */
const fakeCli = (body: string): string => {
  const path = join(fresh("cli"), "junto");
  hook(path, body);
  return path;
};

const baseEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
  PATH: "/usr/bin:/bin",
  HOME: home,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "seat",
  GIT_AUTHOR_EMAIL: "seat@example.com",
  GIT_COMMITTER_NAME: "seat",
  GIT_COMMITTER_EMAIL: "seat@example.com",
  ...extra,
});

/** The environment a seat is spawned with. */
const seatEnv = (extra: Record<string, string> = {}): Record<string, string> =>
  withSeatGitHooks(baseEnv(extra), home, installSeatGitHooks);

const git = (cwd: string, args: ReadonlyArray<string>, env: Record<string, string> = baseEnv(), input?: string) => {
  const run = spawnSync("git", args, { cwd, env, encoding: "utf8", ...(input === undefined ? {} : { input }) });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
};

const repo = (): string => {
  const dir = fresh("repo");
  expect(git(dir, ["init", "-q", "-b", "main"]).status).toBe(0);
  expect(git(dir, ["commit", "-q", "--allow-empty", "-m", "base"]).status).toBe(0);
  return dir;
};

const head = (dir: string): string => git(dir, ["rev-parse", "HEAD"]).stdout.trim();

describe("the Junto hooks directory", () => {
  test("holds every hook name, executable, and a rewrite leaves it the same", () => {
    expect(installSeatGitHooks(home)).toBe(true);
    expect(installSeatGitHooks(home)).toBe(true);
    for (const name of SEAT_GIT_HOOK_NAMES) {
      const path = join(seatGitHooksDir(home), name);
      expect(existsSync(path)).toBe(true);
    }
    expect(SEAT_GIT_HOOK_NAMES).not.toContain("push-to-checkout");
    expect(SEAT_GIT_HOOK_NAMES).not.toContain("proc-receive");
  });

  test("the seat env adds one config entry after the ones it already carries", () => {
    const env = withSeatGitHooks(
      { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "x" },
      home,
      () => true,
    );
    expect(env).toEqual({
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "x",
      GIT_CONFIG_KEY_1: "core.hooksPath",
      GIT_CONFIG_VALUE_1: seatGitHooksDir(home),
    });
  });

  test("the seat env is unchanged when the directory could not be written", () => {
    expect(withSeatGitHooks({ A: "1" }, home, () => false)).toEqual({ A: "1" });
  });
});

describe("the repo's own hooks still run and can refuse", () => {
  test("a failing pre-commit under the repo's own core.hooksPath blocks the seat's commit", () => {
    const dir = repo();
    git(dir, ["config", "core.hooksPath", ".husky"]);
    hook(join(dir, ".husky", "pre-commit"), 'echo "lint failed" >&2\nexit 7');
    const before = head(dir);
    const run = git(dir, ["commit", "--allow-empty", "-m", "blocked"], seatEnv({ JUNTO_CLI: fakeCli("exit 0") }));
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("lint failed");
    expect(head(dir)).toBe(before);
  });

  test("the repo's own core.hooksPath still refuses when Junto's entry is not the last one", () => {
    const dir = repo();
    git(dir, ["config", "core.hooksPath", ".husky"]);
    hook(join(dir, ".husky", "pre-commit"), 'echo "lint failed" >&2\nexit 7');
    const env = {
      ...seatEnv({ JUNTO_CLI: fakeCli("exit 0") }),
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_1: "user.useConfigOnly",
      GIT_CONFIG_VALUE_1: "false",
    };
    const before = head(dir);
    const run = git(dir, ["commit", "--allow-empty", "-m", "blocked"], env);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("lint failed");
    expect(head(dir)).toBe(before);
  });

  test("a failing commit-msg in .git/hooks blocks, and sees the message file it was given", () => {
    const dir = repo();
    const seen = join(dir, "seen");
    hook(join(dir, ".git", "hooks", "commit-msg"), `cat "$1" > ${JSON.stringify(seen)}\nexit 1`);
    const before = head(dir);
    const run = git(dir, ["commit", "--allow-empty", "-m", "needs ticket"], seatEnv({ JUNTO_CLI: fakeCli("exit 0") }));
    expect(run.status).not.toBe(0);
    expect(readFileSync(seen, "utf8")).toContain("needs ticket");
    expect(head(dir)).toBe(before);
  });

  test("a hook reads the same stdin git gives it", () => {
    const dir = repo();
    const seen = join(dir, "seen");
    hook(join(dir, ".git", "hooks", "reference-transaction"), `[ "$1" = committed ] && cat >> ${JSON.stringify(seen)}\nexit 0`);
    const run = git(dir, ["commit", "-q", "--allow-empty", "-m", "next"], seatEnv({ JUNTO_CLI: fakeCli("exit 0") }));
    expect(run.status).toBe(0);
    expect(readFileSync(seen, "utf8")).toContain(head(dir));
  });

  test("a repo with no hooks commits as before", () => {
    const dir = repo();
    const run = git(dir, ["commit", "-q", "--allow-empty", "-m", "plain"], seatEnv({ JUNTO_CLI: fakeCli("exit 0") }));
    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
  });

  test("a linked worktree runs the hooks of its common dir", () => {
    const dir = repo();
    hook(join(dir, ".git", "hooks", "pre-commit"), 'echo "worktree refused" >&2\nexit 1');
    const tree = join(fresh("tree"), "wt");
    expect(git(dir, ["worktree", "add", "-q", "-b", "side", tree]).status).toBe(0);
    const run = git(tree, ["commit", "--allow-empty", "-m", "in worktree"], seatEnv({ JUNTO_CLI: fakeCli("exit 0") }));
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("worktree refused");
  });

  test("a submodule runs its own hooks, not its parent's", () => {
    const inner = repo();
    const outer = repo();
    expect(git(outer, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", inner, "sub"]).status).toBe(0);
    const sub = join(outer, "sub");
    const common = git(sub, ["rev-parse", "--git-common-dir"]).stdout.trim();
    hook(join(resolve(sub, common), "hooks", "pre-commit"), 'echo "submodule refused" >&2\nexit 1');
    hook(join(outer, ".git", "hooks", "pre-commit"), 'echo "parent ran" >&2\nexit 0');
    const run = git(sub, ["commit", "--allow-empty", "-m", "in submodule"], seatEnv({ JUNTO_CLI: fakeCli("exit 0") }));
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("submodule refused");
    expect(run.stderr).not.toContain("parent ran");
  });
});

describe("post-commit", () => {
  test("runs the repo's post-commit, then reports from the repo", () => {
    const dir = repo();
    const order = join(dir, "order");
    hook(join(dir, ".git", "hooks", "post-commit"), `echo repo >> ${JSON.stringify(order)}`);
    const cli = fakeCli(`echo "report $* $(pwd -P) \${JUNTO_WORK_TOKEN:-}" >> ${JSON.stringify(order)}`);
    const run = git(dir, ["commit", "-q", "--allow-empty", "-m", "reported"], seatEnv({ JUNTO_CLI: cli, JUNTO_WORK_TOKEN: "t" }));
    expect(run.status).toBe(0);
    expect(readFileSync(order, "utf8")).toBe(`repo\nreport commit-observed ${dir} t\n`);
  });

  test("a missing junto CLI leaves the commit made, with one quiet line", () => {
    const dir = repo();
    const run = git(dir, ["commit", "-q", "--allow-empty", "-m", "unreported"], seatEnv());
    expect(run.status).toBe(0);
    expect(git(dir, ["log", "-1", "--format=%s"]).stdout.trim()).toBe("unreported");
    expect(run.stderr.trim().split("\n")).toEqual([
      "junto: this commit is not attributed to the seat: the junto CLI was not found",
    ]);
  });

  test("a refused report leaves the commit made, with the CLI's one line", () => {
    const dir = repo();
    const cli = fakeCli('echo "junto: this commit is not attributed to the seat: refused" >&2\nexit 1');
    const run = git(dir, ["commit", "-q", "--allow-empty", "-m", "refused"], seatEnv({ JUNTO_CLI: cli }));
    expect(run.status).toBe(0);
    expect(run.stderr.trim()).toBe("junto: this commit is not attributed to the seat: refused");
  });

  test("a report that hangs is cut at the deadline and the commit stands", () => {
    const dir = repo();
    const run = git(dir, ["commit", "-q", "--allow-empty", "-m", "slow"], seatEnv({ JUNTO_CLI: fakeCli("exec sleep 30") }));
    expect(run.status).toBe(0);
    expect(run.stderr.trim()).toBe("junto: this commit is not attributed to the seat: the report timed out");
    expect(git(dir, ["log", "-1", "--format=%s"]).stdout.trim()).toBe("slow");
  }, 15_000);

  test("the repo's failing post-commit keeps its exit code and the report still runs", () => {
    const dir = repo();
    const order = join(dir, "order");
    hook(join(dir, ".git", "hooks", "post-commit"), "exit 3");
    const run = git(dir, ["commit", "-q", "--allow-empty", "-m", "kept"], seatEnv({ JUNTO_CLI: fakeCli(`echo report > ${JSON.stringify(order)}`) }));
    expect(run.status).toBe(0);
    expect(readFileSync(order, "utf8")).toBe("report\n");
  });
});
