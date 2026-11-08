import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { OWNER_COMMAND_REFUSAL } from "../src/cli/core/owner-access";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const invoke = (args: string[], token: string) => {
  const home = mkdtempSync("/tmp/junto-owner-refusal-");
  homes.push(home);
  const result = spawnSync("bun", ["src/cli/main.ts", ...args], {
    encoding: "utf8",
    env: { ...process.env, JUNTO_HOME: home, JUNTO_WORK_TOKEN: token },
    timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(readdirSync(home)).toEqual([]);
  return result.stderr;
};

it.each(["install-local", "uninstall-local"])("refuses machine %s before loading input when global flags bypass early dispatch", (command) => {
  const stderr = invoke(["--log-level", "error", "machine", command, "@/missing-owner-input.json"], "");
  expect(JSON.parse(stderr)).toMatchObject({
    ok: false,
    command: `machine ${command}`,
    error: { type: "AuthError", message: OWNER_COMMAND_REFUSAL },
  });
});

it.each([["machine"], ["link"], ["companion-stdio"]])("refuses the %j entry in one sentence for a malformed seat variable", (...args) => {
  expect(invoke(args, "malformed")).toBe(`${OWNER_COMMAND_REFUSAL}\n`);
});
