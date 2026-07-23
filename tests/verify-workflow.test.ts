import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  new URL("../.github/workflows/verify.yml", import.meta.url),
  "utf8",
);

describe("verify workflow", () => {
  it("keeps the macOS verify lane and adds the Ubuntu 24.04 Linux package lane", () => {
    expect(workflow).toContain("verify-macos:");
    expect(workflow).toContain("runs-on: macos-14");
    expect(workflow).toContain("bun run verify");

    expect(workflow).toContain("verify-linux:");
    expect(workflow).toContain("runs-on: ubuntu-24.04");
    expect(workflow).toContain("node-version: 22.23.1");
    expect(workflow).toContain("bun run app:build:linux -- --verify");
  });

  it("keeps the workflow trigger narrow and read-only", () => {
    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("push:");
    expect(workflow).toContain("branches: [main]");
    expect(workflow).toContain("permissions:");
    expect(workflow).toContain("contents: read");
  });
});
