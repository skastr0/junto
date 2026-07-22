import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (relative: string): string =>
  readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

describe("ACP lifecycle architecture", () => {
  it("mints local child authority once at the Hermes spawn boundary", () => {
    const client = source("src/main/vellum/chat/acp-client.ts");
    const plane = source("src/main/vellum/hermes/plane.ts");

    expect(client).not.toContain("admitChildProcess");
    expect(plane.match(/admitChildProcess\s*\(/gu) ?? []).toHaveLength(1);
    expect(plane).not.toContain("localChildren");
    expect(plane).not.toContain("terminateLocalAcpChild");
  });

  it("keeps remote ACP scope-owned and outside the OS signal plane", () => {
    const client = source("src/main/vellum/chat/acp-client.ts");
    const plane = source("src/main/vellum/hermes/plane.ts");

    expect(client).toContain('readonly kind: "remote-scope"');
    expect(plane).toContain('kind: "remote-scope"');
    expect(plane).toContain("Scope.make(ExecutionStrategy.sequential)");
    expect(plane).not.toContain("Scope.fork(");
    expect(plane).not.toMatch(/\.kill\s*\(/u);
    expect(plane).not.toContain("signalOwned");
  });
});
