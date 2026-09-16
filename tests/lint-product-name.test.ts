import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const LINT = path.join(ROOT, "scripts/lint-product-name.ts");

describe("lint:product-name", () => {
  it("passes on the current tree (no retired brand mark)", () => {
    const result = spawnSync("bun", [LINT], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toMatch(/ok/i);
  });

  it("rejects every word-bounded retired token", () => {
    // Pattern contract — keep in sync with scripts/lint-product-name.ts
    // Build the retired token at runtime so this file does not trip the lint.
    const token = ["Vel", "lum"].join("");
    const retired = new RegExp(`\\b${token}\\b`, "g");
    expect(retired.test(`Open ${token} now`)).toBe(true);
    retired.lastIndex = 0;
    expect(retired.test(`Open ${token} Command now`)).toBe(true);
    retired.lastIndex = 0;
    expect(retired.test(`${token}-Command-1.0.0-mac.zip`)).toBe(true);
    retired.lastIndex = 0;
    expect(retired.test(`${token}CommandApi and resolve${token}CommandHome`)).toBe(
      false,
    );
    retired.lastIndex = 0;
    expect(
      retired.test(
        `~/.${token.toLowerCase()}-command/state/${token.toLowerCase()}-command.db`,
      ),
    ).toBe(false);
  });
});
