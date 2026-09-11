/**
 * Overseer acceptance: installed CLI path.
 *
 * Does not claim canvas/work/native handlers. Skips until an installed
 * `vellum-command` binary advertises the overseer command. Offline discovery
 * (`schema` / `skill` / help) is the first real surface; mutation scenarios
 * wait on peer APIs.
 */
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { test, expect } from "@playwright/test";

const execFileAsync = promisify(execFile);
const REPO_ROOT = process.cwd();
const INSTALLED_CLI_CANDIDATES = [
  join(REPO_ROOT, "dist/vellum-command"),
  join(REPO_ROOT, "bin/vellum-command"),
] as const;

const resolveInstalledCli = (): string | undefined =>
  INSTALLED_CLI_CANDIDATES.find((path) => existsSync(path));

const runCli = async (
  cli: string,
  args: ReadonlyArray<string>,
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> => {
  try {
    const result = await execFileAsync(cli, [...args], {
      cwd: REPO_ROOT,
      timeout: 20_000,
      env: { ...process.env },
    });
    return {
      code: 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    const failure = error as {
      readonly code?: number | string;
      readonly stdout?: string;
      readonly stderr?: string;
    };
    const code = typeof failure.code === "number" ? failure.code : 1;
    return {
      code,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? (error instanceof Error ? error.message : String(error)),
    };
  }
};

const commandMissing = (stdout: string, stderr: string): boolean => {
  const text = `${stdout}\n${stderr}`.toLowerCase();
  return (
    text.includes("unknown command") ||
    text.includes("invalid command") ||
    text.includes("command not found") ||
    text.includes("no such command") ||
    text.includes("unrecognized")
  );
};

test.describe("overseer acceptance — installed CLI", () => {
  test("installed CLI exposes offline overseer discovery without claiming handlers", async () => {
    const cli = resolveInstalledCli();
    test.skip(
      cli === undefined,
      "installed CLI is not present at dist/vellum-command or bin/vellum-command",
    );
    if (cli === undefined) return;

    const help = await runCli(cli, ["overseer", "--help"]);
    test.skip(
      commandMissing(help.stdout, help.stderr),
      "installed CLI does not yet advertise overseer",
    );

    const combined = `${help.stdout}\n${help.stderr}`;
    expect(combined.toLowerCase()).toContain("overseer");
    expect(combined.toLowerCase()).not.toContain("operator socket");

    const schema = await runCli(cli, ["overseer", "schema"]);
    if (!commandMissing(schema.stdout, schema.stderr) && schema.code === 0) {
      expect(schema.stdout).toContain("canvas.list");
      expect(schema.stdout).toContain("agent.reseat");
      expect(schema.stdout).not.toMatch(/OPERATOR_SEAT_ID/u);
    }

    const skill = await runCli(cli, ["overseer", "skill"]);
    if (!commandMissing(skill.stdout, skill.stderr) && skill.code === 0) {
      expect(skill.stdout.toLowerCase()).toContain("overseer");
      expect(skill.stdout.toLowerCase()).toContain("pause");
    }
  });
});
