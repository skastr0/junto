/**
 * Commit attribution over the real work-control socket: a seat's post-commit
 * report is recorded for the credentialed seat and its current session, the
 * first seat to report a commit keeps it, and a commit Junto cannot find is
 * refused. The last case runs the whole chain: a real `git commit` in a seat
 * environment, Junto's hook, the real CLI, this server, the store. Every
 * store, home, repo and socket lives under a temp root.
 */
import { execFile, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeWorkFrame } from "../src/shared/work-control";
import { publishSeatCredential } from "./helpers/seat-credential";
import { ModelStoresLive, seedCanvas } from "./support/seed-canvas";
import { seat } from "./support/model-nodes";
import { startWorkControlServer, type WorkControlServer } from "../src/main/junto/work/control";
import { WorkLive } from "../src/main/junto/work/service";
import { CrewRepositoryLive } from "../src/main/junto/work/crew-repository";
import { makeContentServiceLive } from "../src/main/junto/content/service";
import { WorkRepositoryLive } from "../src/main/junto/work/repository";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import { MachineRepository, makeMachineRepositoryLive } from "../src/main/junto/machines/repository";
import { SettingsLive } from "../src/main/junto/settings/service";
import { PausePlaneAllPlaying } from "../src/main/junto/pause-plane";
import { createMainAuthoringGate } from "../src/main/junto/main-authoring-gate";
import { makeSeatSessionRepositoryLive, SeatSessionRepository } from "../src/main/junto/seat-sessions/repository";
import { seatSessionCommits } from "../src/main/junto/git/seat-commits";
import { installSeatGitHooks, withSeatGitHooks } from "../src/main/junto/git/seat-hooks";

const CANVAS = "commits";
const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

const makeRuntime = (root: string) => {
  const repositoriesLive = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      CrewRepositoryLive,
      makeSeatSessionRepositoryLive(join(root, "seats")),
      makeMachineRepositoryLive({ defaultName: () => "workbench" }),
      SettingsLive,
      makeContentServiceLive({ root: join(root, "content"), skipInlineMediaMigration: true }),
    ),
    Layer.mergeAll(
      makeStateEngineLive(join(root, "state", "junto.db")),
      makeInstallOpsLive(join(root, "state", "install-ops.db")),
    ),
  );
  const canvasesLive = Layer.provideMerge(ModelStoresLive, repositoriesLive);
  return ManagedRuntime.make(Layer.mergeAll(Layer.provideMerge(WorkLive, canvasesLive), PausePlaneAllPlaying));
};

const claude = (id: string, x: number) =>
  seat(id, {
    x,
    host: "workbench",
    width: 120,
    height: 48,
    bindingId: `bind-${id}` as never,
    launch: { kind: "harness", argv: ["claude"] },
  });

const gitEnv = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "seat",
  GIT_AUTHOR_EMAIL: "seat@example.com",
  GIT_COMMITTER_NAME: "seat",
  GIT_COMMITTER_EMAIL: "seat@example.com",
};

const git = (cwd: string, args: ReadonlyArray<string>, env: Record<string, string> = gitEnv) =>
  spawnSync("git", args, { cwd, env, encoding: "utf8" });

let root: string;
let repo: string;
let workHome: string;
let runtime: ReturnType<typeof makeRuntime>;
let server: WorkControlServer;
let agentToken = "";
let otherToken = "";

beforeEach(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), "junto-seat-commits-ctl-")));
  workHome = join(root, "work");
  mkdirSync(workHome, { recursive: true });
  process.env.JUNTO_WORK_HOME = workHome;
  runtime = makeRuntime(root);
  await runtime.runPromise(Effect.flatMap(MachineRepository, (machine) => machine.configureName("workbench")));
  await runtime.runPromise(seedCanvas(CANVAS, [claude("agent", 0), claude("other", 200)]));
  await runtime.runPromise(
    Effect.flatMap(SeatSessionRepository, (sessions) =>
      sessions.record({ seatId: "agent", bindingId: "bind-agent", sessionId: "s1", harness: "claude" }),
    ),
  );
  server = await startWorkControlServer({
    version: "test",
    workHome,
    home: root,
    run: (effect) => runtime.runPromise(effect),
    authoringGate: createMainAuthoringGate(),
  });
  agentToken = publishSeatCredential(server.credentials, { agentKey: "local:agent" });
  otherToken = publishSeatCredential(server.credentials, { agentKey: "local:other" });
  repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["commit", "-q", "--allow-empty", "-m", "first"]);
});

afterEach(async () => {
  await server.close();
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
  delete process.env.JUNTO_WORK_HOME;
});

const call = (token: string, op: string, args: unknown): Promise<any> =>
  new Promise((resolvePromise, reject) => {
    const socket = createConnection({ path: server.socketPath });
    let buffer = "";
    socket.on("connect", () => socket.write(encodeWorkFrame({ token, op, args })));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.destroy();
      resolvePromise(JSON.parse(buffer.slice(0, newline)));
    });
    socket.on("error", reject);
  });

const head = (): string => git(repo, ["rev-parse", "HEAD"]).stdout.trim();

const rows = () =>
  runtime.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql`SELECT repo, sha, seat_id, session_id FROM seat_commits ORDER BY observed_at`),
  );

describe("junto commit-observed", () => {
  it("records the commit for the credentialed seat and its current session", async () => {
    const sha = head();
    const result = await call(agentToken, "commit.observed", { sha, repo });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ sha, repo, attributed: true, session_id: "s1" });
    expect(await rows()).toEqual([{ repo, sha, seat_id: "agent", session_id: "s1" }]);
    const commits = await runtime.runPromise(
      seatSessionCommits({ canvasName: CANVAS, seatId: "agent", sessionId: "s1", startedAt: 0, endedAt: Date.now() }),
    );
    expect(commits.map((commit) => commit.sha)).toEqual([sha]);
  });

  it("the first seat to report a commit keeps it", async () => {
    const sha = head();
    await call(agentToken, "commit.observed", { sha, repo });
    const second = await call(otherToken, "commit.observed", { sha, repo });
    expect(second.ok).toBe(true);
    expect(second.data.attributed).toBe(false);
    expect(await rows()).toEqual([{ repo, sha, seat_id: "agent", session_id: "s1" }]);
  });

  it("refuses a commit that is not in that repository", async () => {
    const missing = await call(agentToken, "commit.observed", { sha: "f".repeat(40), repo });
    expect(missing.ok).toBe(false);
    expect(missing.error.type).toBe("InputError");
    const elsewhere = await call(agentToken, "commit.observed", { sha: head(), repo: join(root, "work") });
    expect(elsewhere.ok).toBe(false);
    expect(await rows()).toEqual([]);
  });

  it("refuses a caller with no seat credential", async () => {
    const result = await call("", "commit.observed", { sha: head(), repo });
    expect(result.ok).toBe(false);
    expect(await rows()).toEqual([]);
  });

  it("a real commit in a seat's environment is recorded through the hook and the CLI", async () => {
    const cli = join(root, "bin", "junto");
    mkdirSync(join(root, "bin"));
    writeFileSync(cli, `#!/bin/sh\nexec bun ${JSON.stringify(join(ROOT, "src", "cli", "main.ts"))} "$@"\n`);
    chmodSync(cli, 0o755);
    const home = join(root, "home");
    const env = withSeatGitHooks(
      { ...gitEnv, HOME: home, JUNTO_HOME: home, JUNTO_WORK_HOME: workHome, JUNTO_WORK_TOKEN: agentToken, JUNTO_CLI: cli },
      home,
      installSeatGitHooks,
    );
    // Async: the server answering the hook runs in this process.
    const committed = await new Promise<{ status: number; stderr: string }>((done) => {
      execFile("git", ["commit", "-q", "--allow-empty", "-m", "by the seat"], { cwd: repo, env, encoding: "utf8" }, (error, _stdout, stderr) =>
        done({ status: error ? 1 : 0, stderr }),
      );
    });
    expect(committed.status).toBe(0);
    expect(committed.stderr).toBe("");
    expect(await rows()).toEqual([{ repo, sha: head(), seat_id: "agent", session_id: "s1" }]);
  }, 20_000);
});
