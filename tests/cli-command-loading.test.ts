import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";

// An unrelated family's initialization must not run during an agent invocation.
vi.mock("../src/cli/commands/overseer", () => { throw new Error("unrelated overseer catalog initialized"); });
vi.mock("../src/cli/commands/operator", () => { throw new Error("unrelated operator family initialized"); });
vi.mock("../src/cli/commands/pad", () => { throw new Error("unrelated pad family initialized"); });
vi.mock("../src/cli/commands/sheet", () => { throw new Error("unrelated sheet family initialized"); });

import { loadRootCommand } from "../src/cli/command-runner";

describe("agent CLI command loading", () => {
  it("constructs common agent commands without initializing unrelated families", async () => {
    for (const name of ["ping", "doctor", "onboard", "capabilities", "offboard", "msg", "seat", "feedback", "signal"]) {
      await expect(loadRootCommand([name])).resolves.toBeDefined();
    }
  });

  it("prints the version offline without a credential or work socket", () => {
    const result = spawnSync("bun", ["src/cli/main.ts", "--version"], {
      encoding: "utf8",
      env: { ...process.env, JUNTO_WORK_TOKEN: "", JUNTO_WORK_HOME: "/does-not-exist" },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("junto v0.1.0\n");
    expect(result.stderr).toBe("");
  });
});
