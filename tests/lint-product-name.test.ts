import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const LINT = path.join(ROOT, "scripts/lint-product-name.ts");

describe("lint:product-name", () => {
  it("passes on the current tree (product brand fully qualified)", () => {
    const result = spawnSync("bun", [LINT], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toMatch(/ok/i);
  });

  it("rejects bare product token without Command", () => {
    // Pattern contract — keep in sync with scripts/lint-product-name.ts
    // Build the bare token at runtime so this file does not trip the lint.
    const token = ["Vel", "lum"].join("");
    const bare = new RegExp(`\\b${token}\\b(?! Command)(?!-Command)`, "g");
    expect(bare.test(`Open ${token} now`)).toBe(true);
    bare.lastIndex = 0;
    expect(bare.test(`Open ${token} Command now`)).toBe(false);
    bare.lastIndex = 0;
    expect(bare.test(`${token}-Command-1.0.0-mac.zip`)).toBe(false);
    bare.lastIndex = 0;
    expect(bare.test(`${token}Api and resolve${token}Home`)).toBe(false);
    bare.lastIndex = 0;
    expect(bare.test(`~/.${token.toLowerCase()}/state/${token.toLowerCase()}.db`)).toBe(
      false,
    );
  });
});
