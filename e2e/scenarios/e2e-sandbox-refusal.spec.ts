/**
 * Real app: an E2E launch that can reach the operator's live Junto is refused
 * at boot, before it opens a database, a log, a socket or a window.
 *
 * The alarm was real: a spec spread `...process.env` into a launch, and the
 * test app inherited the operator's home, work socket and seat token beside
 * their running install. Discipline per spec does not hold; the app now checks
 * itself (src/shared/e2e-sandbox.ts) and exits nonzero with the reason.
 *
 *   bun run build:bundles && scripts/with-app-run-lock.sh scripts/run-e2e.sh e2e/scenarios/e2e-sandbox-refusal.spec.ts
 *
 * The refused launches name the operator's real work home but never open it:
 * the guard runs at the top of main, before anything of ours touches a file.
 * One of them carries a seat variable with the E2E marker removed, because the
 * seat rule is unconditional: any launch from a seat's shell is refused.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { expect, launchJunto, test } from "../harness/launch";
import { launchEnvironment } from "../harness/launch-env";
import { modelFixture, modelSeat } from "../harness/model";
import { createSandbox, destroySandbox, type Sandbox } from "../harness/sandbox";

const ELECTRON_BINARY = createRequire(import.meta.url)("electron") as string;
const REPO_ROOT = process.cwd();
const REAL_HOME = userInfo().homedir;
const REAL_JUNTO = join(REAL_HOME, ".junto");
const REFUSAL = "[junto] refused to start:";

const sandboxEnv = (sandbox: Sandbox, extra: Record<string, string>): NodeJS.ProcessEnv => ({
  ...launchEnvironment({
    inherited: process.env,
    home: sandbox.homeDir,
    tempRoot: sandbox.root,
    // Never reached: the launch under test exits before a window exists.
    rendererUrl: "http://127.0.0.1:9",
    path: [
      join(sandbox.homeDir, ".local", "bin"),
      join(REPO_ROOT, "e2e", "fakes", "bin"),
      dirname(process.execPath),
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ].join(":"),
    sandboxPath: join(sandbox.homeDir, ".local", "bin"),
    extraEnv: extra,
  }),
});

interface BootOutcome {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly ms: number;
}

/** Launch the real app main and watch it die. */
const bootRefused = async (sandbox: Sandbox, extra: NodeJS.ProcessEnv): Promise<BootOutcome> => {
  const started = Date.now();
  const child = spawn(
    ELECTRON_BINARY,
    [REPO_ROOT, `--user-data-dir=${sandbox.userDataDir}`, "--mute-audio"],
    { cwd: REPO_ROOT, env: extra, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
  child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
  const code = await new Promise<number | null>((done) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      done(null);
    }, 30_000);
    child.once("exit", (exit) => {
      clearTimeout(timer);
      done(exit);
    });
  });
  return { code, stdout, stderr, ms: Date.now() - started };
};

test("an E2E launch handed the operator's work home refuses to boot", async () => {
  test.setTimeout(120_000);
  const sandbox = await createSandbox();
  try {
    const liveWorkHome = join(REAL_JUNTO, "work");
    const outcome = await bootRefused(sandbox, sandboxEnv(sandbox, { JUNTO_WORK_HOME: liveWorkHome }));
    expect(outcome.code, `stdout: ${outcome.stdout}\nstderr: ${outcome.stderr}`).toBe(1);
    expect(outcome.stderr).toContain(REFUSAL);
    expect(outcome.stderr).toContain(`JUNTO_WORK_HOME=${liveWorkHome}`);
    expect(outcome.stderr).toContain(REAL_JUNTO);
    // It got there by refusing, not by hanging: the guard runs at the top of main.
    expect(outcome.ms).toBeLessThan(20_000);
  } finally {
    await destroySandbox(sandbox);
  }
});

test("a raw launch carrying a seat variable refuses to boot, E2E marker or not", async () => {
  test.setTimeout(120_000);
  const sandbox = await createSandbox();
  try {
    // No JUNTO_E2E and no E2E paths: this is an ordinary launch started from a
    // seat's environment, the case a test-only guard would never see.
    const env = sandboxEnv(sandbox, {
      JUNTO_WORK_TOKEN: "junto-seat-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
      JUNTO_SEAT: "second-app-from-a-seat",
    });
    delete env.JUNTO_E2E;
    const outcome = await bootRefused(sandbox, env);
    expect(outcome.code, `stdout: ${outcome.stdout}\nstderr: ${outcome.stderr}`).toBe(1);
    expect(outcome.stderr).toContain(REFUSAL);
    expect(outcome.stderr).toContain("JUNTO_WORK_TOKEN");
    expect(outcome.stderr).toContain("refuses to start");
    expect(outcome.stderr).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(outcome.ms).toBeLessThan(20_000);
  } finally {
    await destroySandbox(sandbox);
  }
});

test("the harness's own sandbox still boots and renders", async () => {
  test.setTimeout(180_000);
  const sandbox = await createSandbox();
  let junto: Awaited<ReturnType<typeof launchJunto>> | undefined;
  try {
    junto = await launchJunto({
      sandbox,
      seedModels: { tripwire: modelFixture([modelSeat({ id: "seat", label: "Seat", x: 200, y: 120 })]) },
    });
    await expect(junto.page.locator('.react-flow__node[data-id="seat"]')).toBeVisible({ timeout: 90_000 });
  } finally {
    await junto?.close().catch(() => undefined);
    await destroySandbox(sandbox);
  }
});
