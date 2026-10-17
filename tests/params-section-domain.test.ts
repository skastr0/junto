import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

describe("seat Params reads the harness record", () => {
  test("names no harness id", () => {
    const source = readFileSync(join(__dirname, "../src/renderer/components/customize/ParamsSection.tsx"), "utf8");
    expect(source.match(/harness\s*[!=]==\s*"[a-z-]+"/g) ?? []).toEqual([]);
    expect(source).not.toMatch(/"amp"/);
  });
});
