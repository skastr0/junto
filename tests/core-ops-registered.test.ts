import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// A group file that declares core operations but is not imported by
// ops/index.ts leaves its names without a body: every converted site then
// fails UnknownCoreOp. Two seats committing ops/index.ts at once dropped a line
// this way (7d32057f5), so the registration is pinned here, per commit.
const OPS = join(__dirname, "..", "src", "main", "core-process", "ops");

describe("core operation groups", () => {
  it("imports every group file in ops/index.ts", () => {
    const groups = readdirSync(OPS)
      .filter((file) => file.endsWith(".ts") && file !== "index.ts")
      .filter((file) => readFileSync(join(OPS, file), "utf8").includes("coreOps("))
      .map((file) => `./${file.replace(/\.ts$/, "")}`)
      .sort();
    const imported = [...readFileSync(join(OPS, "index.ts"), "utf8").matchAll(/^import "(\.\/[^"]+)";$/gm)]
      .map((match) => match[1])
      .sort();
    expect(groups.filter((group) => !imported.includes(group))).toEqual([]);
  });
});
