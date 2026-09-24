import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Effect CLI boolean flags fail when omitted unless they carry a default, so a
// bare `junto msg send '<json>'` used to stop at "Missing required flag".
const home = mkdtempSync(join(tmpdir(), "junto-cli-flags-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("JUNTO_")),
);

const run = (args: ReadonlyArray<string>) =>
  spawnSync("bun", ["src/cli/main.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 30_000,
    env: { ...env, HOME: home },
  });

describe("CLI boolean flags are optional", () => {
  it.each([
    ["msg send", ["msg", "send", '{"target":"peer","text":"hello"}']],
    ["seat wait", ["seat", "wait", "peer", "--until", "idle"]],
    ["seat read", ["seat", "read", "peer"]],
  ] as const)("%s parses without its boolean flag", (_name, args) => {
    const result = run(args);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).not.toContain("Missing required flag");
    expect(output).not.toContain("MissingOption");
  });
});
